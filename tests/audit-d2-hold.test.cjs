"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const modules = process.env.ANTIREA_D2_HOLD_DIR || path.join(__dirname, "../dist/tier2-active");
const hold = require(path.join(modules, "hold-type-features.js"));
const occ = require(path.join(modules, "occupancy-early-minimal-signal.js"));
const names = ["mouseEventRate", "clickDurationStd", "keyHoldStd", "interKeyStd", "sType"];
const config = { taskClickIds: ["task", "other"], fields: [] };
const reference = { mean: { mouseEventRate: 10, clickDurationStd: 20, keyHoldStd: 30, interKeyStd: 40, sType: 0.2 }, sd: Object.fromEntries(names.map((n) => [n, 2])) };
const finite = (v) => { if (typeof v === "number") assert.ok(Number.isFinite(v), String(v)); else if (v && typeof v === "object") for (const x of Object.values(v)) finite(x); };
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
function rng(seed) { return () => { let t = seed += 0x6d2b79f5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
function validSession(random) {
  const events = [{ type: "wheel", t: 0 }];
  const holds = [], gaps = [], clicks = [];
  let keyTs = 100;
  for (let i = 0; i < 5; i++) {
    const h = 20 + Math.floor(random() * 100), gap = 150 + Math.floor(random() * 200);
    events.push({ type: "keydown", targetId: "field", t: keyTs }, { type: "keyup", targetId: "field", t: keyTs + h });
    holds.push(h);
    if (i < 4) gaps.push(gap);
    keyTs += gap;
  }
  for (let i = 0; i < 3; i++) {
    const h = 30 + Math.floor(random() * 100);
    clicks.push(h);
    events.push({ type: "mousedown", targetId: "task", t: 3000 + i * 200 }, { type: "mouseup", targetId: "task", t: 3000 + i * 200 + h });
  }
  for (let i = 0; i < 10; i++) events.push({ type: "pointermove", t: 5000 + i * 100 });
  events.push({ type: "wheel", t: 10000 });
  return { events, holds, gaps, clicks };
}
test("audit hold: valid random sessions preserve independent arithmetic and signed-z", () => {
  const random = rng(2920201), score = hold.createHoldTypeScorer(reference);
  for (let n = 0; n < 200; n++) {
    const s = validSession(random);
    const f = hold.computeHoldTypeFeatures(s.events, { ...config, fields: [{ id: "field", finalLength: 5, keydownCount: 5 }, { id: "fill", finalLength: 3, keydownCount: 0 }] });
    assert.equal(f.valid, true); assert.deepEqual(f.invalidReasons, []);
    approx(f.mouseEventRate, 1); approx(f.keyHoldStd, sd(s.holds)); approx(f.interKeyStd, sd(s.gaps)); approx(f.clickDurationStd, sd(s.clicks)); approx(f.sType, 3 / 8);
    approx(f.descriptive.keyHoldMean, mean(s.holds)); approx(f.descriptive.interKeyMean, mean(s.gaps)); approx(f.descriptive.clickHoldMean, mean(s.clicks));
    assert.equal(f.descriptive.nKeydown, 5); assert.equal(f.descriptive.nEvents, s.events.length); assert.equal(f.descriptive.sessionSeconds, 10);
    const r = score(f), z = names.map((name) => (name === "sType" ? 1 : -1) * (f[name] - reference.mean[name]) / 2);
    assert.equal(r.valid, true); names.forEach((name, i) => approx(r.z[name], z[i]));
    approx(r.set2Score, (z[0] + z[1]) / 2); approx(r.typeScore, (z[4] + z[2] + z[3]) / 3); approx(r.composite, mean(z));
  }
});
test("audit hold: seeded hostile event soup is finite and invalid data is neutral", () => {
  const random = rng(2920202), score = hold.createHoldTypeScorer(reference);
  const types = ["pointermove", "mousedown", "mouseup", "keydown", "keyup", "wheel"];
  for (let n = 0; n < 500; n++) {
    const events = Array.from({ length: Math.floor(random() * 40) }, () => ({ type: types[Math.floor(random() * types.length)], t: [NaN, Infinity, -Infinity, -1, 0, 1, 1e-310, 8.64e15, -8.64e15][Math.floor(random() * 9)], targetId: random() < 0.5 ? "task" : "__proto__" }));
    const f = hold.computeHoldTypeFeatures(events, config), r = score(f);
    finite(f); finite(r);
    if (!f.valid) { assert.equal(r.valid, false); assert.equal(r.composite, 0); assert.equal(r.set2Score, 0); assert.equal(r.typeScore, 0); }
  }
});
test("audit hold: empty, zero span and invalid metadata are explicit", () => {
  const empty = hold.computeHoldTypeFeatures([], config);
  assert.equal(empty.valid, false); assert.ok(empty.invalidReasons.includes("empty_session")); finite(empty);
  const zero = hold.computeHoldTypeFeatures([{ type: "pointermove", t: 0 }], config);
  assert.equal(zero.valid, false); assert.ok(zero.invalidReasons.includes("zero_span")); assert.ok(zero.invalidReasons.includes("non_finite_rate")); assert.equal(zero.mouseEventRate, 0);
  const badField = hold.computeHoldTypeFeatures([{ type: "wheel", t: 0 }, { type: "wheel", t: 1000 }], { ...config, fields: [{ finalLength: -1, keydownCount: 0 }, { finalLength: Infinity, keydownCount: 0 }] });
  assert.equal(badField.valid, false); assert.ok(badField.invalidReasons.includes("invalid_field")); assert.equal(badField.sType, 0);
  const badEvent = hold.computeHoldTypeFeatures([null, { type: "wheel", t: NaN }, { type: "wheel", t: 0 }, { type: "wheel", t: 1000 }], config);
  assert.equal(badEvent.valid, false); assert.deepEqual(badEvent.invalidReasons, ["invalid_event"]);
});
test("audit hold: pair defects never become evidence and one-pair SD stays zero", () => {
  for (const type of ["mousedown", "keydown"]) {
    const f = hold.computeHoldTypeFeatures([{ type, t: 0, targetId: "task" }, { type: "wheel", t: 1000 }], config);
    assert.equal(f.valid, false); assert.ok(f.invalidReasons.includes(type === "mousedown" ? "click_pair" : "key_pair")); finite(f);
  }
  const negative = hold.computeHoldTypeFeatures([{ type: "mousedown", targetId: "task", t: 100 }, { type: "mouseup", targetId: "task", t: 0 }, { type: "keydown", t: 100 }, { type: "keyup", t: 0 }], config);
  assert.equal(negative.valid, false); assert.equal(negative.clickDurationStd, 0); assert.equal(negative.keyHoldStd, 0); assert.equal(negative.descriptive.keyHoldMean, 0);
  const one = hold.computeHoldTypeFeatures([{ type: "mousedown", targetId: "task", t: 0 }, { type: "mouseup", targetId: "task", t: 100 }], config);
  assert.equal(one.valid, true); assert.equal(one.clickDurationStd, 0); assert.equal(one.descriptive.clickHoldMean, 100);
});
test("audit hold: cross-target intervals and non-task clicks are excluded", () => {
  const e = [{ type: "wheel", t: 0 }, { type: "wheel", t: 1000 }];
  for (let i = 0; i < 4; i++) e.push({ type: "keydown", t: i * 100, targetId: `f-${i}` }, { type: "keyup", t: i * 100 + 20, targetId: `f-${i}` });
  e.push({ type: "mousedown", t: 400, targetId: "focus" });
  const f = hold.computeHoldTypeFeatures(e, config);
  assert.equal(f.valid, true); assert.equal(f.interKeyStd, 0); assert.equal(f.descriptive.interKeyMean, 0); assert.equal(f.clickDurationStd, 0);
});
test("audit hold: backwards key stream is invalid and scorer handles hostile direct inputs", () => {
  const f = hold.computeHoldTypeFeatures([{ type: "keydown", t: 100 }, { type: "keyup", t: 120 }, { type: "keydown", t: 0 }, { type: "keyup", t: 20 }], config);
  assert.equal(f.valid, false); assert.ok(f.invalidReasons.includes("negative_inter_key"));
  const score = hold.createHoldTypeScorer(reference);
  for (const v of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    const r = score(Object.fromEntries(names.map((n) => [n, v]))); finite(r);
    if (!Number.isFinite(v)) { assert.equal(r.valid, false); assert.equal(r.composite, 0); }
  }
  const overflow = hold.createHoldTypeScorer({ mean: Object.fromEntries(names.map((n) => [n, -Number.MAX_VALUE])), sd: Object.fromEntries(names.map((n) => [n, Number.MIN_VALUE])) });
  assert.equal(overflow(Object.fromEntries(names.map((n) => [n, Number.MAX_VALUE]))).valid, false);
});
test("audit hold: frozen reference and zero/non-finite scales are inert", () => {
  const ref = { mean: { ...reference.mean }, sd: { ...reference.sd } }, score = hold.createHoldTypeScorer(ref);
  const f = Object.fromEntries(names.map((n) => [n, 0])), before = score(f);
  ref.mean.mouseEventRate = 100000; ref.sd.mouseEventRate = 0;
  assert.deepEqual(score(f), before);
  for (const scale of [0, -1, Infinity, NaN]) {
    const r = hold.createHoldTypeScorer({ mean: reference.mean, sd: Object.fromEntries(names.map((n) => [n, scale])) })(f);
    for (const z of Object.values(r.z)) assert.equal(z, 0);
  }
});
test("audit hold: resource limits reject excessive arrays", () => {
  assert.throws(() => hold.computeHoldTypeFeatures(new Array(100001), config), RangeError);
  assert.throws(() => hold.computeHoldTypeFeatures([], { ...config, fields: new Array(10001) }), RangeError);
  assert.throws(() => hold.computeHoldTypeFeatures([], { ...config, taskClickIds: new Array(10001) }), RangeError);
  assert.throws(() => hold.createHoldTypeScorer(null), TypeError);
});
test("audit hold: two-click variance and invalid field/timestamp boundaries", () => {
  const two = hold.computeHoldTypeFeatures([{ type: "mousedown", targetId: "task", t: 0 }, { type: "mouseup", targetId: "task", t: 40 }, { type: "mousedown", targetId: "task", t: 100 }, { type: "mouseup", targetId: "task", t: 180 }], config);
  assert.equal(two.clickDurationStd, 20);
  for (const field of [{ finalLength: -1, keydownCount: 0 }, { finalLength: 1, keydownCount: -1 }]) {
    const f = hold.computeHoldTypeFeatures([{ type: "wheel", t: 0 }, { type: "wheel", t: 1000 }], { ...config, fields: [field] });
    assert.equal(f.valid, false); assert.ok(f.invalidReasons.includes("invalid_field")); assert.equal(f.sType, 0);
  }
  const f = hold.computeHoldTypeFeatures([{ type: "wheel", t: 0 }, { type: "wheel", t: 8.64e15 + 1 }], config);
  assert.ok(f.invalidReasons.includes("invalid_event"));
});
function feed(signal, events) { for (const e of events) signal.observe(e); }
function session(id, join = 0, activity = 1000, leave = 10000000, created = -1000) { return [{ type: "join", identity: id, ts: join, accountCreatedTs: created }, { type: "activity", identity: id, ts: activity }, { type: "leave", identity: id, ts: leave }]; }
test("audit D2: frozen profiles and exact sustain boundaries", () => {
  assert.equal(occ.OCCUPANCY_EARLY_MINIMAL_EARLY_WINDOW_MS, 300000); assert.equal(occ.OCCUPANCY_EARLY_MINIMAL_NEWNESS_WINDOW_MS, 86400000);
  const s = occ.createOccupancyEarlyMinimalSignal({ capacity: 10 });
  for (let i = 0; i < 5; i++) feed(s, session(`id-${i}`));
  const before = s.evaluate({ asOfTs: 600999 }), at = s.evaluate({ asOfTs: 601000 });
  assert.equal(before.flagged, false); assert.equal(at.laws[0].flagged, true); assert.equal(at.laws[0].firstFlagTs, 601000);
  assert.equal(at.laws[0].threshold, 0.5); assert.equal(at.laws[0].sustainMs, 600000); assert.equal(at.laws[1].threshold, 0.34); assert.equal(at.laws[1].sustainMs, 3600000); assert.equal(at.enforcement, "none");
  assert.equal(s.evaluate({ asOfTs: 3601000 }).laws[1].firstFlagTs, 3601000);
});
test("audit D2: independent random interval oracle matches ratios and both flag laws", () => {
  const random = rng(2920203);
  for (let k = 0; k < 60; k++) {
    const s = occ.createOccupancyEarlyMinimalSignal({ capacity: 12, laws: [{ name: "short", threshold: 0.5, sustainMs: 60 }, { name: "long", threshold: 0.34, sustainMs: 120 }] });
    const intervals = [], events = [];
    for (let i = 0; i < 12; i++) {
      const j = Math.floor(random() * 100), l = j + 200 + Math.floor(random() * 200), times = Array.from({ length: Math.floor(random() * 5) }, () => j + 1 + Math.floor(random() * 300)).sort((a, b) => a - b);
      const created = random() < 0.8 ? j - 1000 : j - 86400000;
      events.push({ type: "join", identity: String(i), ts: j, accountCreatedTs: created }, ...times.map((t) => ({ type: "activity", identity: String(i), ts: t })), { type: "leave", identity: String(i), ts: l });
      if (created > j - 86400000 && times.length) intervals.push([times[0], Math.min(l, times[2] ?? Infinity)]);
    }
    feed(s, events.sort((a, b) => a.ts - b.ts));
    const starts = [null, null], flags = [null, null];
    for (let t = 0; t <= 600; t++) {
      const ratio = intervals.filter(([a, b]) => t >= a && t < b).length / 12;
      const r = s.evaluate({ asOfTs: t }); approx(r.currentRatio, ratio);
      for (let law = 0; law < 2; law++) {
        if (starts[law] !== null && t - starts[law] >= [60, 120][law] && flags[law] === null) flags[law] = t;
        if (ratio >= [0.5, 0.34][law]) { if (starts[law] === null) starts[law] = t; } else starts[law] = null;
        assert.equal(r.laws[law].firstFlagTs, flags[law], `seedcase=${k}/t=${t}/law=${law}`);
      }
    }
  }
});
test("audit D2: closed and open session caps are hard and counters expose loss", () => {
  const s = occ.createOccupancyEarlyMinimalSignal({ capacity: 1, maxSessions: 1 });
  assert.equal(s.observe({ type: "join", identity: "a", ts: 0 }).counted, true);
  assert.deepEqual(s.observe({ type: "join", identity: "b", ts: 1 }), { status: "capacity_exceeded", counted: false });
  assert.equal(s.snapshot().sessions, 1); assert.equal(s.snapshot().openSessions, 1); assert.equal(s.snapshot().counters.rejectedSessions, 1);
  assert.equal(s.snapshot().saturated, true); assert.equal(s.snapshot().trackedIdentities, 1);
  s.observe({ type: "activity", identity: "a", ts: 1 });
  const saturated = s.evaluate({ asOfTs: 4000000 });
  assert.equal(saturated.saturated, true); assert.equal(saturated.flagged, false); assert.ok(saturated.laws.every((l) => !l.flagged && l.firstFlagTs === null));
  s.observe({ type: "leave", identity: "a", ts: 2 });
  assert.equal(s.observe({ type: "join", identity: "b", ts: 3 }).counted, true);
  assert.equal(s.snapshot().sessions, 1); assert.equal(s.snapshot().counters.evictedSessions, 1);
  assert.equal(s.snapshot().counters.observed, 5);
});
test("audit D2: over-capacity hosts stay within [0,1] and left sessions never double count", () => {
  const s = occ.createOccupancyEarlyMinimalSignal({ capacity: 1 });
  for (let i = 0; i < 3; i++) { s.observe({ type: "join", identity: `id-${i}`, ts: 0 }); s.observe({ type: "activity", identity: `id-${i}`, ts: 1 }); }
  assert.equal(s.evaluate({ asOfTs: 2 }).currentRatio, 1); assert.equal(s.evaluate({ asOfTs: 2 }).earlyMinimalSeats, 3);
  for (let i = 0; i < 3; i++) s.observe({ type: "leave", identity: `id-${i}`, ts: 3 });
  for (let i = 0; i < 3; i++) s.observe({ type: "leave", identity: `id-${i}`, ts: 4 });
  assert.equal(s.evaluate({ asOfTs: 5 }).earlyMinimalSeats, 0); assert.equal(s.evaluate({ asOfTs: 5 }).holders, 0); assert.equal(s.snapshot().counters.orphanEvents, 3);
});
test("audit D2: future and exact-boundary creation timestamps are excluded", () => {
  const s = occ.createOccupancyEarlyMinimalSignal({ capacity: 10 });
  feed(s, session("future", 0, 1, 1000000, 1)); feed(s, session("old", 0, 1, 1000000, -86400000)); feed(s, session("new", 0, 1, 1000000, -86399999));
  assert.equal(s.evaluate({ asOfTs: 100 }).earlyMinimalSeats, 1); assert.equal(s.evaluate({ asOfTs: 100 }).currentRatio, 0.1);
});
test("audit D2: early endpoints, third activity and earliest-three retention", () => {
  const s = occ.createOccupancyEarlyMinimalSignal({ capacity: 10 });
  feed(s, session("at-join", 0, 0)); feed(s, session("edge", 0, 300000)); feed(s, session("late", 0, 300001));
  assert.equal(s.evaluate({ asOfTs: 300000 }).earlyMinimalSeats, 1);
  assert.equal(s.evaluate({ asOfTs: 299999 }).earlyMinimalSeats, 0);
  const a = occ.createOccupancyEarlyMinimalSignal({ capacity: 1 });
  a.observe({ type: "join", identity: "a", ts: 0 });
  for (const ts of [100000, 200000, 300000, 5000, 6000, 7000]) a.observe({ type: "activity", identity: "a", ts });
  assert.equal(a.evaluate({ asOfTs: 4999 }).earlyMinimalSeats, 0); assert.equal(a.evaluate({ asOfTs: 5000 }).earlyMinimalSeats, 1); assert.equal(a.evaluate({ asOfTs: 6999 }).earlyMinimalSeats, 1); assert.equal(a.evaluate({ asOfTs: 7000 }).earlyMinimalSeats, 0);
});
test("audit D2: a late second activity drops its session and leaves are half-open", () => {
  const s = occ.createOccupancyEarlyMinimalSignal({ capacity: 1 });
  s.observe({ type: "join", identity: "a", ts: 0 }); s.observe({ type: "activity", identity: "a", ts: 1 }); s.observe({ type: "activity", identity: "a", ts: 300001 }); s.observe({ type: "leave", identity: "a", ts: 400000 });
  assert.equal(s.evaluate({ asOfTs: 300000 }).earlyMinimalSeats, 1); assert.equal(s.evaluate({ asOfTs: 300001 }).earlyMinimalSeats, 0); assert.equal(s.evaluate({ asOfTs: 400000 }).holders, 0);
});
test("audit D2: rejoin closes prior and stale leave cannot create a negative session", () => {
  const s = occ.createOccupancyEarlyMinimalSignal({ capacity: 1 });
  s.observe({ type: "join", identity: "a", ts: 100 }); s.observe({ type: "activity", identity: "a", ts: 101 });
  assert.equal(s.observe({ type: "join", identity: "a", ts: 99 }).counted, false);
  s.observe({ type: "leave", identity: "a", ts: 99 });
  assert.equal(s.snapshot().openSessions, 1);
  s.observe({ type: "join", identity: "a", ts: 200 }); s.observe({ type: "activity", identity: "a", ts: 201 });
  assert.equal(s.evaluate({ asOfTs: 250 }).earlyMinimalSeats, 1); assert.equal(s.evaluate({ asOfTs: 250 }).holders, 1); assert.equal(s.snapshot().sessions, 2);
});
test("audit D2: timestamp storage, forgotten metadata, and equal-time rejoin stay bounded", () => {
  const s = occ.createOccupancyEarlyMinimalSignal({ capacity: 1, maxSessions: 1 });
  s.observe({ type: "join", identity: "a", ts: 0 });
  for (let ts = 1; ts <= 10000; ts++) s.observe({ type: "activity", identity: "a", ts });
  assert.equal(s.snapshot().retainedActivityTimestamps, 3);
  s.observe({ type: "leave", identity: "a", ts: 10001 });
  s.observe({ type: "join", identity: "b", ts: 10002 }); s.observe({ type: "leave", identity: "b", ts: 10003 });
  s.observe({ type: "join", identity: "a", ts: 2 * 86400000 }); s.observe({ type: "activity", identity: "a", ts: 2 * 86400000 + 1 });
  assert.equal(s.evaluate().earlyMinimalSeats, 1);
  assert.equal(s.observe({ type: "join", identity: "a", ts: 2 * 86400000 }).counted, true);
  assert.equal(s.snapshot().openSessions, 1); assert.equal(s.snapshot().sessions, 1);
  assert.equal(s.evaluate().earlyMinimalSeats, 0);
});
test("audit D2: shuffled valid event soup never throws and stays bounded", () => {
  const random = rng(2920204);
  for (let k = 0; k < 100; k++) {
    const events = [];
    for (let i = 0; i < 20; i++) events.push(...session(i === 0 ? "__proto__" : String(i), i, i + 100, i + 500));
    for (let i = events.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [events[i], events[j]] = [events[j], events[i]]; }
    const s = occ.createOccupancyEarlyMinimalSignal({ capacity: 5, maxSessions: 8 }); feed(s, events);
    const r = s.evaluate({ asOfTs: 1000 }); assert.ok(r.currentRatio >= 0 && r.currentRatio <= 1); assert.ok(s.snapshot().sessions <= 8); finite(r);
  }
});
test("audit D2: malformed timestamps/options and payload bounds fail explicitly", () => {
  const s = occ.createOccupancyEarlyMinimalSignal({ capacity: 1 });
  assert.equal(s.evaluate().flagged, false);
  for (const ts of [NaN, Infinity, -Infinity, 8.64e15 + 1]) assert.deepEqual(s.observe({ type: "join", identity: "a", ts }), { status: "invalid_ts", counted: false });
  assert.equal(s.snapshot().counters.invalidTs, 4); assert.equal(s.snapshot().sessions, 0);
  assert.throws(() => s.observe({ type: "join", identity: "a", ts: 0, accountCreatedTs: Infinity }));
  assert.throws(() => s.observe({ type: "join", identity: "x".repeat(1025), ts: 0 }));
  assert.throws(() => s.observe({ type: "join", identity: " ", ts: 0 }));
  assert.throws(() => s.observe({ type: "bad", identity: "a", ts: 0 }));
  assert.throws(() => s.evaluate({ asOfTs: NaN }));
  for (const opts of [{ capacity: 0 }, { capacity: 1.5 }, { capacity: 1, maxSessions: 0 }, { capacity: 1, earlyWindowMs: 0 }, { capacity: 1, newnessWindowMs: Infinity }, { capacity: 1, laws: [] }, { capacity: 1, laws: new Array(33).fill({ threshold: 0.5, sustainMs: 1 }) }, { capacity: 1, laws: [{ threshold: 0, sustainMs: 1 }] }, { capacity: 1, laws: [{ threshold: 1.01, sustainMs: 1 }] }, { capacity: 1, laws: [{ threshold: 0.5, sustainMs: -1 }] }]) assert.throws(() => occ.createOccupancyEarlyMinimalSignal(opts));
});
test("audit D2: evidence is once per law, rejection-safe, and reset rearms", async () => {
  const emitted = [];
  const s = occ.createOccupancyEarlyMinimalSignal({ capacity: 1, laws: [{ name: "custom", threshold: 1, sustainMs: 10 }], onEvidence: async (e) => { emitted.push(e); throw new Error("operator failed"); } });
  feed(s, session("a", 0, 1, 100)); s.evaluate({ asOfTs: 11 }); s.evaluate({ asOfTs: 12 });
  await new Promise((r) => setImmediate(r));
  assert.equal(emitted.length, 1); assert.equal(emitted[0].law, "custom"); assert.equal(emitted[0].firstFlagTs, 11); assert.equal(emitted[0].threshold, 1); assert.equal(emitted[0].sustainMs, 10); assert.equal(emitted[0].timestamp, new Date(11).toISOString());
  s.reset(); assert.equal(s.snapshot().sessions, 0); assert.equal(s.snapshot().openSessions, 0); assert.equal(s.snapshot().counters.observed, 0); assert.equal(s.evaluate().flagged, false);
  feed(s, session("a", 0, 1, 100)); s.evaluate({ asOfTs: 11 }); await new Promise((r) => setImmediate(r)); assert.equal(emitted.length, 2);
});
