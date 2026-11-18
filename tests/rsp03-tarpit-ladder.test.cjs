const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

test('RSP-03 ladder readings at grants 0,1,2,3,4,10 are 30,60,120,240,240,240 exactly', () => {
  const l = sdk.createRspTarpitLadder();
  const readings = [0, 1, 2, 3, 4, 10].map((n) => l.delaySecondsForGrantCount(n));
  assert.deepEqual(readings, [30, 60, 120, 240, 240, 240]);
});

test('RSP-03 a 7200 s entry is rejected at config load; edge ladder [3500] serves at most 3500', () => {
  assert.throws(() => sdk.createRspTarpitLadder([7200]), /rejected at config load/);
  assert.throws(() => sdk.createRspTarpitLadder([30, 3601]), /rejected at config load/);
  const edge = sdk.createRspTarpitLadder([3500]);
  assert.equal(edge.delaySecondsForGrantCount(0), 3500);
  assert.equal(edge.delaySecondsForGrantCount(99), 3500);
  assert.equal(sdk.RSP_TARPIT_CAP_SECONDS, 3600);
});

test('RSP-03 computed values only: the module exposes no timer or enforcement surface', () => {
  const l = sdk.createRspTarpitLadder();
  assert.deepEqual(Object.keys(l).sort(), ['delaySecondsForGrantCount', 'ladder']);
});
