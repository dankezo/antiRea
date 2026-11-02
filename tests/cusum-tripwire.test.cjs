const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const ids = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const PRED = (min, max) => ({ field: 'id', min, max, domainMin: 0, domainMax: 10_000 });

/** Four identities slicing abutting ranges: A[0,1000] B[1005,2000] C[2010,3000] D[3010,4000].
 * Each serves 40 records inside its own range, so the cohort's exact union
 * at the crossing is 160 - above the 150-record consequence floor, while
 * per-member sizes (40) stay below the tiling gate (150) so the tiling
 * stream stays inert and the crossing is adjacency-driven, as before. */
async function feedSlicers(tw, ts = 1_000_000) {
  const decisions = [];
  decisions.push(await tw.observe({ type: 'list', identity: 'account:a', predicate: PRED(0, 1000), recordIds: ids(0, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:b', predicate: PRED(1005, 2000), recordIds: ids(1005, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:c', predicate: PRED(2010, 3000), recordIds: ids(2010, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:d', predicate: PRED(3010, 4000), recordIds: ids(3010, 40), ts }));
  return decisions;
}

test('cusum: bundled tables are r6-calib-1 and labeled uncalibrated', () => {
  assert.equal(sdk.R6_CALIB_1_LLR_TABLES.version, 'r6-calib-1');
  assert.equal(sdk.R6_CALIB_1_LLR_TABLES.uncalibrated, true);
  assert.equal(sdk.R6_CALIB_1_LLR_TABLES.nEff, 189);
});

test('cusum: observe mode (explicit) flags a slicing cohort but restricts nothing', async () => {
  const flags = [];
  const tw = sdk.createCusumTripwire({ mode: 'observe', alpha: 0.05, onCampaignFlag: snap => flags.push(snap) });
  const decisions = await feedSlicers(tw);
  const last = decisions[decisions.length - 1];
  assert.equal(last.crossed, true);
  assert.equal(last.flagged, true);
  assert.equal(last.action, 'logged');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].uncalibrated, true);
  assert.equal(flags[0].notice, 'uncalibrated - audit only');
  // Observe mode: the pre-serve gate is a pass-through.
  assert.deepEqual(await tw.checkServe('account:a', 50), { allowed: 50 });
});

test('cusum: zero floor - exculpatory events cannot bank innocence below zero', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  // Warm, human-paced events carry negative increments.
  for (let i = 0; i < 5; i++) {
    await tw.observe({ type: 'detail', identity: 'account:a', detailId: 42, introducedIds: [42], ts: 1_000_000 + i });
  }
  const decision = await tw.observe({ type: 'detail', identity: 'account:a', detailId: 42, introducedIds: [42], ts: 1_000_100 });
  assert.equal(decision.score, 0);
});

test('cusum TIERING: enforce mode with uncalibrated tables caps at step_up - the ceiling cannot engage', async () => {
  const tw = sdk.createCusumTripwire({ mode: 'enforce', alpha: 0.05 });
  const decisions = await feedSlicers(tw);
  const last = decisions[decisions.length - 1];
  assert.equal(last.crossed, true);
  assert.equal(last.action, 'step_up');
  assert.match(last.clampedReason, /inferred cohorts are capped/);
  const snapshot = await tw.snapshotFor('account:a');
  assert.equal(snapshot.flagged, true);
  assert.equal(snapshot.ceilingActive, false);
});

test('cusum TIERING: host-declared cohort + ceiling-tier manifest lets the ceiling engage and hold', async () => {
  const manifest = {
    modelVersion: 'cusum-1',
    calibrationVersion: 'host-fit-1',
    sampleSizes: { legit: 500, attack: 120 },
    holdout: { falsePositiveRate: 0.001, falseNegativeRate: 0.2 },
    method: 'trace-fitted LLR tables, LOAFO',
    attestedBy: 'host security team',
    issuedAtMs: 900_000,
    expiresAtMs: 9_000_000,
  };
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    ceiling: { limit: 50 },
    declaredCohorts: [['account:a', 'account:b', 'account:c', 'account:d']],
    manifest,
    now: () => 1_000_000,
  });
  const decisions = await feedSlicers(tw);
  const last = decisions[decisions.length - 1];
  assert.equal(last.action, 'campaign_engaged');
  const snapshot = await tw.snapshotFor('account:a');
  assert.equal(snapshot.ceilingActive, true);
  // Serve the cohort past its shared ceiling of 50 distinct records.
  await tw.observe({ type: 'list', identity: 'account:a', recordIds: ids(0, 30), ts: 1_000_100 });
  await tw.observe({ type: 'list', identity: 'account:b', recordIds: ids(100, 30), ts: 1_000_200 });
  const gated = await tw.checkServe('account:c', 10);
  assert.equal(gated.allowed, 0);
  assert.equal(gated.reason, 'campaign_ceiling');
});

test('cusum R6 FIX: whole-domain predicates form no adjacency edges and no cohort', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  const whole = { field: 'id', min: 0, max: 10_000, domainMin: 0, domainMax: 10_000 };
  const first = await tw.observe({ type: 'list', identity: 'account:polite', predicate: whole, ts: 1_000_000 });
  const second = await tw.observe({ type: 'list', identity: 'account:other', predicate: whole, ts: 1_000_100 });
  assert.equal(first.increments.adjacency, 0);
  assert.equal(second.increments.adjacency, 0);
  assert.equal(await tw.snapshotFor('account:polite'), null);
  assert.equal(await tw.snapshotFor('account:other'), null);
});

test('cusum: cold stream - a regular-stride ID walk accrues high_regular increments on exact introduced sets', async () => {
  const tw = sdk.createCusumTripwire({});
  let decision;
  for (let i = 0; i < 6; i++) {
    decision = await tw.observe({ type: 'detail', identity: 'account:walker', detailId: 100 + i, ts: 1_000_000 + i * 1000 });
  }
  assert.equal(decision.increments.cold, sdk.R6_CALIB_1_LLR_TABLES.cold.high_regular);
  assert.ok(decision.score > 0);
  // A warm fetch (previously introduced) earns the null-side increment instead.
  const warm = await tw.observe({
    type: 'detail', identity: 'account:walker', detailId: 500, introducedIds: [500], ts: 1_010_000,
  });
  assert.equal(warm.increments.cold, sdk.R6_CALIB_1_LLR_TABLES.cold.warm);
});

test('cusum: velocity stream - machine-paced cursor chains accrue the fastest bin', async () => {
  const tw = sdk.createCusumTripwire({});
  let decision;
  for (let step = 4; step <= 10; step++) {
    const ts = 1_000_000 + step * 1000;
    decision = await tw.observe({
      type: 'list',
      identity: 'account:fast',
      cursor: { issuedAtMs: ts - 100, pageSize: 10, step },
      ts,
    });
  }
  assert.equal(decision.increments.velocity, sdk.R6_CALIB_1_LLR_TABLES.velocity.v_lt_30);
});

test('cusum: tiling stream fires on disjoint exact sets with no predicate explanation', async () => {
  const tw = sdk.createCusumTripwire({ gates: { minMemberRecords: 5, minCohortSum: 10 } });
  await tw.observe({ type: 'page_view', identity: 'account:b', echoFrom: 'account:a', ts: 1_000_000 });
  await tw.observe({ type: 'list', identity: 'account:a', recordIds: ids(0, 50), ts: 1_000_100 });
  const decision = await tw.observe({ type: 'list', identity: 'account:b', recordIds: ids(50, 50), ts: 1_000_200 });
  assert.equal(decision.increments.tiling, sdk.R6_CALIB_1_LLR_TABLES.tiling.z_ge_0_78);
});

test('cusum CONDITIONAL LLR: records explained by adjacency predicates are excluded from tiling', async () => {
  const tw = sdk.createCusumTripwire({ gates: { minMemberRecords: 5, minCohortSum: 10 } });
  const pred = (min, max) => ({ field: 'id', min, max, domainMin: 0, domainMax: 1000 });
  // A slices [0,49], B slices [50,99]: the second event forms the edge and explains B's ids.
  await tw.observe({ type: 'list', identity: 'account:a', predicate: pred(0, 49), recordIds: ids(0, 50), ts: 1_000_000 });
  await tw.observe({ type: 'list', identity: 'account:b', predicate: pred(50, 99), recordIds: ids(50, 50), ts: 1_000_100 });
  // A's repeat forms its own edge; its ids become explained too.
  await tw.observe({ type: 'list', identity: 'account:a', predicate: pred(0, 49), recordIds: ids(0, 50), ts: 1_000_200 });
  // Now a fresh record-bearing event: every served record is adjacency-explained,
  // so the tiling stream must contribute exactly 0 (no double-counting).
  const decision = await tw.observe({ type: 'list', identity: 'account:b', recordIds: ids(50, 50), ts: 1_000_300 });
  assert.equal(decision.increments.tiling, 0);
});

test('cusum: exempt identities hold no state and emit nothing', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05, isExempt: id => id === 'account:auditor' });
  const decision = await tw.observe({ type: 'list', identity: 'account:auditor', predicate: PRED(0, 1000), ts: 1_000_000 });
  assert.equal(decision.action, 'none');
  assert.equal(decision.score, 0);
  assert.equal(await tw.snapshotFor('account:auditor'), null);
});

/** Six identities with abutting narrow predicates, each serving 5 disjoint
 * records - the polite+NAT shape from the v24 classic test: a shared-pattern
 * cohort whose exact union (30 once all six merged, 20 at the crossing) is
 * far below the 150-record consequence floor. Adjacency increments alone
 * cross B(alpha = 0.05) at the 4th member. */
async function feedNatCohort(tw, ts = 1_000_000) {
  const decisions = [];
  const names = ['nat1', 'nat2', 'nat3', 'nat4', 'nat5', 'polite'];
  for (let i = 0; i < names.length; i++) {
    const min = i * 45;
    decisions.push(await tw.observe({
      type: 'list', identity: `account:${names[i]}`,
      predicate: PRED(min, min + 40), recordIds: ids(min, 5), ts: ts + i * 100,
    }));
  }
  return decisions;
}

test('cusum CONSEQ FLOOR: a below-floor crossing on a polite+NAT shape is telemetry only - flag stands, zero friction', async () => {
  const flags = [];
  const tw = sdk.createCusumTripwire({ mode: 'enforce', alpha: 0.05, onCampaignFlag: snap => flags.push(snap) });
  const decisions = await feedNatCohort(tw);
  const crossing = decisions[3];
  // The evidence is NOT swallowed: the crossing and the flag stand.
  assert.equal(crossing.crossed, true);
  assert.equal(crossing.flagged, true);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].flagged, true);
  assert.equal(flags[0].unionRecords, 20);
  // But below the floor there is no consequence to enroll anyone into.
  assert.equal(crossing.action, 'logged');
  assert.equal(crossing.consequenceEligible, false);
  assert.match(crossing.clampedReason, /consequence floor/);
  assert.equal(flags[0].consequenceEligible, false);
  assert.equal(flags[0].consequenceFloorRecords, 150);
  const snapshot = await tw.snapshotFor('account:nat1');
  assert.equal(snapshot.flagged, true);
  assert.equal(snapshot.unionRecords, 30);
  assert.equal(snapshot.consequenceEligible, false);
  // checkServe is a pass-through for a below-floor flag: no pacing tax.
  assert.deepEqual(await tw.checkServe('account:nat1', 50), { allowed: 50 });
  // Eligibility is live: once the flagged cohort's union grows past the
  // floor, the same flag carries step_up as before.
  const names = ['nat1', 'nat2', 'nat3', 'nat4', 'nat5', 'polite'];
  for (let i = 0; i < names.length; i++) {
    await tw.observe({ type: 'list', identity: `account:${names[i]}`, recordIds: ids(i * 45 + 5, 40), ts: 1_001_000 + i * 100 });
  }
  const grown = await tw.observe({ type: 'page_view', identity: 'account:nat1', ts: 1_002_000 });
  assert.equal(grown.consequenceEligible, true);
  assert.equal(grown.action, 'step_up');
  const grownSnapshot = await tw.snapshotFor('account:nat1');
  assert.equal(grownSnapshot.unionRecords, 270);
  assert.equal(grownSnapshot.consequenceEligible, true);
});

test('cusum CONSEQ FLOOR: a crossing at campaign scale still enrolls step_up (the REA-first shape)', async () => {
  const tw = sdk.createCusumTripwire({ mode: 'enforce', alpha: 0.05 });
  const ranges = [[0, 1000], [1005, 2000], [2010, 3000], [3010, 4000]];
  const names = ['a', 'b', 'c', 'd'];
  let last;
  for (let i = 0; i < 4; i++) {
    last = await tw.observe({
      type: 'list', identity: `account:${names[i]}`,
      predicate: PRED(ranges[i][0], ranges[i][1]), recordIds: ids(ranges[i][0], 200), ts: 1_000_000 + i * 100,
    });
  }
  assert.equal(last.crossed, true);
  assert.equal(last.action, 'step_up');
  assert.equal(last.consequenceEligible, true);
  assert.match(last.clampedReason, /inferred cohorts are capped/);
  const snapshot = await tw.snapshotFor('account:a');
  assert.equal(snapshot.unionRecords, 800);
  assert.equal(snapshot.consequenceEligible, true);
  // Attribution: 'a' never acted while a cohort member (its only event
  // predates the first merge), so it contributed no evidence.
  assert.deepEqual(snapshot.contributingMembers, ['account:b', 'account:c', 'account:d']);
});

test('cusum CONSEQ FLOOR: the floor is host-configurable - a calibrated host may pin it lower', async () => {
  const tw = sdk.createCusumTripwire({ mode: 'enforce', alpha: 0.05, consequences: { minUnionRecords: 10 } });
  const decisions = await feedNatCohort(tw);
  const crossing = decisions[3];
  assert.equal(crossing.crossed, true);
  assert.equal(crossing.consequenceEligible, true);
  assert.equal(crossing.action, 'step_up');
  const snapshot = await tw.snapshotFor('account:nat1');
  assert.equal(snapshot.consequenceFloorRecords, 10);
});
