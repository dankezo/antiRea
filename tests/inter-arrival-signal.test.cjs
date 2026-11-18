"use strict";
// ABE-01 inter-arrival stddev component - tests mirror the frozen lab
// strata of abe-lab/REGISTRATION-ABE-STEP0.md (seed 20321101, consumed
// in the lab's fixed profile order) at SDK scale. "Regular" below is
// the component's descriptive regularity reading (stddev < 50 ms),
// never a verdict: the FP class (metronomic human, 200/200 regular)
// is asserted as measured, and the never-sole-key restriction is
// asserted structurally on the output type's runtime shape.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createInterArrivalSignal,
  combineInterArrivalComponent,
} = require("../dist/index.js");

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20321101);
const uni = (lo, hi) => lo + (hi - lo) * rng();
const N = 200;

function runProfile(genIntervals) {
  let regular = 0, measured = 0;
  for (let s = 0; s < N; s++) {
    const sig = createInterArrivalSignal();
    const intervals = genIntervals();
    let ts = 0;
    let last;
    last = sig.observe({ identity: "sess", ts });
    for (const d of intervals) { ts += d; last = sig.observe({ identity: "sess", ts }); }
    const c = last.component;
    if (c.status === "measured") { measured++; if (c.regularity === "regular") regular++; }
  }
  return { regular, measured };
}

// Consumption order matches the lab runner: BOT-JITTER, BOT-JITTER-B,
// HUMAN, HUMAN-FAST, ACCESS-REGULAR, then G4 (BOT-FIXED and CGNAT
// need no randomness; MINSAMPLES neither).
test("BOT-FIXED: interval exactly 1000 ms reads regular 200/200", () => {
  const sig = createInterArrivalSignal();
  let ts = 0;
  let last = sig.observe({ identity: "fixed", ts });
  for (let i = 0; i < 19; i++) { ts += 1000.0; last = sig.observe({ identity: "fixed", ts }); }
  assert.equal(last.component.stddevMs, 0);
  assert.equal(last.component.regularity, "regular");
  // Full 200-session profile for the fixed shape is deterministic:
  const r = runProfile(() => Array(19).fill(1000.0));
  assert.equal(r.regular, 200);
});

test("BOT-JITTER U(30,80): regular 200/200", () => {
  const r = runProfile(() => Array.from({ length: 19 }, () => uni(30, 80)));
  assert.equal(r.regular, 200);
  assert.equal(r.measured, 200);
});

test("BOT-JITTER-B descriptive: 1000 plus or minus U(30,80) reads regular only 14/200", () => {
  const r = runProfile(() => Array.from({ length: 19 }, () => 1000 + (rng() < 0.5 ? -1 : 1) * uni(30, 80)));
  assert.equal(r.regular, 14);
});

test("HUMAN U(200,800): regular 0/200", () => {
  const r = runProfile(() => Array.from({ length: 19 }, () => uni(200, 800)));
  assert.equal(r.regular, 0);
});

test("HUMAN-FAST U(150,400): regular 2/200 (lab gate line was <= 15)", () => {
  const r = runProfile(() => Array.from({ length: 19 }, () => uni(150, 400)));
  assert.equal(r.regular, 2);
});

test("ACCESS-REGULAR descriptive FP class: metronomic human reads regular 200/200", () => {
  const r = runProfile(() => Array.from({ length: 19 }, () => 300 + uni(0, 10)));
  assert.equal(r.regular, 200);
});

test("CGNAT-BATCH descriptive: bursts sharing one timestamp read regular 0/200", () => {
  let regular = 0;
  for (let s = 0; s < N; s++) {
    const sig = createInterArrivalSignal();
    let last;
    for (let b = 0; b < 4; b++) for (let k = 0; k < 5; k++) {
      last = sig.observe({ identity: "batch", ts: b * 500 });
    }
    if (last.component.regularity === "regular") regular++;
  }
  assert.equal(regular, 0);
});

test("MINSAMPLES: sessions of 2, 3 or 4 timestamps are never measured (0/150)", () => {
  let measured = 0;
  for (const len of [2, 3, 4]) {
    for (let s = 0; s < 50; s++) {
      const sig = createInterArrivalSignal();
      let last;
      for (let i = 0; i < len; i++) last = sig.observe({ identity: "short", ts: i * 1000 });
      if (last.component.status === "measured") measured++;
      assert.equal(last.component.stddevMs, null);
      assert.equal(last.component.regularity, null);
    }
  }
  assert.equal(measured, 0);
});

test("G4 high-resolution contrast: sub-ms bot reads regular on float-ms timestamps", () => {
  let regular = 0;
  for (let s = 0; s < N; s++) {
    const sig = createInterArrivalSignal();
    let ts = 0;
    let last = sig.observe({ identity: "subms", ts });
    for (let i = 0; i < 19; i++) { ts += uni(0.05, 0.15); last = sig.observe({ identity: "subms", ts }); }
    if (last.component.regularity === "regular") regular++;
  }
  assert.equal(regular, 200);
});

test("structural never-sole-key: component carries no verdict field and is CORROBORATING only", () => {
  const sig = createInterArrivalSignal();
  let last;
  for (let i = 0; i < 20; i++) last = sig.observe({ identity: "shape", ts: i * 1000 });
  const c = last.component;
  assert.equal(c.role, "CORROBORATING");
  assert.equal(c.soleKeyEligible, false);
  assert.equal(c.enforcement, "none");
  assert.ok(!("flagged" in c), "component must not carry a flagged field");
  assert.ok(!("verdict" in c), "component must not carry a verdict field");
  assert.ok(!("blocked" in c), "component must not carry a blocked field");
  assert.equal(sig.snapshot().soleKeyEligible, false);
});

test("combine: regular component alone is never eligible; corroborated regular is", () => {
  const sig = createInterArrivalSignal();
  let last;
  for (let i = 0; i < 20; i++) last = sig.observe({ identity: "bot", ts: i * 1000 });
  const regular = last.component;
  assert.deepEqual(
    combineInterArrivalComponent(regular, { independentSignalFired: false }),
    { eligible: false, reason: "no_corroboration" },
  );
  assert.deepEqual(
    combineInterArrivalComponent(regular, { independentSignalFired: true }),
    { eligible: true, reason: "corroborated_regular" },
  );
  assert.throws(() => combineInterArrivalComponent(regular, {}), /independentSignalFired/);
  assert.throws(() => combineInterArrivalComponent(regular), /independentSignalFired/);

  const human = createInterArrivalSignal();
  let ts = 0;
  let hLast = human.observe({ identity: "human", ts });
  const gaps = [200, 800, 350, 700, 250, 600, 300, 750, 400, 550, 220, 780, 310, 690, 270, 640, 380, 520, 450];
  for (const d of gaps) { ts += d; hLast = human.observe({ identity: "human", ts }); }
  assert.equal(hLast.component.regularity, "irregular");
  assert.deepEqual(
    combineInterArrivalComponent(hLast.component, { independentSignalFired: true }),
    { eligible: false, reason: "component_not_regular" },
  );
});

test("sliding window: only the last 20 timestamps are measured", () => {
  const sig = createInterArrivalSignal();
  let ts = 0;
  // 10 irregular gaps, then 20 fixed timestamps (19 fixed gaps).
  const gaps = [200, 800, 350, 700, 250, 600, 300, 750, 400, 550];
  sig.observe({ identity: "w", ts });
  for (const d of gaps) { ts += d; sig.observe({ identity: "w", ts }); }
  let last;
  for (let i = 0; i < 20; i++) { ts += 1000; last = sig.observe({ identity: "w", ts }); }
  assert.equal(last.component.samples, 20);
  assert.equal(last.component.stddevMs, 0);
  assert.equal(last.component.regularity, "regular");
});

test("invalid timestamps refused; invalid options throw", () => {
  const sig = createInterArrivalSignal();
  const r = sig.observe({ identity: "x", ts: Infinity });
  assert.equal(r.status, "invalid_ts");
  assert.equal(sig.snapshot().counters.invalidTs, 1);
  assert.throws(() => createInterArrivalSignal({ minSamples: 25 }), /minSamples/);
  assert.throws(() => createInterArrivalSignal({ thresholdMs: 0 }), /thresholdMs/);
});
