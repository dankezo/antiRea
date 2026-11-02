const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// Spec: FEATURE-PROTECTION-SPEC.md section 4, tests 1-8 (action budget).

function enforceBudget(overrides = {}) {
  return sdk.createActionBudget({
    store: sdk.createInMemoryTransactionalStore(),
    prices: { export: 10, promo_claim: 5 },
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
    ...overrides,
  });
}

test('1. action budget: transactional store -> enforce + CAS note; get/put store -> audit_only + enforced:false', async () => {
  const enforce = enforceBudget({ prices: { export: 10, search: 25 } });
  assert.equal(enforce.mode, 'enforce');
  assert.match(enforce.enforcementNote, /CAS/);
  assert.equal(enforce.derivedSoftFloorCost, 25, 'derived floor = max single-action price');
  const granted = await enforce.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(granted.allowed, true);
  assert.equal(granted.enforced, true);
  assert.equal(granted.mode, 'enforce');
  assert.equal(granted.cost, 10, 'price table supplies the default cost');

  const audit = sdk.createActionBudget({
    store: sdk.createInMemoryGetPutStore(),
    prices: { export: 10 },
  });
  assert.equal(audit.mode, 'audit_only');
  assert.match(audit.enforcementNote, /audit only/);
  const decision = await audit.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(decision.allowed, true);
  assert.equal(decision.enforced, false);
  assert.equal(decision.mode, 'audit_only');
});

test('2. action budget: reserve/commit/release accounting is exact', async () => {
  const budget = enforceBudget({ subjectAllowance: 100 });

  const r1 = await budget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(r1.allowed, true);
  let snap = await budget.snapshot();
  assert.equal(snap.subjects['account:a'].reservedCost, 10);
  assert.equal(snap.subjects['account:a'].committedCost, 0);
  assert.equal(snap.reservedCost, 10);
  assert.equal(snap.outstandingReservations, 1);

  assert.equal((await budget.commitAction(r1.reservationId)).committed, true);
  snap = await budget.snapshot();
  assert.equal(snap.subjects['account:a'].reservedCost, 0);
  assert.equal(snap.subjects['account:a'].committedCost, 10);
  assert.equal(snap.committedCost, 10);
  assert.equal(snap.outstandingReservations, 0);

  const r2 = await budget.reserveAction({ subject: 'account:a', action: 'export', cost: 40 });
  assert.equal(r2.allowed, true);
  assert.equal((await budget.releaseAction(r2.reservationId)).released, true);
  snap = await budget.snapshot();
  assert.equal(snap.subjects['account:a'].reservedCost, 0, 'release frees the reserved cost');
  assert.equal(snap.subjects['account:a'].committedCost, 10, 'release does not touch committed cost');

  // The released 40 is spendable again: 10 committed + 90 = the 100 allowance exactly.
  const r3 = await budget.reserveAction({ subject: 'account:a', action: 'export', cost: 90 });
  assert.equal(r3.allowed, true);
  await budget.commitAction(r3.reservationId);
  const over = await budget.reserveAction({ subject: 'account:a', action: 'export', cost: 1 });
  assert.equal(over.allowed, false);
  assert.equal(over.reason, 'subject_budget_exceeded');

  assert.equal((await budget.commitAction('act_9999')).committed, false);
  assert.equal((await budget.releaseAction('act_9999')).released, false);
});

test('3. action budget CONFORMANCE: 40 parallel reserves against a declared cohort ceiling of exactly 100 cost', async () => {
  const budget = sdk.createActionBudget({
    store: sdk.createInMemoryTransactionalStore({ ioDelayMs: 5 }),
    prices: { export: 10 },
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
  });
  const subjects = Array.from({ length: 40 }, (_, i) => `account:s${i}`);
  await budget.declareActionCohort({ cohortId: 'herd', subjects, ceilingCostPerWindow: 100 });
  const results = await Promise.all(
    subjects.map(subject => budget.reserveAction({ subject, action: 'export', cohortId: 'herd' })),
  );
  const granted = results.filter(r => r.allowed);
  const refused = results.filter(r => !r.allowed);
  const grantedCost = granted.reduce((sum, r) => sum + r.cost, 0);
  assert.equal(grantedCost, 100, 'exactly the ceiling may be granted in parallel, never more');
  assert.equal(granted.length, 10);
  assert.equal(refused.length, 30);
  assert.ok(refused.every(r => r.reason === 'cohort_ceiling_exceeded'));
});

test('4. action budget: subject allowance refuses at cap; the window refill restores', async () => {
  let clock = 1_000_000;
  const budget = enforceBudget({
    subjectAllowance: 30,
    windowMs: 60_000,
    now: () => clock,
  });
  for (let i = 0; i < 3; i++) {
    const r = await budget.reserveAction({ subject: 'account:a', action: 'export' });
    assert.equal(r.allowed, true);
    await budget.commitAction(r.reservationId);
  }
  const atCap = await budget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(atCap.allowed, false);
  assert.equal(atCap.reason, 'subject_budget_exceeded');

  clock += 60_000; // window rolls: committed cost resets
  const after = await budget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(after.allowed, true);

  // A per-subject override replaces the allowance (the step-down landing point).
  budget.setAllowanceOverride('account:b', 15);
  const b1 = await budget.reserveAction({ subject: 'account:b', action: 'export' });
  assert.equal(b1.allowed, true);
  await budget.commitAction(b1.reservationId);
  const b2 = await budget.reserveAction({ subject: 'account:b', action: 'export' });
  assert.equal(b2.allowed, false);
  assert.equal(b2.reason, 'subject_budget_exceeded');
  budget.setAllowanceOverride('account:b', null);
  const b3 = await budget.reserveAction({ subject: 'account:b', action: 'export' });
  assert.equal(b3.allowed, true);
});

test('5. action budget: reservation bounds - TTL sweep, outstanding cap, idempotency', async () => {
  // TTL expiry via sweep.
  let clock = 2_000_000;
  const ttlBudget = enforceBudget({ reservation: { ttlMs: 1_000 }, now: () => clock });
  const held = await ttlBudget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(held.allowed, true);
  clock += 1_001;
  assert.equal((await ttlBudget.sweepExpired()).expired, 1);
  assert.equal((await ttlBudget.snapshot()).outstandingReservations, 0);
  const recommitted = await ttlBudget.commitAction(held.reservationId);
  assert.equal(recommitted.committed, false, 'an expired reservation can no longer commit');

  // Per-subject outstanding cap.
  const capBudget = enforceBudget();
  await capBudget.reserveAction({ subject: 'account:a', action: 'export' });
  await capBudget.reserveAction({ subject: 'account:a', action: 'export' });
  const third = await capBudget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(third.allowed, false);
  assert.equal(third.reason, 'too_many_outstanding');
  const other = await capBudget.reserveAction({ subject: 'account:b', action: 'export' });
  assert.equal(other.allowed, true);

  // Idempotency: a duplicate key returns the original, counted once.
  const idemBudget = enforceBudget();
  const first = await idemBudget.reserveAction({ subject: 'account:a', action: 'export', idempotencyKey: 'k-1' });
  const dupe = await idemBudget.reserveAction({ subject: 'account:a', action: 'export', idempotencyKey: 'k-1' });
  assert.equal(dupe.allowed, true);
  assert.equal(dupe.duplicate, true);
  assert.equal(dupe.reservationId, first.reservationId);
  const snap = await idemBudget.snapshot();
  assert.equal(snap.outstandingReservations, 1);
  assert.equal(snap.reservedCost, 10);
});

test('6. action budget: declared cohort is armed at declaration; non-member and unknown cohort fail closed', async () => {
  const budget = enforceBudget();
  const declared = await budget.declareActionCohort({
    cohortId: 'campaign',
    subjects: ['account:a', 'account:b'],
    ceilingCostPerWindow: 25,
  });
  assert.equal(declared.registered, 2);

  // Armed from the FIRST action - no flag, no crossing needed.
  const a1 = await budget.reserveAction({ subject: 'account:a', action: 'export', cohortId: 'campaign' });
  assert.equal(a1.allowed, true);
  await budget.commitAction(a1.reservationId);
  const a2 = await budget.reserveAction({ subject: 'account:a', action: 'export', cohortId: 'campaign' });
  assert.equal(a2.allowed, true);
  await budget.commitAction(a2.reservationId);
  const a3 = await budget.reserveAction({ subject: 'account:a', action: 'export', cohortId: 'campaign' });
  assert.equal(a3.allowed, false);
  assert.equal(a3.reason, 'cohort_ceiling_exceeded', '20 committed + 10 more crosses the 25 ceiling');

  const stranger = await budget.reserveAction({ subject: 'account:c', action: 'export', cohortId: 'campaign' });
  assert.equal(stranger.allowed, false);
  assert.equal(stranger.reason, 'unregistered_subject');

  const unknown = await budget.reserveAction({ subject: 'account:a', action: 'export', cohortId: 'never-declared' });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.reason, 'unknown_cohort');
});

test('7. action budget: step-down clamp - inferred cohorts stop at the derived floor; declared may reach 0', async () => {
  const budget = enforceBudget(); // prices {export:10, promo_claim:5} -> floor 10
  assert.equal(budget.derivedSoftFloorCost, 10);
  const inferred = { origin: 'inferred', calibrationTier: 'audit_only', tripwireGated: true };

  const hardCut = budget.clampActionStepDown(100, 0, inferred);
  assert.equal(hardCut.limit, 10, 'a hard cut for an inferred cohort lands on the derived floor, never 0');
  assert.equal(hardCut.floored, true);
  assert.equal(hardCut.applied, true);

  const belowFloor = budget.clampActionStepDown(100, 5, inferred);
  assert.equal(belowFloor.limit, 10);
  assert.equal(belowFloor.floored, true);

  const withinLaw = budget.clampActionStepDown(100, 30, inferred);
  assert.equal(withinLaw.limit, 30);
  assert.equal(withinLaw.floored, false);

  // The hard_ceiling request itself is clamped by clampEnforcement reuse.
  const clamped = sdk.clampEnforcement('hard_ceiling', inferred);
  assert.equal(clamped.clamped, true);
  assert.equal(clamped.action, 'budget_step_down');

  // Standalone form: the floor travels with the context.
  const standalone = sdk.clampActionStepDown(100, 0, { ...inferred, derivedSoftFloorCost: 10 });
  assert.equal(standalone.limit, 10);
  assert.equal(standalone.floored, true);

  // Declared cohort: may go to 0.
  const declared = budget.clampActionStepDown(100, 0, { origin: 'host_declared', calibrationTier: 'audit_only' });
  assert.equal(declared.limit, 0);
  assert.equal(declared.applied, true);
  assert.equal(declared.floored, false);

  // Inferred but never gated: no step-down is available at all.
  const ungated = budget.clampActionStepDown(100, 0, { origin: 'inferred', calibrationTier: 'audit_only' });
  assert.equal(ungated.limit, 100);
  assert.equal(ungated.applied, false);
});

test('8. action budget: cohort pacing refuses rate_limited with retryAfterMs, spares unlisted subjects, refills', async () => {
  let clock = 3_000_000;
  const budget = enforceBudget({ subjectAllowance: 10_000, now: () => clock });
  const applied = await budget.setCohortPacing({
    cohortKey: 'flagged',
    subjects: ['account:a', 'account:b'],
    burst: 20,
    refillPerSecond: 1,
  });
  assert.equal(applied.applied, true);

  for (let i = 0; i < 2; i++) {
    const r = await budget.reserveAction({ subject: 'account:a', action: 'export' });
    assert.equal(r.allowed, true);
    await budget.commitAction(r.reservationId);
  }
  const paced = await budget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(paced.allowed, false);
  assert.equal(paced.reason, 'rate_limited');
  assert.equal(paced.retryAfterMs, 10_000, 'deficit 10 cost at 1 token/s');

  const unlisted = await budget.reserveAction({ subject: 'account:c', action: 'export' });
  assert.equal(unlisted.allowed, true, 'pacing never applies to unlisted subjects');
  await budget.releaseAction(unlisted.reservationId);

  clock += 10_000; // +10 tokens: pacing is a rate, service restores
  const restored = await budget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(restored.allowed, true);
  await budget.commitAction(restored.reservationId);

  assert.equal((await budget.clearCohortPacing('flagged')).cleared, true);
  assert.equal((await budget.clearCohortPacing('flagged')).cleared, false);
  const afterClear = await budget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(afterClear.allowed, true, 'cleared pacing no longer refuses');
});

test('9. action budget: re-applying cohort pacing with a grown subject list preserves the spent bucket (no fresh burst)', async () => {
  let clock = 4_000_000;
  const budget = enforceBudget({ subjectAllowance: 10_000, now: () => clock });
  await budget.setCohortPacing({
    cohortKey: 'export',
    subjects: ['account:a'],
    burst: 20,
    refillPerSecond: 1,
  });
  // Drain the burst: two exports at cost 10 each.
  for (let i = 0; i < 2; i++) {
    const r = await budget.reserveAction({ subject: 'account:a', action: 'export' });
    assert.equal(r.allowed, true);
    await budget.commitAction(r.reservationId);
  }
  const drained = await budget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(drained.allowed, false);
  assert.equal(drained.reason, 'rate_limited');

  // Re-apply pacing for the same scope with a grown membership.
  await budget.setCohortPacing({
    cohortKey: 'export',
    subjects: ['account:a', 'account:b'],
    burst: 20,
    refillPerSecond: 1,
  });

  // The spent bucket survives the re-apply: no fresh burst for the
  // existing member, and the new member joins the SAME drained
  // bucket rather than minting one of its own.
  const stillBlocked = await budget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(stillBlocked.allowed, false, 're-apply must not mint a fresh burst');
  assert.equal(stillBlocked.reason, 'rate_limited');
  const joinerBlocked = await budget.reserveAction({ subject: 'account:b', action: 'export' });
  assert.equal(joinerBlocked.allowed, false, 'new member inherits the spent bucket');
  assert.equal(joinerBlocked.reason, 'rate_limited');

  // Refill keeps running from the preserved clock: +10s at 1 token/s
  // restores exactly one export, now spendable by the new member.
  clock += 10_000;
  const restored = await budget.reserveAction({ subject: 'account:b', action: 'export' });
  assert.equal(restored.allowed, true);
  await budget.commitAction(restored.reservationId);
});

test('10. action budget: idempotency replay with different subject/action/cost is refused (F-01)', async () => {
  const budget = enforceBudget();
  const first = await budget.reserveAction({ subject: 'account:a', action: 'export', idempotencyKey: 'k-9' });
  assert.equal(first.allowed, true);
  assert.equal(first.cost, 10);

  // Audit harness V2: another subject replays the key for a different
  // action. Pre-fix this returned allowed:true + duplicate:true with
  // the ORIGINAL subject's cost.
  const otherSubject = await budget.reserveAction({ subject: 'account:b', action: 'promo_claim', idempotencyKey: 'k-9' });
  assert.equal(otherSubject.allowed, false);
  assert.equal(otherSubject.reason, 'idempotency_conflict');

  // Same subject, different action.
  const otherAction = await budget.reserveAction({ subject: 'account:a', action: 'promo_claim', idempotencyKey: 'k-9' });
  assert.equal(otherAction.allowed, false);
  assert.equal(otherAction.reason, 'idempotency_conflict');

  // Same subject and action, different explicit cost.
  const otherCost = await budget.reserveAction({ subject: 'account:a', action: 'export', cost: 1, idempotencyKey: 'k-9' });
  assert.equal(otherCost.allowed, false);
  assert.equal(otherCost.reason, 'idempotency_conflict');

  // The exact replay is still honored as a duplicate, charged once.
  const dupe = await budget.reserveAction({ subject: 'account:a', action: 'export', idempotencyKey: 'k-9' });
  assert.equal(dupe.allowed, true);
  assert.equal(dupe.duplicate, true);
  assert.equal(dupe.reservationId, first.reservationId);
  assert.equal(dupe.cost, 10);
  const snap = await budget.snapshot();
  assert.equal(snap.outstandingReservations, 1);
  assert.equal(snap.reservedCost, 10);
});

test('11. action budget: corrupt or dead store yields store_conflict, never throws (F-06)', async () => {
  // Truncated JSON in a get/put store.
  const corrupt = sdk.createInMemoryGetPutStore();
  await corrupt.put('antirea:action-budget:default', '{"version":1,"subjects":');
  const budgetA = sdk.createActionBudget({ store: corrupt, prices: { export: 10 } });
  const reserveA = await budgetA.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(reserveA.allowed, false);
  assert.equal(reserveA.reason, 'store_conflict');
  const commitA = await budgetA.commitAction('act_1');
  assert.deepEqual(commitA, { committed: false, reason: 'store_conflict' });
  const releaseA = await budgetA.releaseAction('act_1');
  assert.equal(releaseA.released, false);
  assert.equal(releaseA.reason, 'store_conflict');
  const declareA = await budgetA.declareActionCohort({ cohortId: 'c1', subjects: ['account:a'], ceilingCostPerWindow: 100 });
  assert.equal(declareA.registered, 0);
  assert.equal(declareA.reason, 'store_conflict');
  const snapshotA = await budgetA.snapshot();
  assert.equal(snapshotA.storeError, 'store_conflict');

  // Valid JSON, wrong shape.
  const wrongShape = sdk.createInMemoryGetPutStore();
  await wrongShape.put('antirea:action-budget:default', '{"version":1}');
  const budgetB = sdk.createActionBudget({ store: wrongShape, prices: { export: 10 } });
  const reserveB = await budgetB.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(reserveB.allowed, false);
  assert.equal(reserveB.reason, 'store_conflict');

  // Corrupt content behind a TRANSACTIONAL store: its transactLedger
  // parses the same key the budget transacts under and would throw.
  const txStore = sdk.createInMemoryTransactionalStore();
  await txStore.put('antirea:ledger:action-budget:default', '{"version":1,"subjects":');
  const budgetC = sdk.createActionBudget({ store: txStore, prices: { export: 10 } });
  const reserveC = await budgetC.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(reserveC.allowed, false);
  assert.equal(reserveC.reason, 'store_conflict');
  const commitC = await budgetC.commitAction('act_1');
  assert.deepEqual(commitC, { committed: false, reason: 'store_conflict' });
});
