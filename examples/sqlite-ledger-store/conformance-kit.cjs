'use strict';
/**
 * Host-store conformance kit for the antiRea disclosure ledger.
 *
 * Usage:
 *   node conformance-kit.cjs <factory-module-path> [--label <name>]
 *
 * The factory module must export `createStore()` (or be itself a
 * function) returning a FRESH, EMPTY LedgerStoreAdapter per call:
 *
 *   module.exports = { createStore: () => myAdapterFactory() };
 *
 * The kit runs the LedgerStoreAdapter contract checks:
 *   (a) transact-presence-honesty  - transactLedger exists iff the store
 *       claims supportsTransactions; a get/put-only store presented as
 *       transactional FAILS with reason DISHONEST_TRANSACTION_CLAIM.
 *   (b) parallel-ceiling-exactness - 40 parallel reservations of 10
 *       disjoint records each against a ceiling of 100 over the store:
 *       exactly 100 granted, 10 allowed / 30 refused ceiling_exceeded,
 *       100 committed, the 101st record refused.
 *   (c) version-conflict-retry     - a stale expectedVersion conflicts
 *       and changes nothing; the correct version commits; 10 parallel
 *       ledger-level evidence increments all land (the ledger's
 *       conflict-retry loop works over this store).
 *   (d) getput-lie-detection       - the kit points its own honesty
 *       detector at a synthetic get/put-only store that claims
 *       supportsTransactions and requires the detector to reject it
 *       with the named reason; a candidate that IS such a store has
 *       already failed (a) with that same reason.
 *
 * Exit code 0 = PASS, 1 = FAIL. Every failure carries a named reason.
 */

const path = require('node:path');

const sdk = require(path.resolve(__dirname, '..', '..', 'dist', 'index.js'));

const CEILING = 100;
const ids = (from, count) => Array.from({ length: count }, (_, i) => from + i);

function loadFactory(factoryPath) {
  const mod = require(path.resolve(factoryPath));
  const factory = mod.createStore || mod.createSqliteLedgerStore || mod.default || mod;
  if (typeof factory !== 'function') {
    throw new Error(
      `FACTORY_EXPORT_MISSING: ${factoryPath} does not export createStore() (or a factory function)`,
    );
  }
  return () => factory();
}

function freshStore(factory) {
  const store = factory();
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') {
    throw new Error('FACTORY_RETURNED_INVALID_STORE: createStore() must return an adapter with get/put');
  }
  return store;
}

function closeQuietly(store) {
  try {
    if (store && typeof store.close === 'function') store.close();
  } catch {
    /* best effort */
  }
}

/**
 * The honesty detector, shared by checks (a) and (d).
 * Returns { ok: true } or { ok: false, reason, detail }.
 */
function inspectStoreHonesty(store) {
  if (typeof store.supportsTransactions !== 'boolean') {
    return {
      ok: false,
      reason: 'SUPPORTS_TRANSACTIONS_NOT_BOOLEAN',
      detail: `supportsTransactions is ${typeof store.supportsTransactions}, expected a boolean`,
    };
  }
  if (store.supportsTransactions === true && typeof store.transactLedger !== 'function') {
    return {
      ok: false,
      reason: 'DISHONEST_TRANSACTION_CLAIM',
      detail:
        'supportsTransactions=true but transactLedger is missing: this is a get/put-only ' +
        'store presented as transactional - it cannot provide CAS, so the ceiling cannot be enforced over it',
    };
  }
  if (store.supportsTransactions !== true) {
    return {
      ok: false,
      reason: 'NOT_TRANSACTIONAL',
      detail:
        'store declares supportsTransactions=false (audit-only honesty class): decisions over it ' +
        'are computed best-effort and the ceiling is NOT guaranteed under concurrency',
    };
  }
  return { ok: true };
}

function probeState(evidenceValue) {
  return {
    version: 0, // the store overwrites this with stored+1 on commit
    unionBitmap: '',
    anonymousServed: 0,
    reservations: {},
    bucket: { tokens: 0, lastRefillMs: 0, burst: 0, refillPerSecond: 0 },
    evidence: { probe: evidenceValue },
    idempotency: {},
    registry: null,
    nextReservationSeq: 1,
  };
}

async function checkHonesty(factory) {
  const store = freshStore(factory);
  try {
    const verdict = inspectStoreHonesty(store);
    if (!verdict.ok) return verdict;
    const ledger = sdk.createDisclosureLedger({ store, ceilingLimit: CEILING });
    if (ledger.mode !== 'enforce') {
      return {
        ok: false,
        reason: 'LEDGER_MODE_NOT_ENFORCE',
        detail: `SDK put a store claiming transactions into mode=${ledger.mode}`,
      };
    }
    return { ok: true, detail: 'transactLedger present, supportsTransactions=true, ledger mode=enforce' };
  } finally {
    closeQuietly(store);
  }
}

async function checkParallelExactness(factory) {
  const store = freshStore(factory);
  try {
    const ledger = sdk.createDisclosureLedger({
      store,
      ceilingLimit: CEILING,
      bucket: { burst: 100_000, refillPerSecond: 100_000 },
    });
    const subjects = Array.from({ length: 40 }, (_, i) => `account:s${i}`);
    const results = await Promise.all(
      subjects.map((subject, i) => ledger.reserveDisclosure({ subject, recordIds: ids(i * 10, 10) })),
    );
    const allowed = results.filter((r) => r.allowed);
    const refused = results.filter((r) => !r.allowed);
    const totalNew = allowed.reduce((sum, r) => sum + (r.newRecords || 0), 0);
    if (totalNew !== CEILING) {
      return {
        ok: false,
        reason: 'CEILING_OVERSHOOT_OR_UNDERSHOOT',
        detail: `parallel reservations granted ${totalNew} records against ceiling ${CEILING} (expected exactly ${CEILING})`,
      };
    }
    if (allowed.length !== 10 || refused.length !== 30) {
      return {
        ok: false,
        reason: 'PARALLEL_SHAPE_MISMATCH',
        detail: `allowed=${allowed.length} refused=${refused.length}, expected 10/30`,
      };
    }
    if (!refused.every((r) => r.reason === 'ceiling_exceeded')) {
      return {
        ok: false,
        reason: 'REFUSAL_REASON_MISMATCH',
        detail: `refusal reasons seen: ${[...new Set(refused.map((r) => r.reason))].join(', ')}`,
      };
    }
    if (!allowed.every((r) => r.enforced === true)) {
      return {
        ok: false,
        reason: 'DECISIONS_NOT_ENFORCED',
        detail: 'a granted reservation carried enforced:false over a supposedly transactional store',
      };
    }
    for (const r of allowed) {
      const c = await ledger.commitReservation(r.reservationId);
      if (!c.committed) {
        return { ok: false, reason: 'COMMIT_FAILED', detail: `commit of ${r.reservationId} failed: ${c.reason}` };
      }
    }
    const snapshot = await ledger.snapshot();
    if (snapshot.committedRecords !== CEILING) {
      return {
        ok: false,
        reason: 'COMMITTED_COUNT_MISMATCH',
        detail: `snapshot committedRecords=${snapshot.committedRecords}, expected ${CEILING}`,
      };
    }
    const oneMore = await ledger.reserveDisclosure({ subject: 'account:late', recordIds: [9999] });
    if (oneMore.allowed || oneMore.reason !== 'ceiling_exceeded') {
      return {
        ok: false,
        reason: 'POST_CEILING_RESERVATION_ALLOWED',
        detail: `reservation past a full ceiling returned allowed=${oneMore.allowed} reason=${oneMore.reason}`,
      };
    }
    return { ok: true, detail: '40 parallel x 10 records vs ceiling 100 -> exactly 100 granted, 30 refused, 100 committed' };
  } finally {
    closeQuietly(store);
  }
}

async function checkVersionConflict(factory) {
  const store = freshStore(factory);
  try {
    if (typeof store.transactLedger !== 'function') {
      return {
        ok: false,
        reason: 'DISHONEST_TRANSACTION_CLAIM',
        detail: 'transactLedger missing, version-conflict behaviour cannot exist',
      };
    }
    // 1) First commit from the empty state (expectedVersion 0).
    const t1 = await store.transactLedger('kit-probe', 0, (state) => {
      if (state !== null) throw new Error('expected null state for a fresh ledger');
      return probeState(1);
    });
    if (!t1.committed || t1.conflict || t1.version !== 1) {
      return { ok: false, reason: 'FIRST_TRANSACT_WRONG', detail: `t1=${JSON.stringify(t1)}, expected committed v1` };
    }
    // 2) Stale expectedVersion must conflict and change NOTHING.
    const t2 = await store.transactLedger('kit-probe', 0, () => probeState(999));
    if (t2.committed || !t2.conflict || t2.version !== 1) {
      return {
        ok: false,
        reason: 'VERSION_CONFLICT_NOT_DETECTED',
        detail: `stale transact returned ${JSON.stringify(t2)}, expected { committed:false, conflict:true, version:1 }`,
      };
    }
    const raw = await store.get('antirea:ledger:kit-probe');
    const stored = raw ? JSON.parse(raw) : null;
    if (!stored || stored.version !== 1 || stored.evidence.probe !== 1) {
      return {
        ok: false,
        reason: 'CONFLICT_MUTATED_STATE',
        detail: `stored state after conflict: version=${stored && stored.version} probe=${stored && stored.evidence && stored.evidence.probe}, expected version=1 probe=1 (the losing updater must never run its write)`,
      };
    }
    // 3) Updater abort (returns null): no commit, no conflict, NO version bump.
    const t3 = await store.transactLedger('kit-probe', 1, () => null);
    if (t3.committed || t3.conflict || t3.version !== 1) {
      return {
        ok: false,
        reason: 'ABORT_SEMANTICS_WRONG',
        detail: `abort transact returned ${JSON.stringify(t3)}, expected { committed:false, conflict:false, version:1 }`,
      };
    }
    // 4) Correct expectedVersion commits and bumps exactly once.
    const t4 = await store.transactLedger('kit-probe', 1, (state) => ({ ...state, evidence: { probe: 2 } }));
    if (!t4.committed || t4.conflict || t4.version !== 2) {
      return { ok: false, reason: 'SECOND_TRANSACT_WRONG', detail: `t4=${JSON.stringify(t4)}, expected committed v2` };
    }
    // 5) Ledger-level conflict retry: parallel evidence increments all land.
    const ledger = sdk.createDisclosureLedger({
      store,
      ledgerId: 'kit-retry',
      ceilingLimit: CEILING,
      bucket: { burst: 100_000, refillPerSecond: 100_000 },
    });
    await Promise.all(Array.from({ length: 10 }, () => ledger.recordEvidence('hits', 1)));
    const snap = await ledger.snapshot();
    if (snap.evidence.hits !== 10) {
      return {
        ok: false,
        reason: 'LEDGER_RETRY_LOST_UPDATES',
        detail: `10 parallel recordEvidence(+1) landed ${snap.evidence.hits}, expected 10`,
      };
    }
    return {
      ok: true,
      detail: 'stale version conflicts cleanly, abort does not bump, correct version commits, 10 parallel ledger increments all land via retry',
    };
  } finally {
    closeQuietly(store);
  }
}

async function checkLieDetection(factory) {
  // Synthetic liar: a real get/put store that CLAIMS transactions.
  const data = new Map();
  const liar = {
    supportsTransactions: true,
    get: (k) => data.get(k) ?? null,
    put: (k, v) => data.set(k, v),
    // deliberately NO transactLedger
  };
  const verdict = inspectStoreHonesty(liar);
  if (verdict.ok || verdict.reason !== 'DISHONEST_TRANSACTION_CLAIM') {
    return {
      ok: false,
      reason: 'LIE_DETECTOR_BROKEN',
      detail: 'the honesty detector failed to reject a get/put-only store claiming supportsTransactions',
    };
  }
  // And, symmetrically: a candidate that lies the same way must be named here too.
  const store = freshStore(factory);
  try {
    const candidate = inspectStoreHonesty(store);
    if (!candidate.ok && candidate.reason === 'DISHONEST_TRANSACTION_CLAIM') {
      return {
        ok: false,
        reason: 'DISHONEST_TRANSACTION_CLAIM',
        detail: 'the CANDIDATE store is itself a get/put-only store presented as transactional',
      };
    }
  } finally {
    closeQuietly(store);
  }
  return { ok: true, detail: 'synthetic get/put liar rejected with reason DISHONEST_TRANSACTION_CLAIM' };
}

async function main() {
  const args = process.argv.slice(2);
  const labelIdx = args.indexOf('--label');
  const label = labelIdx >= 0 ? args[labelIdx + 1] : null;
  // The --label value sits at labelIdx + 1 - but only when --label is
  // present at all. With labelIdx = -1 the naive `i !== labelIdx + 1`
  // excluded index 0, i.e. the factory path itself, and every invocation
  // without --label fell through to the usage message (audit KIT-1).
  const labelValueIdx = labelIdx >= 0 ? labelIdx + 1 : -1;
  const factoryPath = args.find((a, i) => !a.startsWith('--') && i !== labelValueIdx);
  if (!factoryPath) {
    console.error('usage: node conformance-kit.cjs <factory-module-path> [--label <name>]');
    process.exit(2);
  }
  const name = label || factoryPath;
  console.log(`conformance kit - candidate: ${name}`);
  let factory;
  try {
    factory = loadFactory(factoryPath);
  } catch (err) {
    console.log(`[FAIL] factory-load reason=${err.message}`);
    console.log(`KIT VERDICT: FAIL (${name})`);
    process.exit(1);
  }

  const checks = [
    ['transact-presence-honesty', checkHonesty],
    ['parallel-ceiling-exactness', checkParallelExactness],
    ['version-conflict-retry', checkVersionConflict],
    ['getput-lie-detection', checkLieDetection],
  ];
  let allOk = true;
  for (const [checkName, fn] of checks) {
    let result;
    try {
      result = await fn(factory);
    } catch (err) {
      result = { ok: false, reason: 'CHECK_THREW', detail: String((err && err.stack) || err) };
    }
    if (result.ok) {
      console.log(`[PASS] ${checkName} - ${result.detail}`);
    } else {
      allOk = false;
      console.log(`[FAIL] ${checkName} reason=${result.reason}: ${result.detail}`);
    }
  }
  console.log(`KIT VERDICT: ${allOk ? 'PASS' : 'FAIL'} (${name})`);
  process.exit(allOk ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { inspectStoreHonesty };
