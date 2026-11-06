const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/tier2-active/room-hop-signal.js');

// ---------------------------------------------------------------------------
// Room-hop fan-out signal (CAND-273-5). Frozen lab law: flag an
// identity whose DISTINCT rooms joined in any trailing 3600 s
// window reach 16; self-disarm when > 25% of tracked identities
// would flag (names nobody). Lab pin: baseline surfers max 6
// distinct/hour, heavy surfers max 11, a 40-room sweep flagged
// 20/20 inside its first hour, disarm never fired.
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

function hop(sig, identity, room, ts) {
  sig.observe({ identity, room, ts });
}
function sweep(sig, identity, rooms, startTs, stepMs = 30_000) {
  for (let i = 0; i < rooms; i++) hop(sig, identity, `room-${i}`, startTs + i * stepMs);
}

test('a 40-room enumeration sweep flags within its first hour', () => {
  const sig = sdk.createRoomHopSignal();
  sweep(sig, 'mapper', 40, T0);
  // Calm co-tenants: without them the lone mapper would be 100% of
  // tracked identities and the disarm rule would (correctly) fire.
  for (let i = 0; i < 6; i++) hop(sig, `calm-${i}`, 'room-0', T0 + (i + 1) * MIN);
  const r = sig.evaluate({ asOfTs: T0 + HOUR });
  assert.equal(r.disarmed, false);
  assert.deepEqual(r.flagged, ['mapper']);
  assert.equal(r.maxDistinctObserved, 40);
  assert.equal(r.enforcement, 'none');
  assert.equal(r.kind, 'room-hop');
});

test('baseline and heavy legit surfing stay under the threshold', () => {
  const sig = sdk.createRoomHopSignal();
  for (let u = 0; u < 10; u++) sweep(sig, `surfer-${u}`, 5, T0 + u * MIN, 5 * MIN); // 5 rooms
  for (let u = 0; u < 5; u++) sweep(sig, `heavy-${u}`, 11, T0 + u * MIN, 4 * MIN); // 11 rooms
  const r = sig.evaluate({ asOfTs: T0 + HOUR });
  assert.deepEqual(r.flagged, []);
  assert.equal(r.maxDistinctObserved, 11);
});

test('re-joining the same rooms does not inflate the distinct count', () => {
  const sig = sdk.createRoomHopSignal();
  for (let i = 0; i < 40; i++) hop(sig, 'loyal', `room-${i % 3}`, T0 + i * 30_000);
  const r = sig.evaluate({ asOfTs: T0 + HOUR });
  assert.deepEqual(r.flagged, []);
  assert.equal(r.maxDistinctObserved, 3);
});

test('breadth spread across separated hours never reaches the window threshold', () => {
  const sig = sdk.createRoomHopSignal();
  sweep(sig, 'slow', 10, T0, 60_000); // 10 rooms in hour 1
  sweep(sig, 'slow', 10, T0 + 3 * HOUR, 60_000); // 10 more in hour 4 (rooms 0-9 again is fine too)
  const r = sig.evaluate({ asOfTs: T0 + 4 * HOUR });
  assert.deepEqual(r.flagged, []);
});

test('exactly at the threshold flags; one below does not', () => {
  const sig = sdk.createRoomHopSignal();
  sweep(sig, 'edge16', 16, T0);
  sweep(sig, 'edge15', 15, T0);
  for (let i = 0; i < 6; i++) hop(sig, `calm-${i}`, 'room-0', T0 + (i + 1) * MIN);
  const r = sig.evaluate({ asOfTs: T0 + HOUR });
  assert.deepEqual(r.flagged, ['edge16']);
});

test('self-disarm: when over 25% of tracked identities would flag, nobody is named', () => {
  const sig = sdk.createRoomHopSignal();
  for (let i = 0; i < 4; i++) sweep(sig, `mapper-${i}`, 20, T0); // 4 of 9 tracked flag = 44%
  for (let i = 0; i < 5; i++) hop(sig, `calm-${i}`, 'room-0', T0 + i * MIN);
  const r = sig.evaluate({ asOfTs: T0 + HOUR });
  assert.equal(r.disarmed, true);
  assert.deepEqual(r.flagged, []);
  assert.equal(r.flaggedCount, 4);
});

test('flagged identities come back sorted', () => {
  const sig = sdk.createRoomHopSignal();
  sweep(sig, 'zeta', 20, T0);
  sweep(sig, 'alpha', 20, T0);
  for (let i = 0; i < 10; i++) hop(sig, `calm-${i}`, 'room-1', T0 + i * MIN);
  const r = sig.evaluate({ asOfTs: T0 + HOUR });
  assert.equal(r.disarmed, false); // 2/12 = 16.7% < 25%
  assert.deepEqual(r.flagged, ['alpha', 'zeta']);
});

test('malformed input: invalid ts no-op, empty fields throw RoomHopError', () => {
  const sig = sdk.createRoomHopSignal();
  assert.deepEqual(sig.observe({ identity: 'x', room: 'r', ts: Number.NaN }), {
    status: 'invalid_ts',
    counted: false,
  });
  assert.throws(() => sig.observe({ identity: 'x', room: '', ts: T0 }), sdk.RoomHopError);
  assert.throws(() => sdk.createRoomHopSignal({ threshold: 0 }), sdk.RoomHopError);
  assert.throws(() => sdk.createRoomHopSignal({ disarmShare: 2 }), sdk.RoomHopError);
});

test('identity eviction past maxIdentities is counted', () => {
  const sig = sdk.createRoomHopSignal({ maxIdentities: 3 });
  for (let i = 0; i < 6; i++) hop(sig, `u-${i}`, 'room-0', T0 + i * MIN);
  const snap = sig.snapshot();
  assert.equal(snap.identities, 3);
  assert.ok(snap.counters.evictedIdentities >= 3);
});
