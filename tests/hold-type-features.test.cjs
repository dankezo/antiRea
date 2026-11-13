"use strict";
// RECOMB-02 HOLD-TYPE (PASS-LAB Step 0) - mechanical feature computation
// and the frozen signed-z composite. These tests pin the runner's exact
// definitions (recomb02-run.cjs computeFeatures) on synthetic sessions:
// population SDs, event-order pairing, the per-field s_type rule, and
// the scorer signs (higher signed z = more agent-like). No detection
// claim is tested or implied - Step 0 covers computation only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeHoldTypeFeatures, createHoldTypeScorer } = require("../dist/index.js");

function approx(actual, expected, tol, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    label + ": expected ~" + expected + ", got " + actual,
  );
}

const CONFIG = {
  taskClickIds: ["k1", "k2"],
  fields: [
    { id: "f-name", finalLength: 5, keydownCount: 5 },
    { id: "f-email", finalLength: 4, keydownCount: 4 },
    { id: "f-note", finalLength: 6, keydownCount: 0 },
  ],
};

function sessionEvents() {
  const ev = [];
  // Three keystrokes in f-name, constant 50 ms holds, 200 ms apart.
  for (const t0 of [1000, 1200, 1400]) {
    ev.push({ type: "keydown", t: t0, targetId: "f-name" });
    ev.push({ type: "keyup", t: t0 + 50, targetId: "f-name" });
  }
  // Two task clicks: holds 80 ms and 120 ms (population SD 20).
  ev.push({ type: "mousedown", t: 2000, targetId: "k1" });
  ev.push({ type: "mouseup", t: 2080, targetId: "k1" });
  ev.push({ type: "mousedown", t: 3000, targetId: "k2" });
  ev.push({ type: "mouseup", t: 3120, targetId: "k2" });
  // A field-focus click (not a task target) must not enter click stats.
  ev.push({ type: "mousedown", t: 3500, targetId: "f-name" });
  ev.push({ type: "mouseup", t: 3900, targetId: "f-name" });
  // 20 pointermoves.
  for (let i = 0; i < 20; i++) ev.push({ type: "pointermove", t: 4000 + i * 100 });
  // Last event stretches the session span to exactly 10 s.
  ev.push({ type: "wheel", t: 11000 });
  return ev;
}

test("constant key holds and intervals give zero SDs; click SD is the population SD", () => {
  const f = computeHoldTypeFeatures(sessionEvents(), CONFIG);
  assert.equal(f.keyHoldStd, 0);
  assert.equal(f.descriptive.keyHoldMean, 50);
  assert.equal(f.interKeyStd, 0);
  assert.equal(f.descriptive.interKeyMean, 200);
  approx(f.clickDurationStd, 20, 1e-12, "clickDurationStd");
  approx(f.descriptive.clickHoldMean, 100, 1e-12, "clickHoldMean");
  // 20 pointermoves over a 10 s span.
  approx(f.mouseEventRate, 2, 1e-12, "mouseEventRate");
  assert.equal(f.descriptive.sessionSeconds, 10);
  assert.equal(f.descriptive.nKeydown, 3);
  assert.equal(f.descriptive.nEvents, sessionEvents().length);
});

test("varying key holds give the population SD", () => {
  const ev = [
    { type: "keydown", t: 0, targetId: "f-name" },
    { type: "keyup", t: 40, targetId: "f-name" },
    { type: "keydown", t: 200, targetId: "f-name" },
    { type: "keyup", t: 280, targetId: "f-name" },
  ];
  const f = computeHoldTypeFeatures(ev, CONFIG);
  approx(f.keyHoldStd, 20, 1e-12, "keyHoldStd"); // holds 40 and 80
  assert.equal(f.descriptive.keyHoldMean, 60);
  assert.equal(f.interKeyStd, 0); // only one interval
});

test("s_type: keydown-typed fields count 0, a programmatically filled field counts fully", () => {
  const f = computeHoldTypeFeatures(sessionEvents(), CONFIG);
  // f-note: 6 chars, 0 keydowns -> programmatic; total 5 + 4 + 6 = 15.
  approx(f.sType, 6 / 15, 1e-12, "sType");

  const typed = computeHoldTypeFeatures(sessionEvents(), {
    taskClickIds: CONFIG.taskClickIds,
    fields: [
      { id: "f-name", finalLength: 5, keydownCount: 5 },
      { id: "f-email", finalLength: 4, keydownCount: 4 },
      { id: "f-note", finalLength: 6, keydownCount: 6 },
    ],
  });
  assert.equal(typed.sType, 0);

  const filled = computeHoldTypeFeatures(sessionEvents(), {
    taskClickIds: CONFIG.taskClickIds,
    fields: [{ id: "f-note", finalLength: 6, keydownCount: 0 }],
  });
  assert.equal(filled.sType, 1);
});

test("bad key pairing yields NaN keyHoldStd (runner semantics)", () => {
  const ev = [
    { type: "keydown", t: 0, targetId: "f-name" },
    { type: "keydown", t: 100, targetId: "f-name" },
    { type: "keyup", t: 150, targetId: "f-name" },
  ];
  const f = computeHoldTypeFeatures(ev, CONFIG);
  assert.ok(Number.isNaN(f.keyHoldStd));
});

test("scorer signs: lower-than-reference clickDurationStd gives a positive z", () => {
  const score = createHoldTypeScorer({
    mean: { mouseEventRate: 10, clickDurationStd: 50, keyHoldStd: 20, interKeyStd: 30, sType: 0.1 },
    sd: { mouseEventRate: 10, clickDurationStd: 10, keyHoldStd: 10, interKeyStd: 10, sType: 0.1 },
  });
  const s = score({ mouseEventRate: 0, clickDurationStd: 30, keyHoldStd: 20, interKeyStd: 30, sType: 0.3 });
  approx(s.z.mouseEventRate, 1, 1e-9, "z mouseEventRate"); // negated sign
  approx(s.z.clickDurationStd, 2, 1e-9, "z clickDurationStd"); // below mean -> positive
  approx(s.z.keyHoldStd, 0, 1e-9, "z keyHoldStd");
  approx(s.z.interKeyStd, 0, 1e-9, "z interKeyStd");
  approx(s.z.sType, 2, 1e-9, "z sType"); // as-is sign
  approx(s.set2Score, 1.5, 1e-9, "set2Score");
  approx(s.typeScore, 2 / 3, 1e-9, "typeScore");
  approx(s.composite, 1, 1e-9, "composite");
});

test("scorer sd=0 guard yields z 0 for that feature", () => {
  const score = createHoldTypeScorer({
    mean: { mouseEventRate: 10, clickDurationStd: 50, keyHoldStd: 20, interKeyStd: 30, sType: 0.1 },
    sd: { mouseEventRate: 10, clickDurationStd: 0, keyHoldStd: 10, interKeyStd: 10, sType: 0.1 },
  });
  const s = score({ mouseEventRate: 0, clickDurationStd: 30, keyHoldStd: 20, interKeyStd: 30, sType: 0.3 });
  assert.equal(s.z.clickDurationStd, 0);
});
