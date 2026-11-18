const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ABS-11 (upgrade attempt): subnet escalation needs a collateral
// bound. Neighbour measurement (abs-lab RESULTS-ABS-STEP0): 3 framed
// bans in one /24 (spoofed XFF victims .1/.2/.3) banned the whole
// /24 for 900 s; an innocent at .99 in the same /24 - never seen
// before - got 403 (scope "subnet"), while the neighbouring /24 was
// 200. The upgrade is an opt-in guard on the ban guard with three
// structural bounds:
//  1. Only PROVEN bans count toward escalation - framed (unproven)
//     bans cannot trigger it at all, however many are attempted.
//  2. Host-declared known-good identities are exempt from the subnet
//     ban even inside an escalated subnet.
//  3. The subnet ban duration is capped at the measured 900 s.

const NET = '203.0.113';
const proofFor = (id) => ({ kind: 'connection', boundTo: id, verified: true });

function makeGuard(now = () => 1_000_000) {
  return sdk.createBanGuard({
    strictProvenIdentity: true,
    now,
    subnetEscalation: { threshold: 3, subnetBanMs: 900_000 },
  });
}

test('ABS-11: three FRAMED bans in one /24 escalate nothing; the innocent at .99 stays served', () => {
  const guard = makeGuard();
  for (const host of ['1', '2', '3']) {
    const attempt = guard.issueBan(`${NET}.${host}`, { claimedBy: '198.51.100.9' });
    assert.equal(attempt.issued, false); // unproven: refused at issuance (ABS-03 strict mode)
  }
  assert.equal(guard.isBanned(`${NET}.99`).banned, false);
  assert.equal(guard.subnetBanFor(`${NET}.99`), null);
  assert.equal(guard.isBanned('203.0.114.99').banned, false); // neighbouring /24 control
});

test('ABS-11: three PROVEN bans escalate the /24, capped at 900 s, and the neighbouring /24 is untouched', () => {
  let now = 1_000_000;
  const guard = makeGuard(() => now);
  for (const host of ['1', '2', '3']) {
    assert.equal(guard.issueBan(`${NET}.${host}`, { proof: proofFor(`${NET}.${host}`) }).issued, true);
  }
  const subnet = guard.subnetBanFor(`${NET}.99`);
  assert.ok(subnet, 'subnet ban active after 3 proven bans');
  assert.equal(subnet.expiresAt, 1_000_000 + 900_000); // the measured 900 s, not a millisecond more
  assert.equal(guard.isBanned(`${NET}.99`).banned, true);
  assert.equal(guard.isBanned(`${NET}.99`).scope, 'subnet');
  assert.equal(guard.isBanned('203.0.114.99').banned, false);
  now += 900_001;
  assert.equal(guard.isBanned(`${NET}.99`).banned, false);
});

test('ABS-11: a host-declared known-good identity inside an escalated /24 is exempt', () => {
  const guard = makeGuard();
  guard.markKnownGood(`${NET}.99`);
  for (const host of ['1', '2', '3']) {
    guard.issueBan(`${NET}.${host}`, { proof: proofFor(`${NET}.${host}`) });
  }
  assert.ok(guard.subnetBanFor(`${NET}.98`), 'escalation fired for the subnet');
  assert.equal(guard.isBanned(`${NET}.99`).banned, false); // known-good collateral is bounded away
  assert.equal(guard.isBanned(`${NET}.98`).banned, true);
});

test('ABS-11: without the subnetEscalation opt-in, proven bans never escalate', () => {
  const guard = sdk.createBanGuard({ strictProvenIdentity: true, now: () => 1_000_000 });
  for (const host of ['1', '2', '3']) {
    guard.issueBan(`${NET}.${host}`, { proof: proofFor(`${NET}.${host}`) });
  }
  assert.equal(guard.subnetBanFor(`${NET}.99`), null);
  assert.equal(guard.isBanned(`${NET}.99`).banned, false);
});

test('ABS-11: non-IP identities never join a subnet', () => {
  const guard = makeGuard();
  assert.equal(guard.subnetBanFor('account:user-1'), null);
  assert.equal(guard.issueBan('account:user-1', { proof: { kind: 'authenticated', boundTo: 'account:user-1', verified: true } }).issued, true);
  assert.equal(guard.isBanned('account:user-1').scope, 'identity');
});
