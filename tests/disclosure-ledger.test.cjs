const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const ids = (from, count) => Array.from({ length: count }, (_, i) => from + i);

function enforceLedger(overrides = {}) {
  return sdk.createDisclosureLedger({
    store: sdk.createInMemoryTransactionalStore(),
    ceilingLimit: 100,
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
    ...overrides,
  });
}

test('ledger: transactional store yields enforce mode and an honest note', () => {
  const ledger = enforceLedger();
  assert.equal(ledger.mode, 'enforce');
  assert.match(ledger.enforcementNote, /CAS/);
});

test('ledger: get/put-only store yields audit_only mode and enforced:false decisions', async () => {
  const ledger = sdk.createDisclosureLedger({
    store: sdk.createInMemoryGetPutStore(),
    ceilingLimit: 10,
  });
  assert.equal(ledger.mode, 'audit_only');
  assert.match(ledger.enforcementNote, /audit only/);
  const result = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 3) });
  assert.equal(result.allowed, true);
  assert.equal(result.enforced, false);
  assert.equal(result.mode, 'audit_only');
});

test('ledger CONFORMANCE: parallel reservations never jointly overspend the ceiling', async () => {
  // Slow async store: without the transaction mutex, check-then-write
  // races would let all 40 reservations read the same empty state.
  const ledger = sdk.createDisclosureLedger({
    store: sdk.createInMemoryTransactionalStore({ ioDelayMs: 5 }),
    ceilingLimit: 100,
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
  });
  const subjects = Array.from({ length: 40 }, (_, i) => `account:s${i}`);
  const results = await Promise.all(
    subjects.map((subject, i) => ledger.reserveDisclosure({ subject, recordIds: ids(i * 10, 10) })),
  );
  const allowed = results.filter(r => r.allowed);
  const refused = results.filter(r => !r.allowed);
  const totalNew = allowed.reduce((sum, r) => sum + r.newRecords, 0);
  assert.equal(totalNew, 100, 'exactly the ceiling may be reserved in parallel, never more');
  assert.equal(allowed.length, 10);
  assert.equal(refused.length, 30);
  assert.ok(refused.every(r => r.reason === 'ceiling_exceeded'));
  for (const r of allowed) await ledger.commitReservation(r.reservationId);
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.committedRecords, 100);
  const oneMore = await ledger.reserveDisclosure({ subject: 'account:late', recordIds: [9999] });
  assert.equal(oneMore.allowed, false);
  assert.equal(oneMore.reason, 'ceiling_exceeded');
});

test('ledger: re-delivery of already-committed records is free', async () => {
  const ledger = enforceLedger({ ceilingLimit: 5 });
  const first = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 5) });
  await ledger.commitReservation(first.reservationId);
  const again = await ledger.reserveDisclosure({ subject: 'account:b', recordIds: ids(0, 5) });
  assert.equal(again.allowed, true);
  assert.equal(again.newRecords, 0);
});

test('ledger: reservation bounds - max outstanding per subject', async () => {
  const ledger = enforceLedger();
  await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 1) });
  await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(10, 1) });
  const third = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(20, 1) });
  assert.equal(third.allowed, false);
  assert.equal(third.reason, 'too_many_outstanding');
  const other = await ledger.reserveDisclosure({ subject: 'account:b', recordIds: ids(20, 1) });
  assert.equal(other.allowed, true);
});

test('ledger: reservation bounds - per-subject reserved record cap', async () => {
  const ledger = enforceLedger({ reservation: { maxReservedRecordsPerSubject: 10 } });
  const tooBig = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 11) });
  assert.equal(tooBig.allowed, false);
  assert.equal(tooBig.reason, 'subject_reservation_cap');
});

test('ledger: reservation bounds - cohort-wide outstanding cap', async () => {
  const ledger = enforceLedger({ reservation: { cohortOutstandingCap: 15 } });
  assert.equal((await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 10) })).allowed, true);
  const second = await ledger.reserveDisclosure({ subject: 'account:b', recordIds: ids(100, 10) });
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'cohort_reservation_cap');
});

test('ledger: reservations expire lazily and via sweep, freeing the ceiling', async () => {
  let clock = 1_000_000;
  const ledger = enforceLedger({
    ceilingLimit: 10,
    reservation: { ttlMs: 1_000 },
    now: () => clock,
  });
  const held = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 10) });
  assert.equal(held.allowed, true);
  const blocked = await ledger.reserveDisclosure({ subject: 'account:b', recordIds: ids(100, 1) });
  assert.equal(blocked.allowed, false);
  clock += 1_001;
  const swept = await ledger.sweepExpired();
  assert.equal(swept.expired, 1);
  const after = await ledger.reserveDisclosure({ subject: 'account:b', recordIds: ids(100, 10) });
  assert.equal(after.allowed, true);
});

test('ledger: long reservations require host authorization and outlive the normal TTL', async () => {
  let clock = 5_000_000;
  const ledger = enforceLedger({
    reservation: { ttlMs: 1_000, longTtlMs: 60_000 },
    now: () => clock,
  });
  const refused = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 2), longReservation: true });
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, 'long_reservation_not_authorized');
  const granted = await ledger.reserveDisclosure({
    subject: 'account:a', recordIds: ids(0, 2), longReservation: true, hostAuthorizedLong: true,
  });
  assert.equal(granted.allowed, true);
  clock += 5_000; // beyond the normal TTL, inside the long TTL
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.outstandingReservations, 1);
});

test('ledger: registry completeness - unregistered subjects fail closed by default', async () => {
  const ledger = enforceLedger();
  await ledger.declareRegistry(['account:a']);
  const stranger = await ledger.reserveDisclosure({ subject: 'account:b', recordIds: ids(0, 1) });
  assert.equal(stranger.allowed, false);
  assert.equal(stranger.reason, 'unregistered_subject');
  const member = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 1) });
  assert.equal(member.allowed, true);
  const completeness = await ledger.checkRegistryCompleteness(['account:a', 'account:b', 'account:c']);
  assert.equal(completeness.declared, true);
  assert.equal(completeness.complete, false);
  assert.deepEqual(completeness.missing, ['account:b', 'account:c']);
});

test('ledger: registry audit_only policy flags instead of refusing', async () => {
  const ledger = enforceLedger({ unregisteredPolicy: 'audit_only' });
  await ledger.declareRegistry(['account:a']);
  const result = await ledger.reserveDisclosure({ subject: 'account:b', recordIds: ids(0, 1) });
  assert.equal(result.allowed, true);
  assert.equal(result.auditFlag, 'unregistered_subject');
});

test('ledger: idempotency key returns the original reservation, counted once', async () => {
  const ledger = enforceLedger();
  const first = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 4), idempotencyKey: 'k-1' });
  const dupe = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 4), idempotencyKey: 'k-1' });
  assert.equal(dupe.allowed, true);
  assert.equal(dupe.duplicate, true);
  assert.equal(dupe.reservationId, first.reservationId);
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.reservedRecords, 4);
  assert.equal(snapshot.outstandingReservations, 1);
});

test('ledger: rate bucket refuses with retryAfterMs and refills over time', async () => {
  let clock = 9_000_000;
  const ledger = sdk.createDisclosureLedger({
    store: sdk.createInMemoryTransactionalStore(),
    ceilingLimit: 1000,
    bucket: { burst: 5, refillPerSecond: 10 },
    now: () => clock,
  });
  const tooFast = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 6) });
  assert.equal(tooFast.allowed, false);
  assert.equal(tooFast.reason, 'rate_limited');
  assert.ok(tooFast.retryAfterMs >= 100);
  clock += 1_000; // +10 tokens, capped at burst... burst is 5, so ask for 5
  const ok = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 5) });
  assert.equal(ok.allowed, true);
});

test('ledger: release frees reserved records back under the ceiling', async () => {
  const ledger = enforceLedger({ ceilingLimit: 10 });
  const held = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: ids(0, 10) });
  assert.equal((await ledger.reserveDisclosure({ subject: 'account:b', recordIds: [500] })).allowed, false);
  assert.equal((await ledger.releaseReservation(held.reservationId)).released, true);
  assert.equal((await ledger.reserveDisclosure({ subject: 'account:b', recordIds: ids(100, 10) })).allowed, true);
});

test('ledger: evidence accumulates inside the same transactional state', async () => {
  const ledger = enforceLedger();
  await ledger.recordEvidence('cusum:coh:x', 1.5);
  const second = await ledger.recordEvidence('cusum:coh:x', 0.5);
  assert.equal(second.value, 2);
  assert.equal(second.enforced, true);
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.evidence['cusum:coh:x'], 2);
});

test('bucket min-merge: merged cohort bucket never resets upward', () => {
  const merged = sdk.mergeCohortBucketStates(
    { tokens: 40, lastRefillMs: 100, burst: 150, refillPerSecond: 5 },
    { tokens: 12, lastRefillMs: 250, burst: 150, refillPerSecond: 3 },
  );
  assert.equal(merged.tokens, 12);
  assert.equal(merged.refillPerSecond, 3);
  assert.equal(merged.lastRefillMs, 250);
});
