const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// PREREG-V261 L2: the two action-layer unit tests LIMITATIONS.md admits
// are missing in 2.6.0 - canary taint expiry, and shared-target
// supplementary re-announcement. Style mirrors tests/action-cohort.test.cjs.

function collectFlags() {
  const flags = [];
  return { flags, onFlag: s => flags.push(s) };
}

/** Feed one identity two disjoint export slices at cost 8 each. */
function feedPair(tracker, subject, firstSlice) {
  tracker.observe({ subject, action: 'export', targetKey: `slice:${firstSlice}`, cost: 8 });
  return tracker.observe({ subject, action: 'export', targetKey: `slice:${firstSlice + 1}`, cost: 8 });
}

test('L2 taint expiry: canary taint lives for the activity window only, then leaves taints() and flag snapshots', () => {
  let clock = 10_000_000;
  const windowMs = 900_000; // shipped default activity window (15 min)
  const registry = sdk.createCanaryActionRegistry();
  registry.registerCanaryTarget({ action: 'export', targetKey: 'export:slice:canary', label: 'never-linked slice' });

  const { flags, onFlag } = collectFlags();
  const tracker = sdk.createActionCohortTracker({
    onFlag,
    canaryRegistry: registry,
    now: () => clock,
    windowMs,
  });

  const A = 'account:tainted-a';
  const B = 'account:clean-b';

  // Subject A touches the canary target -> A alone is tainted.
  tracker.observe({ subject: A, action: 'export', targetKey: 'export:slice:canary', cost: 10 });
  let taints = tracker.taints();
  assert.equal(taints.length, 1);
  assert.equal(taints[0].subject, A);
  assert.equal(taints[0].action, 'export');
  assert.equal(taints[0].targetKey, 'export:slice:canary');
  assert.ok(!taints.some(t => t.subject === B), 'B is never tainted');

  // Before expiry: a flag snapshot on the same action class lists A in
  // taintedMembers. A and B are both members of the flagged complement
  // group (A + B + six others, disjoint slice pairs, cost 8 x 2 each).
  const others = ['account:s2', 'account:s3', 'account:s4', 'account:s5', 'account:s6', 'account:s7'];
  feedPair(tracker, A, 0);
  feedPair(tracker, B, 2);
  others.forEach((subject, i) => feedPair(tracker, subject, 4 + i * 2));

  assert.equal(flags.length, 1);
  const before = flags[0];
  assert.equal(before.mechanism, 'complement');
  assert.ok(before.members.includes(A), 'A is a member of the flagged group');
  assert.ok(before.members.includes(B), 'B is a member of the flagged group');
  assert.deepEqual(before.taintedMembers, [A], 'before expiry the snapshot lists A (and only A) as tainted');
  assert.ok(!tracker.taints().some(t => t.subject === B), 'B is still never tainted');

  // Advance time past the activity window.
  clock += windowMs + 1;

  taints = tracker.taints();
  assert.deepEqual(taints, [], 'after the window, taints() no longer lists A');
  assert.ok(!taints.some(t => t.subject === B), 'B is never tainted at any point');

  // A new flag snapshot on the same action class no longer lists A in
  // taintedMembers - even though A is a member of this new group too
  // (fresh, non-canary targets only, so nothing re-taints A).
  feedPair(tracker, A, 100);
  feedPair(tracker, B, 102);
  others.forEach((subject, i) => feedPair(tracker, subject, 104 + i * 2));

  assert.equal(flags.length, 2, 'a fresh flag fires for the post-expiry group');
  const after = flags[1];
  assert.ok(after.members.includes(A), 'A is a member of the post-expiry group');
  assert.ok(after.members.includes(B), 'B is a member of the post-expiry group');
  assert.ok(!after.taintedMembers.includes(A), 'after expiry the snapshot no longer lists A as tainted');
  assert.deepEqual(after.taintedMembers, []);
  assert.ok(!after.taintedMembers.includes(B), 'B is never tainted');
  assert.deepEqual(tracker.taints(), [], 'no taint survives the window');
});

test('L2 shared-target supplementary: late joiner re-announces the flagged group, coalesced inside 5s', () => {
  let clock = 20_000_000;
  const { flags, onFlag } = collectFlags();
  // Shipped defaults: shared-target floors >= 6 subjects / >= 100 cost,
  // supplementaryCooldownMs 5_000, activity window 900_000.
  const tracker = sdk.createActionCohortTracker({ onFlag, now: () => clock });
  const targetKey = 'promo:pool-1';

  // The group flags at the shipped floors: 6 distinct subjects,
  // 120 aggregate cost on ONE targetKey, same action.
  let last;
  for (let i = 0; i < 6; i++) {
    last = tracker.observe({ subject: `account:f${i}`, action: 'promo_claim', targetKey, cost: 20 });
  }
  assert.equal(flags.length, 1);
  const initial = flags[0];
  assert.equal(last.flag, initial);
  assert.equal(initial.mechanism, 'shared-target');
  assert.equal(initial.members.length, 6);
  assert.equal(initial.aggregateCost, 120);
  assert.equal(initial.targetCoverage, 1);
  assert.equal(initial.supplementary, undefined);

  // Past the 5s coalescing window, a late joiner acts on the same
  // target crossing materiality (cost 20 >= ceil(100/12) = 9):
  // a supplementary snapshot fires containing the joiner.
  clock += 6_000;
  const joinerObs = tracker.observe({ subject: 'account:late-joiner', action: 'promo_claim', targetKey, cost: 20 });
  assert.ok(joinerObs.flag, 'the late joiner produces a supplementary snapshot');
  assert.equal(joinerObs.flag.supplementary, true);
  assert.equal(joinerObs.flag.mechanism, 'shared-target');
  assert.ok(joinerObs.flag.members.includes('account:late-joiner'), 'supplementary snapshot contains the joiner');
  assert.equal(joinerObs.flag.aggregateCost, 140);
  assert.equal(flags.length, 2);
  assert.equal(flags[1], joinerObs.flag);

  // A second material event inside the 5s coalescing window produces
  // NO additional snapshot.
  const secondObs = tracker.observe({ subject: 'account:second-joiner', action: 'promo_claim', targetKey, cost: 20 });
  assert.equal(secondObs.recorded, true);
  assert.equal(secondObs.flag, undefined, 'coalescing: no extra snapshot inside 5s');
  assert.equal(flags.length, 2, 'still exactly the initial + one supplementary snapshot');
  const group = tracker.groups().find(g => g.mechanism === 'shared-target' && g.targetKey === targetKey);
  assert.ok(group, 'the shared-target group still exists');
  assert.ok(group.members.includes('account:second-joiner'), 'the second joiner was recorded - only its announcement was coalesced');
});
