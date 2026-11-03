const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/**
 * Regression tests for the 2.7.0 pre-release audit port into the
 * disclosure ledger (audit 2026-11-03, findings F-01 / F-06 / F-07 /
 * F-12 + the L-DEEP-2 hybrid clock rule for this module).
 *
 * The F-01, F-06 and F-07 tests below are copied VERBATIM from the
 * released tree's tests/disclosure-ledger.test.cjs (antirea-220,
 * 2.6.3) - the tests that shipped with the fixes being ported. The
 * monotonic-TTL test is copied verbatim from the released tree's
 * tests/mono-clock.test.cjs. The F-12 tests and the wall-first
 * hybrid test are NEW: the released ledger never cleaned
 * idempotency keys on commit/release (F-12 was still open there),
 * so no released test exists for them; they mirror the audit
 * harness regress-h2.cjs, which read the raw stored state and found
 * 25 orphaned idempotency keys over 0 reservations.
 */

const ids = (from, count) => Array.from({ length: count }, (_, i) => from + i);

function enforceLedger(overrides = {}) {
  return sdk.createDisclosureLedger({
    store: sdk.createInMemoryTransactionalStore(),
    ceilingLimit: 100,
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
    ...overrides,
  });
}

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

test('ledger: idempotency replay with a different subject or payload is refused (F-01)', async () => {
  const ledger = enforceLedger();
  await ledger.declareRegistry(['account:a']);
  const first = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 4), idempotencyKey: 'k-1' });
  assert.equal(first.allowed, true);

  // Audit harness V1: an UNREGISTERED stranger replays the key with
  // completely different record ids. Pre-fix this returned
  // allowed:true + duplicate:true and charged the victim's union.
  const stranger = await ledger.reserveDisclosure({ subject: 'account:stranger', recordIds: ids(500, 4), idempotencyKey: 'k-1' });
  assert.equal(stranger.allowed, false);
  assert.equal(stranger.reason, 'idempotency_conflict');

  // Same subject, different ids: also a conflict, never a duplicate.
  const otherIds = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(500, 4), idempotencyKey: 'k-1' });
  assert.equal(otherIds.allowed, false);
  assert.equal(otherIds.reason, 'idempotency_conflict');

  // Same subject and ids, different count-only amount: conflict.
  const otherCount = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 4), count: 3, idempotencyKey: 'k-1' });
  assert.equal(otherCount.allowed, false);
  assert.equal(otherCount.reason, 'idempotency_conflict');

  // The exact replay is still honored as a duplicate, charged once.
  const dupe = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 4), idempotencyKey: 'k-1' });
  assert.equal(dupe.allowed, true);
  assert.equal(dupe.duplicate, true);
  assert.equal(dupe.reservationId, first.reservationId);

  // Committing the original reservation charges A's ids only.
  const commit = await ledger.commitReservation(first.reservationId);
  assert.equal(commit.committed, true);
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.committedRecords, 4);
});

test('ledger: corrupt or dead store yields store_conflict refusals, never throws (F-06)', async () => {
  // Truncated JSON in a get/put store (audit harness H1-9b).
  const truncated = sdk.createInMemoryGetPutStore();
  await truncated.put('antirea:ledger:default', '{"version":1,"reservations":');
  const ledgerA = sdk.createDisclosureLedger({ store: truncated, ceilingLimit: 100 });
  const reserveA = await ledgerA.reserveDisclosure({ subject: 'account:a', recordIds: [1, 2] });
  assert.equal(reserveA.allowed, false);
  assert.equal(reserveA.reason, 'store_conflict');
  const commitA = await ledgerA.commitReservation('res_1');
  assert.deepEqual(commitA, { committed: false, reason: 'store_conflict' });
  const releaseA = await ledgerA.releaseReservation('res_1');
  assert.equal(releaseA.released, false);
  assert.equal(releaseA.reason, 'store_conflict');
  const snapshotA = await ledgerA.snapshot();
  assert.equal(snapshotA.storeError, 'store_conflict');
  const declareA = await ledgerA.declareRegistry(['account:a']);
  assert.equal(declareA.registered, 0);
  assert.equal(declareA.reason, 'store_conflict');
  const completenessA = await ledgerA.checkRegistryCompleteness(['account:a']);
  assert.equal(completenessA.storeError, 'store_conflict');
  const sweepA = await ledgerA.sweepExpired();
  assert.equal(sweepA.expired, 0);
  assert.equal(sweepA.reason, 'store_conflict');

  // Valid JSON, wrong shape (audit harness H1-9b2).
  const wrongShape = sdk.createInMemoryGetPutStore();
  await wrongShape.put('antirea:ledger:default', '{"version":1}');
  const ledgerB = sdk.createDisclosureLedger({ store: wrongShape, ceilingLimit: 100 });
  const reserveB = await ledgerB.reserveDisclosure({ subject: 'account:a', recordIds: [1, 2] });
  assert.equal(reserveB.allowed, false);
  assert.equal(reserveB.reason, 'store_conflict');

  // Corrupt content behind a TRANSACTIONAL store: reading it back for
  // the transaction would throw; the ledger must still refuse cleanly.
  const txStore = sdk.createInMemoryTransactionalStore();
  await txStore.put('antirea:ledger:default', '{"version":1,"reservations":');
  const ledgerC = sdk.createDisclosureLedger({ store: txStore, ceilingLimit: 100 });
  const reserveC = await ledgerC.reserveDisclosure({ subject: 'account:a', recordIds: [1, 2] });
  assert.equal(reserveC.allowed, false);
  assert.equal(reserveC.reason, 'store_conflict');

  // A store whose reads throw outright (dead backend).
  const deadStore = {
    supportsTransactions: false,
    get() { throw new Error('store backend down'); },
    put() { throw new Error('store backend down'); },
  };
  const ledgerD = sdk.createDisclosureLedger({ store: deadStore, ceilingLimit: 100 });
  const reserveD = await ledgerD.reserveDisclosure({ subject: 'account:a', recordIds: [1, 2] });
  assert.equal(reserveD.allowed, false);
  assert.equal(reserveD.reason, 'store_conflict');
});

test('ledger: extreme record ids stay sparse, fast, and never throw (F-07)', async () => {
  const store = sdk.createInMemoryTransactionalStore();
  const ledger = sdk.createDisclosureLedger({
    store,
    ceilingLimit: 100_000,
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
    reservation: { maxOutstandingPerSubject: 10 },
  });
  const started = Date.now();
  const big = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: [100_000_000] });
  const elapsedMs = Date.now() - started;
  assert.equal(big.allowed, true);
  const raw = await store.get('antirea:ledger:default');
  // Pre-fix (audit harness H1-10a) this single reservation serialized
  // to 16,670,239 bytes and took 1,439ms of synchronous work.
  assert.ok(raw.length < 20_000, `state stayed sparse (${raw.length} bytes)`);
  assert.ok(elapsedMs < 1_000, `reserve stayed fast (${elapsedMs}ms)`);

  // The id that used to throw RangeError out of reserveDisclosure.
  const extreme = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: [2 ** 53 - 1] });
  assert.equal(extreme.allowed, true);
  // A snowflake-scale id from an imported dataset.
  const snowflake = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: [1_234_567_890_123_456_780] });
  assert.equal(snowflake.allowed, true);

  await ledger.commitReservation(big.reservationId);
  await ledger.commitReservation(extreme.reservationId);
  await ledger.commitReservation(snowflake.reservationId);
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.committedRecords, 3);
});

test('ledger: pre-fix dense bitmap state still decodes (F-07 compatibility)', async () => {
  // Hand-built state in the <= 2.6.0 dense format: union bitmap byte
  // 0b00001010 means ids {1, 3} were served.
  const legacyState = {
    version: 3,
    unionBitmap: Buffer.from([0b0000_1010]).toString('base64url'),
    anonymousServed: 0,
    reservations: {},
    bucket: { tokens: 1000, lastRefillMs: 0, burst: 1000, refillPerSecond: 1000 },
    evidence: {},
    idempotency: {},
    registry: null,
    nextReservationSeq: 1,
  };
  const store = sdk.createInMemoryGetPutStore();
  await store.put('antirea:ledger:default', JSON.stringify(legacyState));
  const ledger = sdk.createDisclosureLedger({ store, ceilingLimit: 100 });
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.committedRecords, 2);
  // Re-delivery of already-served ids is free; a new id is charged once.
  const again = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: [1, 3] });
  assert.equal(again.allowed, true);
  assert.equal(again.newRecords, 0);
  const fresh = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: [3, 4] });
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.newRecords, 1);
  await ledger.commitReservation(fresh.reservationId);
  const after = await ledger.snapshot();
  assert.equal(after.committedRecords, 3);
  // After the commit the stored union uses the sparse format.
  const raw = await store.get('antirea:ledger:default');
  assert.match(raw, /"unionBitmap":"s1\./);
});

test('ledger: commit removes the idempotency key with its reservation (F-12)', async () => {
  // Audit harness regress-h2: 25 reserve+commit cycles with distinct
  // keys left 25 orphaned keys over 0 reservations pre-fix, because
  // commit deleted only the reservation. The key must die with it.
  const store = sdk.createInMemoryTransactionalStore();
  const ledger = enforceLedger({ store });
  for (let i = 0; i < 25; i++) {
    const held = await ledger.reserveDisclosure({
      subject: 'account:a', recordIds: ids(i * 10, 2), idempotencyKey: `key-${i}`,
    });
    assert.equal(held.allowed, true);
    const commit = await ledger.commitReservation(held.reservationId);
    assert.equal(commit.committed, true);
  }
  const raw = await store.get('antirea:ledger:default');
  const state = JSON.parse(raw);
  assert.equal(Object.keys(state.reservations).length, 0);
  assert.equal(Object.keys(state.idempotency).length, 0);
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.outstandingReservations, 0);
  assert.equal(snapshot.committedRecords, 50);
});

test('ledger: release removes the idempotency key with its reservation (F-12)', async () => {
  // Same leak through the release path: releasing a reservation must
  // also drop its idempotency key, not leave it pointing at nothing.
  const store = sdk.createInMemoryTransactionalStore();
  const ledger = enforceLedger({ store });
  for (let i = 0; i < 25; i++) {
    const held = await ledger.reserveDisclosure({
      subject: 'account:a', recordIds: ids(i * 10, 2), idempotencyKey: `key-${i}`,
    });
    assert.equal(held.allowed, true);
    const release = await ledger.releaseReservation(held.reservationId);
    assert.equal(release.released, true);
  }
  const raw = await store.get('antirea:ledger:default');
  const state = JSON.parse(raw);
  assert.equal(Object.keys(state.reservations).length, 0);
  assert.equal(Object.keys(state.idempotency).length, 0);
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.outstandingReservations, 0);
  assert.equal(snapshot.committedRecords, 0);
});

test('disclosure ledger: a reservation created by this process dies at its monotonic TTL', async () => {
  const clocks = makeClocks();
  const ledger = sdk.createDisclosureLedger({
    store: sdk.createInMemoryTransactionalStore(),
    ceilingLimit: 1000,
    reservation: { ttlMs: 60_000 },
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  const reserved = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: [1, 2, 3] });
  assert.equal(reserved.allowed, true);

  clocks.stepWall(-300_000); // wall expiry (t0 + 60 s) is now 5 min in the wall future
  clocks.advanceReal(61_000); // but the TTL has fully elapsed in real time

  const swept = await ledger.sweepExpired();
  assert.equal(swept.expired, 1);
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.outstandingReservations, 0);
});

test('disclosure ledger: a reservation also dies at its wall expiry when the wall clock steps forward first (L-DEEP-2 hybrid)', async () => {
  // The hybrid rule is "whichever comes first": the monotonic TTL
  // (previous test) OR the persisted wall expiry. Here almost no
  // monotonic time passes, but the wall clock steps past expiresAtMs,
  // so the reservation must still die - the wall deadline is shared
  // across processes and cannot be ignored.
  const clocks = makeClocks();
  const ledger = sdk.createDisclosureLedger({
    store: sdk.createInMemoryTransactionalStore(),
    ceilingLimit: 1000,
    reservation: { ttlMs: 60_000 },
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  const reserved = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: [1, 2, 3] });
  assert.equal(reserved.allowed, true);

  clocks.stepWall(300_000); // wall jumps +5 min; monotonic time is unchanged

  const swept = await ledger.sweepExpired();
  assert.equal(swept.expired, 1);
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.outstandingReservations, 0);
});
