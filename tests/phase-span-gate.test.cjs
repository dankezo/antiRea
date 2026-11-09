"use strict";
/*
 * Regression tests for the span gate (range FP, 2026-11-09).
 *
 * The antirea-range smoke run confirmed 12 legitimate readers as a
 * scheduler herd at cohortR 1.0000 over a 40 s window: on a 900 s grid,
 * any population observed for a fraction of one period has all its
 * phases inside one small arc, so R_i and R_cohort approach 1 by
 * geometry alone. The gate: a member can only confirm when its event
 * span covers at least one full period, and only eligible members are
 * named. memberCount / cohortR stay descriptive and unchanged.
 *
 * Cells: (a) short-span legit, (b) long-span jittered legit,
 * (c) long-span aligned herd (positive control), (d) mixed spans,
 * (e) herd-phase core carries the same gate.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createActivityPhaseSignal, createHerdPhaseSignal } = require("../dist/index.js");

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const T0 = 1_700_000_000_000;
const PERIOD = 900_000;

test("(a) short-span legit population can never confirm", () => {
  const sig = createActivityPhaseSignal({});
  const rnd = mulberry32(101);
  for (let i = 0; i < 12; i++) {
    let t = T0 + rnd() * 5000;
    while (t < T0 + 40000) { sig.observe({ identity: `reader-${i}`, ts: Math.floor(t) }); t += 700 + rnd() * 1800; }
  }
  const r = sig.evaluate();
  assert.equal(r.status, "scored");
  assert.equal(r.memberCount, 12); // descriptive statistics unchanged
  assert.ok(r.cohortR > 0.99);
  assert.equal(r.spanEligibleMembers, 0);
  assert.equal(r.confirmed, false);
  assert.deepEqual(r.members, []);
});

test("(b) long-span jittered legit does not confirm", () => {
  const sig = createActivityPhaseSignal({});
  const rnd = mulberry32(202);
  for (let i = 0; i < 12; i++) {
    let t = T0 + rnd() * 60000;
    while (t < T0 + 1800000) { sig.observe({ identity: `reader-${i}`, ts: Math.floor(t) }); t += 20000 + rnd() * 40000; }
  }
  const r = sig.evaluate();
  assert.equal(r.confirmed, false);
  assert.deepEqual(r.members, []);
});

test("(c) positive control: one-draw-per-period aligned herd still confirms", () => {
  // minEvents lowered to 4 so the sparse one-draw-per-period shape is
  // scored at all; the lab cells use dense draws and the default 8.
  const sig = createActivityPhaseSignal({ minEvents: 4 });
  const rnd = mulberry32(606);
  for (let i = 0; i < 12; i++) {
    for (let k = 0; k < 4; k++) {
      sig.observe({ identity: `bot-${i}`, ts: T0 + 12345 + k * PERIOD + Math.floor(rnd() * 3000) });
    }
  }
  const r = sig.evaluate();
  assert.equal(r.spanEligibleMembers, 12);
  assert.equal(r.confirmed, true);
  assert.equal(r.members.length, 12);
});

test("(d) mixed spans: short-span members are not named even inside a confirmed cohort", () => {
  const sig = createActivityPhaseSignal({ minEvents: 4 });
  const rnd = mulberry32(707);
  for (let i = 0; i < 12; i++) {
    for (let k = 0; k < 4; k++) {
      sig.observe({ identity: `bot-${i}`, ts: T0 + 12345 + k * PERIOD + Math.floor(rnd() * 3000) });
    }
  }
  // 3 extra identities phase-locked but only inside 40 s
  for (let i = 0; i < 3; i++) {
    let t = T0 + 12000;
    while (t < T0 + 52000) { sig.observe({ identity: `short-${i}`, ts: Math.floor(t) }); t += 700 + rnd() * 1800; }
  }
  const r = sig.evaluate();
  assert.equal(r.confirmed, true);
  assert.equal(r.members.length, 12);
  assert.ok(!r.members.some((m) => m.startsWith("short-")));
});

test("(e) herd-phase core carries the same gate", () => {
  const sig = createHerdPhaseSignal({});
  const rnd = mulberry32(808);
  for (let i = 0; i < 12; i++) {
    let t = T0 + rnd() * 5000;
    while (t < T0 + 40000) { sig.observe({ identity: `reader-${i}`, ts: Math.floor(t) }); t += 700 + rnd() * 1800; }
  }
  const r = sig.evaluate();
  assert.equal(r.memberCount, 12);
  assert.equal(r.spanEligibleMembers, 0);
  assert.equal(r.confirmed, false);
  assert.deepEqual(r.members, []);
});
