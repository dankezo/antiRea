'use strict';
// NHS-13 Prometheus metrics surface - suite version of nhs-lab/nhs13.cjs.
// Expectations are the frozen Step-0 numbers (RESULTS-NHS-STEP0.md):
// fixture counters exact, shadow_total 3 with the challenge row
// excluded, gauge 2-1-0, zero-state emit with all 21 series at 0.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pm = require('../dist/tier2-active/prometheus-metrics.js');

const FIXTURE = [
  ['allow', [], false],
  ['allow', [], false],
  ['allow', ['bot'], false],
  ['allow', [], false],
  ['challenge', ['bot', 'coherence'], false],
  ['challenge', ['errrate'], true],
  ['tarpit', ['scanner'], true],
  ['tarpit', ['velocity'], false],
  ['block', ['crowdsec'], true],
  ['block', ['errrate', 'blocked'], true],
];

test('fixture: counters exact on the 10-request lab fixture', () => {
  const m = pm.createPrometheusMetrics();
  for (const [verdict, signals, shadow] of FIXTURE) m.record({ verdict, signals, shadow });
  const s = m.snapshot();
  assert.equal(s.requests, 10);
  assert.deepEqual(s.verdict, { allow: 4, challenge: 2, tarpit: 2, block: 2 });
  assert.deepEqual(s.signal, {
    errrate: 2, blocked: 1, scanner: 1, bot: 2, header: 0, honeypot: 0,
    velocity: 1, asn: 0, coherence: 1, crowdsec: 1, ja3: 0, ja4: 0, ja4t: 0, c2ip: 0,
  });
});

test('shadow_total is 3: shadow challenge row correctly excluded, verdict still counted', () => {
  const m = pm.createPrometheusMetrics();
  for (const [verdict, signals, shadow] of FIXTURE) m.record({ verdict, signals, shadow });
  const s = m.snapshot();
  assert.equal(s.shadow, 3);
  // The shadow challenge request still bumped its computed verdict and signal.
  assert.equal(s.verdict.challenge, 2);
  assert.equal(s.signal.errrate, 2);
});

test('zero-state emit succeeds with all 21 series at 0', () => {
  const m = pm.createPrometheusMetrics();
  const out = m.emit(0);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 21);
  assert.ok(lines.every((l) => / 0$/.test(l)), 'every series at 0');
  assert.ok(out.includes('sentinel_requests_total 0'));
  assert.ok(out.includes('sentinel_shadow_total 0'));
  assert.ok(out.includes('sentinel_tarpit_active 0'));
});

test('emit renders the fixture totals in Prometheus series form', () => {
  const m = pm.createPrometheusMetrics();
  for (const [verdict, signals, shadow] of FIXTURE) m.record({ verdict, signals, shadow });
  const out = m.emit(0);
  assert.equal(out.trim().split('\n').length, 21);
  assert.ok(out.includes('sentinel_requests_total 10'));
  assert.ok(out.includes('sentinel_verdict_total{v="allow"} 4'));
  assert.ok(out.includes('sentinel_verdict_total{v="block"} 2'));
  assert.ok(out.includes('sentinel_signal_total{s="bot"} 2'));
  assert.ok(out.includes('sentinel_signal_total{s="c2ip"} 0'));
  assert.ok(out.includes('sentinel_shadow_total 3'));
});

test('tarpit gauge tracks 2, 1, 0 live and emit override does not mutate it', () => {
  const m = pm.createPrometheusMetrics();
  const trace = [];
  m.tarpitOpened(); m.tarpitOpened(); trace.push(m.snapshot().tarpitActive);
  m.tarpitClosed(); trace.push(m.snapshot().tarpitActive);
  m.tarpitClosed(); trace.push(m.snapshot().tarpitActive);
  assert.deepEqual(trace, [2, 1, 0]);
  assert.ok(m.emit().includes('sentinel_tarpit_active 0'));
  assert.ok(m.emit(7).includes('sentinel_tarpit_active 7'));
  assert.equal(m.snapshot().tarpitActive, 0, 'override is emit-local');
  m.tarpitClosed();
  assert.equal(m.snapshot().tarpitActive, 0, 'gauge floors at 0');
});

test('unknown verdict or signal is rejected loudly, counters untouched', () => {
  const m = pm.createPrometheusMetrics();
  assert.throws(() => m.record({ verdict: 'deny' }), TypeError);
  assert.throws(() => m.record({ verdict: 'allow', signals: ['nope'] }), TypeError);
  assert.equal(m.snapshot().requests, 0);
});
