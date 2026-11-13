"use strict";
// WALL-03 ownership probe (incremental build) - tests mirror the frozen
// lab families of WALL-03-REGISTRATION.md at SDK scale: sweep shapes must
// flag, the three legit families must not, the 6 h window must catch the
// slow sweep the 1 h window misses, and the incremental state must agree
// with the batch (lab) semantics on the same corpus.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createOwnershipProbe } = require("../dist/index.js");

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const BASE = 1763000000;
const PRIVATE = "GET /docs/:id";
const PUBLIC_ARTICLE = "GET /public/article";
const PUBLIC_FEED = "GET /feed";
const resolveEvader = (objectId) => "o" + objectId;
const resolveAdmin = (objectId) =>
  objectId.startsWith("admin-obj-") ? "admin-owner-" + objectId.split("-")[2] : "o" + objectId;

test("sequential-ID sweep flags with correct evidence", () => {
  const probe = createOwnershipProbe({ resolveOwner: resolveEvader, publicRoutes: [PUBLIC_ARTICLE, PUBLIC_FEED] });
  const rnd = mulberry32(101);
  let ts = BASE;
  let r;
  const actualOwners = new Set();
  for (let i = 0; i < 30; i++) {
    ts += ri(rnd, 30, 60);
    actualOwners.add("o" + "obj-" + i);
    r = probe.observe("sweeper", { objectId: "obj-" + i, route: PRIVATE, ts });
  }
  const w = r.windows[0];
  assert.equal(w.verdict, "flag");
  assert.equal(w.countedTouches, 30);
  assert.equal(w.distinctOwners, 30);
  assert.equal(w.ratio, 1);
  assert.ok(w.evidence.owners.length <= 10);
  for (const o of w.evidence.owners) assert.ok(actualOwners.has(o));
  assert.equal(r.flagged, true);
});

test("random-ID sweep flags across many sessions", () => {
  const probe = createOwnershipProbe({ resolveOwner: resolveEvader, publicRoutes: [PUBLIC_ARTICLE] });
  const rnd = mulberry32(20298103);
  let flagged = 0;
  for (let s = 0; s < 50; s++) {
    let ts = BASE;
    let r;
    for (let i = 0; i < 25; i++) {
      ts += ri(rnd, 30, 60);
      r = probe.observe("rand-" + s, { objectId: "obj-" + Math.floor(rnd() * 1e9), route: PRIVATE, ts });
    }
    if (r.windows[0].verdict === "flag") flagged++;
  }
  assert.equal(flagged, 50);
});

test("legit (a): public-page reader is exempt - insufficient_history, counted 0", () => {
  const probe = createOwnershipProbe({ resolveOwner: resolveEvader, publicRoutes: [PUBLIC_ARTICLE, PUBLIC_FEED] });
  const rnd = mulberry32(7);
  let ts = BASE;
  let r;
  for (let i = 0; i < 40; i++) {
    ts += ri(rnd, 10, 60);
    r = probe.observe("reader", { objectId: "art-" + i, route: i % 2 ? PUBLIC_ARTICLE : PUBLIC_FEED, ts });
  }
  assert.equal(r.windows[0].verdict, "insufficient_history");
  assert.equal(r.windows[0].countedTouches, 0);
  assert.equal(r.flagged, false);
});

test("legit (b): news aggregator (public feed + few familiar private owners) does not flag", () => {
  const probe = createOwnershipProbe({ resolveOwner: resolveAdmin, publicRoutes: [PUBLIC_ARTICLE, PUBLIC_FEED] });
  const rnd = mulberry32(8);
  let ts = BASE;
  let r;
  for (let i = 0; i < 60; i++) {
    ts += ri(rnd, 10, 60);
    r = probe.observe("agg", { objectId: "art-" + i, route: PUBLIC_FEED, ts });
  }
  for (let i = 0; i < 6; i++) {
    ts += ri(rnd, 10, 60);
    const familiar = i % 3;
    r = probe.observe("agg", { objectId: "admin-obj-" + familiar + "-" + i, route: PRIVATE, ts });
  }
  assert.notEqual(r.windows[0].verdict, "flag");
  assert.equal(r.flagged, false);
});

test("legit (c): real admin touching <= 3 familiar owners does not flag", () => {
  const probe = createOwnershipProbe({ resolveOwner: resolveAdmin, publicRoutes: [PUBLIC_ARTICLE] });
  const rnd = mulberry32(9);
  let ts = BASE;
  let r;
  for (let i = 0; i < 100; i++) {
    ts += ri(rnd, 5, 30);
    r = probe.observe("admin", { objectId: "admin-obj-" + (i % 3) + "-" + (i % 100), route: PRIVATE, ts });
  }
  const w = r.windows[0];
  assert.equal(w.verdict, "ok");
  assert.equal(w.distinctOwners, 3);
  assert.ok(w.ratio < 0.5);
});

test("slow sweep: 1 h window stays insufficient, 6 h window flags (dual window, one state)", () => {
  const probe = createOwnershipProbe({
    resolveOwner: resolveEvader,
    windows: [{ windowSeconds: 3600 }, { windowSeconds: 21600 }],
  });
  let ts = BASE;
  let r;
  // 8 touches per hour for 8 hours, every object a distinct owner.
  for (let i = 0; i < 64; i++) {
    ts += 450;
    r = probe.observe("slow", { objectId: "slow-obj-" + i, route: PRIVATE, ts });
  }
  assert.equal(r.windows[0].verdict, "insufficient_history");
  assert.equal(r.windows[1].verdict, "flag");
  assert.equal(r.flagged, true);
});

test("unknown owners count in the denominator, never as strange owners", () => {
  const probe = createOwnershipProbe({
    resolveOwner: (id) => (id.startsWith("known-") ? "o" + id : null),
  });
  let ts = BASE;
  let r;
  for (let i = 0; i < 20; i++) {
    ts += 30;
    r = probe.observe("mix", { objectId: "known-" + i, route: PRIVATE, ts });
    ts += 30;
    r = probe.observe("mix", { objectId: "mystery-" + i, route: PRIVATE, ts });
  }
  const w = r.windows[0];
  assert.equal(w.countedTouches, 40);
  assert.equal(w.unknownOwnerTouches, 20);
  assert.equal(w.distinctOwners, 20);
  assert.equal(w.ratio, 0.5);
  assert.equal(w.verdict, "flag");
});

test("owner resolutions are cached per object id", () => {
  let calls = 0;
  const probe = createOwnershipProbe({
    resolveOwner: (id) => { calls++; return "o" + id; },
  });
  let ts = BASE;
  for (let i = 0; i < 100; i++) {
    ts += 10;
    probe.observe("cacher", { objectId: "obj-" + (i % 10), route: PRIVATE, ts });
  }
  assert.equal(calls, 10);
  assert.equal(probe.size().cachedOwners, 10);
});

test("onEvidence fires once on the transition into flag, not on every touch", () => {
  const events = [];
  const probe = createOwnershipProbe({
    resolveOwner: resolveEvader,
    onEvidence: (e) => events.push(e),
  });
  let ts = BASE;
  for (let i = 0; i < 40; i++) {
    ts += 30;
    probe.observe("ev", { objectId: "e-obj-" + i, route: PRIVATE, ts });
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].identity, "ev");
  assert.equal(events[0].result.verdict, "flag");
});

test("eviction: after the window passes, the verdict falls back to insufficient_history", () => {
  const probe = createOwnershipProbe({ resolveOwner: resolveEvader });
  let ts = BASE;
  for (let i = 0; i < 30; i++) {
    ts += 30;
    probe.observe("fader", { objectId: "f-obj-" + i, route: PRIVATE, ts });
  }
  assert.equal(probe.check("fader").windows[0].verdict, "flag");
  const later = probe.check("fader", ts + 7200);
  assert.equal(later.windows[0].verdict, "insufficient_history");
  assert.equal(later.windows[0].countedTouches, 0);
});

test("incremental state agrees with batch semantics on a mixed corpus", () => {
  // Batch reference implementing the frozen lab semantics directly.
  function batch(touches) {
    const lastTs = touches[touches.length - 1].ts;
    const floor = lastTs - 3600;
    const owners = new Map();
    let counted = 0, unknown = 0;
    for (const t of touches) {
      if (t.ts < floor) continue;
      if (t.route === PUBLIC_ARTICLE || t.route === PUBLIC_FEED) continue;
      counted++;
      const o = resolveAdmin(t.objectId);
      if (o === null || o === undefined) { unknown++; continue; }
      owners.set(o, (owners.get(o) || 0) + 1);
    }
    const distinct = owners.size;
    const ratio = counted > 0 ? distinct / counted : 0;
    const verdict = counted < 20 ? "insufficient_history" : distinct >= 10 && ratio >= 0.5 ? "flag" : "ok";
    return { counted, distinct, ratio, unknown, verdict };
  }
  const probe = createOwnershipProbe({ resolveOwner: resolveAdmin, publicRoutes: [PUBLIC_ARTICLE, PUBLIC_FEED] });
  const rnd = mulberry32(42);
  for (let s = 0; s < 30; s++) {
    const id = "mix-" + s;
    const touches = [];
    let ts = BASE;
    const n = ri(rnd, 5, 60);
    for (let i = 0; i < n; i++) {
      ts += ri(rnd, 5, 120);
      const kind = rnd();
      const t = kind < 0.3
        ? { objectId: "art-" + ri(rnd, 0, 500), route: PUBLIC_FEED, ts }
        : kind < 0.6
          ? { objectId: "admin-obj-" + ri(rnd, 0, 2) + "-" + ri(rnd, 0, 90), route: PRIVATE, ts }
          : { objectId: "obj-" + ri(rnd, 0, 500), route: PRIVATE, ts };
      touches.push(t);
      probe.observe(id, t);
    }
    const got = probe.check(id).windows[0];
    const want = batch(touches);
    assert.equal(got.countedTouches, want.counted, id + " counted");
    assert.equal(got.distinctOwners, want.distinct, id + " distinct");
    assert.equal(got.unknownOwnerTouches, want.unknown, id + " unknown");
    assert.equal(got.verdict, want.verdict, id + " verdict");
    assert.ok(Math.abs(got.ratio - want.ratio) < 1e-12, id + " ratio");
  }
});

test("cost smoke: 100k-touch window ingests and flags correctly", () => {
  const probe = createOwnershipProbe({ resolveOwner: resolveEvader });
  let r;
  for (let i = 0; i < 100000; i++) {
    r = probe.observe("bulk", { objectId: "bulk-" + i, route: PRIVATE, ts: BASE + i * 0.036 });
  }
  const w = r.windows[0];
  assert.equal(w.countedTouches, 100000);
  assert.equal(w.distinctOwners, 100000);
  assert.equal(w.verdict, "flag");
});

test("reset drops one identity, or everything when omitted", () => {
  const probe = createOwnershipProbe({ resolveOwner: resolveEvader });
  let ts = BASE;
  for (let i = 0; i < 25; i++) {
    ts += 30;
    probe.observe("a", { objectId: "a-" + i, route: PRIVATE, ts });
    probe.observe("b", { objectId: "b-" + i, route: PRIVATE, ts });
  }
  probe.reset("a");
  assert.equal(probe.check("a").windows[0].verdict, "insufficient_history");
  assert.equal(probe.check("b").windows[0].verdict, "flag");
  probe.reset();
  assert.deepEqual(probe.size(), { identities: 0, cachedOwners: 0 });
});

test("resolveOwner is required", () => {
  assert.throws(() => createOwnershipProbe({}), TypeError);
});
