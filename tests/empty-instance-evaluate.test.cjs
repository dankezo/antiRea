const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ---------------------------------------------------------------------------
// Regression (benchmark 2.7.3, finding 4.1): evaluate() with NO arguments
// on a FRESH instance must be a structured no-op for every 2.7.3 room
// signal - docs/AGENT-GUIDE.md prints exactly this call pattern, and a
// host evaluating on a schedule (a tick before the day's first join, a
// health check, a quiet room) must not get an exception from a telemetry
// call. seat-occupancy / room-hop / reconnect-storm previously threw
// because their default asOfTs fell back to latestTs = -Infinity before
// the first event. The explicit-asOfTs validation must stay strict.
// ---------------------------------------------------------------------------

test('seat-occupancy: evaluate() on a fresh instance returns the inert result', () => {
  const sig = sdk.createSeatOccupancySignal({ capacity: 30 });
  const r = sig.evaluate();
  assert.equal(r.kind, 'seat-occupancy');
  assert.equal(r.flagged, false);
  assert.equal(r.firstFlagTs, null);
  assert.equal(r.currentRatio, 0);
  assert.equal(r.newIdleSeats, 0);
  assert.equal(r.holders, 0);
  assert.equal(r.enforcement, 'none');
  // Explicit invalid asOfTs still throws - validation is not weakened.
  assert.throws(() => sig.evaluate({ asOfTs: NaN }), sdk.SeatOccupancyError);
  assert.throws(() => sig.evaluate({ asOfTs: Infinity }), sdk.SeatOccupancyError);
});

test('room-hop: evaluate() on a fresh instance returns the inert result', () => {
  const sig = sdk.createRoomHopSignal();
  const r = sig.evaluate();
  assert.equal(r.kind, 'room-hop');
  assert.equal(r.disarmed, false);
  assert.deepEqual(r.flagged, []);
  assert.equal(r.flaggedCount, 0);
  assert.equal(r.trackedIdentities, 0);
  assert.equal(r.enforcement, 'none');
  assert.throws(() => sig.evaluate({ asOfTs: NaN }), sdk.RoomHopError);
});

test('reconnect-storm: evaluate() on a fresh instance returns the inert result', () => {
  const sig = sdk.createReconnectStormSignal();
  const r = sig.evaluate();
  assert.equal(r.kind, 'reconnect-storm');
  assert.equal(r.disarmed, false);
  assert.deepEqual(r.flagged, []);
  assert.equal(r.flaggedCount, 0);
  assert.equal(r.trackedSources, 0);
  assert.equal(r.enforcement, 'none');
  assert.throws(() => sig.evaluate({ asOfTs: NaN }), sdk.ReconnectStormError);
});

test('vote-brigading: evaluate() on a fresh instance stays a no-op', () => {
  const sig = sdk.createVoteBrigadingSignal();
  const r = sig.evaluate();
  assert.equal(r.kind, 'vote-brigading');
  assert.equal(r.flagged, false);
  assert.equal(r.accumulator, 0);
  assert.equal(r.enforcement, 'none');
});

test('herd-phase: evaluate() on a fresh instance stays a no-op', () => {
  const sig = sdk.createHerdPhaseSignal();
  const r = sig.evaluate();
  assert.equal(r.kind, 'herd-phase');
  assert.equal(r.confirmed, false);
  assert.equal(r.enforcement, 'none');
});

test('activity-phase: evaluate() on a fresh instance stays a no-op', () => {
  const sig = sdk.createActivityPhaseSignal();
  const r = sig.evaluate();
  assert.equal(r.kind, 'activity-phase');
  assert.equal(r.status, 'insufficient_population');
  assert.equal(r.confirmed, false);
  assert.equal(r.enforcement, 'none');
});
