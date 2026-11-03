const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const ids = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const PRED = (min, max) => ({ field: 'id', min, max, domainMin: 0, domainMax: 10_000 });

/** Same polite+NAT shape as tests/cusum-tripwire.test.cjs: six identities
 * with abutting narrow predicates, each serving 5 disjoint records.
 * Adjacency increments alone cross B(alpha = 0.05) at the 4th member,
 * when the cohort's exact union is 20 (30 once all six have fed). With
 * the consequence floor pinned at 50 via consequences.minUnionRecords,
 * that crossing is BELOW the floor - the L8a setup. */
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

/** Same slicing cohort as tests/cusum-tripwire.test.cjs: four identities
 * on abutting ranges, 40 records each, adjacency-driven crossing at
 * alpha 0.05 with the union (160) above any floor pinned in this file. */
async function feedSlicers(tw, ts = 1_000_000) {
  const decisions = [];
  decisions.push(await tw.observe({ type: 'list', identity: 'account:a', predicate: PRED(0, 1000), recordIds: ids(0, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:b', predicate: PRED(1005, 2000), recordIds: ids(1005, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:c', predicate: PRED(2010, 3000), recordIds: ids(2010, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:d', predicate: PRED(3010, 4000), recordIds: ids(3010, 40), ts }));
  return decisions;
}

test('cusum L8a: below-floor cross, then growth into eligibility - transition fires exactly once with an eligible snapshot', async () => {
  const flags = [];
  const transitions = [];
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    consequences: { minUnionRecords: 50 },
    onCampaignFlag: snap => flags.push(snap),
    onConsequenceEligibility: snap => transitions.push(snap),
  });

  // (i) The cohort crosses below the floor: the flag fires carrying
  // consequenceEligible false, and the transition callback does NOT.
  const decisions = await feedNatCohort(tw);
  const crossing = decisions[3];
  assert.equal(crossing.crossed, true);
  assert.equal(crossing.flagged, true);
  assert.equal(crossing.consequenceEligible, false);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].flagged, true);
  assert.equal(flags[0].consequenceEligible, false);
  assert.equal(flags[0].consequenceFloorRecords, 50);
  assert.equal(flags[0].unionRecords, 20);
  assert.equal(transitions.length, 0);
  // Still below the floor after all six fed (union 30): snapshot and
  // checkServe evaluations do not fire the transition either.
  const belowSnap = await tw.snapshotFor('account:nat1');
  assert.equal(belowSnap.unionRecords, 30);
  assert.equal(belowSnap.consequenceEligible, false);
  assert.deepEqual(await tw.checkServe('account:nat1', 50), { allowed: 50 });
  assert.equal(transitions.length, 0);

  // (ii) Feed more serves until the union reaches eligibility: nat1
  // adds ids 5..44 (40 records disjoint from every other member), so
  // the union grows 30 -> 70, past the 50-record floor.
  const grown = await tw.observe({
    type: 'list', identity: 'account:nat1', recordIds: ids(5, 40), ts: 1_001_000,
  });
  assert.equal(grown.consequenceEligible, true);
  assert.equal(grown.flagged, true);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].flagged, true);
  assert.equal(transitions[0].consequenceEligible, true);
  assert.equal(transitions[0].consequenceFloorRecords, 50);
  assert.equal(transitions[0].unionRecords, 70);
  assert.equal(transitions[0].cohortId, flags[0].cohortId);
  assert.equal(flags.length, 1, 'the transition is not a second campaign flag');

  // (iii) More observes, snapshot reads and checkServe calls on every
  // detection path: still exactly one transition fire.
  await tw.observe({ type: 'page_view', identity: 'account:nat1', ts: 1_002_000 });
  await tw.observe({ type: 'list', identity: 'account:nat2', recordIds: ids(45, 5), ts: 1_002_100 });
  await tw.snapshotFor('account:nat2');
  await tw.getSnapshot(transitions[0].cohortId);
  await tw.checkServe('account:nat1', 5);
  await tw.snapshotFor('account:nat1');
  assert.equal(transitions.length, 1);
  assert.equal(flags.length, 1);
});

test('cusum L8a CONTROL: a cohort that crosses already-eligible never fires the transition callback', async () => {
  const flags = [];
  const transitions = [];
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    consequences: { minUnionRecords: 50 },
    onCampaignFlag: snap => flags.push(snap),
    onConsequenceEligibility: snap => transitions.push(snap),
  });
  const decisions = await feedSlicers(tw);
  const last = decisions[decisions.length - 1];
  assert.equal(last.crossed, true);
  assert.equal(last.consequenceEligible, true);
  // The crossing's own flag snapshot already carried eligibility, so
  // no transition is owed - not at the crossing, and not later.
  assert.equal(flags.length, 1);
  assert.equal(flags[0].consequenceEligible, true);
  assert.equal(flags[0].unionRecords, 160);
  assert.equal(transitions.length, 0);
  await tw.observe({ type: 'page_view', identity: 'account:a', ts: 1_001_000 });
  await tw.snapshotFor('account:a');
  await tw.checkServe('account:a', 5);
  assert.equal(transitions.length, 0);
});

test('cusum L8a: a throwing transition callback is swallowed and still counts as the one notification', async () => {
  let attempts = 0;
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    consequences: { minUnionRecords: 50 },
    onConsequenceEligibility: () => { attempts++; throw new Error('host wiring boom'); },
  });
  await feedNatCohort(tw);
  assert.equal(attempts, 0);
  // The growth observe must complete normally despite the throw.
  const grown = await tw.observe({
    type: 'list', identity: 'account:nat1', recordIds: ids(5, 40), ts: 1_001_000,
  });
  assert.equal(grown.consequenceEligible, true);
  assert.equal(attempts, 1);
  // Exactly once means the failed attempt is not retried either.
  await tw.snapshotFor('account:nat1');
  await tw.checkServe('account:nat1', 5);
  assert.equal(attempts, 1);
});
