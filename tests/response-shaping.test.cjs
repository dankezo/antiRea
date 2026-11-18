'use strict';
// NHS-16 throttle/shield forks - suite version of nhs-lab/nhs16.cjs,
// upgraded form: the egress-cap shield fork ships as opt-in
// response shaping; the tarpit drip leg is DROPPED (house rule), so
// the neither-row falls through with drip permanently false - a
// deliberate, documented divergence from the lab form, pinned here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rs = require('../dist/tier2-active/response-shaping.js');

test('throttle rows serve with throttled=1, an egress cap and no drip', () => {
  for (const rate of [1024, 2048]) {
    const r = rs.resolveResponseFork({ throttleRate: rate, shield: false });
    assert.equal(r.action, 'serve');
    assert.equal(r.throttled, 1);
    assert.equal(r.egressCapBytesPerSec, rate);
    assert.equal(r.drip, false);
  }
});

test('shield rows serve from cache with shield=1, origin untouched, no drip', () => {
  const r = rs.resolveResponseFork({ throttleRate: 0, shield: true });
  assert.equal(r.action, 'serve-cache');
  assert.equal(r.shield, 1);
  assert.equal(r.originTouched, false);
  assert.equal(r.drip, false);
});

test('both-set rows take the throttle fork', () => {
  for (const rate of [1024, 2048]) {
    const r = rs.resolveResponseFork({ throttleRate: rate, shield: true });
    assert.equal(r.throttled, 1);
    assert.equal(r.shield, 0);
    assert.equal(r.action, 'serve');
  }
});

test('GAP PINNED: the neither-row falls through WITHOUT the lab tarpit drip', () => {
  const r = rs.resolveResponseFork({ throttleRate: 0, shield: false });
  assert.equal(r.action, 'fallthrough');
  assert.equal(r.drip, false, 'the drip leg is dropped by house rule, not reproduced');
  assert.equal(r.throttled, 0);
  assert.equal(r.shield, 0);
});
