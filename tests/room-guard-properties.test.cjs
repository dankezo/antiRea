const { test } = require('node:test');
const assert = require('node:assert/strict');
// Room guard property tests (test-battery upgrade, 2026-11-09).
// The unit tests pin specific scenarios and the lab-replay file pins
// the frozen populations; this file pins the INVARIANTS a host
// relies on regardless of scenario:
//   - determinism: the same stream gives the same verdict, and
//     evaluate() is a pure readout (repeated calls agree);
//   - feed-order independence within the observe contract:
//     interleavings that preserve each identity's own chronological
//     order (the guarantee real per-key pipelines give) change
//     nothing. A leave observed before its join is an orphan by
//     contract - dropped and counted in snapshot() - so arbitrary
//     global shuffles are NOT promised equivalence, and this file
//     pins that boundary explicitly instead of papering over it;
//   - the tick-budget guard fails loudly instead of truncating;
//   - malformed events are rejected, never silently absorbed.
// Streams are built with a seeded PRNG so failures reproduce.
const { createRoomGuard, RoomGuardError } = require('../dist/index.js');

const T0 = 1_700_000_100_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A mixed stream: a quiet legit background plus a silent squat wave
// (the occupancy path must fire) - rich enough that feed order and
// repetition actually exercise the tick machinery.
function buildStream() {
  const rng = mulberry32(424242);
  const events = [];
  for (let i = 0; i < 40; i++) {
    const joinTs = T0 + Math.floor(rng() * 6 * HOUR);
    events.push({ type: 'join', identity: 'user-' + i, ts: joinTs, accountCreatedTs: joinTs - 20 * DAY });
    const acts = 1 + Math.floor(rng() * 5);
    for (let a = 0; a < acts; a++) {
      events.push({ type: 'activity', identity: 'user-' + i, ts: joinTs + 60_000 + a * 120_000 });
    }
    events.push({ type: 'leave', identity: 'user-' + i, ts: joinTs + 30 * 60_000 });
  }
  const waveStart = T0 + 8 * HOUR;
  for (let i = 0; i < 30; i++) {
    const joinTs = waveStart + i * 4000;
    events.push({ type: 'join', identity: 'bot-' + i, ts: joinTs, accountCreatedTs: joinTs - HOUR });
    events.push({ type: 'leave', identity: 'bot-' + i, ts: joinTs + HOUR });
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events, asOf: T0 + 12 * HOUR };
}

function feed(events, asOf) {
  const guard = createRoomGuard({ capacity: 30 });
  for (const e of events) guard.observe(e);
  return guard.evaluate({ asOfTs: asOf });
}

test('property: determinism and evaluate purity', () => {
  const { events, asOf } = buildStream();
  const first = feed(events, asOf);
  const second = feed(events, asOf);
  assert.deepEqual(second, first);
  assert.equal(first.flagged, true);
  assert.equal(first.paths.occupancy, true);
  // evaluate() twice on the same instance: identical readout.
  const guard = createRoomGuard({ capacity: 30 });
  for (const e of events) guard.observe(e);
  assert.deepEqual(guard.evaluate({ asOfTs: asOf }), guard.evaluate({ asOfTs: asOf }));
});

test('property: per-identity-ordered interleavings do not change the verdict', () => {
  const { events, asOf } = buildStream();
  const baseline = feed(events, asOf);
  // Re-interleave the stream with a seeded merge that preserves
  // each identity's own event order (per-key ordering, the contract
  // the session model documents) but scrambles the global order.
  const byIdentity = new Map();
  for (const e of events) {
    if (!byIdentity.has(e.identity)) byIdentity.set(e.identity, []);
    byIdentity.get(e.identity).push(e);
  }
  const queues = [...byIdentity.values()];
  const rng = mulberry32(777);
  const merged = [];
  let remaining = events.length;
  while (remaining > 0) {
    const nonEmpty = queues.filter((q) => q.length > 0);
    const q = nonEmpty[Math.floor(rng() * nonEmpty.length)];
    merged.push(q.shift());
    remaining--;
  }
  assert.equal(merged.length, events.length);
  assert.deepEqual(feed(merged, asOf), baseline);
});

test('property: a leave observed before its join is an orphan (contract boundary)', () => {
  const guard = createRoomGuard({ capacity: 10 });
  guard.observe({ type: 'leave', identity: 'ghost', ts: T0 });
  const snap = guard.snapshot();
  assert.equal(snap.counters.orphanEvents, 1);
  assert.equal(snap.openSessions, 0);
});

test('property: the tick budget fails loudly, never silently', () => {
  const guard = createRoomGuard({ capacity: 10, tickMs: 1 });
  guard.observe({ type: 'join', identity: 'x', ts: T0, accountCreatedTs: T0 - HOUR });
  assert.throws(() => guard.evaluate({ asOfTs: T0 + 3 * DAY }), RoomGuardError);
});

test('property: malformed events are rejected, never silently absorbed', () => {
  const guard = createRoomGuard({ capacity: 10 });
  // A non-finite timestamp is refused through the observation
  // status (the sibling signals' posture: the event is not counted
  // and the refusal is visible in snapshot()).
  const bad = guard.observe({ type: 'join', identity: 'x', ts: Number.NaN });
  assert.equal(bad.counted, false);
  assert.equal(bad.status, 'invalid_ts');
  // Structural violations throw.
  assert.throws(() => guard.observe({ type: 'teleport', identity: 'x', ts: T0 }), RoomGuardError);
  assert.throws(() => guard.observe({ type: 'join', identity: '', ts: T0 }), RoomGuardError);
  // Nothing valid was ever observed: the invalid event is counted
  // as such, and the instance stays inert.
  const snap = guard.snapshot();
  assert.equal(snap.counters.invalidTs, 1);
  assert.equal(snap.counters.observed, 0);
  const res = guard.evaluate({ asOfTs: T0 + HOUR });
  assert.equal(res.flagged, false);
  assert.equal(res.firstFlagTs, null);
});
