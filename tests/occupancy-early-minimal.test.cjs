"use strict";
// A1-COUNTER-D2 early-minimal seat-occupancy signal - tests mirror the
// frozen lab families of REGISTRATION-A1-COUNTER-D2.md at SDK scale:
// the core squat shapes (fast burst, slow drip, delay-300) must flag,
// the legit families (mixed karaoke room, new-identity lurkers - the
// P-G4 family) must not, the descriptive delay-gap cell (first
// activity at +450 s) must never enter the numerator, and the
// estimand's boundary rules (3rd activity drops the session, the
// 24 h newness window, the +300 s early boundary) are asserted
// directly. All streams are deterministic; expected flag times are
// computed from the frozen law geometry, not fitted.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createOccupancyEarlyMinimalSignal,
  OccupancyEarlyMinimalError,
  OCCUPANCY_EARLY_MINIMAL_FAST_PROFILE,
  OCCUPANCY_EARLY_MINIMAL_DRIP_PROFILE,
  OCCUPANCY_EARLY_MINIMAL_EARLY_WINDOW_MS,
} = require("../dist/index.js");

const T0 = 1763000000000;
const NEW = T0 - 3600000; // created 1 h before T0: new (< 24 h) at every join below
const OLD = T0 - 3 * 86400000; // created 3 days before T0: never new

const join = (id, ts, createdTs) => ({ type: "join", identity: id, ts, accountCreatedTs: createdTs });
const act = (id, ts) => ({ type: "activity", identity: id, ts });
const leave = (id, ts) => ({ type: "leave", identity: id, ts });
const feed = (sig, events) => { for (const e of events) sig.observe(e); };
const law = (result, name) => result.laws.find((l) => l.name === name);

// 30 fresh squatters fill a 30-seat room inside 30 s, one activity
// 30 s after joining (inside the 300 s early window), seats held 1 h.
function fastSquat(sig, holdMs) {
  const events = [];
  for (let i = 0; i < 30; i++) {
    const id = "bot-" + i;
    const j = T0 + i * 1000;
    events.push(join(id, j, NEW), act(id, j + 30000), leave(id, j + holdMs));
  }
  feed(sig, events);
}

test("fast squat of new identities with 1 early activity flags D2-FAST at the exact sustain boundary", () => {
  const sig = createOccupancyEarlyMinimalSignal({ capacity: 30 });
  fastSquat(sig, 3600000);
  // The 15th session starts counting at T0+44 s (join +14 s, activity
  // +30 s): the ratio reaches 0.50 there, so the 600 s sustain
  // completes at exactly T0+644 s and not one ms earlier.
  const before = sig.evaluate({ asOfTs: T0 + 643999 });
  assert.equal(law(before, "fast").flagged, false);
  assert.equal(before.flagged, false);
  const at = sig.evaluate({ asOfTs: T0 + 644000 });
  assert.equal(law(at, "fast").flagged, true);
  assert.equal(law(at, "fast").firstFlagTs, T0 + 644000);
  assert.equal(law(at, "drip").flagged, false);
  const later = sig.evaluate({ asOfTs: T0 + 700000 });
  assert.equal(later.currentRatio, 1);
  assert.equal(later.earlyMinimalSeats, 30);
  assert.equal(later.holders, 30);
  assert.equal(later.enforcement, "none");
});

test("slow drip (1 join per 60 s, activity at join+60 s) flags FAST then DRIP", () => {
  const sig = createOccupancyEarlyMinimalSignal({ capacity: 30 });
  const events = [];
  for (let i = 0; i < 30; i++) {
    const id = "drip-" + i;
    const j = T0 + i * 60000;
    events.push(join(id, j, NEW), act(id, j + 60000), leave(id, j + 3600000));
  }
  feed(sig, events);
  // The 15th session starts counting at T0+900 s (FAST completes at
  // +1500 s); the 11th at T0+660 s puts the ratio over the 0.34 drip
  // bar, and it never dips back before +4260 s (DRIP completes).
  const mid = sig.evaluate({ asOfTs: T0 + 1600000 });
  assert.equal(law(mid, "fast").flagged, true);
  assert.equal(law(mid, "fast").firstFlagTs, T0 + 1500000);
  assert.equal(law(mid, "drip").flagged, false);
  const late = sig.evaluate({ asOfTs: T0 + 4300000 });
  assert.equal(law(late, "drip").flagged, true);
  assert.equal(law(late, "drip").firstFlagTs, T0 + 4260000);
  assert.equal(law(late, "fast").firstFlagTs, T0 + 1500000);
});

test("legit karaoke-style mixed room (old + new, chatty new users) does not flag", () => {
  const sig = createOccupancyEarlyMinimalSignal({ capacity: 30 });
  const events = [];
  for (let i = 0; i < 30; i++) {
    const id = "user-" + i;
    const created = i < 22 ? OLD : NEW; // only 8 new users: numerator ceiling 8/30 < 0.34
    const j = T0 + i * 10000;
    events.push(join(id, j, created));
    for (const off of [60000, 180000, 300000, 600000, 1200000, 2400000]) {
      events.push(act(id, j + off));
    }
    events.push(leave(id, j + 3600000));
  }
  feed(sig, events);
  // New users count only between their 1st (+60 s) and 3rd (+300 s)
  // activity; at T0+400 s all 8 are inside that band.
  const mid = sig.evaluate({ asOfTs: T0 + 400000 });
  assert.equal(mid.earlyMinimalSeats, 8);
  assert.equal(mid.currentRatio, 8 / 30);
  assert.equal(mid.flagged, false);
  const end = sig.evaluate({ asOfTs: T0 + 7200000 });
  assert.equal(end.flagged, false);
  assert.equal(law(end, "fast").flagged, false);
  assert.equal(law(end, "drip").flagged, false);
});

test("new-identity lurkers with activities spread over 600 s do NOT flag (the P-G4 family)", () => {
  const sig = createOccupancyEarlyMinimalSignal({ capacity: 30 });
  const events = [];
  // Lab-shaped lurker population at SDK scale: 30 new identities join
  // 1 per 60 s and hold seats 7,200 s. Activity pattern by i % 6:
  // 0 and 4 -> silent (never count); 1 and 5 -> one activity at
  // +500 s (late first activity: never counts); 2 -> one early
  // activity at +120 s (counts for the whole hold); 3 -> activities
  // at +100 s and +550 s (counts only until the late second one).
  // Fully-early sessions: 5 of 30; peak simultaneous numerator is 7
  // of 30 (0.2333), below the 0.34 drip bar - the lab's P-G4 pass had
  // d2max 0.3333, exactly one session of headroom under that bar.
  for (let i = 0; i < 30; i++) {
    const id = "lurker-" + i;
    const j = T0 + i * 60000;
    events.push(join(id, j, NEW));
    const kind = i % 6;
    if (kind === 1 || kind === 5) events.push(act(id, j + 500000));
    else if (kind === 2) events.push(act(id, j + 120000));
    else if (kind === 3) events.push(act(id, j + 100000), act(id, j + 550000));
    events.push(leave(id, j + 7200000));
  }
  feed(sig, events);
  const peak = sig.evaluate({ asOfTs: T0 + 1800000 });
  assert.equal(peak.earlyMinimalSeats, 7);
  assert.equal(peak.currentRatio, 7 / 30);
  for (const asOf of [T0 + 1800000, T0 + 3600000, T0 + 5400000, T0 + 9000000]) {
    const r = sig.evaluate({ asOfTs: asOf });
    assert.equal(r.flagged, false, "no flag at " + asOf);
    assert.equal(law(r, "fast").flagged, false);
    assert.equal(law(r, "drip").flagged, false);
  }
});

test("first activity at +450 s never enters the numerator (the descriptive delay gap)", () => {
  const sig = createOccupancyEarlyMinimalSignal({ capacity: 30 });
  const events = [];
  for (let i = 0; i < 30; i++) {
    const id = "gap-" + i;
    const j = T0 + i * 1000;
    events.push(join(id, j, NEW), act(id, j + 450000), leave(id, j + 3600000));
  }
  feed(sig, events);
  const mid = sig.evaluate({ asOfTs: T0 + 500000 });
  assert.equal(mid.earlyMinimalSeats, 0);
  assert.equal(mid.currentRatio, 0);
  assert.equal(mid.holders, 30);
  const end = sig.evaluate({ asOfTs: T0 + 4000000 });
  assert.equal(end.flagged, false);
});

test("a session stops counting at its 3rd activity (the CT-ADAPT-3 ceiling)", () => {
  const sig = createOccupancyEarlyMinimalSignal({ capacity: 10 });
  const events = [];
  for (let i = 0; i < 6; i++) {
    const id = "adapt-" + i;
    events.push(
      join(id, T0, NEW),
      act(id, T0 + 30000),
      act(id, T0 + 60000),
      act(id, T0 + 90000),
      leave(id, T0 + 3600000),
    );
  }
  feed(sig, events);
  assert.equal(sig.evaluate({ asOfTs: T0 + 45000 }).earlyMinimalSeats, 6);
  assert.equal(sig.evaluate({ asOfTs: T0 + 75000 }).earlyMinimalSeats, 6);
  assert.equal(sig.evaluate({ asOfTs: T0 + 95000 }).earlyMinimalSeats, 0);
  // The above-bar run lasted 60 s, far under the 600 s sustain.
  assert.equal(sig.evaluate({ asOfTs: T0 + 3700000 }).flagged, false);
});

test("sessions with zero activity never count (the shipped laws own that shape)", () => {
  const sig = createOccupancyEarlyMinimalSignal({ capacity: 30 });
  const events = [];
  for (let i = 0; i < 30; i++) {
    const id = "silent-" + i;
    const j = T0 + i * 1000;
    events.push(join(id, j, NEW), leave(id, j + 3600000));
  }
  feed(sig, events);
  const r = sig.evaluate({ asOfTs: T0 + 700000 });
  assert.equal(r.earlyMinimalSeats, 0);
  assert.equal(r.currentRatio, 0);
  assert.equal(r.holders, 30);
  assert.equal(r.flagged, false);
});

test("identity older than 24 h at join never counts; exactly 24 h is not new; 24 h minus 1 s is", () => {
  const aged = createOccupancyEarlyMinimalSignal({ capacity: 30 });
  const events = [];
  for (let i = 0; i < 30; i++) {
    const id = "aged-" + i;
    const j = T0 + i * 1000;
    events.push(join(id, j, j - 90000000), act(id, j + 30000), leave(id, j + 3600000)); // created 25 h before join
  }
  feed(aged, events);
  const r = aged.evaluate({ asOfTs: T0 + 700000 });
  assert.equal(r.earlyMinimalSeats, 0);
  assert.equal(r.flagged, false);

  const edge = createOccupancyEarlyMinimalSignal({ capacity: 30 });
  feed(edge, [
    join("exact", T0, T0 - 86400000), act("exact", T0 + 30000), leave("exact", T0 + 3600000),
    join("inside", T0, T0 - 86399000), act("inside", T0 + 30000), leave("inside", T0 + 3600000),
  ]);
  assert.equal(edge.evaluate({ asOfTs: T0 + 100000 }).earlyMinimalSeats, 1);
});

test("early boundary: activity at exactly join+300 s counts, at join+301 s it does not", () => {
  assert.equal(OCCUPANCY_EARLY_MINIMAL_EARLY_WINDOW_MS, 300000);
  const sig = createOccupancyEarlyMinimalSignal({ capacity: 30 });
  const events = [];
  for (let i = 0; i < 16; i++) {
    const id = "edge-" + i;
    const j = T0 + i * 1000;
    events.push(join(id, j, NEW), act(id, j + 300000), leave(id, j + 3600000));
  }
  for (let i = 16; i < 30; i++) {
    const id = "late-" + i;
    const j = T0 + i * 1000;
    events.push(join(id, j, NEW), act(id, j + 301000), leave(id, j + 3600000));
  }
  feed(sig, events);
  const r = sig.evaluate({ asOfTs: T0 + 400000 });
  assert.equal(r.earlyMinimalSeats, 16);
  assert.equal(r.currentRatio, 16 / 30);
  assert.equal(r.flagged, false); // the run is only ~85 s old at asOf
});

test("onEvidence fires exactly once per law, on the evaluate that first observes the flag", () => {
  const events = [];
  const sig = createOccupancyEarlyMinimalSignal({
    capacity: 30,
    onEvidence: (e) => events.push(e),
  });
  fastSquat(sig, 7200000); // 2 h hold: the drip run is not broken by leaves
  sig.evaluate({ asOfTs: T0 + 700000 });
  assert.equal(events.length, 1);
  assert.equal(events[0].law, "fast");
  assert.equal(events[0].firstFlagTs, T0 + 644000);
  assert.equal(events[0].threshold, OCCUPANCY_EARLY_MINIMAL_FAST_PROFILE.threshold);
  assert.equal(events[0].timestamp, new Date(T0 + 644000).toISOString());
  // The drip run starts when the 11th session counts (T0+40 s) and
  // completes its 3,600 s sustain at T0+3640 s.
  sig.evaluate({ asOfTs: T0 + 3700000 });
  assert.equal(events.length, 2);
  assert.equal(events[1].law, "drip");
  assert.equal(events[1].firstFlagTs, T0 + 3640000);
  assert.equal(events[1].threshold, OCCUPANCY_EARLY_MINIMAL_DRIP_PROFILE.threshold);
  sig.evaluate({ asOfTs: T0 + 3800000 });
  assert.equal(events.length, 2); // no re-fire on later evaluates
});

test("invalid ts is refused without touching state; bad options throw the named error; reset clears", () => {
  const sig = createOccupancyEarlyMinimalSignal({ capacity: 30 });
  // Evaluate before any event: structured inert result, not a throw.
  const empty = sig.evaluate();
  assert.equal(empty.flagged, false);
  assert.equal(empty.currentRatio, 0);
  const refused = sig.observe({ type: "join", identity: "x", ts: NaN });
  assert.equal(refused.status, "invalid_ts");
  assert.equal(refused.counted, false);
  assert.equal(sig.snapshot().counters.invalidTs, 1);
  assert.equal(sig.snapshot().sessions, 0);
  assert.throws(() => createOccupancyEarlyMinimalSignal({ capacity: 0 }), OccupancyEarlyMinimalError);
  assert.throws(
    () =>
      createOccupancyEarlyMinimalSignal({
        capacity: 30,
        laws: [
          { name: "dup", threshold: 0.5, sustainMs: 600000 },
          { name: "dup", threshold: 0.34, sustainMs: 3600000 },
        ],
      }),
    OccupancyEarlyMinimalError,
  );
  fastSquat(sig, 3600000);
  assert.ok(sig.snapshot().sessions > 0);
  sig.reset();
  assert.equal(sig.snapshot().sessions, 0);
  assert.equal(sig.evaluate({ asOfTs: T0 + 700000 }).flagged, false);
});
