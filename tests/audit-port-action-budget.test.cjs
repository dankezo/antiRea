const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/*
 * Audit-port regression tests for the action budget ONLY.
 *
 * Provenance: this file ports the action-budget parts of the
 * 2.6.1-2.6.3 fixes (released tree `antirea-220`) into the 2.7.0 tree,
 * which was forked before those fix waves:
 *
 *   F-01 (variant) - idempotency replay must bind subject + action +
 *     cost + cohort; a mismatched replay is refused
 *     `idempotency_conflict`. Source test: 220
 *     tests/action-budget.test.cjs test 10; retest bar:
 *     audits/antirea-270-pre-release-2026-11-03
 *     scripts/regress-harness-verify.cjs V2 (replay allowed pre-port,
 *     cost reported was the victim's).
 *   F-05 - an action with no price anywhere is refused
 *     `unknown_action` by default; `unknownActionCost` charges a
 *     fallback and flags results `unpriced: true`. Source tests: 220
 *     tests/audit-wave2.test.cjs (F-05 block, verbatim); retest bar
 *     V3 = 0/30 granted.
 *   CLK-1 / L-DEEP-2 (action-budget point A12) - hybrid clock rule:
 *     own reservations die at the earlier of wall expiry / monotonic
 *     TTL; own windows roll at the earlier of wall / monotonic
 *     length; refill credit is clamped. Source test: 220
 *     tests/mono-clock.test.cjs (action-budget window test,
 *     verbatim) plus the reservation-TTL test modeled on the ledger
 *     test in the same file.
 *   F-13 (LOW) - `state.subjects` never expired: 40 one-shot subjects
 *     stayed in state forever (270 audit regress-h6.cjs). The
 *     released tree has NO prune mechanism, so the F-13 tests below
 *     pin a NEW minimal fix, not a port: a subject window that has
 *     fully rolled (wall or anchored monotonic length) and holds no
 *     open reservation is deleted on persisting mutation paths.
 *
 * The 2.7.0 override contract (tests/action-budget-overrides.test.cjs)
 * is untouched by this port; one interaction test below pins that the
 * F-05 pre-transaction refusal does not publish the override mirror.
 */

const makeClocks = (start = 1_700_000_000_000) => {
  let wall = start;
  let mono = start;
  return {
    now: () => wall,
    monoNow: () => mono,
    advanceReal(ms) {
      wall += ms;
      mono += ms;
    },
    stepWall(ms) {
      wall += ms;
    },
  };
};

/* ------------------------------ F-01 ------------------------------ */

function enforceBudget(overrides = {}) {
  return sdk.createActionBudget({
    store: sdk.createInMemoryTransactionalStore(),
    prices: { export: 10, promo_claim: 5 },
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
    ...overrides,
  });
}

test('F-01: action budget: idempotency replay with different subject/action/cost is refused', async () => {
  const budget = enforceBudget();
  const first = await budget.reserveAction({ subject: 'account:a', action: 'export', idempotencyKey: 'k-9' });
  assert.equal(first.allowed, true);
  assert.equal(first.cost, 10);

  // Audit harness V2: another subject replays the key for a different
  // action. Pre-port this returned allowed:true + duplicate:true with
  // the ORIGINAL subject's cost.
  const otherSubject = await budget.reserveAction({ subject: 'account:b', action: 'promo_claim', idempotencyKey: 'k-9' });
  assert.equal(otherSubject.allowed, false);
  assert.equal(otherSubject.reason, 'idempotency_conflict');

  // Same subject, different action.
  const otherAction = await budget.reserveAction({ subject: 'account:a', action: 'promo_claim', idempotencyKey: 'k-9' });
  assert.equal(otherAction.allowed, false);
  assert.equal(otherAction.reason, 'idempotency_conflict');

  // Same subject and action, different explicit cost.
  const otherCost = await budget.reserveAction({ subject: 'account:a', action: 'export', cost: 1, idempotencyKey: 'k-9' });
  assert.equal(otherCost.allowed, false);
  assert.equal(otherCost.reason, 'idempotency_conflict');

  // Same subject, action and cost, but a different cohort binding.
  const otherCohort = await budget.reserveAction({ subject: 'account:a', action: 'export', cohortId: 'c-any', idempotencyKey: 'k-9' });
  assert.equal(otherCohort.allowed, false);
  assert.equal(otherCohort.reason, 'idempotency_conflict');

  // The exact replay is still honored as a duplicate, charged once.
  const dupe = await budget.reserveAction({ subject: 'account:a', action: 'export', idempotencyKey: 'k-9' });
  assert.equal(dupe.allowed, true);
  assert.equal(dupe.duplicate, true);
  assert.equal(dupe.reservationId, first.reservationId);
  assert.equal(dupe.cost, 10);
  const snap = await budget.snapshot();
  assert.equal(snap.outstandingReservations, 1);
  assert.equal(snap.reservedCost, 10);
});

/* ------------------------------ F-05 ------------------------------ */

function actionBudgetWith(overrides = {}) {
  return sdk.createActionBudget({
    store: sdk.createInMemoryTransactionalStore(),
    prices: { export: 10, freebie: 0 },
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
    ...overrides,
  });
}

test('F-05: an unpriced action is refused unknown_action - 0 of 30 granted (audit V3 scenario)', async () => {
  const budget = actionBudgetWith();
  let granted = 0;
  for (let i = 0; i < 30; i++) {
    const r = await budget.reserveAction({ subject: 'account:a', action: 'teleport' });
    if (r.allowed) granted++;
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'unknown_action');
    assert.equal(r.cost, 0);
  }
  assert.equal(granted, 0, 'retest bar: no unpriced action is granted');
});

test('F-05: deliberate zeros and explicit costs still work; NaN cost is not a price', async () => {
  const budget = actionBudgetWith();
  const explicit = await budget.reserveAction({ subject: 'account:a', action: 'teleport', cost: 5 });
  assert.equal(explicit.allowed, true);
  assert.equal(explicit.cost, 5);
  assert.equal(explicit.unpriced, undefined);

  const explicitZero = await budget.reserveAction({ subject: 'account:b', action: 'teleport', cost: 0 });
  assert.equal(explicitZero.allowed, true, 'an explicit cost: 0 is the host\u2019s deliberate choice');
  assert.equal(explicitZero.cost, 0);

  const tableZero = await budget.reserveAction({ subject: 'account:c', action: 'freebie' });
  assert.equal(tableZero.allowed, true, 'a table entry priced at 0 is deliberate too');
  assert.equal(tableZero.cost, 0);
  assert.equal(tableZero.unpriced, undefined);

  const nanUnpriced = await budget.reserveAction({ subject: 'account:d', action: 'teleport', cost: NaN });
  assert.equal(nanUnpriced.allowed, false);
  assert.equal(nanUnpriced.reason, 'unknown_action', 'NaN falls through to the unpriced path, not to a silent 0');

  const nanPriced = await budget.reserveAction({ subject: 'account:e', action: 'export', cost: NaN });
  assert.equal(nanPriced.allowed, true);
  assert.equal(nanPriced.cost, 10, 'NaN explicit cost falls back to the table price');
});

test('F-05: unknownActionCost charges the fallback and flags the result unpriced', async () => {
  const budget = actionBudgetWith({ unknownActionCost: 7, subjectAllowance: 10 });
  const first = await budget.reserveAction({ subject: 'account:a', action: 'teleport' });
  assert.equal(first.allowed, true);
  assert.equal(first.cost, 7);
  assert.equal(first.unpriced, true);
  // The fallback cost is real accounting: a second reserve would take
  // reserved cost to 14 over an allowance of 10 and is refused.
  const second = await budget.reserveAction({ subject: 'account:a', action: 'teleport' });
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'subject_budget_exceeded');
  assert.equal(second.unpriced, true);
  const committed = await budget.commitAction(first.reservationId);
  assert.equal(committed.committed, true);
});

test('F-05 x overrides (2.7 contract): an unknown_action refusal does not publish the override mirror', async () => {
  const store = sdk.createInMemoryTransactionalStore();
  const opts = {
    store,
    budgetId: 'f05-override-isolation',
    prices: { export: 10 },
    subjectAllowance: 100,
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
  };
  const a = sdk.createActionBudget(opts);
  const b = sdk.createActionBudget(opts);
  a.setAllowanceOverride('subj', 15);
  // The F-05 refusal returns before any store transaction, exactly
  // like a refused reserve under the pre-flush contract: B must still
  // decide on the default allowance afterwards.
  const refused = await a.reserveAction({ subject: 'subj', action: 'teleport' });
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, 'unknown_action');
  const bFirst = await b.reserveAction({ subject: 'subj', action: 'export' });
  assert.equal(bFirst.allowed, true);
  await b.commitAction(bFirst.reservationId);
  const bSecond = await b.reserveAction({ subject: 'subj', action: 'export' });
  assert.equal(bSecond.allowed, true, 'B allowed 20 total cost: the unknown_action refusal never published the override of 15');
  // And the explicit flush still publishes it, as the contract says.
  await a.flushOverrides();
  const bThird = await b.reserveAction({ subject: 'subj', action: 'export' });
  assert.equal(bThird.allowed, false);
  assert.equal(bThird.reason, 'subject_budget_exceeded');
});

/* --------------------------- L-DEEP-2 / CLK-1 --------------------------- */

test('L-DEEP-2: action budget: a subject window created by this process rolls on the monotonic clock', async () => {
  const clocks = makeClocks();
  const budget = sdk.createActionBudget({
    store: sdk.createInMemoryTransactionalStore(),
    prices: { export: 10 },
    subjectAllowance: 100,
    windowMs: 60_000,
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  const reserved = await budget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(reserved.allowed, true);
  const committed = await budget.commitAction(reserved.reservationId);
  assert.equal(committed.committed, true);
  let snapshot = await budget.snapshot();
  assert.equal(snapshot.subjects['account:a'].committedCost, 10);

  clocks.stepWall(-300_000);
  clocks.advanceReal(61_000); // the 60 s window has elapsed in real time

  // Wall-only accounting would keep the committed cost until real
  // second 360; the anchored window rolls on schedule.
  snapshot = await budget.snapshot();
  assert.equal(snapshot.subjects['account:a'].committedCost, 0);
});

test('L-DEEP-2: action budget: a reservation created by this process dies at its monotonic TTL', async () => {
  const clocks = makeClocks();
  const budget = sdk.createActionBudget({
    store: sdk.createInMemoryTransactionalStore(),
    prices: { export: 10 },
    reservation: { ttlMs: 60_000 },
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  const reserved = await budget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(reserved.allowed, true);

  clocks.stepWall(-300_000); // wall expiry (t0 + 60 s) is now 5 min in the wall future
  clocks.advanceReal(61_000); // but the TTL has fully elapsed in real time

  const swept = await budget.sweepExpired();
  assert.equal(swept.expired, 1);
  const snapshot = await budget.snapshot();
  assert.equal(snapshot.outstandingReservations, 0);
});

/* ------------------------------ F-13 ------------------------------ */

test('F-13: 40 one-shot subjects are pruned once their windows have fully rolled (sweep persists the prune)', async () => {
  const clocks = makeClocks();
  const budget = sdk.createActionBudget({
    store: sdk.createInMemoryTransactionalStore(),
    prices: { export: 10 },
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  // The regress-h6 scenario: 40 subjects, each used exactly once.
  for (let i = 0; i < 40; i++) {
    const r = await budget.reserveAction({ subject: 'one-shot-' + i, action: 'export' });
    assert.equal(r.allowed, true);
    await budget.commitAction(r.reservationId);
  }
  // Live windows are accounting, not garbage: nothing is pruned
  // while the window is still current.
  let snap = await budget.snapshot();
  assert.equal(Object.keys(snap.subjects).length, 40);
  assert.equal(snap.committedCost, 400);

  clocks.advanceReal(61_000); // every window has now fully rolled

  const swept = await budget.sweepExpired();
  assert.equal(swept.expired, 0, 'no reservations were open; the sweep is prune-only');
  snap = await budget.snapshot();
  assert.equal(Object.keys(snap.subjects).length, 0, 'rolled, reservation-free subject windows are gone from persisted state');
  assert.equal(snap.committedCost, 0);
});

test('F-13: a subject with an open reservation is NOT pruned when its window rolls', async () => {
  const clocks = makeClocks();
  const budget = sdk.createActionBudget({
    store: sdk.createInMemoryTransactionalStore(),
    prices: { export: 10 },
    windowMs: 60_000,
    reservation: { ttlMs: 300_000 },
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  const held = await budget.reserveAction({ subject: 'holder', action: 'export' });
  assert.equal(held.allowed, true); // never committed or released
  const done = await budget.reserveAction({ subject: 'done', action: 'export' });
  assert.equal(done.allowed, true);
  await budget.commitAction(done.reservationId);

  clocks.advanceReal(61_000); // windows rolled; the held reservation (TTL 300 s) is still open

  await budget.sweepExpired();
  const snap = await budget.snapshot();
  assert.deepEqual(Object.keys(snap.subjects), ['holder'], 'only the reservation-free subject was pruned');
  assert.equal(snap.subjects['holder'].reservedCost, 10, 'the rolled window recomputed reserved cost from the open reservation');
  assert.equal(snap.outstandingReservations, 1);
});

test('F-13: the prune is persisted on write paths, not just hidden from snapshots (audit_only raw state)', async () => {
  const clocks = makeClocks();
  const store = sdk.createInMemoryGetPutStore();
  const budget = sdk.createActionBudget({
    store,
    budgetId: 'f13-raw',
    prices: { export: 10 },
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  assert.equal(budget.mode, 'audit_only');
  for (const subject of ['old-1', 'old-2', 'old-3']) {
    const r = await budget.reserveAction({ subject, action: 'export' });
    assert.equal(r.allowed, true);
    await budget.commitAction(r.reservationId);
  }
  clocks.advanceReal(61_000);
  // Any persisting write after the roll prunes the stale windows in
  // the stored state itself.
  const fresh = await budget.reserveAction({ subject: 'fresh', action: 'export' });
  assert.equal(fresh.allowed, true);
  const raw = await store.get('antirea:action-budget:f13-raw');
  assert.equal(typeof raw, 'string');
  const persisted = JSON.parse(raw);
  assert.deepEqual(Object.keys(persisted.subjects), ['fresh']);
});

/* ------------------------------ F-06 ------------------------------ */
/*
 * F-06 - a corrupt or dead store must surface as a structured
 * `store_conflict` refusal from every public entry, never as a
 * SyntaxError/TypeError escaping into the host. The first test below
 * is the released tree's test, verbatim: 220
 * tests/action-budget.test.cjs test 11. The rest extend it to the
 * entries that test does not name (sweep, pacing writes) and to the
 * 2.7-only `flushOverrides`, plus a store whose reads throw outright.
 */

test('F-06: action budget: corrupt or dead store yields store_conflict, never throws (220 test 11, verbatim)', async () => {
  // Truncated JSON in a get/put store.
  const corrupt = sdk.createInMemoryGetPutStore();
  await corrupt.put('antirea:action-budget:default', '{"version":1,"subjects":');
  const budgetA = sdk.createActionBudget({ store: corrupt, prices: { export: 10 } });
  const reserveA = await budgetA.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(reserveA.allowed, false);
  assert.equal(reserveA.reason, 'store_conflict');
  const commitA = await budgetA.commitAction('act_1');
  assert.deepEqual(commitA, { committed: false, reason: 'store_conflict' });
  const releaseA = await budgetA.releaseAction('act_1');
  assert.equal(releaseA.released, false);
  assert.equal(releaseA.reason, 'store_conflict');
  const declareA = await budgetA.declareActionCohort({ cohortId: 'c1', subjects: ['account:a'], ceilingCostPerWindow: 100 });
  assert.equal(declareA.registered, 0);
  assert.equal(declareA.reason, 'store_conflict');
  const snapshotA = await budgetA.snapshot();
  assert.equal(snapshotA.storeError, 'store_conflict');

  // Valid JSON, wrong shape.
  const wrongShape = sdk.createInMemoryGetPutStore();
  await wrongShape.put('antirea:action-budget:default', '{"version":1}');
  const budgetB = sdk.createActionBudget({ store: wrongShape, prices: { export: 10 } });
  const reserveB = await budgetB.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(reserveB.allowed, false);
  assert.equal(reserveB.reason, 'store_conflict');

  // Corrupt content behind a TRANSACTIONAL store: its transactLedger
  // parses the same key the budget transacts under and would throw.
  const txStore = sdk.createInMemoryTransactionalStore();
  await txStore.put('antirea:ledger:action-budget:default', '{"version":1,"subjects":');
  const budgetC = sdk.createActionBudget({ store: txStore, prices: { export: 10 } });
  const reserveC = await budgetC.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(reserveC.allowed, false);
  assert.equal(reserveC.reason, 'store_conflict');
  const commitC = await budgetC.commitAction('act_1');
  assert.deepEqual(commitC, { committed: false, reason: 'store_conflict' });
});

test('F-06: wrong-shape JSON is refused by every entry, not just reserve (261 extension)', async () => {
  const wrongShape = sdk.createInMemoryGetPutStore();
  await wrongShape.put('antirea:action-budget:default', '{"version":1}');
  const budget = sdk.createActionBudget({ store: wrongShape, prices: { export: 10 } });

  const commit = await budget.commitAction('act_1');
  assert.deepEqual(commit, { committed: false, reason: 'store_conflict' });
  const release = await budget.releaseAction('act_1');
  assert.deepEqual(release, { released: false, reason: 'store_conflict' });
  const swept = await budget.sweepExpired();
  assert.deepEqual(swept, { expired: 0, reason: 'store_conflict' });
  const declare = await budget.declareActionCohort({ cohortId: 'c1', subjects: ['account:a'], ceilingCostPerWindow: 100 });
  assert.deepEqual(declare, { registered: 0, reason: 'store_conflict' });
  const pacing = await budget.setCohortPacing({ cohortKey: 'k1', subjects: ['account:a'], burst: 10, refillPerSecond: 1 });
  assert.deepEqual(pacing, { applied: false, reason: 'store_conflict' });
  const cleared = await budget.clearCohortPacing('k1');
  assert.deepEqual(cleared, { cleared: false, reason: 'store_conflict' });
  const snapshot = await budget.snapshot();
  assert.equal(snapshot.storeError, 'store_conflict');
  // The failed snapshot describes an EMPTY budget, clearly marked.
  assert.equal(snapshot.outstandingReservations, 0);
  assert.equal(snapshot.reservedCost, 0);
  assert.deepEqual(snapshot.subjects, {});
});

test('F-06: a store whose reads throw yields store_conflict from every entry, never throws', async () => {
  const deadGetPut = {
    supportsTransactions: false,
    get() { throw new Error('backend on fire'); },
    put() { throw new Error('backend on fire'); },
  };
  const budget = sdk.createActionBudget({ store: deadGetPut, prices: { export: 10 } });
  assert.equal(budget.mode, 'audit_only');
  const reserve = await budget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(reserve.allowed, false);
  assert.equal(reserve.reason, 'store_conflict');
  assert.deepEqual(await budget.commitAction('act_1'), { committed: false, reason: 'store_conflict' });
  assert.deepEqual(await budget.releaseAction('act_1'), { released: false, reason: 'store_conflict' });
  assert.deepEqual(await budget.sweepExpired(), { expired: 0, reason: 'store_conflict' });
  const declare = await budget.declareActionCohort({ cohortId: 'c1', subjects: ['account:a'], ceilingCostPerWindow: 100 });
  assert.deepEqual(declare, { registered: 0, reason: 'store_conflict' });
  const snapshot = await budget.snapshot();
  assert.equal(snapshot.storeError, 'store_conflict');
});

test('F-06: a transactional store whose transact throws yields store_conflict, never throws', async () => {
  const deadTx = {
    supportsTransactions: true,
    get() { return null; },
    put() {},
    async transactLedger() { throw new Error('backend on fire'); },
  };
  const budget = sdk.createActionBudget({ store: deadTx, prices: { export: 10 } });
  assert.equal(budget.mode, 'enforce');
  const reserve = await budget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(reserve.allowed, false);
  assert.equal(reserve.reason, 'store_conflict');
  assert.deepEqual(await budget.commitAction('act_1'), { committed: false, reason: 'store_conflict' });
  assert.deepEqual(await budget.releaseAction('act_1'), { released: false, reason: 'store_conflict' });
  const snapshot = await budget.snapshot();
  assert.equal(snapshot.storeError, 'store_conflict');
});

test('F-06 x flushOverrides (2.7-only entry): a corrupt store yields a structured flush result, never throws', async () => {
  const corrupt = sdk.createInMemoryGetPutStore();
  await corrupt.put('antirea:action-budget:default', '{"version":1,"subjects":');
  const budget = sdk.createActionBudget({ store: corrupt, prices: { export: 10 } });
  budget.setAllowanceOverride('subj', 5);
  const flushed = await budget.flushOverrides();
  assert.equal(flushed.flushed, 0, 'nothing was published to a corrupt store');
  assert.equal(flushed.reason, 'store_conflict');
});
