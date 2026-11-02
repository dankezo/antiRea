const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// Spec: FEATURE-PROTECTION-SPEC.md section 4, tests 9-15 (action cohort + canary).

function collectFlags() {
  const flags = [];
  return { flags, onFlag: s => flags.push(s) };
}

/** Feed one identity two disjoint export slices at cost 8 each. Returns the last observation. */
function feedPair(tracker, subject, firstSlice) {
  tracker.observe({ subject, action: 'export', targetKey: `slice:${firstSlice}`, cost: 8 });
  return tracker.observe({ subject, action: 'export', targetKey: `slice:${firstSlice + 1}`, cost: 8 });
}

test('9. action cohort: complement flag at the floors with a correct snapshot; below floor -> none', () => {
  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({ onFlag });
  let causing;
  for (let i = 0; i < 8; i++) {
    const first = tracker.observe({ subject: `account:s${i}`, action: 'export', targetKey: `slice:${i * 2}`, cost: 8 });
    const second = tracker.observe({ subject: `account:s${i}`, action: 'export', targetKey: `slice:${i * 2 + 1}`, cost: 8 });
    if (first.flag) causing = first;
    if (second.flag) causing = second;
  }
  assert.equal(flags.length, 1);
  const flag = flags[0];
  assert.equal(causing.flag, flag, 'observe returns the flag it caused');
  assert.equal(flag.mechanism, 'complement');
  assert.equal(flag.members.length, 8);
  assert.ok(flag.aggregateCost >= 100, `aggregate ${flag.aggregateCost} >= 100`);
  assert.ok(flag.targetCoverage >= 10, `coverage ${flag.targetCoverage} >= 10`);
  for (const member of flag.members) {
    assert.ok(flag.memberCost[member] > 0);
    assert.ok(flag.memberTargetCounts[member] >= 1);
  }
  assert.deepEqual(flag.taintedMembers, []);
  assert.deepEqual(flag.protectedMembers, []);
  assert.equal(flag.supplementary, undefined);

  // Below the member floor: 7 identities, same shape -> no flag.
  const small = collectFlags();
  const tracker2 = sdk.createActionCohortTracker({ onFlag: small.onFlag });
  for (let i = 0; i < 7; i++) feedPair(tracker2, `account:s${i}`, i * 2);
  assert.equal(small.flags.length, 0);

  // Below the aggregate floor: 8 identities, tiny cost -> no flag.
  const cheap = collectFlags();
  const tracker3 = sdk.createActionCohortTracker({ onFlag: cheap.onFlag });
  for (let i = 0; i < 8; i++) {
    tracker3.observe({ subject: `account:s${i}`, action: 'export', targetKey: `slice:${i}`, cost: 5 });
  }
  assert.equal(cheap.flags.length, 0);
});

test('10. action cohort: dilution gate - a majority individually OVER allowance does not complement-flag', () => {
  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({ onFlag, subjectAllowance: 10 });
  // Same herd shape as test 9 (aggregate 128, coverage 16, 8 members),
  // but every member's window cost (16) is over its allowance (10).
  for (let i = 0; i < 8; i++) feedPair(tracker, `account:s${i}`, i * 2);
  assert.equal(flags.length, 0, 'a small heavy team is governed by per-subject budgets, not the complement flag');
  const group = tracker.groups().find(g => g.mechanism === 'complement' && g.members.length === 8);
  assert.ok(group, 'the group still forms and accrues telemetry');
  assert.equal(group.flagged, false);
});

test('11. action cohort: shared-target flag at 6 subjects on one target; 5 -> none', () => {
  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({ onFlag });
  let last;
  for (let i = 0; i < 6; i++) {
    last = tracker.observe({ subject: `account:s${i}`, action: 'promo_claim', targetKey: 'promo:1', cost: 20 });
  }
  assert.equal(flags.length, 1);
  const flag = flags[0];
  assert.equal(last.flag, flag);
  assert.equal(flag.mechanism, 'shared-target');
  assert.equal(flag.members.length, 6);
  assert.equal(flag.aggregateCost, 120);
  assert.equal(flag.targetCoverage, 1);

  const five = collectFlags();
  const tracker2 = sdk.createActionCohortTracker({ onFlag: five.onFlag });
  for (let i = 0; i < 5; i++) {
    tracker2.observe({ subject: `account:s${i}`, action: 'promo_claim', targetKey: 'promo:1', cost: 20 });
  }
  assert.equal(five.flags.length, 0);
});

test('12. action cohort: IP-only invariant - shared IP with unrelated actions/targets never groups, never flags', () => {
  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({ onFlag });
  for (let i = 0; i < 10; i++) {
    const obs = tracker.observe({
      subject: `account:u${i}`,
      action: `act${i}`,
      targetKey: `target:${i}`,
      cost: 40,
      ip: '203.0.113.1',
    });
    assert.equal(obs.recorded, true);
    assert.equal(obs.flag, undefined);
  }
  assert.equal(flags.length, 0);
  for (const group of tracker.groups()) {
    assert.equal(group.members.length, 1, 'no group ever holds more than the identity itself');
    assert.equal(group.flagged, false);
  }
});

test('13. action cohort: protected members are listed and excluded from friction; low contributors too', () => {
  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({
    onFlag,
    isProtected: s => s === 'account:prot',
  });
  // Bystander: a single duplicated target at trivial cost.
  tracker.observe({ subject: 'account:by', action: 'export', targetKey: 'slice:0', cost: 1 });
  // Protected member: full material contribution.
  feedPair(tracker, 'account:prot', 100);
  // Seven ordinary members, disjoint slices.
  for (let i = 0; i < 7; i++) feedPair(tracker, `account:m${i}`, i * 2);

  assert.equal(flags.length, 1);
  const flag = flags[0];
  assert.deepEqual(flag.protectedMembers, ['account:prot']);
  assert.ok(flag.members.includes('account:by'), 'bystander is in the snapshot membership');
  assert.ok(flag.members.includes('account:prot'), 'protected member accrues full telemetry');

  const targets = tracker.actionFrictionTargets(flag);
  assert.ok(!targets.includes('account:prot'), 'protected members get zero friction');
  assert.ok(!targets.includes('account:by'), 'a low-contribution member (cost 1, unique 0) gets zero friction');
  assert.ok(targets.includes('account:m0'), 'material members are friction targets');
  assert.deepEqual(sdk.actionFrictionTargets(flag), targets, 'standalone form agrees');
});

test('14. action cohort: supplementary flag announces a material late joiner, coalesced at 5s', () => {
  let clock = 5_000_000;
  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({ onFlag, now: () => clock });
  for (let i = 0; i < 8; i++) feedPair(tracker, `account:s${i}`, i * 2);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].supplementary, undefined);

  // Late joiner crosses materiality but the 5s coalescing window is shut.
  const early = tracker.observe({ subject: 'account:late', action: 'export', targetKey: 'slice:100', cost: 16 });
  assert.equal(early.flag, undefined, 'coalescing: no supplementary inside 5s of the flag');
  assert.equal(flags.length, 1);

  clock += 6_000;
  const later = tracker.observe({ subject: 'account:late', action: 'export', targetKey: 'slice:101', cost: 1 });
  assert.ok(later.flag, 'the pending late joiner is announced once the window opens');
  assert.equal(later.flag.supplementary, true);
  assert.ok(later.flag.members.includes('account:late'));
  assert.equal(flags.length, 2);
  assert.equal(flags[1], later.flag);

  // A second joiner inside the new coalescing window is held, not announced.
  const held = tracker.observe({ subject: 'account:late2', action: 'export', targetKey: 'slice:102', cost: 16 });
  assert.equal(held.flag, undefined);
  assert.equal(flags.length, 2);
});

test('15. action cohort: canary hit taints the toucher only; tainted members surface in cohort flags', () => {
  const registry = sdk.createCanaryActionRegistry();
  registry.registerCanaryTarget({ action: 'export', targetKey: 'export:slice:40', label: 'never-linked slice' });
  registry.registerCanaryTarget({ action: 'promo_claim', targetKey: 'promo-ghost' });
  assert.equal(registry.isCanaryTarget('export', 'export:slice:40'), true);
  assert.equal(registry.isCanaryTarget('export', 'slice:1'), false);
  assert.equal(registry.list().length, 2);
  assert.equal(registry.checkAction({ action: 'export', targetKey: 'export:slice:40' }), true);
  assert.equal(registry.checkAction({ action: 'export', targetKey: 'slice:1' }), false);

  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({
    onFlag,
    canaryRegistry: registry,
    isProtected: s => s === 'account:prot',
  });

  tracker.observe({ subject: 'account:r', action: 'export', targetKey: 'export:slice:40', cost: 10 });
  let taints = tracker.taints();
  assert.equal(taints.length, 1);
  assert.equal(taints[0].subject, 'account:r');
  assert.equal(taints[0].targetKey, 'export:slice:40');

  // A protected subject's own hit taints that subject - and only itself.
  tracker.observe({ subject: 'account:prot', action: 'promo_claim', targetKey: 'promo-ghost', cost: 5 });
  taints = tracker.taints();
  assert.deepEqual(taints.map(t => t.subject).sort(), ['account:prot', 'account:r']);

  // A complement cohort flags on export; the tainted rotator is merged in.
  feedPair(tracker, 'account:r', 0);
  for (let i = 1; i < 8; i++) feedPair(tracker, `account:s${i}`, i * 2);
  assert.equal(flags.length, 1);
  const flag = flags[0];
  assert.ok(flag.members.includes('account:r'));
  assert.deepEqual(flag.taintedMembers, ['account:r'], 'only the export-tainted member surfaces on the export flag');

  // A bystander who never touched a canary is never tainted.
  tracker.observe({ subject: 'account:q', action: 'search', targetKey: 'corpus:1', cost: 1 });
  taints = tracker.taints();
  assert.ok(!taints.some(t => t.subject === 'account:q'));
  assert.ok(!taints.some(t => t.subject.startsWith('account:s')), 'taints never splash onto cohort-mates');
});

test('16. action cohort: evaluateAction is pure - no state mutation, no flag side effects, repeatable', () => {
  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({ onFlag });
  for (let i = 0; i < 8; i++) feedPair(tracker, `account:s${i}`, i * 2);
  assert.equal(flags.length, 1);

  const groupsBefore = JSON.parse(JSON.stringify(tracker.groups()));
  const taintsBefore = tracker.taints();

  const probe = { subject: 'account:new', action: 'export', targetKey: 'slice:999', cost: 8 };
  const first = tracker.evaluateAction(probe);
  const second = tracker.evaluateAction(probe);
  assert.deepEqual(second, first, 'repeated calls return identical results');
  // Other probes: a member event, a no-target event, a shared-target probe.
  tracker.evaluateAction({ subject: 'account:s0', action: 'export', targetKey: 'slice:0', cost: 8 });
  tracker.evaluateAction({ subject: 'account:new', action: 'export', cost: 1 });
  tracker.evaluateAction({ subject: 'account:new', action: 'promo_claim', targetKey: 'promo:1', cost: 20 });
  tracker.evaluateAction({ subjectKey: 'account:new', action: 'export', targetKey: 'slice:998', cost: 8 });

  assert.deepEqual(
    JSON.parse(JSON.stringify(tracker.groups())),
    groupsBefore,
    'groups (clusters + flagged states) are identical after evaluateAction calls',
  );
  assert.deepEqual(tracker.taints(), taintsBefore, 'no taint is recorded');
  assert.equal(flags.length, 1, 'onFlag does not fire again');
});

test('17. action cohort: evaluateAction wouldJoin - flagged vs unflagged clusters, member, unrelated', () => {
  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({ onFlag });
  for (let i = 0; i < 8; i++) feedPair(tracker, `account:s${i}`, i * 2);
  assert.equal(flags.length, 1);
  const flagGroupId = flags[0].groupId;

  // A new subject whose disjoint target links into the flagged cluster.
  const joiner = tracker.evaluateAction({ subject: 'account:new', action: 'export', targetKey: 'slice:999', cost: 8 });
  const entry = joiner.clusters.find(c => c.groupId === flagGroupId);
  assert.ok(entry, 'the flagged cluster is reported');
  assert.equal(entry.mechanism, 'complement');
  assert.equal(entry.flagged, true);
  assert.equal(entry.wouldJoin, true);
  assert.deepEqual(joiner.sharedTargets, [], 'slice:999 is no shared-target group for a new subject view');

  // A subject already in the flagged cluster: flagged + wouldJoin.
  const member = tracker.evaluateAction({ subject: 'account:s3', action: 'export', targetKey: 'slice:1234', cost: 8 });
  const memberEntry = member.clusters.find(c => c.groupId === flagGroupId);
  assert.ok(memberEntry);
  assert.equal(memberEntry.flagged, true);
  assert.equal(memberEntry.wouldJoin, true);

  // An unrelated action has no clusters to join.
  const unrelated = tracker.evaluateAction({ subject: 'account:new', action: 'search', targetKey: 'corpus:1', cost: 8 });
  assert.deepEqual(unrelated.clusters, []);
  assert.deepEqual(unrelated.sharedTargets, []);

  // A same-action event with no target never joins.
  const noTarget = tracker.evaluateAction({ subject: 'account:new', action: 'export', cost: 8 });
  const noTargetEntry = noTarget.clusters.find(c => c.groupId === flagGroupId);
  assert.ok(noTargetEntry);
  assert.equal(noTargetEntry.wouldJoin, false);
  assert.equal(noTargetEntry.flagged, true);

  // Unflagged cluster: wouldJoin is true, flagged is false.
  const quiet = collectFlags();
  const tracker2 = sdk.createActionCohortTracker({ onFlag: quiet.onFlag });
  feedPair(tracker2, 'account:a', 0);
  feedPair(tracker2, 'account:b', 10);
  assert.equal(quiet.flags.length, 0);
  const quietEval = tracker2.evaluateAction({ subject: 'account:c', action: 'export', targetKey: 'slice:77', cost: 8 });
  assert.equal(quietEval.clusters.length, 1);
  assert.equal(quietEval.clusters[0].flagged, false);
  assert.equal(quietEval.clusters[0].wouldJoin, true);

  // Shared target: the flagged promo group is reported with its subject count.
  const promo = collectFlags();
  const tracker3 = sdk.createActionCohortTracker({ onFlag: promo.onFlag });
  for (let i = 0; i < 6; i++) {
    tracker3.observe({ subject: `account:p${i}`, action: 'promo_claim', targetKey: 'promo:1', cost: 20 });
  }
  assert.equal(promo.flags.length, 1);
  assert.equal(promo.flags[0].mechanism, 'shared-target');
  const sharedEval = tracker3.evaluateAction({ subject: 'account:p9', action: 'promo_claim', targetKey: 'promo:1', cost: 20 });
  assert.deepEqual(sharedEval.sharedTargets, [
    { action: 'promo_claim', targetKey: 'promo:1', flagged: true, subjectCount: 6 },
  ]);
  const otherPromo = tracker3.evaluateAction({ subject: 'account:p9', action: 'promo_claim', targetKey: 'promo:2', cost: 20 });
  assert.deepEqual(otherPromo.sharedTargets, []);
});

test('18. action cohort: complement friction materiality is UNIQUE-only - high cost with unique 0 is excluded', () => {
  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({ onFlag });
  // Duplicated-coverage member: one target (slice:0) that a herd member
  // also serves, at HIGH cost (50 >= the old cost floor of 9) - under
  // the pre-fix cost-OR rule this member was a friction target.
  tracker.observe({ subject: 'account:dup', action: 'export', targetKey: 'slice:0', cost: 50 });
  // Seven herd members with disjoint slice pairs; m0 also serves slice:0.
  for (let i = 0; i < 7; i++) feedPair(tracker, `account:m${i}`, i * 2);

  assert.equal(flags.length, 1);
  const flag = flags[0];
  assert.equal(flag.mechanism, 'complement');
  assert.ok(flag.members.includes('account:dup'), 'the duplicated member is in the flagged group');
  assert.equal(flag.memberUniqueTargetCounts['account:dup'], 0, 'its only target is duplicated by m0');
  assert.ok(flag.memberCost['account:dup'] >= 9, 'its cost alone would have passed the old cost floor');
  assert.ok(flag.memberUniqueTargetCounts['account:m0'] >= 1, 'm0 holds slice:1 uniquely');

  const targets = tracker.actionFrictionTargets(flag);
  assert.ok(!targets.includes('account:dup'), 'unique 0 -> zero friction for complement, however high the cost');
  assert.ok(targets.includes('account:m0'), 'unique >= 1 -> friction target');
  assert.deepEqual(sdk.actionFrictionTargets(flag), targets, 'standalone form agrees');
});

test('19. action cohort: shared-target friction materiality stays cost-based (unique 0 still targeted)', () => {
  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({ onFlag });
  for (let i = 0; i < 6; i++) {
    tracker.observe({ subject: `account:s${i}`, action: 'promo_claim', targetKey: 'promo:1', cost: 20 });
  }
  assert.equal(flags.length, 1);
  const flag = flags[0];
  assert.equal(flag.mechanism, 'shared-target');
  // On a shared target nobody holds anything uniquely...
  for (const member of flag.members) {
    assert.equal(flag.memberUniqueTargetCounts[member], 0);
  }
  // ...but cost 20 >= ceil(100/12) = 9 keeps every member a target.
  const targets = tracker.actionFrictionTargets(flag);
  assert.deepEqual([...targets].sort(), [...flag.members].sort(), 'cost-based materiality is unchanged for shared-target');
  assert.deepEqual(sdk.actionFrictionTargets(flag), targets, 'standalone form agrees');
});

test('20. action cohort: evaluateAction targetKnown - known target true, new target false, no target false; pure', () => {
  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({ onFlag });
  for (let i = 0; i < 8; i++) feedPair(tracker, `account:s${i}`, i * 2);
  assert.equal(flags.length, 1);
  const flagGroupId = flags[0].groupId;
  const groupsBefore = JSON.parse(JSON.stringify(tracker.groups()));

  // The cluster's refcount holds slice:0..slice:15 (feedPair targets).
  // A member aiming at a target the cluster already holds: known.
  const known = tracker.evaluateAction({ subject: 'account:s0', action: 'export', targetKey: 'slice:0', cost: 8 });
  const knownEntry = known.clusters.find(c => c.groupId === flagGroupId);
  assert.ok(knownEntry);
  assert.equal(knownEntry.targetKnown, true, 'target already in the cluster refcount');

  // Known-ness is a property of the cluster, not of membership: a
  // fresh subject aiming at the same held target also sees it known.
  const knownJoiner = tracker.evaluateAction({ subject: 'account:new', action: 'export', targetKey: 'slice:7', cost: 8 });
  assert.equal(knownJoiner.clusters.find(c => c.groupId === flagGroupId).targetKnown, true);

  // The same member aiming at a destination nobody in the cluster has
  // touched: not known (this is the coverage-extending join shape).
  const fresh = tracker.evaluateAction({ subject: 'account:s0', action: 'export', targetKey: 'slice:999', cost: 8 });
  const freshEntry = fresh.clusters.find(c => c.groupId === flagGroupId);
  assert.ok(freshEntry);
  assert.equal(freshEntry.targetKnown, false, 'new destination is not known to the cluster');
  assert.equal(freshEntry.wouldJoin, true, 'wouldJoin semantics unchanged by targetKnown');

  // No targetKey: never known.
  const noTarget = tracker.evaluateAction({ subject: 'account:s0', action: 'export', cost: 8 });
  assert.equal(noTarget.clusters.find(c => c.groupId === flagGroupId).targetKnown, false);

  // Purity is unchanged with the new field: no state moved, no flag.
  assert.deepEqual(JSON.parse(JSON.stringify(tracker.groups())), groupsBefore);
  assert.equal(flags.length, 1, 'no flag side effects');
});
