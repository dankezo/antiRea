const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/tier2-active/reconnect-storm-signal.js');

// ---------------------------------------------------------------------------
// Reconnect-storm signal (CAND-273-6). Frozen lab law: flag a
// source with >= 40 connects in a trailing 600 s window AND
// median duration of sessions starting in that window < 5 s;
// self-disarm when > 25% of tracked sources would flag. Lab pin:
// stable max 2 connects/10 min, flaky phones 13, heavy commuters
// 21 (median saved them too), storm sources 20/20 flagged,
// distributed storm (200 x 25) flagged 0 - the documented blind
// spot, deliberately without a population gate.
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const WIN = 600_000;

/** n sessions for one source: starts spaced stepMs, each lasting durMs. */
function sessions(sig, source, n, startTs, stepMs, durMs) {
  for (let i = 0; i < n; i++) {
    const s = startTs + i * stepMs;
    sig.observe({ source, kind: 'connect', ts: s });
    sig.observe({ source, kind: 'disconnect', ts: s + durMs });
  }
}
function calmSources(sig, n) {
  for (let i = 0; i < n; i++) sessions(sig, `calm-${i}`, 2, T0 + i * MIN, 30 * MIN, 20 * MIN);
}

test('a sub-second reconnect storm flags inside its first window', () => {
  const sig = sdk.createReconnectStormSignal();
  sessions(sig, 'storm', 55, T0, 10_000, 1_000); // 55 connects / ~9 min, 1 s sessions
  calmSources(sig, 6);
  const r = sig.evaluate({ asOfTs: T0 + WIN });
  assert.equal(r.disarmed, false);
  assert.deepEqual(r.flagged, ['storm']);
  assert.ok(r.maxConnectsObserved >= 40);
  assert.equal(r.enforcement, 'none');
  assert.equal(r.kind, 'reconnect-storm');
});

test('the rate leg alone does not flag: fast reconnects with real session lengths', () => {
  const sig = sdk.createReconnectStormSignal();
  sessions(sig, 'busy', 45, T0, 12_000, 60_000); // 45 connects but median 60 s
  const r = sig.evaluate({ asOfTs: T0 + WIN });
  assert.deepEqual(r.flagged, []);
});

test('the duration leg alone does not flag: a few very short sessions', () => {
  const sig = sdk.createReconnectStormSignal();
  sessions(sig, 'flaky', 13, T0, 40_000, 800); // the lab flaky-phone shape
  const r = sig.evaluate({ asOfTs: T0 + WIN });
  assert.deepEqual(r.flagged, []);
  assert.equal(r.maxConnectsObserved, 13);
});

test('heavy commuter pattern (bursts of retries, long rides) does not flag', () => {
  const sig = sdk.createReconnectStormSignal();
  // 21 connects in 10 min, but most sessions are minutes long.
  sessions(sig, 'commuter', 15, T0, 30_000, 240_000);
  sessions(sig, 'commuter', 6, T0 + 500_000, 10_000, 3_000);
  const r = sig.evaluate({ asOfTs: T0 + WIN });
  assert.deepEqual(r.flagged, []);
});

test('a distributed low-rate storm flags nobody (documented blind spot)', () => {
  const sig = sdk.createReconnectStormSignal();
  for (let i = 0; i < 30; i++) sessions(sig, `dist-${i}`, 25, T0, 20_000, 1_000);
  const r = sig.evaluate({ asOfTs: T0 + WIN });
  // 25 < 40 per source; disarm also fires (raw flags would be 0
  // anyway) - the point is no source is named.
  assert.deepEqual(r.flagged, []);
  assert.equal(r.flaggedCount, 0);
});

test('self-disarm: a fleet-wide flap names nobody', () => {
  const sig = sdk.createReconnectStormSignal();
  for (let i = 0; i < 4; i++) sessions(sig, `storm-${i}`, 50, T0, 10_000, 1_000);
  calmSources(sig, 4); // 4 of 8 tracked would flag = 50% > 25%
  const r = sig.evaluate({ asOfTs: T0 + WIN });
  assert.equal(r.disarmed, true);
  assert.deepEqual(r.flagged, []);
  assert.equal(r.flaggedCount, 4);
});

test('unmatched disconnects are counted as orphans, not fatal', () => {
  const sig = sdk.createReconnectStormSignal();
  sig.observe({ source: 'x', kind: 'disconnect', ts: T0 });
  sig.observe({ source: 'x', kind: 'disconnect', ts: T0 + 1_000 });
  assert.equal(sig.snapshot().counters.orphanDisconnects, 2);
});

test('sessions still open count toward rate but not yet toward the median', () => {
  const sig = sdk.createReconnectStormSignal();
  sessions(sig, 'mix', 10, T0, 10_000, 1_000); // 10 closed, 1 s each
  for (let i = 0; i < 35; i++) sig.observe({ source: 'mix', kind: 'connect', ts: T0 + 200_000 + i * 5_000 });
  calmSources(sig, 6);
  const r = sig.evaluate({ asOfTs: T0 + WIN });
  // 45 connects in-window; the closed median (1 s) carries the
  // duration leg - the law as frozen in the lab.
  assert.deepEqual(r.flagged, ['mix']);
});

test('malformed input: invalid ts no-op, bad kind throws ReconnectStormError', () => {
  const sig = sdk.createReconnectStormSignal();
  assert.deepEqual(sig.observe({ source: 'x', kind: 'connect', ts: Number.NaN }), {
    status: 'invalid_ts',
    counted: false,
  });
  assert.throws(() => sig.observe({ source: 'x', kind: 'reconnect', ts: T0 }), sdk.ReconnectStormError);
  assert.throws(() => sdk.createReconnectStormSignal({ minConnects: 0 }), sdk.ReconnectStormError);
  assert.throws(() => sdk.createReconnectStormSignal({ disarmShare: 0 }), sdk.ReconnectStormError);
});

test('snapshot exposes the frozen law parameters', () => {
  const snap = sdk.createReconnectStormSignal().snapshot();
  assert.equal(snap.minConnects, 40);
  assert.equal(snap.windowMs, 600_000);
  assert.equal(snap.maxMedianDurationMs, 5_000);
  assert.equal(snap.enforcement, 'none');
});
