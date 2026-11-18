const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ABS-03 (upgrade attempt): a ban must not be frameable against an
// unproven identity. Neighbour measurement (abs-lab
// RESULTS-ABS-STEP0): ONE spoofed selenium request (XFF naming the
// victim) banned the victim for 600 s; the attacker's own next
// request was 200. antiRea ships no ban surface of its own, so the
// upgrade is an opt-in strict mode on the new ban guard: with
// `strictProvenIdentity: true`, a ban issues only against an
// identity bound to a server-side proof (the connection identity
// itself, an authenticated session, or a verified step-up proof
// bound to that same identity). A claim about an identity - a
// header, a fingerprint, a self-declared id - is not proof.

const VICTIM = '203.0.113.50';
const ATTACKER = '198.51.100.9';

test('ABS-03: strict mode refuses to ban an identity on an unproven claim', () => {
  const guard = sdk.createBanGuard({ strictProvenIdentity: true, now: () => 1_000_000 });
  // The neighbour attack, transposed: one request CLAIMING the
  // victim identity (spoofed header), no proof bound to the victim.
  const attempt = guard.issueBan(VICTIM, { claimedBy: ATTACKER });
  assert.equal(attempt.issued, false);
  assert.equal(attempt.reason, 'unproven_identity');
  assert.equal(guard.isBanned(VICTIM).banned, false); // victim's next request is a 200
  assert.equal(guard.isBanned(ATTACKER).banned, false);
});

test('ABS-03: strict mode refuses a proof bound to a DIFFERENT identity', () => {
  const guard = sdk.createBanGuard({ strictProvenIdentity: true, now: () => 1_000_000 });
  const attempt = guard.issueBan(VICTIM, {
    proof: { kind: 'step-up-proof', boundTo: ATTACKER, verified: true },
  });
  assert.equal(attempt.issued, false);
  assert.equal(attempt.reason, 'unproven_identity');
  assert.equal(guard.isBanned(VICTIM).banned, false);
});

test('ABS-03: strict mode bans when the proof is bound to the banned identity itself', () => {
  let now = 1_000_000;
  const guard = sdk.createBanGuard({ strictProvenIdentity: true, now: () => now });
  const issued = guard.issueBan(VICTIM, {
    proof: { kind: 'connection', boundTo: VICTIM, verified: true },
  });
  assert.equal(issued.issued, true);
  const state = guard.isBanned(VICTIM);
  assert.equal(state.banned, true);
  assert.equal(state.expiresAt, 1_000_000 + 600_000); // neighbour ban length: 600 s
  now += 600_001;
  assert.equal(guard.isBanned(VICTIM).banned, false);
});

test('ABS-03: an unverified proof never bans, even when bound to the identity', () => {
  const guard = sdk.createBanGuard({ strictProvenIdentity: true, now: () => 1_000_000 });
  const attempt = guard.issueBan(VICTIM, {
    proof: { kind: 'step-up-proof', boundTo: VICTIM, verified: false },
  });
  assert.equal(attempt.issued, false);
  assert.equal(guard.isBanned(VICTIM).banned, false);
});

test('ABS-03: the default (non-strict) mode keeps the legacy behavior, documented as frameable', () => {
  const guard = sdk.createBanGuard({ now: () => 1_000_000 });
  const issued = guard.issueBan(VICTIM, { claimedBy: ATTACKER });
  assert.equal(issued.issued, true);
  assert.equal(guard.isBanned(VICTIM).banned, true);
  // Hosts opt into strict mode to close exactly this; the guard
  // reports its own mode so the choice is auditable.
  assert.equal(guard.strictProvenIdentity, false);
});
