'use strict';
// NHS-11 error-rate burst - ADVISORY variant, measured here with
// lab-style fixtures replaying nhs-lab/nhs11.cjs sequences exactly.
// The lab's enforcement form (a real block) is NOT built: this
// signal sets burst/burstUntil and blocks nothing. Lab numbers in
// seconds are expressed in milliseconds (x1000).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const er = require('../dist/tier2-active/error-rate-signal.js');

test('A: burst flag set at the 5th 404 with burstUntil exactly 3604000; lookups 1-5 read not-burst', () => {
  const s = er.createErrorRateSignal(); // threshold 5, window 300 s, burst 3600 s
  const burstByRequest = [];
  let after5;
  for (let t = 0; t <= 7; t++) {
    const o = s.observe('A', 404, t * 1000);
    burstByRequest.push(o.burst);
    if (t === 4) after5 = o;
  }
  assert.deepEqual(burstByRequest.slice(0, 5), [false, false, false, false, false]);
  assert.deepEqual(burstByRequest.slice(5), [true, true, true], 'requests 6-8 read burst');
  assert.equal(after5.burstAfter, true, 'the 5th recorded 404 trips the flag');
  assert.equal(after5.burstUntil, 3604000, 'burstUntil = t(4 s) + 3600 s, the lab value x1000');
  assert.equal(after5.enforcement, 'none');
});

test('A: records while burst do not extend burstUntil; burst lifts after its TTL', () => {
  const s = er.createErrorRateSignal();
  for (let t = 0; t <= 7; t++) s.observe('A', 404, t * 1000);
  assert.equal(s.snapshot('A', 7000).burstUntil, 3604000, 'still 3604000 after records 6-8');
  assert.equal(s.snapshot('A', 3605000).burst, false, 'unblocked after the TTL (lab t=3605)');
});

test('B: only status >= 400 records - count is 3, never burst', () => {
  const s = er.createErrorRateSignal();
  const statuses = [404, 200, 404, 200, 404];
  const seen = statuses.map((status, t) => s.observe('B', status, t * 1000));
  assert.deepEqual(seen.map((o) => o.recorded), [true, false, true, false, true]);
  assert.ok(seen.every((o) => !o.burst && !o.burstAfter));
  assert.equal(s.snapshot('B', 4000).count, 3);
});

test('C: events at t=0 are pruned at t=301 s - count 0 before the new record, 1 after', () => {
  const s = er.createErrorRateSignal();
  for (let i = 0; i < 4; i++) s.observe('C', 404, 0);
  const before = s.snapshot('C', 301000);
  assert.equal(before.count, 0);
  assert.equal(before.burst, false);
  s.observe('C', 404, 301000);
  assert.equal(s.snapshot('C', 301000).count, 1);
});

test('per-identity isolation: B and C counts are independent of A', () => {
  const s = er.createErrorRateSignal();
  for (let t = 0; t <= 4; t++) s.observe('A', 404, t * 1000);
  assert.equal(s.snapshot('A', 4000).burst, true);
  assert.equal(s.snapshot('B', 4000).count, 0);
  assert.equal(s.snapshot('C', 4000).burst, false);
});
