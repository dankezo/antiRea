const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const ids = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const PRED = (min, max) => ({ field: 'id', min, max, domainMin: 0, domainMax: 10_000 });

/** Same slicing cohort as tests/cusum-tripwire.test.cjs: four identities
 * on abutting ranges, 40 records each, adjacency-driven crossing at
 * alpha 0.05 with the union (160) above the consequence floor. */
async function feedSlicers(tw, ts = 1_000_000) {
  const decisions = [];
  decisions.push(await tw.observe({ type: 'list', identity: 'account:a', predicate: PRED(0, 1000), recordIds: ids(0, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:b', predicate: PRED(1005, 2000), recordIds: ids(1005, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:c', predicate: PRED(2010, 3000), recordIds: ids(2010, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:d', predicate: PRED(3010, 4000), recordIds: ids(3010, 40), ts }));
  return decisions;
}

test('consequenceTargets: a member merged after the crossing who only feeds warm details is not a friction target', async () => {
  const tw = sdk.createCusumTripwire({ mode: 'enforce', alpha: 0.05 });
  await feedSlicers(tw);
  // Member 5 merges into the already-flagged cohort through an
  // abutting predicate - that merge event itself contributes
  // positively (c5plus) - and then feeds ONLY warm details, whose
  // negative increments bring its net in-cohort contribution below
  // zero, so it is a member but not a contributing member.
  await tw.observe({ type: 'list', identity: 'account:e', predicate: PRED(4010, 5000), recordIds: ids(4010, 40), ts: 1_000_100 });
  for (let i = 0; i < 100; i++) {
    await tw.observe({
      type: 'detail', identity: 'account:e', detailId: 9000 + i, introducedIds: [9000 + i], ts: 1_000_200 + i * 100,
    });
  }
  const snapshot = await tw.snapshotFor('account:a');
  assert.ok(snapshot.members.includes('account:e'), 'member 5 is in the cohort');
  assert.ok(!snapshot.contributingMembers.includes('account:e'), 'member 5 did not contribute net evidence');
  const targets = sdk.consequenceTargets(snapshot);
  assert.ok(!targets.targets.includes('account:e'), 'friction targets exclude the non-contributor');
  assert.ok(targets.nonContributingMembers.includes('account:e'), 'member 5 lands in nonContributingMembers');
  assert.deepEqual(targets.targets, ['account:b', 'account:c', 'account:d']);
  assert.deepEqual(targets.nonContributingMembers, ['account:a', 'account:e']);
  assert.deepEqual(targets.protectedMembers, []);
});

test('consequenceTargets: a protected slicer is listed as protected and excluded from targets', async () => {
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    isProtected: id => id === 'account:b',
  });
  await feedSlicers(tw);
  const snapshot = await tw.snapshotFor('account:a');
  assert.deepEqual(snapshot.protectedMembers, ['account:b']);
  assert.ok(snapshot.contributingMembers.includes('account:b'), 'the protected slicer did contribute evidence');
  const targets = sdk.consequenceTargets(snapshot);
  assert.deepEqual(targets.protectedMembers, ['account:b']);
  assert.ok(!targets.targets.includes('account:b'), 'friction targets exclude the protected member');
  assert.ok(!targets.nonContributingMembers.includes('account:b'), 'protected members are not reclassified as non-contributors');
  assert.deepEqual(targets.targets, ['account:c', 'account:d']);
});

test('herdFrictionTargets: per-member coverage separates a duplicated light member from the heavy herd', () => {
  const flags = [];
  const det = sdk.createHerdDetector({
    onFlag: s => flags.push(s),
    recordIndex: id => Number(id.slice(2)) - 1,
  });
  const T0 = 1_700_000_000_000;
  const hIds = (start, len) => Array.from({ length: len }, (_, i) => `R-${String(start + i + 1).padStart(4, '0')}`);
  const members = ['account:h1', 'account:h2', 'account:light'];
  // Signup chaining on one IP groups all three under v1.
  members.forEach((m, i) => det.observe({ type: 'signup', identity: m, ip: '10.0.0.9', ts: T0 + i * 10_000 }));
  let t = T0 + 100_000;
  const feedH = (identity, recordIds) => { det.observe({ type: 'detail', identity, ip: '10.0.0.9', ts: t, recordIds }); t += 10_000; };
  // Two heavy members with disjoint coverage, 160 records each.
  for (let p = 0; p < 160; p += 20) feedH('account:h1', hIds(p, 20));
  // One light member whose 5 records duplicate heavy member 1 exactly.
  feedH('account:light', hIds(0, 5));
  for (let p = 0; p < 130; p += 10) feedH('account:h2', hIds(200 + p, 10));
  assert.equal(flags.length, 0, 'combined coverage 290 is still below the 300 flag floor');
  // One final 30-record event jumps the group over the floor, so the
  // flag snapshot carries the full intended per-member coverage.
  feedH('account:h2', hIds(330, 30));
  assert.equal(flags.length, 1, `expected exactly one flag, got ${flags.length}`);
  const flag = flags[0];
  assert.equal(flag.mechanism, 'v1-ip');
  assert.equal(flag.combinedCoverage, 320);
  assert.deepEqual(flag.memberCoverage, { 'account:h1': 160, 'account:h2': 160, 'account:light': 5 });
  assert.deepEqual(flag.memberUniqueCoverage, { 'account:h1': 155, 'account:h2': 160, 'account:light': 0 });
  assert.equal(sdk.HERD_FRICTION_MIN_UNIQUE_RECORDS, 25);
  assert.deepEqual(sdk.herdFrictionTargets(flag), ['account:h1', 'account:h2']);
  // Legacy fallback: a snapshot with no memberUniqueCoverage field
  // (an older producer) targets every member.
  assert.deepEqual(
    sdk.herdFrictionTargets({ members: ['account:x', 'account:y'], band: 'graduated_only' }),
    ['account:x', 'account:y'],
  );
});

test('formation slice: two filter-only identities with disjoint served sets merge and flag on tiling', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  let ts = 1_000_000;
  const chunk = async (identity, start) => {
    const decision = await tw.observe({ type: 'list', identity, recordIds: ids(start, 100), ts });
    ts += 1000;
    return decision;
  };
  // No predicates at all - the list events model filtered lists whose
  // only honest trace is the served set. 100 records per side is
  // below the 150 per-member formation gate: no cohort yet, and
  // snapshotFor reports a singleton as null.
  await chunk('account:x', 0);
  await chunk('account:y', 1000);
  assert.equal(await tw.snapshotFor('account:x'), null);
  assert.equal(await tw.snapshotFor('account:y'), null);
  for (let c = 1; c < 7; c++) {
    await chunk('account:x', c * 100);
    await chunk('account:y', 1000 + c * 100);
  }
  const snapX = await tw.snapshotFor('account:x');
  const snapY = await tw.snapshotFor('account:y');
  assert.ok(snapX, 'x is in a cohort after formation');
  assert.deepEqual(snapX.members, ['account:x', 'account:y']);
  assert.equal(snapY.cohortId, snapX.cohortId);
  assert.equal(snapX.unionRecords, 1400);
  assert.equal(snapX.flagged, true, 'the merged cohort flags on the tiling stream');
});

test('formation slice negative: two identities serving the SAME 700 records never merge and never flag', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  let ts = 1_000_000;
  let last;
  for (let c = 0; c < 7; c++) {
    last = await tw.observe({ type: 'list', identity: 'account:x', recordIds: ids(c * 100, 100), ts });
    ts += 1000;
    last = await tw.observe({ type: 'list', identity: 'account:y', recordIds: ids(c * 100, 100), ts });
    ts += 1000;
  }
  // Jaccard 1 is the opposite of complementary: no merge, no cohort,
  // and a singleton can never flag.
  assert.equal(await tw.snapshotFor('account:x'), null);
  assert.equal(await tw.snapshotFor('account:y'), null);
  assert.equal(last.flagged, false);
});

test('formation cold-walk: two detail-only walkers on disjoint continuous ranges merge and flag', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  let ts = 1_000_000;
  const walk = async (identity, detailId) => {
    const decision = await tw.observe({ type: 'detail', identity, detailId, ts });
    ts += 1000;
    return decision;
  };
  for (let i = 0; i < 10; i++) {
    await walk('account:w1', i);
    await walk('account:w2', 400 + i);
  }
  assert.equal(await tw.snapshotFor('account:w1'), null, 'a 20-record cold union is far below the formation union floor');
  for (let i = 10; i < 400; i++) {
    await walk('account:w1', i);
    await walk('account:w2', 400 + i);
  }
  const snapshot = await tw.snapshotFor('account:w1');
  assert.ok(snapshot, 'the walkers formed a cohort');
  assert.deepEqual(snapshot.members, ['account:w1', 'account:w2']);
  assert.equal(snapshot.flagged, true);
});

test('formation cold-walk negative: a lone walker with 800 cold details never flags', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  let ts = 1_000_000;
  let last;
  for (let i = 0; i < 800; i++) {
    last = await tw.observe({ type: 'detail', identity: 'account:solo', detailId: i, ts });
    ts += 1000;
  }
  assert.equal(await tw.snapshotFor('account:solo'), null, 'no partner, no cohort');
  assert.equal(last.flagged, false, 'a singleton accumulator never engages a cohort flag');
});

test('formation cold-walk negative: sparse cold fetches (density about 0.01) never merge', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  let ts = 1_000_000;
  for (let i = 0; i < 80; i++) {
    await tw.observe({ type: 'detail', identity: 'account:s1', detailId: (i * 120) % 10_000, ts });
    ts += 1000;
    await tw.observe({ type: 'detail', identity: 'account:s2', detailId: (i * 120 + 60) % 10_000, ts });
    ts += 1000;
  }
  // 80 cold ids each, spread over a 10,000-wide range: density is
  // about 0.01, far under the 0.5 range-density gate (and the cold
  // union, 160, is under the 300 floor as well).
  assert.equal(await tw.snapshotFor('account:s1'), null);
  assert.equal(await tw.snapshotFor('account:s2'), null);
});

test('formation cold-walk negative: a warm reader accrues zero cold ids and never merges', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  let ts = 1_000_000;
  let warmDecision;
  for (let i = 0; i < 400; i++) {
    warmDecision = await tw.observe({
      type: 'detail', identity: 'account:r1', detailId: i, introducedIds: [i], ts,
    });
    ts += 1000;
    await tw.observe({
      type: 'detail', identity: 'account:r2', detailId: 400 + i, introducedIds: [400 + i], ts,
    });
    ts += 1000;
  }
  // Every detail was introduced first (the introducedIds form of a
  // warm reader), so cold is 0 on both sides and no formation signal
  // has anything to pair.
  assert.equal(warmDecision.bins.cold, 'warm');
  assert.equal(await tw.snapshotFor('account:r1'), null);
  assert.equal(await tw.snapshotFor('account:r2'), null);
});

test('formation cold-walk KNOWN SHAPE EQUIVALENCE: two compliance reviewers walking disjoint sequential detail ranges merge and flag - the consequence is capped by the tiering law for inferred cohorts', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  let ts = 1_000_000;
  let last;
  for (let i = 0; i < 400; i++) {
    last = await tw.observe({ type: 'detail', identity: 'account:reviewer1', detailId: 2000 + i, ts });
    ts += 1000;
    last = await tw.observe({ type: 'detail', identity: 'account:reviewer2', detailId: 2400 + i, ts });
    ts += 1000;
  }
  // This is the documented limit, asserted rather than hidden: at
  // the formation level a sequential compliance review is the same
  // shape as a walk, so the cohort forms and flags. What protects
  // the reviewers is downstream - the tiering law caps an inferred
  // cohort at friction, a host-declared protected cohort is exempt,
  // and here the flag does not even reach the consequence floor on
  // served records, so the decision stays telemetry (logged).
  const snapshot = await tw.snapshotFor('account:reviewer1');
  assert.ok(snapshot, 'the reviewers formed a cohort');
  assert.deepEqual(snapshot.members, ['account:reviewer1', 'account:reviewer2']);
  assert.equal(snapshot.flagged, true);
  assert.equal(last.action, 'logged');
});

test('bins: decisions carry the bin label each stream used', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  const decisions = await feedSlicers(tw);
  for (const decision of decisions) assert.equal(typeof decision.bins.adjacency, 'string');
  assert.equal(decisions[0].bins.adjacency, 'null');
  assert.equal(decisions[1].bins.adjacency, 'c2');
  assert.equal(decisions[2].bins.adjacency, 'c3');
  assert.equal(decisions[3].bins.adjacency, 'c4');
  assert.equal(decisions[0].bins.tiling, null);
  assert.equal(decisions[0].bins.cold, null);
  assert.equal(decisions[0].bins.velocity, null);

  const tw2 = sdk.createCusumTripwire({});
  const cold = await tw2.observe({ type: 'detail', identity: 'account:walker', detailId: 123, ts: 1_000_000 });
  assert.ok(['warm', 'low', 'mid', 'high', 'high_regular'].includes(cold.bins.cold), `cold bin ${cold.bins.cold}`);
  assert.equal(cold.bins.cold, 'low');
  const warm = await tw2.observe({
    type: 'detail', identity: 'account:walker', detailId: 500, introducedIds: [500], ts: 1_001_000,
  });
  assert.equal(warm.bins.cold, 'warm');
});
