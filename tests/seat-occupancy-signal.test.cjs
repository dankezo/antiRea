const { test } = require('node:test');
const assert = require('node:assert/strict');
// The module is wired through src/index.ts like its siblings; the
// tests import the compiled module directly (the bunching-monitor
// tests use the same subpath pattern).
const sdk = require('../dist/tier2-active/seat-occupancy-signal.js');

// ---------------------------------------------------------------------------
// Seat-occupancy signal (CAND-273-1 FAST + CAND-273-2 DRIP). These
// tests pin the frozen lab laws on small deterministic streams:
//   - occupancyNewIdle = seats held by identities created < 24 h
//     before joining with ZERO activity since joining, / capacity.
//   - FAST (defaults): flag when ratio >= 0.50 sustained 600 s.
//     Lab: burst squat flagged 660 s after first join (gate 900 s);
//     legit karaoke peaked 0.0667, silent-audience 0.1333, raid
//     0.0200 - never flagged.
//   - DRIP profile: ratio >= 0.34 sustained 3,600 s. Lab: flagged
//     85 minutes before the drip finished seating.
//   - Population signal: the result carries NO identity field.
// The streams here are hand-built (not the lab generator), so they
// assert the law's mechanics, not the lab's exact numbers.
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function join(sig, identity, ts, createdTs) {
  return sig.observe({ type: 'join', identity, ts, accountCreatedTs: createdTs });
}
function newJoin(sig, identity, ts) {
  return join(sig, identity, ts, ts - HOUR); // created 1 h before joining
}
function oldJoin(sig, identity, ts) {
  return join(sig, identity, ts, ts - 30 * DAY); // created 30 days before
}

test('FAST: a burst of new silent joins flags after the 600 s sustain', () => {
  const sig = sdk.createSeatOccupancySignal({ capacity: 30 });
  // 26 fresh silent accounts, one every 5 s: ratio reaches 0.50 at
  // the 15th join (t = T0 + 70,000).
  for (let i = 0; i < 26; i++) newJoin(sig, `bot-${i}`, T0 + i * 5_000);
  const before = sig.evaluate({ asOfTs: T0 + 70_000 + 599_999 });
  assert.equal(before.flagged, false);
  const after = sig.evaluate({ asOfTs: T0 + 70_000 + 600_000 });
  assert.equal(after.flagged, true);
  assert.equal(after.firstFlagTs, T0 + 70_000 + 600_000);
  assert.equal(after.enforcement, 'none');
  assert.equal(after.kind, 'seat-occupancy');
});

test('legit silent audience (new-idle ratio 0.1333) never flags under either profile', () => {
  for (const profile of [sdk.SEAT_OCCUPANCY_FAST_PROFILE, sdk.SEAT_OCCUPANCY_DRIP_PROFILE]) {
    const sig = sdk.createSeatOccupancySignal({ capacity: 30, ...profile });
    for (let i = 0; i < 20; i++) oldJoin(sig, `regular-${i}`, T0 + i * 60_000);
    for (let i = 0; i < 4; i++) newJoin(sig, `quiet-new-${i}`, T0 + i * 60_000);
    join(sig, 'chatty-new', T0, T0 - HOUR);
    sig.observe({ type: 'activity', identity: 'chatty-new', ts: T0 + 30_000 });
    const r = sig.evaluate({ asOfTs: T0 + 7 * DAY });
    assert.equal(r.flagged, false);
    assert.equal(r.newIdleSeats, 4);
    assert.ok(Math.abs(r.currentRatio - 4 / 30) < 1e-9);
  }
});

test('DRIP profile flags a slow fill the FAST profile cannot see', () => {
  const drip = sdk.createSeatOccupancySignal({ capacity: 30, ...sdk.SEAT_OCCUPANCY_DRIP_PROFILE });
  const fast = sdk.createSeatOccupancySignal({ capacity: 30 });
  // 11 fresh silent seats over 10 minutes: ratio 11/30 = 0.3667.
  for (let i = 0; i < 11; i++) {
    newJoin(drip, `slow-${i}`, T0 + i * 60_000);
    newJoin(fast, `slow-${i}`, T0 + i * 60_000);
  }
  const flagAt = T0 + 600_000 + 3_600_000; // run starts at the 11th join
  assert.equal(drip.evaluate({ asOfTs: flagAt - 1 }).flagged, false);
  assert.equal(drip.evaluate({ asOfTs: flagAt }).flagged, true);
  assert.equal(fast.evaluate({ asOfTs: T0 + 7 * DAY }).flagged, false);
});

test('activity after joining removes the seat from the idle numerator at that moment', () => {
  const sig = sdk.createSeatOccupancySignal({ capacity: 30 });
  for (let i = 0; i < 16; i++) newJoin(sig, `n-${i}`, T0 + i * 1_000);
  const lastJoin = T0 + 15_000;
  assert.ok(Math.abs(sig.evaluate({ asOfTs: lastJoin + 500 }).currentRatio - 16 / 30) < 1e-9);
  sig.observe({ type: 'activity', identity: 'n-0', ts: lastJoin + 1_000 });
  sig.observe({ type: 'activity', identity: 'n-1', ts: lastJoin + 1_000 });
  const r = sig.evaluate({ asOfTs: lastJoin + 2_000 });
  assert.equal(r.newIdleSeats, 14);
  assert.equal(r.flagged, false);
});

test('leaving breaks the sustain run', () => {
  const sig = sdk.createSeatOccupancySignal({ capacity: 30 });
  for (let i = 0; i < 16; i++) newJoin(sig, `n-${i}`, T0);
  sig.observe({ type: 'leave', identity: 'n-0', ts: T0 + 300_000 });
  sig.observe({ type: 'leave', identity: 'n-1', ts: T0 + 300_000 });
  // Ratio was >= 0.50 for only 300 s before dropping to 14/30.
  assert.equal(sig.evaluate({ asOfTs: T0 + 900_000 }).flagged, false);
});

test('old identities sitting silent do not count (newness is the leg)', () => {
  const sig = sdk.createSeatOccupancySignal({ capacity: 30 });
  for (let i = 0; i < 29; i++) oldJoin(sig, `vet-${i}`, T0 + i * 1_000);
  const r = sig.evaluate({ asOfTs: T0 + DAY });
  assert.equal(r.holders, 29);
  assert.equal(r.newIdleSeats, 0);
  assert.equal(r.flagged, false);
});

test('accountCreatedTs on the join wins over first-observation stand-in', () => {
  const sig = sdk.createSeatOccupancySignal({ capacity: 10 });
  // Identity observed long ago on another surface, but its account
  // was created an hour before THIS join: accountCreatedTs rules.
  sig.observe({ type: 'activity', identity: 'ghost', ts: T0 - 40 * DAY });
  for (let i = 0; i < 5; i++) newJoin(sig, `n-${i}`, T0);
  join(sig, 'ghost', T0, T0 - HOUR);
  const r = sig.evaluate({ asOfTs: T0 + 1_000 });
  assert.equal(r.newIdleSeats, 6);
});

test('population-only output: the result names no identity', () => {
  const sig = sdk.createSeatOccupancySignal({ capacity: 30 });
  newJoin(sig, 'someone', T0);
  const r = sig.evaluate({ asOfTs: T0 });
  for (const key of Object.keys(r)) {
    assert.ok(!/identit|member|flaggedIdentities/i.test(key), `unexpected identity-bearing key ${key}`);
  }
  assert.equal('flagged' in r, true); // the room flag itself is the output
});

test('malformed events: invalid ts is a structured no-op, bad shapes throw SeatOccupancyError', () => {
  const sig = sdk.createSeatOccupancySignal({ capacity: 30 });
  assert.deepEqual(
    sig.observe({ type: 'join', identity: 'x', ts: Number.NaN }),
    { status: 'invalid_ts', counted: false },
  );
  assert.throws(() => sig.observe({ type: 'peek', identity: 'x', ts: T0 }), sdk.SeatOccupancyError);
  assert.throws(() => sig.observe({ type: 'join', identity: ' ', ts: T0 }), sdk.SeatOccupancyError);
  assert.throws(() => sdk.createSeatOccupancySignal({ capacity: 0 }), sdk.SeatOccupancyError);
  assert.throws(() => sdk.createSeatOccupancySignal({ capacity: 30, threshold: 1.5 }), sdk.SeatOccupancyError);
  assert.equal(sig.snapshot().counters.invalidTs, 1);
});

test('orphan leave/activity events are counted, not fatal', () => {
  const sig = sdk.createSeatOccupancySignal({ capacity: 30 });
  sig.observe({ type: 'leave', identity: 'nobody', ts: T0 });
  sig.observe({ type: 'activity', identity: 'nobody', ts: T0 });
  assert.equal(sig.snapshot().counters.orphanEvents, 2);
});

test('closed sessions evict past maxSessions and the eviction is counted', () => {
  const sig = sdk.createSeatOccupancySignal({ capacity: 100, maxSessions: 5 });
  for (let i = 0; i < 8; i++) {
    oldJoin(sig, `u-${i}`, T0 + i * 2_000);
    sig.observe({ type: 'leave', identity: `u-${i}`, ts: T0 + i * 2_000 + 1_000 });
  }
  const snap = sig.snapshot();
  assert.ok(snap.counters.evictedSessions >= 3);
  assert.equal(snap.enforcement, 'none');
});
