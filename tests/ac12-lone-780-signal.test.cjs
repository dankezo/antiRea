const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// AC-12 (PASS-LAB, component only, ac-batch2-lab): tool sessions
// fire 5/5; simulated humans 0/80 fired and 0/80 resize to exactly
// 780. Binding restriction: lone-780 is never a standalone gate;
// the C48/C51 exact forms stay killed.

const toolSession = () => [[1024, 780], [1280, 780], [900, 780], [1440, 780]];
const humanSession = i => {
  // Simulated humans resize to assorted widths, never exactly 780.
  const widths = [1024, 1180, 940, 1366, 812, 690].slice(0, 1 + (i % 4));
  return widths.map(w => [w, w - 20]);
};

test('AC-12: tool sessions fire 5/5 under the R780 rule', () => {
  const sessions = Array.from({ length: 5 }, () => sdk.evaluateLone780(toolSession()));
  assert.equal(sessions.filter(s => s.present).length, 5);
  for (const s of sessions) assert.equal(s.windowsWith780, 4);
});

test('AC-12: simulated humans fire 0/80 and 0/80 resize to exactly 780', () => {
  const sessions = Array.from({ length: 80 }, (_, i) => humanSession(i));
  const results = sessions.map(w => sdk.evaluateLone780(w));
  assert.equal(results.filter(r => r.present).length, 0);
  assert.equal(results.filter(r => r.windowsWith780 > 0).length, 0);
});

test('AC-12: fewer than 3 windows with 780 does not fire (the frozen floor)', () => {
  assert.equal(sdk.evaluateLone780([[780], [780]]).present, false);
  assert.equal(sdk.evaluateLone780([[780], [780], [780]]).present, true);
  assert.equal(sdk.LONE_780_MIN_WINDOWS, 3);
  assert.equal(sdk.LONE_780_WIDTH, 780);
  // A window counts once however many times it lands on 780.
  assert.equal(sdk.evaluateLone780([[780, 780, 780]]).windowsWith780, 1);
});

test('AC-12: the result is a component only - never a standalone gate', () => {
  const result = sdk.evaluateLone780(toolSession());
  assert.equal(result.component, 'lone-780-viewport');
  assert.equal(result.standalone, false);
  assert.equal(result.enforcement, 'none');
  assert.equal('verdict' in result, false);
  assert.equal('blocked' in result, false);
  assert.deepEqual(sdk.lone780ComponentContribution(toolSession()), {
    name: 'lone-780-viewport',
    present: true,
    windowsWith780: 4,
  });
});
