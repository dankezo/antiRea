const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// Regression tests for finding L4-F1 (AMENDMENT-L4F1): the aggregate
// overlap ratio in complement grouping let a large cluster absorb a
// singleton whose only target duplicates a herd target (1 instance
// into a 9-instance / 9-target herd scores exactly 0.10 <= the 0.10
// ceiling). The registered fix (the L4-F1 merge guard) permits a
// complement merge / join only if the smaller side contributes >= 1
// target NEW to the other side, OR the smaller side has >= 2 total
// instances. `linkOverlapCeiling` is unchanged (0.10).

function collectFlags() {
  const flags = [];
  return { flags, onFlag: s => flags.push(s) };
}

const complementGroups = tracker =>
  tracker.groups().filter(g => g.mechanism === 'complement');

test('L4-F1 (i): S2 shape in miniature - duplicate singleton is NOT absorbed; herd flags without it; duplicated herd member keeps its unique count and stays friction-targeted', () => {
  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({ onFlag });

  // Herd, first 9 members: disjoint search slices, one instance each.
  for (let i = 0; i < 9; i++) {
    tracker.observe({ subject: `account:h${i}`, action: 'search', targetKey: `slice:${i}`, cost: 20 });
  }
  assert.equal(flags.length, 0, 'coverage 9 < 10: no flag yet');

  // The bystander control: one shallow search duplicating herd target
  // slice:0 - exactly the instance the old ratio absorbed at 0.10.
  tracker.observe({ subject: 'account:ctrl', action: 'search', targetKey: 'slice:0', cost: 2 });

  // Herd completes its tiling (10th disjoint member) and flags.
  tracker.observe({ subject: 'account:h9', action: 'search', targetKey: 'slice:9', cost: 20 });

  assert.equal(flags.length, 1, 'the herd still flags on its own evidence');
  const flag = flags[0];
  assert.equal(flag.mechanism, 'complement');
  assert.equal(flag.members.length, 10, 'flag covers exactly the 10 herd members');
  assert.ok(!flag.members.includes('account:ctrl'), 'the duplicate singleton is absent from the flag snapshot');
  for (const f of flags) {
    assert.ok(!f.members.includes('account:ctrl'), 'control is in NO flag snapshot');
  }

  // The herd member who owned the duplicated target keeps it unique
  // (the absorbed duplicate used to zero this count)...
  assert.ok(
    flag.memberUniqueTargetCounts['account:h0'] >= 1,
    `h0 unique count for slice:0 intact, got ${flag.memberUniqueTargetCounts['account:h0']}`,
  );
  // ...and is therefore friction-targeted by the contribution gate.
  const targets = tracker.actionFrictionTargets(flag);
  assert.ok(targets.includes('account:h0'), 'h0 IS friction-targeted by the contribution gate');
  assert.ok(!targets.includes('account:ctrl'), 'the control gets no friction');

  // Grouping state agrees: the singleton stayed its own cluster.
  const herdGroup = complementGroups(tracker).find(g => g.members.includes('account:h0'));
  assert.ok(herdGroup);
  assert.ok(!herdGroup.members.includes('account:ctrl'), 'clusters did NOT merge');
  const ctrlGroup = complementGroups(tracker).find(g => g.members.includes('account:ctrl'));
  assert.ok(ctrlGroup);
  assert.deepEqual(ctrlGroup.members, ['account:ctrl'], 'the singleton is a cluster of one');
});

test('L4-F1 (ii): two disjoint singleton clusters still merge (herd formation unbroken)', () => {
  const tracker = sdk.createActionCohortTracker({});
  tracker.observe({ subject: 'account:a', action: 'search', targetKey: 'slice:0', cost: 8 });
  tracker.observe({ subject: 'account:b', action: 'search', targetKey: 'slice:1', cost: 8 });
  const groups = complementGroups(tracker).filter(g => g.members.length > 0);
  assert.equal(groups.length, 1, 'disjoint singletons form ONE complement cluster');
  assert.deepEqual([...groups[0].members].sort(), ['account:a', 'account:b']);
});

test('L4-F1 (iii): duplicate-only cluster with >= 2 instances still merges (mass prong)', () => {
  const tracker = sdk.createActionCohortTracker({});
  // Herd: 9 members x 2 disjoint targets = 18 instances / 18 targets,
  // tiny cost so no flag interferes with the grouping assertion.
  for (let i = 0; i < 9; i++) {
    tracker.observe({ subject: `account:h${i}`, action: 'export', targetKey: `slice:${i * 2}`, cost: 1 });
    tracker.observe({ subject: `account:h${i}`, action: 'export', targetKey: `slice:${i * 2 + 1}`, cost: 1 });
  }
  // Duplicate-only subject, FIRST instance: a zero-new-target
  // singleton - the guard must refuse the merge (ratio would pass:
  // 1 - 18/19 ~= 0.053 <= 0.10).
  tracker.observe({ subject: 'account:dup', action: 'export', targetKey: 'slice:0', cost: 1 });
  let herdGroup = complementGroups(tracker).find(g => g.members.includes('account:h0'));
  assert.ok(herdGroup);
  assert.ok(!herdGroup.members.includes('account:dup'), 'singleton duplicate stays separate');

  // SECOND instance of the same duplicated target: the cluster now
  // has mass (>= 2 instances), so the mass prong permits the merge
  // (ratio 1 - 18/20 = 0.10 <= 0.10).
  tracker.observe({ subject: 'account:dup', action: 'export', targetKey: 'slice:0', cost: 1 });
  herdGroup = complementGroups(tracker).find(g => g.members.includes('account:h0'));
  assert.ok(herdGroup);
  assert.ok(herdGroup.members.includes('account:dup'), 'duplicate-only cluster with >= 2 instances merges by the mass prong');
});

test('L4-F1 (iv): shared-target grouping still flags a same-target group (existing behavior pinned)', () => {
  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({ onFlag });
  for (let i = 0; i < 6; i++) {
    tracker.observe({ subject: `account:s${i}`, action: 'promo_claim', targetKey: 'promo:1', cost: 20 });
  }
  assert.equal(flags.length, 1);
  const flag = flags[0];
  assert.equal(flag.mechanism, 'shared-target', 'the S3 promo mechanism is untouched by the complement guard');
  assert.equal(flag.members.length, 6);
  assert.equal(flag.aggregateCost, 120);
  assert.equal(flag.targetCoverage, 1);
  // Complement grouping still refuses to merge the identical-target
  // singletons: no complement cluster holds more than one of them.
  for (const g of complementGroups(tracker)) {
    const farmers = g.members.filter(m => /^account:s\d$/.test(m));
    assert.ok(farmers.length <= 1, 'shared-target subjects are not complement-merged');
  }
});

test('L4-F1 (v): evaluateAction join gate applies the same guard - duplicate target wouldJoin=false, new target wouldJoin=true', () => {
  const tracker = sdk.createActionCohortTracker({});
  // Unflagged herd cluster: 9 disjoint singleton members (aggregate
  // ratio for a duplicate join would be exactly 0.10 - the L4-F1
  // boundary - so the ratio alone would have admitted it).
  for (let i = 0; i < 9; i++) {
    tracker.observe({ subject: `account:h${i}`, action: 'search', targetKey: `slice:${i}`, cost: 20 });
  }
  const herd = complementGroups(tracker).find(g => g.members.length === 9);
  assert.ok(herd, 'herd cluster formed');

  const dupEval = tracker.evaluateAction({ subject: 'account:late', action: 'search', targetKey: 'slice:0', cost: 20 });
  const dupEntry = dupEval.clusters.find(c => c.groupId === herd.groupId);
  assert.ok(dupEntry);
  assert.equal(dupEntry.targetKnown, true);
  assert.equal(dupEntry.wouldJoin, false, 'a duplicate-only singleton join is refused by the guard');

  const newEval = tracker.evaluateAction({ subject: 'account:late', action: 'search', targetKey: 'slice:99', cost: 20 });
  const newEntry = newEval.clusters.find(c => c.groupId === herd.groupId);
  assert.ok(newEntry);
  assert.equal(newEntry.targetKnown, false);
  assert.equal(newEntry.wouldJoin, true, 'a coverage-extending join is still admitted');
});
