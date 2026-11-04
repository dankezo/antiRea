const { test } = require('node:test');
const assert = require('node:assert/strict');
// This phase ports the module only; src/index.ts wiring is handled
// outside it, so the tests import the compiled module directly
// (the web-bot-auth tests use the same subpath pattern).
const sdk = require('../dist/tier2-active/bunching-monitor.js');

// ---------------------------------------------------------------------------
// Bunching monitor (HARVEST2 candidate C29). These tests port the
// decisive cells of the study lab (C29-DESIGN.md / C29-RESULTS.md)
// to the SDK module:
//   - Placebo notches {10, 20, 25, 50} on legitimate populations:
//     lab cache VALID max positive z = 2.17, SALE max 2.17, fresh-
//     seed legit max 1.55 - the gate is z < +3 at every placebo
//     notch (a single z >= +3 would have KILLED the candidate).
//   - Positive control: 2% hard calibrators (desired novel spread
//     12-28/day, hard-capped at C-1) injected into VALID gave
//     z = 36.97 at C = 15 in the lab, and migration to C = 25 gave
//     z = 29.47. The lab numbers come from the full generator
//     (~68k identity-days); this test is smaller, so it asserts
//     the mechanism - sign and the +3 threshold, with a large
//     positive z - not the lab's exact value.
//   - The advisory ceiling is structural: there is NO identity-
//     level API and no output carries a "flagged" field. That is
//     pinned below, not just documented.
// The synthetic legit population is a deterministic allocation
// (largest-remainder, no sampling noise) over a smooth two-
// component decaying weight curve over novel counts 1..60 - the
// shape family of the lab's VALID histogram - 24,000 identity-days
// across 1,200 identities x 20 days, fed through addDailyNovel.
// The full-generator reproduction lives in the lab's
// sdk-recheck.cjs, not here.
// ---------------------------------------------------------------------------

const DAY_MS = 86400e3;
const IDENTITIES = 1200;
const TOTAL_DAYS = 24000;

function legitWeights() {
  const w = [];
  for (let v = 1; v <= 60; v++) {
    w.push(0.8 * Math.exp(-0.38 * v + 0.004 * v * v - 0.00003 * v * v * v) + 0.2 * Math.exp(-0.1 * v));
  }
  return w;
}

function legitCounts(total) {
  const w = legitWeights();
  const sum = w.reduce((a, b) => a + b, 0);
  const raw = w.map((x) => (total * x) / sum);
  const counts = raw.map(Math.floor);
  let rem = total - counts.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let i = 0; i < rem; i++) counts[order[i % order.length][1]]++;
  return counts; // index 0 -> novel count 1
}

// Feed `counts` identity-days (novel = index + 1) as unique
// (identity, day) pairs: 1,200 identities cycling, one new day
// every 1,200 identity-days.
function feedCounts(inst, counts) {
  let idx = 0;
  counts.forEach((count, i) => {
    for (let j = 0; j < count; j++) {
      inst.addDailyNovel(`id-${idx % IDENTITIES}`, Math.floor(idx / IDENTITIES) * DAY_MS, i + 1);
      idx++;
    }
  });
  return idx;
}

function legitInstance() {
  const inst = sdk.createBunchingMonitor();
  const fed = feedCounts(inst, legitCounts(TOTAL_DAYS));
  assert.equal(fed, TOTAL_DAYS);
  assert.equal(inst.snapshot().identityDays, TOTAL_DAYS);
  return inst;
}

// Hard calibrators as in the lab's step1.cjs: desired novel spread
// uniformly over 12..28, hard-capped at cap - 1, so the upper tail
// piles at cap - 1. 24 identities = 2% of the 1,200-identity
// population, 20 days each.
function feedCalibrators(inst, cap) {
  for (let i = 0; i < 24; i++) {
    for (let d = 0; d < 20; d++) {
      const desired = 12 + ((i * 20 + d) % 17);
      inst.addDailyNovel(`cal-${i}`, d * DAY_MS, Math.min(desired, cap - 1));
    }
  }
}

/* ---------------- the lab's decisive cells ---------------- */

test('placebo notches on a legitimate population stay below z = +3 (lab gate: max +2.17 cache, +1.55 fresh)', () => {
  const inst = legitInstance();
  const results = inst.evaluateNotches([10, 20, 25, 50]);
  assert.equal(results.length, 4);
  for (const r of results) {
    assert.equal(r.status, 'scored', `notch ${r.notch} must score`);
    assert.equal(r.enforcement, 'none');
    assert.ok(Number.isFinite(r.z), `notch ${r.notch} z must be finite`);
    assert.ok(r.z < 3, `placebo notch ${r.notch} must stay below +3, got z=${r.z}`);
  }
});

test('hard calibrators capped at C-1 produce a large positive z at C (lab: z = 36.97 at C = 15 on the full generator)', () => {
  const inst = legitInstance();
  feedCalibrators(inst, 15);
  const r = inst.evaluate(15);
  assert.equal(r.status, 'scored');
  assert.ok(r.excessMass > 0, `excess mass must be positive, got ${r.excessMass}`);
  assert.ok(r.z >= 3, `calibrator notch must clear +3, got z=${r.z}`);
  // Mechanism strength, not the lab's exact number: at this
  // smaller scale the pile still lands an order of magnitude
  // past the placebo gate.
  assert.ok(r.z > 6, `expected a large positive z from the pile, got ${r.z}`);
});

/* ---------------- the advisory ceiling, pinned ---------------- */

test('no identity-level API exists and no output carries a "flagged" field', () => {
  const inst = legitInstance();
  assert.equal(inst.evaluateIdentity, undefined, 'instance must not expose evaluateIdentity');
  assert.equal(typeof inst.evaluate, 'function');
  assert.equal(typeof inst.evaluateNotches, 'function');
  const outputs = [
    inst.evaluate(10),
    inst.evaluateNotches([20])[0],
    inst.snapshot(),
    inst.observe({ identity: 'probe', resourceId: 1, ts: 0 }),
    inst.addDailyNovel('probe', 0, 2),
  ];
  for (const out of outputs) {
    assert.ok(!JSON.stringify(out).includes('"flagged"'), 'no output may carry a flagged field');
  }
  for (const out of outputs.slice(0, 3)) assert.equal(out.enforcement, 'none');
});

/* ---------------- population floor ---------------- */

test('a too-small population is insufficient_population and scores nothing', () => {
  const inst = sdk.createBunchingMonitor();
  for (let i = 0; i < 10; i++) inst.addDailyNovel(`tiny-${i}`, 0, 3);
  const r = inst.evaluate(10);
  assert.equal(r.status, 'insufficient_population');
  assert.equal(r.z, null);
  assert.equal(r.excessMass, null);
  assert.equal(r.se, null);
  assert.equal(r.enforcement, 'none');
});

/* ---------------- feeding lanes ---------------- */

test('observe computes novelty per (identity, UTC day): repeats are duplicates, a new day counts again', () => {
  const inst = sdk.createBunchingMonitor();
  const first = inst.observe({ identity: 'a', resourceId: 42, ts: 3600e3 });
  assert.equal(first.status, 'recorded');
  assert.equal(first.counted, true);
  assert.equal(first.novelTotal, 1);
  const dup = inst.observe({ identity: 'a', resourceId: 42, ts: 7200e3 });
  assert.equal(dup.status, 'duplicate');
  assert.equal(dup.counted, false);
  assert.equal(dup.novelTotal, 1);
  const other = inst.observe({ identity: 'a', resourceId: 43, ts: 7300e3 });
  assert.equal(other.novelTotal, 2);
  const nextDay = inst.observe({ identity: 'a', resourceId: 42, ts: DAY_MS + 1000 });
  assert.equal(nextDay.status, 'recorded');
  assert.equal(nextDay.novelTotal, 1);
  const snap = inst.snapshot();
  assert.equal(snap.histogram[2], 1); // day 0: 2 novel
  assert.equal(snap.histogram[1], 1); // day 1: 1 novel
  assert.equal(snap.counters.duplicateObserved, 1);
});

test('addDailyNovel accumulates per identity-day and moves the histogram bucket', () => {
  const inst = sdk.createBunchingMonitor();
  inst.addDailyNovel('a', 0, 5);
  const r = inst.addDailyNovel('a', 0, 4);
  assert.equal(r.novelTotal, 9);
  const snap = inst.snapshot();
  assert.equal(snap.histogram[9], 1);
  assert.equal(snap.histogram[5], 0);
  assert.equal(snap.identityDays, 1);
  assert.equal(snap.novelRecords, 9);
});

test('invalid timestamps are refused as no-ops by observe', () => {
  const inst = sdk.createBunchingMonitor();
  for (const ts of [NaN, Infinity, 8.64e15 + 1]) {
    const obs = inst.observe({ identity: 'a', resourceId: 1, ts });
    assert.equal(obs.status, 'invalid_ts');
    assert.equal(obs.counted, false);
  }
  assert.equal(inst.snapshot().counters.invalidTs, 3);
  assert.equal(inst.snapshot().identityDays, 0);
});

/* ---------------- invalid notches throw ---------------- */

test('invalid notches throw BunchingError', () => {
  const inst = legitInstance();
  for (const bad of [0, -5, NaN, Infinity, -Infinity, 2.5]) {
    assert.throws(
      () => inst.evaluate(bad),
      (err) => err.name === 'BunchingError' && err instanceof sdk.BunchingError,
      `notch ${bad} must throw`,
    );
  }
  assert.throws(
    () => inst.evaluateNotches([10, 0]),
    (err) => err.name === 'BunchingError',
  );
  assert.throws(
    () => inst.addDailyNovel('a', 0, -1),
    (err) => err.name === 'BunchingError',
  );
  assert.throws(
    () => sdk.createBunchingMonitor({ minIdentityDays: 0 }),
    (err) => err.name === 'BunchingError',
  );
});
