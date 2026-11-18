'use strict';
// ABG-04 redirect-maze timing, MEASUREMENT FORM - suite version of
// abg-lab/abg04.cjs. The lab gates are encoded as measurements: the
// fast chain's total is measured under the lab reference, the slow
// chain's over it, a partial chain is never evaluated, a bad token
// restarts unscored, entry gating is risk >= 80. The shipped module
// has NO frozen verdict: with no host threshold, wouldFlag is null
// even for a fast chain. Descriptive arm: 50 seeded replicas with
// gaps U(200,500) ms flag 39/50 (0.78) at the lab's 800 ms reference,
// reproducing the lab sequence (A and B draws consume the stream
// first, exactly as in abg04.cjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const m = require('../dist/tier2-active/redirect-maze-timing.js');

const SECRET = crypto.createHash('sha256').update('abg04-lab:20321204').digest();
const ID = 'id-maze';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function walk(timer, identity, gaps, now0) {
  let t = now0;
  let last;
  for (let step = 0; step < 3; step++) {
    const token = timer.issueToken(identity, step, t);
    last = timer.recordHop(identity, token, t);
    if (step < 2) t = Math.round(t + gaps[step]);
  }
  return last;
}

test('ABG-04 measurement: a fast chain completes with a measured total under the lab reference, but no verdict ships', () => {
  const timer = m.createRedirectMazeTimer(SECRET);
  const r = walk(timer, ID, [150, 150], 1_000_000);
  assert.equal(r.complete, true);
  assert.equal(r.scored, true);
  assert.equal(r.totalMs, 300);
  assert.ok(r.totalMs < m.ABG04_LAB_REFERENCE_MS);
  assert.equal(r.verdict, 'measurement_only');
  assert.equal(r.wouldFlag, null, 'no frozen default verdict: wouldFlag stays null without a host threshold');
  assert.equal(r.thresholdMs, null);
  assert.equal(r.enforcement, 'none');
});

test('ABG-04 measurement: a slow chain measures over the lab reference', () => {
  const timer = m.createRedirectMazeTimer(SECRET);
  const r = walk(timer, ID, [500, 500], 2_000_000);
  assert.equal(r.complete, true);
  assert.equal(r.totalMs, 1000);
  assert.ok(r.totalMs >= m.ABG04_LAB_REFERENCE_MS);
  assert.equal(r.wouldFlag, null);
});

test('ABG-04: a host-configured threshold is labelled host_configured and compares against the host number only', () => {
  const timer = m.createRedirectMazeTimer(SECRET, { thresholdMs: 800 });
  const fast = walk(timer, ID, [150, 150], 1_000_000);
  assert.equal(fast.verdict, 'host_configured');
  assert.equal(fast.thresholdMs, 800);
  assert.equal(fast.wouldFlag, true);
  const slow = walk(timer, ID, [500, 500], 2_000_000);
  assert.equal(slow.wouldFlag, false);
});

test('ABG-04 gate C: a chain that stops after 1 hop is never evaluated', () => {
  const timer = m.createRedirectMazeTimer(SECRET);
  const token = timer.issueToken(ID, 0, 1_000_000);
  const r = timer.recordHop(ID, token, 1_000_000);
  assert.equal(r.complete, false);
  assert.equal(r.scored, false);
  assert.equal(r.totalMs, null);
});

test('ABG-04 gate D: a wrong-step bad-HMAC token restarts and is never scored', () => {
  const timer = m.createRedirectMazeTimer(SECRET);
  const r = timer.recordHop(ID, '9.3000000.0000000000000000', 3_000_000);
  assert.equal(r.tokenValid, false);
  assert.equal(r.response, 'restart');
  assert.equal(r.scored, false);
  assert.equal(r.totalMs, null);
});

test('ABG-04 control (c): entry at risk 79 passes through, risk 80 enters the maze', () => {
  assert.equal(m.shouldEnterRedirectMaze(79, false), false);
  assert.equal(m.shouldEnterRedirectMaze(80, false), true);
  assert.equal(m.shouldEnterRedirectMaze(90, true), false);
});

test('ABG-04 descriptive: 50 seeded replicas flag 39/50 (0.78) at the 800 ms reference (seed 20321204)', () => {
  const rand = mulberry32(20321204);
  const timer = m.createRedirectMazeTimer(SECRET, { thresholdMs: m.ABG04_LAB_REFERENCE_MS });
  // Consume the stream exactly as abg04.cjs does: A (2 draws), then B (2 draws).
  walk(timer, ID, [100 + rand() * 200, 100 + rand() * 200], 1_000_000);
  walk(timer, ID, [400 + rand() * 200, 400 + rand() * 200], 2_000_000);
  let flagged = 0;
  for (let i = 0; i < 50; i++) {
    const gaps = [200 + rand() * 300, 200 + rand() * 300];
    const r = walk(timer, ID, gaps, 3_000_000 + i * 10_000);
    assert.equal(r.complete, true);
    if (r.wouldFlag) flagged++;
  }
  assert.equal(flagged, 39);
  assert.equal(flagged / 50, 0.78);
});
