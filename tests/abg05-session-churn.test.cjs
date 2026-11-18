'use strict';
// ABG-05 session-churn fingerprint count - suite version of abg-lab/abg05.cjs.
// Frozen gates (seed 20321205, R-ABG-4): threshold 6 (enforcement-path
// value; config.py's 3 is the recorded contradiction). 7 mints flag,
// 6 do not (> 6, not >= 6), split fingerprints do not, split JA4 does
// not. Descriptive arm: the window slides - a 7th mint at t = 61 s
// does not flag.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../dist/tier2-active/session-churn-signal.js');

const UA = 'Mozilla/5.0 Chrome/131.0.0.0';
const IP = '203.0.113.7';
const JA4_A = 't13d1516h2_aaaa';
const JA4_B = 't13d1516h2_bbbb';
const S = 1000;

function run(signal, ja4, timesS) {
  let r;
  for (const t of timesS) r = signal.recordMint({ userAgent: UA, ipTier: IP, ja4, nowMs: t * S });
  return r;
}

test('ABG-05 gate A: 7 mints in 60 s on one fingerprint flag, count 7', () => {
  const s = m.createSessionChurnSignal();
  const r = run(s, JA4_A, [0, 9, 18, 27, 36, 45, 54]);
  assert.equal(r.count, 7);
  assert.equal(r.flagged, true);
  assert.equal(r.maxMints, 6);
  assert.equal(r.enforcement, 'none');
});

test('ABG-05 gate B: exactly 6 mints do not flag (flag iff count > 6)', () => {
  const s = m.createSessionChurnSignal();
  const r = run(s, 't13d1516h2_cccc', [100, 109, 118, 127, 136, 145]);
  assert.equal(r.count, 6);
  assert.equal(r.flagged, false);
});

test('ABG-05 gate C: 7 mints split 4+3 across two fingerprints flag neither', () => {
  const s = m.createSessionChurnSignal();
  const r1 = run(s, 't13d1516h2_dddd', [200, 210, 220, 230]);
  const r2 = run(s, 't13d1516h2_eeee', [205, 215, 225]);
  assert.equal(r1.flagged, false);
  assert.equal(r2.flagged, false);
});

test('ABG-05 gate D: same UA + IP with split JA4 gives no flag (JA4 is part of the fingerprint)', () => {
  const s = m.createSessionChurnSignal();
  const r1 = run(s, JA4_A, [300, 310, 320, 330]);
  const r2 = run(s, JA4_B, [305, 315, 325]);
  assert.notEqual(r1.fingerprint, r2.fingerprint);
  assert.equal(r1.flagged, false);
  assert.equal(r2.flagged, false);
});

test('ABG-05 control (c): a real browser at 3 mints does not flag', () => {
  const s = m.createSessionChurnSignal();
  const r = run(s, 't13d1516h2_ffff', [400, 420, 440]);
  assert.equal(r.count, 3);
  assert.equal(r.flagged, false);
});

test('ABG-05 descriptive: the window slides - 7th mint at t = 61 s does not flag (1st evicted, 6 remain)', () => {
  const s = m.createSessionChurnSignal();
  const r = run(s, 't13d1516h2_gggg', [500, 510, 520, 530, 540, 550, 561]);
  assert.equal(r.count, 6);
  assert.equal(r.flagged, false);
});

test('ABG-05: the threshold contradiction is on record in the exports (6 enforced, 3 config-only)', () => {
  assert.equal(m.SESSION_CHURN_MAX_MINTS, 6);
  assert.equal(m.SESSION_CHURN_CONFIG_DEFAULT_ON_RECORD, 3);
  assert.equal(m.SESSION_CHURN_WINDOW_MS, 60_000);
});
