"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const dir = process.env.ANTIREA_ROOM_MODULE_DIR || path.join(__dirname, "../dist/tier2-active");
const factories = {
  seat: require(path.join(dir, "seat-occupancy-signal.js")).createSeatOccupancySignal,
  room: require(path.join(dir, "room-guard.js")).createRoomGuard,
};
for (const [name, factory] of Object.entries(factories)) {
  test(`audit ${name}: all-open session caps suppress incomplete-telemetry confirmation`, () => {
    const s = factory({ capacity: 1, maxSessions: 2 });
    for (let i = 0; i < 2; i++) assert.equal(s.observe({ type: "join", identity: String(i), ts: 0 }).counted, true);
    for (let i = 2; i < 1000; i++) assert.deepEqual(s.observe({ type: "join", identity: String(i), ts: i }), { status: "capacity_exceeded", counted: false });
    const snap = s.snapshot(), r = s.evaluate({ asOfTs: 600000 });
    assert.equal(snap.sessions, 2); assert.equal(snap.openSessions, 2); assert.equal(snap.trackedIdentities, 2); assert.equal(snap.saturated, true); assert.equal(snap.counters.rejectedSessions, 998);
    assert.equal(r.saturated, true); assert.equal(r.flagged, false); assert.equal(r.firstFlagTs, null); assert.equal(r.enforcement, "none");
    assert.equal(name === "seat" ? r.currentRatio : r.current.occupancyRatio, 1);
    if (name === "room") { assert.equal(r.pressureHighNow, false); assert.equal(r.recommendStepUpForNewJoins, false); assert.ok(Object.values(r.paths).every((v) => v === false)); }
  });
  test(`audit ${name}: closed session churn and orphan identities cannot grow metadata`, () => {
    const s = factory({ capacity: 10, maxSessions: 2 });
    for (let i = 0; i < 1000; i++) {
      s.observe({ type: "activity", identity: `orphan-${i}`, ts: i });
      s.observe({ type: "join", identity: `user-${i}`, ts: i * 10 });
      s.observe({ type: "leave", identity: `user-${i}`, ts: i * 10 + 1 });
      assert.ok(s.snapshot().sessions <= 2); assert.ok(s.snapshot().trackedIdentities <= 2);
    }
    assert.equal(s.snapshot().counters.evictedSessions, 998); assert.equal(s.snapshot().saturated, false);
  });
  test(`audit ${name}: one earliest activity preserves the idle estimand under reverse timestamps`, () => {
    const s = factory({ capacity: 1 });
    s.observe({ type: "join", identity: "a", ts: 0 });
    for (let ts = 10000; ts >= 1; ts--) s.observe({ type: "activity", identity: "a", ts });
    assert.equal(s.snapshot().retainedActivityTimestamps, 1);
    const r = s.evaluate({ asOfTs: 600000 }); assert.equal(r.flagged, false); assert.equal(name === "seat" ? r.newIdleSeats : r.current.newIdleSeats, 0);
    const before = s.evaluate({ asOfTs: 0 }); assert.equal(name === "seat" ? before.newIdleSeats : before.current.newIdleSeats, 1);
  });
  test(`audit ${name}: future creation cannot count as new or create occupancy pressure`, () => {
    const s = factory({ capacity: 30 });
    for (let i = 0; i < 30; i++) s.observe({ type: "join", identity: String(i), ts: 0, accountCreatedTs: 1000000000000 });
    const r = s.evaluate({ asOfTs: 600000 }); assert.equal(r.flagged, false); assert.equal(name === "seat" ? r.newIdleSeats : r.current.newIdleSeats, 0);
    if (name === "room") { assert.equal(r.current.newFrac10Min, 0); assert.equal(r.current.newFrac30Min, 0); }
  });
  test(`audit ${name}: stale rejoin/leave cannot create negative durations or duplicate seats`, () => {
    const s = factory({ capacity: 1, maxSessions: 2 });
    s.observe({ type: "join", identity: "__proto__", ts: 100 });
    assert.equal(s.observe({ type: "join", identity: "__proto__", ts: 99 }).counted, false);
    s.observe({ type: "leave", identity: "__proto__", ts: 99 });
    assert.equal(s.snapshot().openSessions, 1);
    s.observe({ type: "join", identity: "__proto__", ts: 200 });
    const r = s.evaluate({ asOfTs: 30000 }); assert.equal(name === "seat" ? r.holders : r.current.holders, 1);
    assert.throws(() => s.observe({ type: "join", identity: "x".repeat(1025), ts: 1000 }));
  });
}
test("audit room: a sub-ULP tick cannot trap the evaluator in a non-progressing loop", () => {
  const s = factories.room({ capacity: 1, tickMs: 0.1 });
  s.observe({ type: "join", identity: "a", ts: 8e15, accountCreatedTs: 8e15 });
  const r = s.evaluate({ asOfTs: 8e15 }); assert.equal(r.flagged, false); assert.equal(r.current.holders, 1);
  const tiny = factories.room({ capacity: 1, tickMs: 1e-310 });
  tiny.observe({ type: "join", identity: "a", ts: 1000 });
  assert.throws(() => tiny.evaluate({ asOfTs: 1000 }));
});
