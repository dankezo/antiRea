const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// L8d (PREREG-V261): the action-budget override propagation contract,
// measured 2026-11-02 against the built SDK with two
// createActionBudget instances over ONE shared transactional store.
//
// Measured pre-flush contract (pinned by tests 1-3 below):
// - An override is local to the setting instance until that instance
//   performs a mutation that actually persists state. A successful
//   reserve is such a mutation (even for a DIFFERENT subject: the
//   mirror syncs every locally touched subject).
// - With NO subsequent persisting mutation on the setting instance,
//   a second instance does NOT see the override: it decides on the
//   default allowance.
// - A REFUSED reserve does not persist the mirror (its transaction
//   returns no state), and neither does snapshot().
// flushOverrides() (tests 4-6) is the explicit way to publish an
// override - set or clear - without waiting for a reserve.

function pair(store, budgetId, extra = {}) {
  const opts = {
    store,
    budgetId,
    prices: { export: 10 },
    subjectAllowance: 100,
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
    ...extra,
  };
  return [sdk.createActionBudget(opts), sdk.createActionBudget(opts)];
}

// With override 15 and export cost 10, a decider that RESPECTS the
// override allows exactly one committed export for the subject and
// refuses the second (10 + 10 > 15); a decider on the default
// allowance (100) allows both.
async function secondExportAllowed(budget, subject) {
  const first = await budget.reserveAction({ subject, action: 'export' });
  assert.equal(first.allowed, true);
  await budget.commitAction(first.reservationId);
  const second = await budget.reserveAction({ subject, action: 'export' });
  return second;
}

test('1. overrides (pre-flush): a successful reserve on the setting instance propagates its override to a second instance', async () => {
  const store = sdk.createInMemoryTransactionalStore();
  const [a, b] = pair(store, 'l8d-pre-success');
  a.setAllowanceOverride('subj', 15);
  const aReserve = await a.reserveAction({ subject: 'subj', action: 'export' });
  assert.equal(aReserve.allowed, true);
  // A's reserve persisted the mirror: B now decides under 15, so a
  // second 10 on top of A's reserved 10 (20 > 15) is refused.
  const bReserve = await b.reserveAction({ subject: 'subj', action: 'export' });
  assert.equal(bReserve.allowed, false);
  assert.equal(bReserve.reason, 'subject_budget_exceeded');
});

test('2. overrides (pre-flush): with no mutation on the setting instance, a second instance does NOT see the override', async () => {
  const store = sdk.createInMemoryTransactionalStore();
  const [a, b] = pair(store, 'l8d-pre-none');
  a.setAllowanceOverride('subj', 15);
  // No A mutation at all: B still decides on the default 100.
  const second = await secondExportAllowed(b, 'subj');
  assert.equal(second.allowed, true, 'B allowed 20 total cost: it never saw the override of 15');
});

test('3. overrides (pre-flush): a refused reserve and a snapshot do not persist the mirror', async () => {
  // Refused reserve: the transaction returns no state, so sync is lost.
  {
    const store = sdk.createInMemoryTransactionalStore();
    const [a, b] = pair(store, 'l8d-pre-refused');
    a.setAllowanceOverride('subj', 15);
    const refused = await a.reserveAction({ subject: 'subj', action: 'export', cost: 999 });
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason, 'subject_budget_exceeded');
    const second = await secondExportAllowed(b, 'subj');
    assert.equal(second.allowed, true, 'refused reserve did not propagate the override');
  }
  // Snapshot: read-only by contract, it must not publish overrides.
  {
    const store = sdk.createInMemoryTransactionalStore();
    const [a, b] = pair(store, 'l8d-pre-snapshot');
    a.setAllowanceOverride('subj', 15);
    await a.snapshot();
    const second = await secondExportAllowed(b, 'subj');
    assert.equal(second.allowed, true, 'snapshot did not propagate the override');
  }
});

test('4. overrides: after A.flushOverrides(), B\'s next reserve respects A\'s override', async () => {
  const store = sdk.createInMemoryTransactionalStore();
  const [a, b] = pair(store, 'l8d-flush-set');
  a.setAllowanceOverride('subj', 15);
  const flushed = await a.flushOverrides();
  assert.deepEqual(flushed, { flushed: 1, mode: 'enforce', enforced: true });
  const second = await secondExportAllowed(b, 'subj');
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'subject_budget_exceeded');
});

test('5. overrides: after A clears an override and flushes, B sees the default again', async () => {
  const store = sdk.createInMemoryTransactionalStore();
  const [a, b] = pair(store, 'l8d-flush-clear');
  a.setAllowanceOverride('subj', 15);
  await a.flushOverrides();
  const first = await b.reserveAction({ subject: 'subj', action: 'export' });
  assert.equal(first.allowed, true);
  await b.commitAction(first.reservationId);
  const whileSet = await b.reserveAction({ subject: 'subj', action: 'export' });
  assert.equal(whileSet.allowed, false, 'override of 15 still in force before the clear');

  a.setAllowanceOverride('subj', null);
  const flushed = await a.flushOverrides();
  assert.equal(flushed.flushed, 1, 'a clear counts as one flushed entry');
  const afterClear = await b.reserveAction({ subject: 'subj', action: 'export' });
  assert.equal(afterClear.allowed, true, 'cleared + flushed: B is back on the default allowance of 100');
});

test('6. overrides: flushOverrides is a no-op-safe call, and in audit_only mode it writes but reports enforced:false', async () => {
  // Nothing pending: no write, no error, honest zero.
  const enforce = sdk.createActionBudget({
    store: sdk.createInMemoryTransactionalStore(),
    prices: { export: 10 },
  });
  assert.deepEqual(await enforce.flushOverrides(), { flushed: 0, mode: 'enforce', enforced: true });

  // audit_only: the get/put store still accepts the write, so B sees
  // the override - but the result must not claim CAS enforcement.
  const store = sdk.createInMemoryGetPutStore();
  const [a, b] = pair(store, 'l8d-flush-audit');
  assert.equal(a.mode, 'audit_only');
  a.setAllowanceOverride('subj', 15);
  const flushed = await a.flushOverrides();
  assert.deepEqual(flushed, { flushed: 1, mode: 'audit_only', enforced: false });
  const second = await secondExportAllowed(b, 'subj');
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'subject_budget_exceeded');
  assert.equal(second.enforced, false);
});
