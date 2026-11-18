const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ABS-10 (upgrade attempt): a temporary ban must have a challenge
// release valve. Neighbour measurement (abs-lab RESULTS-ABS-STEP0):
// a banned client completed the challenge verify (200, cookie set -
// verify is dispatched before the ban check) and its next request
// WITH the valid cookie was still 403; the ban record sat in storage
// until expiry - a dead end for a real user who just proved
// themselves. The upgrade is opt-in on the ban guard
// (`challengeRelease: true`): a verified challenge proof bound to
// the banned identity lifts the ban immediately.

const USER = '203.0.113.50';
const OTHER = '203.0.113.51';
const proofFor = (id) => ({ kind: 'step-up-proof', boundTo: id, verified: true });

function bannedGuard(options = {}) {
  const guard = sdk.createBanGuard({ now: () => 1_000_000, ...options });
  guard.issueBan(USER, {});
  assert.equal(guard.isBanned(USER).banned, true);
  return guard;
}

test('ABS-10: with the release valve enabled, a verified challenge proof lifts the ban at once', () => {
  const guard = bannedGuard({ challengeRelease: true });
  const released = guard.releaseViaChallenge(USER, proofFor(USER));
  assert.equal(released.released, true);
  assert.equal(guard.isBanned(USER).banned, false); // the next request is a 200, not a dead-end 403
});

test('ABS-10: without the opt-in, the neighbour dead end is the documented behavior', () => {
  const guard = bannedGuard({});
  const released = guard.releaseViaChallenge(USER, proofFor(USER));
  assert.equal(released.released, false);
  assert.equal(released.reason, 'release_valve_disabled');
  assert.equal(guard.isBanned(USER).banned, true);
});

test('ABS-10: a proof bound to another identity, or unverified, releases nothing', () => {
  const guard = bannedGuard({ challengeRelease: true });
  assert.equal(guard.releaseViaChallenge(USER, proofFor(OTHER)).released, false);
  assert.equal(
    guard.releaseViaChallenge(USER, { kind: 'step-up-proof', boundTo: USER, verified: false }).released,
    false,
  );
  assert.equal(guard.isBanned(USER).banned, true);
});

test('ABS-10: releasing an identity that is not banned is a no-op, not an error', () => {
  const guard = sdk.createBanGuard({ challengeRelease: true, now: () => 1_000_000 });
  const released = guard.releaseViaChallenge(USER, proofFor(USER));
  assert.equal(released.released, false);
  assert.equal(released.reason, 'not_banned');
});
