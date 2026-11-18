const { test } = require('node:test');
const assert = require('node:assert/strict');
// ABP-04 EVERY-LADDER-RUNG-MUST-BE-REACHABLE-ON-FIRST-PARTY-SIGNALS-
// ALONE-OR-THE-DEPENDENCY-STATED: in the neighbour, the first-party-
// only cap was score 55 (degrade rung); block/tarpit needed trap hits
// or a low third-party score, stated nowhere. antiRea form: a design
// audit of the enforcement-tiering ladder - auditEnforcementLadder()
// derives each rung's reachability from maxEnforcementAction itself,
// and every unreachable rung must carry a stated dependency.
const sdk = require('../dist/index.js');

test('the audit covers all five rungs in ladder order', () => {
  const audit = sdk.auditEnforcementLadder();
  assert.deepEqual(
    audit.map(r => r.action),
    ['observe', 'step_up', 'budget_step_down', 'hard_ceiling', 'deny'],
  );
});

test('first-party cap: friction rungs are reachable on first-party signals alone', () => {
  const audit = sdk.auditEnforcementLadder();
  const byAction = Object.fromEntries(audit.map(r => [r.action, r]));
  assert.equal(byAction.observe.reachableOnFirstPartySignals, true);
  assert.equal(byAction.step_up.reachableOnFirstPartySignals, true);
  assert.equal(byAction.budget_step_down.reachableOnFirstPartySignals, true);
  assert.equal(byAction.observe.dependency, null);
  assert.equal(byAction.step_up.dependency, null);
  assert.equal(byAction.budget_step_down.dependency, null);
});

test('heavy rungs are NOT first-party reachable, and each states its dependency', () => {
  const audit = sdk.auditEnforcementLadder();
  const byAction = Object.fromEntries(audit.map(r => [r.action, r]));
  assert.equal(byAction.hard_ceiling.reachableOnFirstPartySignals, false);
  assert.match(byAction.hard_ceiling.dependency, /host-declared/);
  assert.match(byAction.hard_ceiling.dependency, /ceiling/);
  assert.equal(byAction.deny.reachableOnFirstPartySignals, false);
  assert.match(byAction.deny.dependency, /host-declared/);
  assert.match(byAction.deny.dependency, /ceiling/);
});

test('every rung is either reachable or carries a non-empty dependency (the ABP-04 rule)', () => {
  for (const rung of sdk.auditEnforcementLadder()) {
    assert.ok(typeof rung.basis === 'string' && rung.basis.length > 0, rung.action);
    if (rung.reachableOnFirstPartySignals) {
      assert.equal(rung.dependency, null, rung.action);
    } else {
      assert.ok(typeof rung.dependency === 'string' && rung.dependency.length > 0, rung.action);
    }
  }
});

test('the audit agrees with maxEnforcementAction on the defining contexts', () => {
  // First-party-only context (inferred, uncalibrated, gated): the cap
  // is the friction ceiling, exactly the audit's reachable boundary.
  assert.equal(
    sdk.maxEnforcementAction({ origin: 'inferred', calibrationTier: 'audit_only', tripwireGated: true }),
    'budget_step_down',
  );
  // Ungated inferred evidence reaches nothing past observe: even the
  // friction rungs depend on a gated first-party signal firing.
  assert.equal(
    sdk.maxEnforcementAction({ origin: 'inferred', calibrationTier: 'audit_only', tripwireGated: false }),
    'observe',
  );
  // The stated dependencies are real: satisfying them opens the rungs.
  assert.equal(
    sdk.maxEnforcementAction({ origin: 'inferred', calibrationTier: 'ceiling', tripwireGated: true }),
    'hard_ceiling',
  );
  assert.equal(
    sdk.maxEnforcementAction({ origin: 'host_declared', calibrationTier: 'ceiling', tripwireGated: false }),
    'deny',
  );
  assert.equal(
    sdk.maxEnforcementAction({ origin: 'host_declared', calibrationTier: 'audit_only', tripwireGated: false }),
    'hard_ceiling',
  );
});

test('clampEnforcement enforces the audited boundary (no rung is reachable by asking)', () => {
  const firstParty = { origin: 'inferred', calibrationTier: 'audit_only', tripwireGated: true };
  const hard = sdk.clampEnforcement('hard_ceiling', firstParty);
  assert.equal(hard.clamped, true);
  assert.equal(hard.action, 'budget_step_down');
  const deny = sdk.clampEnforcement('deny', firstParty);
  assert.equal(deny.clamped, true);
  assert.equal(deny.action, 'budget_step_down');
  const friction = sdk.clampEnforcement('budget_step_down', firstParty);
  assert.equal(friction.clamped, false);
  assert.equal(friction.budgetFloorRecords, sdk.SOFT_BUDGET_FLOOR_RECORDS);
});
