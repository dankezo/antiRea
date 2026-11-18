'use strict';
// NHS-10 velocity ring - suite version of nhs-lab/nhs10.cjs. Frozen
// expectations: identity A exceeds exactly at requests 11-12 of 12
// (a request never sees its own record); identity B never exceeds
// and its ring count is 3 including the 500 (status-blind).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vr = require('../dist/tier2-active/velocity-ring.js');

test('identity A exceeds exactly at requests 11-12 of 12', () => {
  const ring = vr.createVelocityRing(); // lab zone: threshold 10, interval 10 s, exceed 3600 s
  const exceeded = [];
  for (let t = 0; t <= 11; t++) {
    exceeded.push(ring.observe('A', t * 1000).exceeded);
  }
  assert.deepEqual(exceeded, [false, false, false, false, false, false, false, false, false, false, true, true]);
});

test('a request never sees its own record: request 10 checks against 9 prior records', () => {
  const ring = vr.createVelocityRing();
  let tenth;
  for (let t = 0; t <= 9; t++) tenth = ring.observe('A', t * 1000);
  assert.equal(tenth.exceeded, false);
  assert.equal(tenth.count, 9);
  assert.equal(tenth.enforcement, 'none');
});

test('identity B never exceeds; ring count is 3 including the 500 response (status-blind)', () => {
  const ring = vr.createVelocityRing();
  const exceeded = [];
  [200, 500, 200].forEach((status, i) => {
    // observe() takes no status at all: recording is status-blind by construction.
    exceeded.push(ring.observe('B', i * 1000).exceeded);
  });
  assert.deepEqual(exceeded, [false, false, false]);
  assert.equal(ring.check('B', 2000).count, 3);
});

test('per-identity isolation and window pruning', () => {
  const ring = vr.createVelocityRing({ threshold: 3, intervalMs: 10000, exceedMs: 60000 });
  ring.observe('C', 0); ring.observe('C', 0); ring.observe('C', 0);
  assert.equal(ring.check('D', 0).count, 0, 'another identity is unaffected');
  assert.equal(ring.check('C', 0).exceeded, true, 'C tripped at its 3rd record');
  const ring2 = vr.createVelocityRing({ threshold: 10, intervalMs: 10000, exceedMs: 60000 });
  for (let i = 0; i < 4; i++) ring2.record('E', 0);
  assert.equal(ring2.check('E', 301000).count, 0, 'events older than the interval are pruned');
  ring2.record('E', 301000);
  assert.equal(ring2.check('E', 301000).count, 1);
});
