'use strict';
// NHS-14 shadow mode - suite version of nhs-lab/nhs14.cjs. Frozen
// expectations: 6/6 shadow requests served normally, 0 enforced, all
// decision logs carry score + verdict + shadow flag, shadow_total
// increments by exactly 3, no state persists, and the follow-up
// enforce-mode request from the block-verdict identity is served.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sm = require('../dist/tier2-active/shadow-mode.js');

const ROWS = [
  { identity: 'A', score: 0, verdict: 'allow' },
  { identity: 'B', score: 45, verdict: 'challenge' },
  { identity: 'C', score: 70, verdict: 'tarpit' },
  { identity: 'D', score: 95, verdict: 'block' },
  { identity: 'E', score: 65, verdict: 'tarpit' },
  { identity: 'F', score: 10, verdict: 'allow' },
];

test('shadow: 6/6 served normally, 0 enforced', () => {
  const s = sm.createShadowMode({ mode: 'shadow' });
  const outcomes = ROWS.map((r) => s.evaluate(r));
  assert.ok(outcomes.every((o) => o.served && o.outcome === 'served' && !o.enforced));
});

test('shadow: all decision logs carry score + verdict + shadow flag; shadow_total is exactly 3', () => {
  const s = sm.createShadowMode({ mode: 'shadow' });
  for (const r of ROWS) s.evaluate(r);
  const logs = s.logs();
  assert.equal(logs.length, 6);
  assert.ok(logs.every((l) => typeof l.score === 'number' && typeof l.verdict === 'string' && l.shadow === 1));
  assert.equal(s.shadowTotal(), 3);
});

test('no state persists: follow-up enforce-mode request from the block-verdict identity is served', () => {
  const s = sm.createShadowMode({ mode: 'shadow' });
  for (const r of ROWS) s.evaluate(r);
  s.setMode('enforce');
  const req7 = s.evaluate({ identity: 'D', score: 0, verdict: 'allow' });
  assert.equal(req7.served, true);
  assert.equal(req7.outcome, 'served');
});

test('enforce contrast: the same six produce [served, challenge, tarpit, block, tarpit, served]', () => {
  const s = sm.createShadowMode({ mode: 'enforce' });
  const outcomes = ROWS.map((r) => s.evaluate(r).outcome);
  assert.deepEqual(outcomes, ['served', 'challenge', 'tarpit', 'block', 'tarpit', 'served']);
  assert.equal(s.shadowTotal(), 0, 'shadow_total never moves in enforce mode');
  assert.ok(s.logs().every((l) => l.shadow === 0));
});

test('default mode is shadow (the lab merge default)', () => {
  const s = sm.createShadowMode();
  assert.equal(s.mode(), 'shadow');
});
