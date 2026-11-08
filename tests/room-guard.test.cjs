const { test } = require('node:test');
const assert = require('node:assert/strict');
// Room guard (RECOMB-06 ROOMGUARD-2). These tests pin the frozen
// lab laws on small hand-built streams (the lab's own seeded
// 7-day cells are the measurement of record, RECOMB06-RESULTS.md):
//   - pressure = burst OR sustained OR churn OR occupancy, on
//     30 s ticks; recommendStepUpForNewJoins iff pressure is high
//     at the latest tick; seated members never named.
//   - occupancy leg: FAST ratio >= 0.50 sustained 600 s; DRIP
//     ratio >= 0.34 sustained 3,600 s (lab SQUAT flagged +690 s
//     against the 900 s gate; legit peaks 0.02-0.10).
//   - hole A1 is documented by test: squatters who emit even a
//     little activity escape the occupancy leg's definition.
const sdk = require('../dist/tier2-active/room-guard.js');

const T0 = 1_700_000_100_000; // aligned to the 30 s tick grid
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
function leave(sig, identity, ts) {
  return sig.observe({ type: 'leave', identity, ts });
}
function act(sig, identity, ts) {
  return sig.observe({ type: 'activity', identity, ts });
}

test('empty instance evaluates inert', () => {
  const sig = sdk.createRoomGuard({ capacity: 30 });
  const r = sig.evaluate();
  assert.equal(r.kind, 'room-guard');
  assert.equal(r.flagged, false);
  assert.equal(r.firstFlagTs, null);
  assert.equal(r.pressureHighNow, false);
  assert.equal(r.recommendStepUpForNewJoins, false);
  assert.equal(r.enforcement, 'none');
});

test('SQUAT: burst of new silent joins flags via the occupancy FAST law inside the 900 s gate', () => {
  const sig = sdk.createRoomGuard({ capacity: 30 });
  for (let i = 0; i < 30; i++) newJoin(sig, `squat-${i}`, T0 + i * 4_000);
  const r = sig.evaluate({ asOfTs: T0 + 1_500_000 });
  assert.equal(r.flagged, true);
  assert.equal(r.paths.occupancy, true);
  // 16th join lands at T0+60 s (ratio 0.50+); +600 s sustain.
  assert.equal(r.firstPathTs.occupancy, T0 + 660_000);
  assert.ok(r.firstFlagTs <= T0 + 900_000, 'inside the lab G-B4 gate');
  assert.equal(r.pressureHighNow, true);
  assert.equal(r.recommendStepUpForNewJoins, true);
  assert.equal(r.current.newIdleSeats, 30);
});

test('after the squatters leave, history stays flagged but pressure-now clears', () => {
  const sig = sdk.createRoomGuard({ capacity: 30 });
  for (let i = 0; i < 30; i++) newJoin(sig, `squat-${i}`, T0 + i * 4_000);
  for (let i = 0; i < 30; i++) leave(sig, `squat-${i}`, T0 + 1_800_000);
  const r = sig.evaluate({ asOfTs: T0 + 2_400_000 });
  assert.equal(r.flagged, true);
  assert.equal(r.pressureHighNow, false);
  assert.equal(r.recommendStepUpForNewJoins, false);
});

test('legit silence: old silent holders and a new silent minority never flag', () => {
  const sig = sdk.createRoomGuard({ capacity: 30 });
  for (let i = 0; i < 25; i++) oldJoin(sig, `old-${i}`, T0 + i * 10_000);
  for (let i = 0; i < 5; i++) newJoin(sig, `new-${i}`, T0 + i * 10_000);
  const r = sig.evaluate({ asOfTs: T0 + 7_200_000 });
  assert.equal(r.flagged, false);
  assert.equal(r.current.newIdleSeats, 5);
  assert.ok(r.current.occupancyRatio < 0.34);
});

test('FLOOD: 30 new silent joins in 10 s fire the burst path inside 120 s', () => {
  const sig = sdk.createRoomGuard({ capacity: 100 });
  for (let i = 0; i < 30; i++) newJoin(sig, `flood-${i}`, T0 + Math.floor(i / 3) * 1_000);
  const r = sig.evaluate({ asOfTs: T0 + 300_000 });
  assert.equal(r.paths.burst, true);
  assert.ok(r.firstPathTs.burst <= T0 + 120_000, 'inside the lab G-B1 gate');
});

test('CHURN: join/leave cycles with 5 s dwell fire the churn path', () => {
  const sig = sdk.createRoomGuard({ capacity: 100 });
  for (let i = 0; i < 25; i++) {
    newJoin(sig, `churn-${i}`, T0 + i * 1_000);
    leave(sig, `churn-${i}`, T0 + i * 1_000 + 5_000);
  }
  const r = sig.evaluate({ asOfTs: T0 + 120_000 });
  assert.equal(r.paths.churn, true);
  assert.equal(r.current.churnRatio, 1);
});

test('DRIP occupancy: a slow new-silent build flags under the DRIP law only', () => {
  const sig = sdk.createRoomGuard({ capacity: 30 });
  for (let i = 0; i < 12; i++) newJoin(sig, `drip-${i}`, T0 + i * 300_000);
  const r = sig.evaluate({ asOfTs: T0 + 7_000_000 });
  assert.equal(r.paths.occupancy, true);
  assert.equal(r.paths.burst, false);
  assert.equal(r.paths.sustained, false);
  // Ratio crosses 0.34 at the 11th join (T0+3,000 s); +3,600 s sustain.
  assert.equal(r.firstPathTs.occupancy, T0 + 6_600_000);
});

test('hole A1 (declared open): squatters who chat once escape the occupancy leg', () => {
  const sig = sdk.createRoomGuard({ capacity: 30 });
  for (let i = 0; i < 16; i++) {
    newJoin(sig, `a1-${i}`, T0 + i * 10_000);
    act(sig, `a1-${i}`, T0 + i * 10_000 + 120_000);
  }
  const r = sig.evaluate({ asOfTs: T0 + 3_600_000 });
  assert.equal(r.flagged, false);
});

test('validation: bad capacity and bad events throw RoomGuardError; invalid ts is counted', () => {
  assert.throws(() => sdk.createRoomGuard({ capacity: 0 }), sdk.RoomGuardError);
  assert.throws(() => sdk.createRoomGuard({}), sdk.RoomGuardError);
  const sig = sdk.createRoomGuard({ capacity: 10 });
  assert.throws(() => sig.observe({ type: 'peek', identity: 'x', ts: T0 }), sdk.RoomGuardError);
  const obs = sig.observe({ type: 'join', identity: 'x', ts: NaN });
  assert.deepEqual(obs, { status: 'invalid_ts', counted: false });
  const snap = sig.snapshot();
  assert.equal(snap.counters.invalidTs, 1);
  assert.equal(snap.enforcement, 'none');
});
