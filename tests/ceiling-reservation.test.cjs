const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/**
 * Declared-ceiling serve reservations (2.7.0, PREREG L1).
 *
 * `checkServe` is a check, not an atomic reservation: two concurrent
 * serves that both pass below the armed cap could jointly overshoot
 * it, because the union only grew on the host's later `observe`.
 * These tests pin the reservation discipline that closes the gap
 * for armed declared cohorts:
 *
 * - reserveServe checks AND tentatively holds in one synchronous
 *   step; pending holds count against the cap immediately (for
 *   reserveServe, checkServe and snapshots alike);
 * - commit finalizes without double-counting - including when the
 *   host also observes the same ids (before or after the commit);
 * - release and TTL expiry free a hold's ids;
 * - already-served ids count 0 new (re-delivery is free);
 * - non-armed cohorts are a no-op allow, protected subjects in
 *   inferred cohorts are never capped, and the armed cap binds
 *   with the same headroom rule checkServe uses.
 *
 * The parallel-load cell itself lives in the study harness
 * (v261/l1-cell.cjs); these are the unit-level hygiene bars.
 */

const ids = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const PRED = (min, max) => ({ field: 'id', min, max, domainMin: 0, domainMax: 10_000 });

const CEILING_MANIFEST = {
  modelVersion: 'cusum-1',
  calibrationVersion: 'host-fit-1',
  sampleSizes: { legit: 500, attack: 120 },
  holdout: { falsePositiveRate: 0.001, falseNegativeRate: 0.2 },
  method: 'trace-fitted LLR tables, LOAFO',
  attestedBy: 'host security team',
  issuedAtMs: 900_000,
  expiresAtMs: 9_000_000,
};
const STEP_DOWN_MANIFEST = {
  ...CEILING_MANIFEST,
  holdout: { falsePositiveRate: 0.2, falseNegativeRate: 0.2 },
};
const DECLARED = [['account:a', 'account:b', 'account:c', 'account:d']];

/** Armed tripwire over a mutable fake clock. Limit 50, TTL 1s unless overridden. */
function armedTripwire(extra = {}) {
  const clock = { nowMs: 1_000_000 };
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    ceiling: { limit: 50 },
    declaredCohorts: DECLARED,
    manifest: CEILING_MANIFEST,
    ceilingReservation: { ttlMs: 1_000 },
    now: () => clock.nowMs,
    ...extra,
  });
  return { tw, clock };
}

/** Evidence-free serve: the CUSUM score cannot move, so any refusal is the cap. */
async function feedPlain(tw, identity, from, count, ts) {
  return tw.observe({ type: 'page_view', identity, recordIds: ids(from, count), ts });
}

test('reservation: pending holds count against the armed cap immediately - second reserver gets only the headroom', async () => {
  const { tw } = armedTripwire();
  const first = tw.reserveServe('account:a', ids(0, 30));
  assert.equal(first.newRecords, 30);
  assert.deepEqual(first.allowed, ids(0, 30));
  assert.ok(first.reservationId);
  assert.equal(first.reason, undefined);

  // Nothing has been served or observed yet, but the cap already sees 30.
  const snapPending = await tw.snapshotFor('account:a');
  assert.equal(snapPending.unionRecords, 30);
  assert.equal(snapPending.reservedRecords, 30);

  const second = tw.reserveServe('account:b', ids(100, 30));
  assert.equal(second.newRecords, 20, 'only the remaining headroom is granted');
  assert.deepEqual(second.allowed, ids(100, 20));
  assert.equal(second.reason, 'campaign_ceiling');

  // Cap full on holds alone: a third reserver and checkServe both refuse.
  const third = tw.reserveServe('account:c', ids(200, 5));
  assert.deepEqual(third.allowed, []);
  assert.equal(third.newRecords, 0);
  assert.equal(third.reservationId, undefined);
  assert.equal(third.reason, 'campaign_ceiling');
  const gated = await tw.checkServe('account:d', 1);
  assert.equal(gated.allowed, 0);
  assert.equal(gated.reason, 'campaign_ceiling');
});

test('reservation: release frees its ids - they can be reserved and served after', async () => {
  const { tw } = armedTripwire();
  const held = tw.reserveServe('account:a', ids(0, 50));
  assert.equal(held.newRecords, 50);
  assert.equal(tw.reserveServe('account:b', ids(100, 1)).allowed.length, 0);

  assert.deepEqual(tw.releaseServe(held.reservationId), { released: true });
  assert.equal((await tw.snapshotFor('account:a')).unionRecords, 0);
  assert.equal((await tw.snapshotFor('account:a')).reservedRecords, 0);

  const after = tw.reserveServe('account:b', ids(100, 50));
  assert.equal(after.newRecords, 50);
  assert.deepEqual(after.allowed, ids(100, 50));

  // Double release and unknown ids are reported, not silently ok.
  assert.equal(tw.releaseServe(held.reservationId).released, false);
  assert.equal(tw.releaseServe('srv_9999').released, false);
});

test('reservation: an expired (TTL) reservation frees its ids without a commit', async () => {
  const { tw, clock } = armedTripwire();
  const held = tw.reserveServe('account:a', ids(0, 50));
  assert.equal(held.newRecords, 50);

  clock.nowMs += 1_001; // past the 1s TTL
  const after = tw.reserveServe('account:b', ids(100, 50));
  assert.equal(after.newRecords, 50, 'the expired hold no longer counts');
  assert.deepEqual(after.allowed, ids(100, 50));

  // Committing the expired reservation is REFUSED with the named
  // reason and counts nothing (Argon TTL attack response).
  const late = tw.commitServe(held.reservationId);
  assert.equal(late.committed, false);
  assert.equal(late.reason, 'reservation_expired');
  assert.equal((await tw.snapshotFor('account:b')).unionRecords, 50, 'only the live hold counts');
});

test('reservation: commit after TTL expiry is refused (reservation_expired) and counts nothing', async () => {
  const { tw, clock } = armedTripwire();
  const held = tw.reserveServe('account:a', ids(0, 50));
  assert.equal(held.newRecords, 50);
  clock.nowMs += 1_001; // TTL passes with no commit and no second reserver
  const refused = tw.commitServe(held.reservationId);
  assert.equal(refused.committed, false);
  assert.equal(refused.reason, 'reservation_expired');
  const snap = await tw.snapshotFor('account:a');
  assert.equal(snap.unionRecords, 0, 'the refused commit resurrected nothing');
  assert.equal(snap.reservedRecords, 0);
  // A never-seen id is a different refusal than an expired one.
  assert.equal(tw.commitServe('srv_424242').reason, 'unknown_reservation');
});

test('reservation: commit after release is refused (reservation_released) and counts nothing', async () => {
  const { tw } = armedTripwire();
  const held = tw.reserveServe('account:a', ids(0, 50));
  assert.deepEqual(tw.releaseServe(held.reservationId), { released: true });
  const refused = tw.commitServe(held.reservationId);
  assert.equal(refused.committed, false);
  assert.equal(refused.reason, 'reservation_released');
  assert.equal((await tw.snapshotFor('account:a')).unionRecords, 0);
  // Releasing twice reports the settlement, not success.
  const again = tw.releaseServe(held.reservationId);
  assert.equal(again.released, false);
  assert.equal(again.reason, 'reservation_released');
});

test('reservation: an expired hold frees capacity for a DIFFERENT id set - accounting stays exact', async () => {
  const { tw, clock } = armedTripwire();
  const stale = tw.reserveServe('account:a', ids(0, 50));
  assert.equal(stale.newRecords, 50);
  clock.nowMs += 1_001; // stale hold expires while its serve is "in flight"
  // A different identity reserving a disjoint set legitimately takes the freed cap.
  const fresh = tw.reserveServe('account:b', ids(100, 50));
  assert.equal(fresh.newRecords, 50);
  assert.deepEqual(fresh.allowed, ids(100, 50));
  assert.equal(tw.commitServe(fresh.reservationId).committed, true);
  // The stale commit is refused and cannot push the union to 100.
  const late = tw.commitServe(stale.reservationId);
  assert.equal(late.committed, false);
  assert.equal(late.reason, 'reservation_expired');
  const snap = await tw.snapshotFor('account:b');
  assert.equal(snap.unionRecords, 50, 'exactly the live set - the expired hold counts nothing');
});

test('reservation: TTL hazard is a host contract breach, not an SDK failure - a late observe is recorded telemetry', async () => {
  // Argon attack shape: hold expires mid-serve, the freed capacity is
  // re-granted for different ids, then the first serve completes and
  // observes anyway. The SDK records what was actually served (the
  // union passes the cap, the decision reports campaign_engaged) -
  // the cap's promise covers serves inside a LIVE reservation only
  // (see the TTL CONTRACT in the source header).
  const { tw, clock } = armedTripwire();
  const stale = tw.reserveServe('account:a', ids(0, 50));
  clock.nowMs += 1_001;
  const fresh = tw.reserveServe('account:b', ids(100, 50));
  assert.equal(tw.commitServe(fresh.reservationId).committed, true);
  await feedPlain(tw, 'account:b', 100, 50, clock.nowMs);
  const breach = await feedPlain(tw, 'account:a', 0, 50, clock.nowMs);
  assert.equal(breach.action, 'campaign_engaged', 'the late serve is recorded, not hidden');
  assert.equal((await tw.snapshotFor('account:a')).unionRecords, 100);
  // The same-record variant can never overshoot: re-serving ids that
  // are already counted is a set-union no-op.
  const again = tw.reserveServe('account:c', ids(100, 10));
  assert.equal(again.newRecords, 0);
});

test('reservation: TTL is configurable - a longer TTL keeps the hold', async () => {
  const { tw, clock } = armedTripwire({ ceilingReservation: { ttlMs: 60_000 } });
  const held = tw.reserveServe('account:a', ids(0, 50));
  clock.nowMs += 5_000;
  assert.equal(tw.reserveServe('account:b', ids(100, 1)).allowed.length, 0);
  assert.equal(tw.commitServe(held.reservationId).committed, true);
});

test('reservation: double commit does not double-count, and observe after commit counts once (the contract)', async () => {
  const { tw } = armedTripwire();
  const held = tw.reserveServe('account:a', ids(0, 20));
  assert.deepEqual(tw.commitServe(held.reservationId), { committed: true });
  const again = tw.commitServe(held.reservationId);
  assert.equal(again.committed, true);
  assert.equal(again.duplicate, true);
  assert.equal((await tw.snapshotFor('account:a')).unionRecords, 20, 'second commit added nothing');

  // The host's normal post-serve observe of the same ids: no double count.
  await feedPlain(tw, 'account:a', 0, 20, 1_000_000);
  const snap = await tw.snapshotFor('account:a');
  assert.equal(snap.unionRecords, 20);
  assert.equal(snap.reservedRecords, 0, 'the served copy now carries the ids');

  // A committed reservation cannot be released back open.
  assert.equal(tw.releaseServe(held.reservationId).released, false);
  assert.equal((await tw.snapshotFor('account:a')).unionRecords, 20);
});

test('reservation: observe BEFORE commit also counts once - pending hold and served copy share the union', async () => {
  const { tw } = armedTripwire();
  const held = tw.reserveServe('account:a', ids(0, 20));
  await feedPlain(tw, 'account:a', 0, 20, 1_000_000);
  assert.equal((await tw.snapshotFor('account:a')).unionRecords, 20, 'not 40: the union is a set union');
  assert.equal(tw.commitServe(held.reservationId).committed, true);
  assert.equal((await tw.snapshotFor('account:a')).unionRecords, 20);
});

test('reservation: release after an observe cannot un-serve - served ids stay counted', async () => {
  const { tw } = armedTripwire();
  const held = tw.reserveServe('account:a', ids(0, 20));
  await feedPlain(tw, 'account:a', 0, 20, 1_000_000);
  assert.deepEqual(tw.releaseServe(held.reservationId), { released: true });
  assert.equal((await tw.snapshotFor('account:a')).unionRecords, 20, 'release un-holds, it cannot un-serve');
});

test('reservation: reserving ids already served counts 0 new and holds nothing', async () => {
  const { tw } = armedTripwire();
  await feedPlain(tw, 'account:a', 0, 20, 1_000_000);

  const redelivery = tw.reserveServe('account:b', ids(0, 20));
  assert.equal(redelivery.newRecords, 0);
  assert.equal(redelivery.reservationId, undefined);
  assert.deepEqual(redelivery.allowed, ids(0, 20), 're-delivery is free and fully allowed');

  // Mixed request: old ids ride free, only the new ones count and hold.
  const mixed = tw.reserveServe('account:b', [...ids(0, 20), ...ids(100, 10)]);
  assert.equal(mixed.newRecords, 10);
  assert.deepEqual(mixed.allowed, [...ids(0, 20), ...ids(100, 10)]);
  assert.equal((await tw.snapshotFor('account:a')).unionRecords, 30);
});

test('reservation: duplicate ids inside one request are deduped before counting', async () => {
  const { tw } = armedTripwire();
  const res = tw.reserveServe('account:a', [7, 7, 7, 8, 8]);
  assert.equal(res.newRecords, 2);
  assert.deepEqual(res.allowed, [7, 8]);
});

test('reservation: non-armed cohorts are a no-op allow - declared without ceiling manifest, undeclared, outsider', async () => {
  for (const manifest of [null, STEP_DOWN_MANIFEST]) {
    const tw = sdk.createCusumTripwire({
      mode: 'enforce', alpha: 0.05, ceiling: { limit: 50 },
      declaredCohorts: DECLARED, manifest, now: () => 1_000_000,
    });
    const res = tw.reserveServe('account:a', ids(0, 100));
    assert.deepEqual(res.allowed, ids(0, 100), 'past the nominal limit, still a no-op allow');
    assert.equal(res.newRecords, 0);
    assert.equal(res.reservationId, undefined);
    assert.equal((await tw.snapshotFor('account:a')).unionRecords, 0, 'a no-op holds nothing');
  }
  const { tw } = armedTripwire();
  const outsider = tw.reserveServe('account:outsider', ids(0, 100));
  assert.deepEqual(outsider.allowed, ids(0, 100));
  assert.equal(outsider.newRecords, 0);
});

test('reservation: observe mode is a no-op allow even for an armed declaration', async () => {
  const tw = sdk.createCusumTripwire({
    mode: 'observe', alpha: 0.05, ceiling: { limit: 50 },
    declaredCohorts: DECLARED, manifest: CEILING_MANIFEST, now: () => 1_000_000,
  });
  const res = tw.reserveServe('account:a', ids(0, 100));
  assert.deepEqual(res.allowed, ids(0, 100));
  assert.equal(res.newRecords, 0);
  assert.equal(res.reservationId, undefined);
});

test('reservation: inferred cohorts are never capped by reservations - the crossing-gated ceiling stays checkServe-only', async () => {
  const tw = sdk.createCusumTripwire({
    mode: 'enforce', alpha: 0.05, ceiling: { limit: 50 },
    manifest: CEILING_MANIFEST, now: () => 1_000_000,
  });
  // Form + cross an inferred cohort (the declared-ceiling test's shape).
  await feedPlain(tw, 'account:a', 0, 20, 1_000_000);
  await feedPlain(tw, 'account:b', 100, 20, 1_000_100);
  await feedPlain(tw, 'account:c', 200, 15, 1_000_200);
  const ranges = [[0, 1000], [1005, 2000], [2010, 3000], [3010, 4000]];
  const names = ['a', 'b', 'c', 'd'];
  let last;
  for (let i = 0; i < 4; i++) {
    last = await tw.observe({
      type: 'list', identity: `account:${names[i]}`,
      predicate: PRED(ranges[i][0], ranges[i][1]), recordIds: ids(ranges[i][0], 40), ts: 1_001_000 + i * 100,
    });
  }
  assert.equal(last.action, 'campaign_engaged');
  const snap = await tw.snapshotFor('account:a');
  assert.equal(snap.ceilingArmed, false);
  assert.equal(snap.ceilingActive, true);
  // checkServe enforces the engaged ceiling...
  assert.equal((await tw.checkServe('account:a', 1)).allowed, 0);
  // ...but reserveServe is scoped to ARMED declared cohorts: no-op allow.
  const res = tw.reserveServe('account:a', ids(5000, 10));
  assert.deepEqual(res.allowed, ids(5000, 10));
  assert.equal(res.newRecords, 0);
  assert.equal(res.reservationId, undefined);
});

test('reservation: a protected subject in an inferred cohort is never capped (reserve or check)', async () => {
  const registry = sdk.createProtectedCohortRegistry();
  registry.declareProtected(['account:comp1'], { reason: 'quarterly compliance review' });
  const tw = sdk.createCusumTripwire({
    mode: 'enforce', alpha: 0.05, ceiling: { limit: 50 },
    manifest: CEILING_MANIFEST,
    declaredCohorts: [['account:x', 'account:y']],
    isProtected: id => registry.isProtected(id),
    now: () => 1_000_000,
  });
  const ranges = [[0, 1000], [1005, 2000], [2010, 3000], [3010, 4000]];
  const names = ['comp1', 'b', 'c', 'd'];
  for (let i = 0; i < 4; i++) {
    await tw.observe({
      type: 'list', identity: `account:${names[i]}`,
      predicate: PRED(ranges[i][0], ranges[i][1]), recordIds: ids(ranges[i][0], 40), ts: 1_000_000 + i * 100,
    });
  }
  const snap = await tw.snapshotFor('account:comp1');
  assert.equal(snap.ceilingActive, true);
  assert.deepEqual(snap.protectedMembers, ['account:comp1']);
  assert.deepEqual(await tw.checkServe('account:comp1', 10), { allowed: 10 });
  const res = tw.reserveServe('account:comp1', ids(5000, 10));
  assert.deepEqual(res.allowed, ids(5000, 10));
  assert.equal(res.newRecords, 0);
  // The unprotected cohort-mate is still refused by checkServe.
  assert.equal((await tw.checkServe('account:b', 1)).allowed, 0);
});

test('reservation: full reserve-serve-commit-observe flow lands the union exactly on the cap', async () => {
  const { tw } = armedTripwire();
  // a serves 20, b serves 20, c asks for 25 and is granted the 10 headroom.
  for (const [identity, from, count] of [['account:a', 0, 20], ['account:b', 100, 20]]) {
    const res = tw.reserveServe(identity, ids(from, count));
    assert.equal(res.newRecords, count);
    await feedPlain(tw, identity, from, res.allowed.length, 1_000_000);
    assert.equal(tw.commitServe(res.reservationId).committed, true);
  }
  const capped = tw.reserveServe('account:c', ids(200, 25));
  assert.equal(capped.newRecords, 10);
  assert.equal(capped.reason, 'campaign_ceiling');
  await feedPlain(tw, 'account:c', 200, capped.allowed.length, 1_000_100);
  assert.equal(tw.commitServe(capped.reservationId).committed, true);

  const snap = await tw.snapshotFor('account:a');
  assert.equal(snap.unionRecords, 50, 'exactly the declared limit, no overshoot');
  assert.equal(snap.reservedRecords, 0);
  assert.equal(tw.reserveServe('account:d', ids(300, 1)).allowed.length, 0);
  assert.equal((await tw.checkServe('account:d', 1)).allowed, 0);
});
