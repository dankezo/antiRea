'use strict';
// WDN-07 PoW difficulty scaling - suite version of wdn-lab/wdn07.cjs.
// Frozen lab properties: scaling exact (residential/fresh 4, datacenter
// 5, +11 hits 5 and 6, limiter-exceeded 6) over the verbatim 45-CIDR
// table; the too-fast floor reads the server clock only (900 ms trips
// at 0.8/0.85, 2500 ms does not). The helper is a policy helper for
// host verifiers - it is not wired into any enforcement path.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pow = require('../dist/tier2-active/wdn-pow-policy.js');

const RES = '203.0.113.10';
const DC = '104.154.7.7';

test('the datacenter table is the verbatim 45-CIDR lab table and classifies the frozen IPs', () => {
  assert.equal(pow.DATACENTER_CIDRS.length, 45);
  assert.equal(pow.isDatacenterIp(DC), true); // inside 104.154.0.0/15
  assert.equal(pow.isDatacenterIp(RES), false); // in none
});

test('POW-SCALE exact: 4, 5, 5, 6, 6 across the frozen cases', () => {
  // hitCount is the limiter count at scaling time (the lab limiter
  // records the scaling check itself: 11 pre-loaded hits read as 12).
  assert.equal(pow.scalePowDifficulty({ ip: RES, hitCount: 1, limiterExceeded: false }), 4);
  assert.equal(pow.scalePowDifficulty({ ip: DC, hitCount: 1, limiterExceeded: false }), 5);
  assert.equal(pow.scalePowDifficulty({ ip: RES, hitCount: 12, limiterExceeded: false }), 5);
  assert.equal(pow.scalePowDifficulty({ ip: DC, hitCount: 12, limiterExceeded: false }), 6);
  assert.equal(pow.scalePowDifficulty({ ip: RES, hitCount: 20, limiterExceeded: true }), 6);
});

test('POW-FLOOR: a difficulty-4 solve at 900 ms server elapsed trips the too-fast detection; at 2500 ms it does not', () => {
  const fast = pow.evaluatePowTooFast(900);
  assert.equal(fast.tooFast, true);
  assert.equal(fast.detection.score, 0.8);
  assert.equal(fast.detection.confidence, 0.85);
  const slow = pow.evaluatePowTooFast(2500);
  assert.equal(slow.tooFast, false);
  assert.equal(slow.detection, null);
});
