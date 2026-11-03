const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/*
 * Audit-port regression tests for the CUSUM tripwire: the wave-2
 * fixes F-08..F-11 ported from the released 2.6.3 tree
 * (~/workspace/antirea-220/tests/audit-wave2.test.cjs - the F-08..
 * F-11 tests below are that file's, verbatim), plus the fixes that
 * exist only in this tree:
 *
 *   F-16 cusum observe() did not validate its event: a missing
 *        identity filed state under a shared `undefined` key and
 *        observe(null) threw a bare TypeError (harness-verify V6);
 *        the ts-NaN variant (h5/h6 H2-3) poisoned flaggedAtMs so
 *        epoch rotation never fired. 220 never patched F-16 - the
 *        contract chosen here is a structured no-op decision (the
 *        exempt decision's shape), no throw, no state mutation.
 *   CLK  bucket refill follows the monotonic clock (L-DEEP-2 cusum
 *        tests from 220's mono-clock.test.cjs).
 *   CLK-2 serve reservations (2.7.0-only code): the TTL was pure
 *        wall clock, so a +61 s wall step freed a full declared
 *        ceiling hold after ~0 ms of real time and a second hold
 *        overshot the cap 2x (audit repro-ldeep-reserve part 2).
 *        The TTL is now measured on the monotonic clock.
 */

const ids = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const PRED = (min, max) => ({ field: 'id', min, max, domainMin: 0, domainMax: 10_000 });

/** Four identities slicing abutting ranges (the suite's standard
 *  adjacency-driven crossing; union at crossing = 160 >= floor 150). */
async function feedSlicers(tw, ts = 1_000_000) {
  const decisions = [];
  decisions.push(await tw.observe({ type: 'list', identity: 'account:a', predicate: PRED(0, 1000), recordIds: ids(0, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:b', predicate: PRED(1005, 2000), recordIds: ids(1005, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:c', predicate: PRED(2010, 3000), recordIds: ids(2010, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:d', predicate: PRED(3010, 4000), recordIds: ids(3010, 40), ts }));
  return decisions;
}

/* ------------------------------ F-08 ------------------------------ */

test('F-08: a throwing onCampaignFlag neither rejects observe nor loses the flag', async () => {
  const delivered = [];
  let calls = 0;
  const tw = sdk.createCusumTripwire({
    mode: 'observe',
    alpha: 0.05,
    onCampaignFlag: snap => {
      calls++;
      if (calls === 1) throw new Error('host callback bug');
      delivered.push(snap);
    },
  });
  // Pre-fix, the crossing observe rejected with the host's error.
  const decisions = await feedSlicers(tw);
  assert.equal(decisions[decisions.length - 1].crossed, true);
  assert.equal(delivered.length, 0, 'the first delivery attempt threw');
  // The next observe of a cohort member retries and delivers.
  await tw.observe({ type: 'list', identity: 'account:a', recordIds: ids(5000, 3), ts: 1_000_100 });
  assert.equal(delivered.length, 1, 'retest bar: the flag IS delivered at the next observe');
  assert.equal(delivered[0].flagged, true);
  assert.ok(delivered[0].members.includes('account:a'));
});

test('F-08: a pending flag is also delivered by the next snapshot read', async () => {
  const delivered = [];
  let fail = true;
  const tw = sdk.createCusumTripwire({
    mode: 'observe',
    alpha: 0.05,
    onCampaignFlag: snap => {
      if (fail) throw new Error('host callback bug');
      delivered.push(snap);
    },
  });
  await feedSlicers(tw);
  assert.equal(delivered.length, 0);
  fail = false;
  const snapshot = await tw.snapshotFor('account:a');
  assert.equal(snapshot.flagged, true);
  assert.equal(delivered.length, 1, 'snapshotFor retried the pending delivery');
});

test('F-08: throwing isProtected / isExempt predicates behave as absent predicates', async () => {
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    isProtected: () => { throw new Error('host bug'); },
  });
  const decisions = await feedSlicers(tw);
  // Treated as "not protected": the crossing consequence is NOT
  // suppressed (pre-fix, observe/checkServe threw the host's error).
  assert.equal(decisions[decisions.length - 1].action, 'step_up');
  const snapshot = await tw.snapshotFor('account:a');
  assert.deepEqual(snapshot.protectedMembers, []);
  const serve = await tw.checkServe('account:a', 5);
  assert.equal(serve.allowed, 5);

  const tw2 = sdk.createCusumTripwire({
    alpha: 0.05,
    isExempt: () => { throw new Error('host bug'); },
  });
  const decisions2 = await feedSlicers(tw2);
  assert.equal(decisions2[decisions2.length - 1].crossed, true, 'a throwing isExempt does not exempt anyone');
});

/* ------------------------------ F-09 ------------------------------ */

test('F-09: checkServe(NaN) is refused and the cohort bucket stays healthy (audit H2-5 sequence)', async () => {
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    now: () => 1_000_000,
    monoNow: () => 7_000,
  });
  await feedSlicers(tw);
  const ok1 = await tw.checkServe('account:a', 10);
  assert.equal(ok1.allowed, 10);
  const poison = await tw.checkServe('account:a', NaN);
  assert.equal(poison.allowed, 0);
  assert.equal(poison.reason, 'invalid_request');
  assert.equal(typeof poison.cohortId, 'string');
  for (const bad of [-5, Infinity, -Infinity]) {
    const r = await tw.checkServe('account:a', bad);
    assert.equal(r.allowed, 0);
    assert.equal(r.reason, 'invalid_request');
  }
  // Retest bar: after ok -> NaN -> ok, the third request is healthy.
  const ok2 = await tw.checkServe('account:a', 10);
  assert.equal(ok2.allowed, 10, 'the bucket was not poisoned by the NaN call');
  const snapshot = await tw.snapshotFor('account:a');
  assert.equal(snapshot.bucketTokens, 130, 'exactly the two valid debits left the bucket (150 - 10 - 10)');
  // An invalid request from an identity with no cohort is refused too.
  const nobody = await tw.checkServe('account:nobody', NaN);
  assert.equal(nobody.allowed, 0);
  assert.equal(nobody.reason, 'invalid_request');
  assert.equal(nobody.cohortId, undefined);
  // clearCohort is a real recovery path now: it restores a full bucket.
  await tw.clearCohort(snapshot.cohortId);
  const cleared = await tw.snapshotFor('account:a');
  assert.equal(cleared.bucketTokens, 150, 'clearCohort resets the pacing bucket to burst');
});

/* ------------------------------ F-10 ------------------------------ */

test('F-10: identity state is capped; an active cohort survives churn (LRU)', async () => {
  const tw = sdk.createCusumTripwire({ mode: 'observe', alpha: 0.05, maxIdentities: 10 });
  await tw.observe({ type: 'list', identity: 'account:a', predicate: PRED(0, 1000), recordIds: ids(0, 40), ts: 1_000_000 });
  await tw.observe({ type: 'list', identity: 'account:b', predicate: PRED(1005, 2000), recordIds: ids(1005, 40), ts: 1_000_000 });
  let snapshot = await tw.snapshotFor('account:a');
  assert.ok(snapshot, 'the slicer pair formed a cohort');
  // Churn 30 singleton identities past the cap of 10, keeping the
  // cohort members active so LRU must retain them.
  for (let i = 0; i < 30; i++) {
    await tw.observe({ type: 'search', identity: `churn:${i}`, ts: 1_000_100 + i });
    if (i % 3 === 0) {
      await tw.observe({ type: 'list', identity: 'account:a', recordIds: ids(0, 1), ts: 1_000_100 + i });
      await tw.observe({ type: 'list', identity: 'account:b', recordIds: ids(1005, 1), ts: 1_000_100 + i });
    }
  }
  snapshot = await tw.snapshotFor('account:a');
  assert.ok(snapshot, 'retest bar: the ACTIVE cohort was not evicted');
  assert.deepEqual(snapshot.members, ['account:a', 'account:b']);
  assert.equal(snapshot.stateSizes.identities, 10, 'state size stays at the cap after 32 identities');
  assert.ok(snapshot.stateSizes.cohorts >= 1);
  assert.equal(typeof snapshot.stateSizes.pairThrottles, 'number');
});

test('F-10: evicting quiet cohort members (incl. the union-find root) leaves a working engine', async () => {
  const tw = sdk.createCusumTripwire({ mode: 'observe', alpha: 0.05, maxIdentities: 10 });
  await tw.observe({ type: 'list', identity: 'account:a', predicate: PRED(0, 1000), recordIds: ids(0, 40), ts: 1_000_000 });
  await tw.observe({ type: 'list', identity: 'account:b', predicate: PRED(1005, 2000), recordIds: ids(1005, 40), ts: 1_000_000 });
  assert.ok(await tw.snapshotFor('account:a'));
  // Neither member acts again: churn pushes both out (one eviction
  // retires the union-find root and must promote/re-key cleanly).
  for (let i = 0; i < 15; i++) {
    await tw.observe({ type: 'search', identity: `churn:${i}`, ts: 1_000_100 + i });
  }
  assert.equal(await tw.snapshotFor('account:a'), null, 'both members evicted; no zombie cohort remains');
  // The engine still works afterwards: the pair can form again.
  await tw.observe({ type: 'list', identity: 'account:a', predicate: PRED(0, 1000), recordIds: ids(0, 40), ts: 1_001_000 });
  await tw.observe({ type: 'list', identity: 'account:b', predicate: PRED(1005, 2000), recordIds: ids(1005, 40), ts: 1_001_000 });
  assert.ok(await tw.snapshotFor('account:a'), 'the cohort re-forms after eviction');
});

/* ------------------------------ F-11 ------------------------------ */

test('F-11: epoch rotation resets score and contributions - no instant re-cross, no stale targets', async () => {
  const tw = sdk.createCusumTripwire({ mode: 'enforce', alpha: 0.05 });
  const decisions = await feedSlicers(tw, 1_000_000);
  assert.equal(decisions[decisions.length - 1].crossed, true);
  const before = await tw.snapshotFor('account:a');
  assert.equal(before.flagged, true);
  assert.ok(before.contributingMembers.includes('account:b'), 'b contributed before rotation');
  assert.ok(before.score >= Math.log(1 / 0.05) - 1e-9, 'score at/above the boundary before rotation');
  // +90 days: the first event of the new epoch (the audit h6 control).
  const ts2 = 1_000_000 + 90 * 86_400_000;
  const first = await tw.observe({ type: 'list', identity: 'account:a', recordIds: ids(5000, 5), ts: ts2 });
  assert.equal(first.crossed, false, 'retest bar: the new epoch does not re-cross on stale score');
  assert.equal(first.flagged, false);
  assert.equal(first.score, 0, 'the accumulator restarted at the rotation');
  const after = await tw.snapshotFor('account:a');
  assert.equal(after.flagged, false);
  assert.ok(!after.contributingMembers.includes('account:b'), 'stale contributors are no longer targeted');
  assert.deepEqual(sdk.consequenceTargets(after).targets, [], 'no friction targets survive the rotation');
  assert.equal(after.unionRecords, 165, 'coverage is a fact: the union survives rotation (160 + 5 new)');
});

/* ------------------------------ F-16 ------------------------------ */

test('F-16: malformed events are refused with a structured no-op and mutate no state (harness-verify V6)', async () => {
  const tw = sdk.createCusumTripwire({ mode: 'observe', alpha: 0.05 });
  const badEvents = [
    null,
    undefined,
    'not-an-event',
    { type: 'list', recordIds: ids(0, 5) }, // no identity at all (V6/H2-7)
    { type: 'list', identity: '', recordIds: ids(0, 5) },
    { type: 'list', identity: 42, recordIds: ids(0, 5) },
    { type: 'list', identity: 'account:ghost', ts: NaN, recordIds: ids(0, 5) },
    { type: 'list', identity: 'account:ghost', ts: Infinity, recordIds: ids(0, 5) },
  ];
  for (const bad of badEvents) {
    // Pre-fix: observe(null) threw a bare TypeError, and the
    // identity-less events accrued state under the key `undefined`.
    const d = await tw.observe(bad);
    assert.equal(d.action, 'none');
    assert.equal(d.crossed, false);
    assert.equal(d.flagged, false);
    assert.equal(d.score, 0);
    assert.equal(d.cohortId, null);
  }
  const noId = await tw.observe({ type: 'list', recordIds: ids(0, 5) });
  assert.equal(noId.identity, '', 'a missing identity is reported as empty, never as a shared key');
  // The NaN-ts ghost events created no state for their identity.
  assert.equal(await tw.snapshotFor('account:ghost'), null);
  // Valid traffic afterwards is unaffected, and the invalid barrage
  // left no extra identity behind: exactly the 4 slicers exist.
  await feedSlicers(tw);
  const snap = await tw.snapshotFor('account:a');
  assert.equal(snap.stateSizes.identities, 4, 'no `undefined`-keyed or ghost state was created');
});

test('F-16: a NaN-ts event cannot poison a flagged cohort - rotation still fires on clean time (h5/h6 H2-3 variant)', async () => {
  const tw = sdk.createCusumTripwire({ mode: 'observe', alpha: 0.05 });
  const decisions = await feedSlicers(tw, 1_000_000);
  assert.equal(decisions[decisions.length - 1].crossed, true);
  // Pre-fix this event was applied with ts = NaN: flaggedAtMs became
  // NaN and every later rotation comparison was false forever.
  const poison = await tw.observe({ type: 'list', identity: 'account:a', recordIds: ids(6000, 5), ts: NaN });
  assert.equal(poison.action, 'none', 'the NaN-ts event is dropped as a structured no-op');
  assert.equal(poison.score, 0);
  const mid = await tw.snapshotFor('account:a');
  assert.equal(mid.flagged, true, 'the flag stands - the event was refused, not applied');
  assert.equal(mid.unionRecords, 160, 'the refused event served nothing');
  const ts2 = 1_000_000 + 90 * 86_400_000;
  const first = await tw.observe({ type: 'list', identity: 'account:a', recordIds: ids(6000, 5), ts: ts2 });
  assert.equal(first.flagged, false, 'epoch rotation fires on the clean timestamp');
});

/* ------------------------------- CLK ------------------------------- */

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

/**
 * The slicing shape, but observed WITHOUT event timestamps so the
 * events stamp the injected twin clocks and the cohort bucket
 * anchors on the monotonic one (220 mono-clock.test.cjs).
 */
const feedSlicersLive = async (tw) => {
  await tw.observe({ type: 'list', identity: 'account:a', predicate: PRED(0, 1000), recordIds: ids(0, 40) });
  await tw.observe({ type: 'list', identity: 'account:b', predicate: PRED(1005, 2000), recordIds: ids(1005, 40) });
  await tw.observe({ type: 'list', identity: 'account:c', predicate: PRED(2010, 3000), recordIds: ids(2010, 40) });
  const last = await tw.observe({ type: 'list', identity: 'account:d', predicate: PRED(3010, 4000), recordIds: ids(3010, 40) });
  assert.equal(last.flagged, true);
};

// Cohort of 4: refill rate = 3.5 * 4^0.15 tokens/s, so 10 real
// seconds refill floor(43.09) = 43 tokens of the 150-token burst.
const REFILL_10S_SIZE4 = Math.floor(10 * 3.5 * Math.pow(4, 0.15));

test('CLK: bucket refill follows the monotonic clock across a +5 min wall step', async () => {
  const clocks = makeClocks();
  const tw = sdk.createCusumTripwire({ mode: 'enforce', alpha: 0.05, now: clocks.now, monoNow: clocks.monoNow });
  await feedSlicersLive(tw);
  const drained = await tw.checkServe('account:a', 150);
  assert.equal(drained.allowed, 150); // burst bucket spent

  clocks.advanceReal(10_000);
  clocks.stepWall(300_000); // wall says 310 s elapsed - a full refill

  // Wall arithmetic would refill the bucket to full and pace nothing.
  // On the monotonic clock only 10 real seconds refilled it.
  const paced = await tw.checkServe('account:a', 150);
  assert.equal(paced.allowed, REFILL_10S_SIZE4);
  assert.equal(paced.reason, 'campaign_bucket');
});

test('CLK: bucket refill is not frozen by a -5 min wall step', async () => {
  const clocks = makeClocks();
  const tw = sdk.createCusumTripwire({ mode: 'enforce', alpha: 0.05, now: clocks.now, monoNow: clocks.monoNow });
  await feedSlicersLive(tw);
  const drained = await tw.checkServe('account:a', 150);
  assert.equal(drained.allowed, 150);

  clocks.stepWall(-300_000);
  clocks.advanceReal(10_000);

  // Wall arithmetic would see a negative elapsed time and refill
  // nothing, pacing the cohort for ~5 extra minutes. The monotonic
  // clock refilled exactly the 10 real seconds.
  const paced = await tw.checkServe('account:a', 150);
  assert.equal(paced.allowed, REFILL_10S_SIZE4);
  assert.equal(paced.reason, 'campaign_bucket');
});

/* ------------------------------ CLK-2 ------------------------------ */

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
const DECLARED = [['account:a', 'account:b', 'account:c', 'account:d']];

/** Armed declared-ceiling tripwire (limit 50, default 60 s TTL) over split clocks. */
function armedClocks() {
  const clocks = makeClocks(1_000_000);
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    ceiling: { limit: 50 },
    declaredCohorts: DECLARED,
    manifest: CEILING_MANIFEST,
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  return { tw, clocks };
}

test('CLK-2: a +61 s wall step (TTL 60 s, ~0 ms real) does NOT expire a serve hold - the second hold is refused at the cap', async () => {
  const { tw, clocks } = armedClocks();
  const holdA = tw.reserveServe('account:a', ids(0, 50));
  assert.equal(holdA.newRecords, 50);
  assert.ok(holdA.reservationId);

  clocks.stepWall(61_000); // wall jumps past the TTL; real (monotonic) elapsed time is ~0

  // Pre-fix (audit repro-ldeep-reserve part 2): hold A counted as
  // expired on the wall step alone, hold B was granted in full, and
  // committing + observing both sets landed union = 100 on a cap of 50.
  const holdB = tw.reserveServe('account:b', ids(100, 50));
  assert.equal(holdB.newRecords, 0, 'hold A still holds the whole ceiling');
  assert.deepEqual(holdB.allowed, []);
  assert.equal(holdB.reason, 'campaign_ceiling');

  // The host did everything right and in ~0 real ms: its commit lands.
  assert.deepEqual(tw.commitServe(holdA.reservationId), { committed: true });
  await tw.observe({ type: 'page_view', identity: 'account:a', recordIds: ids(0, 50), ts: clocks.now() });
  const snap = await tw.snapshotFor('account:a');
  assert.equal(snap.unionRecords, 50, 'the union stays at the declared ceiling, never 100');
});

test('CLK-2: a hold genuinely outliving the TTL on the monotonic clock still expires', async () => {
  const { tw, clocks } = armedClocks();
  const holdA = tw.reserveServe('account:a', ids(0, 50));
  assert.equal(holdA.newRecords, 50);

  clocks.advanceReal(61_000); // real time passes the 60 s TTL (both clocks move)

  const holdB = tw.reserveServe('account:b', ids(100, 50));
  assert.equal(holdB.newRecords, 50, 'the expired hold freed the ceiling');
  assert.deepEqual(holdB.allowed, ids(100, 50));
  // A late commit of the expired hold is refused and counts nothing.
  const late = tw.commitServe(holdA.reservationId);
  assert.equal(late.committed, false);
  assert.equal(late.reason, 'reservation_expired');
  assert.equal((await tw.snapshotFor('account:b')).unionRecords, 50, 'only the live hold counts');
});
