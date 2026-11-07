const { test } = require('node:test');
const assert = require('node:assert/strict');
// Tests import the compiled module directly (the herd-phase-signal
// tests use the same subpath pattern).
const sdk = require('../dist/tier2-active/herd-tightness-signal.js');
const { createHerdTightnessSignal, HerdTightnessError, phasePlanePoint, phaseCloudD0max } = sdk;

// ---------------------------------------------------------------------------
// Herd-tightness signal (HARVEST candidate H7-11, candidate-level
// PASS-lab at cycle C148). These tests pin:
//   - the pure statistic (phaseCloudD0max) on exact hand-computed
//     clouds, including the lab's V5 property (duplicate points
//     never change d0max) and the two-cluster single-linkage value;
//   - the lab's binding cells in synthetic form: a shared-scheduler
//     herd reads TIGHT against a legitimate reference; a cohort
//     drawn from the same legitimate family as the reference reads
//     NOT tight; an independent-offset herd reads NOT tight (the
//     registered by-design blind spot);
//   - the honesty contract: no reference -> "uncalibrated" with
//     tight === null (never a verdict on the raw number); too few
//     identities -> "insufficient_population"; evaluate() on an
//     empty instance never throws.
// The synthetic streams are deterministic (mulberry32), so the
// assertions are exact, not statistical hopes.
// ---------------------------------------------------------------------------

const BASE = 1_730_000_000_000; // fixed epoch ms; no wall clock anywhere
const PERIOD_MS = 900_000;
const DAY_MS = 86_400_000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Shared-grid herd: every identity on the SAME 900 s grid offset, jitter 30 s. */
function feedSharedHerd(feed, prefix, count, events, seed) {
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < events; k++) {
      const ts = BASE + k * PERIOD_MS + Math.round(gauss(rng) * 30_000);
      feed({ identity: `${prefix}-${i}`, ts });
    }
  }
}

/** Independent herd: same grid, but each identity has its OWN offset. */
function feedIndepHerd(feed, prefix, count, events, seed) {
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const offset = Math.floor(rng() * PERIOD_MS);
    for (let k = 0; k < events; k++) {
      const ts = BASE + offset + k * PERIOD_MS + Math.round(gauss(rng) * 30_000);
      feed({ identity: `${prefix}-${i}`, ts });
    }
  }
}

/**
 * Legitimate-family stream: each identity keeps a personal daily
 * rhythm (personal start minute, per-identity jitter strength), so
 * phase-plane points fill a disk at personal angles with varied
 * resultant lengths - the harness LEGIT shape in synthetic form.
 */
function feedLegit(feed, prefix, count, events, seed) {
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const startMin = Math.floor(rng() * 1440);
    const jitterSec = 30 * Math.pow(60, rng()); // 30 s .. 1800 s, log-spread
    for (let k = 0; k < events; k++) {
      const day = Math.floor(k / 2);
      const ts =
        BASE + day * DAY_MS + startMin * 60_000 + Math.round(gauss(rng) * jitterSec * 1000);
      feed({ identity: `${prefix}-${i}`, ts });
    }
  }
}

test('phaseCloudD0max: exact values on hand-computed clouds', () => {
  assert.equal(phaseCloudD0max([]), 0);
  assert.equal(phaseCloudD0max([[0, 0]]), 0);
  // Two points: the only edge.
  assert.equal(phaseCloudD0max([[0, 0], [3, 4]]), 5);
  // Two clusters: d0max is the single-linkage bridge = the minimum
  // cross-cluster pairwise distance (lab validation V3 property).
  const twoClusters = [
    [0, 0], [0.1, 0], [0, 0.1],
    [5, 0], [5.1, 0], [5, 0.1],
  ];
  assert.ok(Math.abs(phaseCloudD0max(twoClusters) - 4.9) < 1e-9);
  // Duplicates never change d0max (lab V5 property).
  const withDupes = [...twoClusters, [0, 0], [5, 0], [0.1, 0]];
  assert.equal(phaseCloudD0max(withDupes), phaseCloudD0max(twoClusters));
});

test('phasePlanePoint: grid-locked stream lands near (1, 0); scattered stream stays near origin', () => {
  const locked = [];
  for (let k = 0; k < 16; k++) locked.push(BASE + k * PERIOD_MS);
  const [lx, ly] = phasePlanePoint(locked, 900);
  // All phases identical (spacing = the grid period), so the point
  // sits ON the unit circle at the phase of BASE itself.
  const phi0 = 2 * Math.PI * ((BASE % PERIOD_MS) / PERIOD_MS);
  assert.ok(Math.abs(Math.hypot(lx, ly) - 1) < 1e-9);
  assert.ok(Math.abs(lx - Math.cos(phi0)) < 1e-9 && Math.abs(ly - Math.sin(phi0)) < 1e-9);
  const rng = mulberry32(7);
  const scattered = [];
  for (let k = 0; k < 16; k++) scattered.push(BASE + Math.floor(rng() * 7 * DAY_MS));
  const [sx, sy] = phasePlanePoint(scattered, 900);
  assert.ok(Math.hypot(sx, sy) < 0.75);
  assert.deepEqual(phasePlanePoint([], 900), [0, 0]);
});

test('shared-scheduler herd reads TIGHT against a legitimate reference (C148 G1 shape)', () => {
  const sig = createHerdTightnessSignal();
  feedLegit((e) => sig.observeReference(e), 'ref', 14, 14, 501);
  feedSharedHerd((e) => sig.observe(e), 'bot', 12, 12, 502);
  const r = sig.evaluate();
  assert.equal(r.kind, 'herd-tightness');
  assert.equal(r.status, 'scored');
  assert.equal(r.scoredIdentities, 12);
  assert.equal(r.referenceIdentities, 14);
  assert.equal(r.tight, true);
  assert.ok(r.d0max !== null && r.d0max < r.bar, `d0max ${r.d0max} !< bar ${r.bar}`);
  assert.ok(r.marginRel !== null && r.marginRel > 0);
  assert.equal(r.enforcement, 'none');
});

test('a cohort from the legitimate family itself reads NOT tight (C148 G2 shape)', () => {
  const sig = createHerdTightnessSignal();
  feedLegit((e) => sig.observeReference(e), 'ref', 14, 14, 601);
  feedLegit((e) => sig.observe(e), 'user', 12, 14, 602);
  const r = sig.evaluate();
  assert.equal(r.status, 'scored');
  assert.equal(r.tight, false);
  assert.ok(r.d0max !== null && r.d0max >= r.bar, `d0max ${r.d0max} !>= bar ${r.bar}`);
});

test('independent-offset herd reads NOT tight - the registered by-design blind spot', () => {
  const sig = createHerdTightnessSignal();
  feedLegit((e) => sig.observeReference(e), 'ref', 14, 14, 701);
  feedIndepHerd((e) => sig.observe(e), 'bot', 12, 12, 702);
  const r = sig.evaluate();
  assert.equal(r.status, 'scored');
  assert.equal(r.tight, false);
  assert.ok(r.d0max !== null && r.d0max >= r.bar, `d0max ${r.d0max} !>= bar ${r.bar}`);
});

test('no reference population -> uncalibrated, tight is null, raw d0max still reported', () => {
  const sig = createHerdTightnessSignal();
  feedSharedHerd((e) => sig.observe(e), 'bot', 12, 12, 801);
  const r = sig.evaluate();
  assert.equal(r.status, 'uncalibrated');
  assert.equal(r.tight, null);
  assert.equal(r.d0max, null);
  assert.ok(r.d0maxRaw !== null && r.d0maxRaw >= 0);
});

test('too few scored identities -> insufficient_population; empty instance never throws', () => {
  const empty = createHerdTightnessSignal();
  const r0 = empty.evaluate();
  assert.equal(r0.status, 'insufficient_population');
  assert.equal(r0.tight, null);

  const sig = createHerdTightnessSignal();
  feedSharedHerd((e) => sig.observe(e), 'bot', 5, 12, 901);
  feedLegit((e) => sig.observeReference(e), 'ref', 14, 14, 902);
  const r = sig.evaluate();
  assert.equal(r.status, 'insufficient_population');
  assert.equal(r.scoredIdentities, 5);
});

test('identities below the event floor are not scored', () => {
  const sig = createHerdTightnessSignal();
  feedLegit((e) => sig.observeReference(e), 'ref', 14, 14, 1001);
  feedSharedHerd((e) => sig.observe(e), 'bot', 12, 12, 1002);
  // Three extra identities with only 3 events each: never scored.
  feedSharedHerd((e) => sig.observe(e), 'thin', 3, 3, 1003);
  const r = sig.evaluate();
  assert.equal(r.cohortIdentities, 15);
  assert.equal(r.scoredIdentities, 12);
});

test('invalid timestamps are refused as no-ops; snapshot counters track both streams', () => {
  const sig = createHerdTightnessSignal();
  const bad = sig.observe({ identity: 'x', ts: Number.NaN });
  assert.deepEqual(bad, { status: 'invalid_ts', counted: false });
  const good = sig.observeReference({ identity: 'r', ts: BASE });
  assert.equal(good.status, 'recorded');
  const snap = sig.snapshot();
  assert.equal(snap.counters.invalidTs, 1);
  assert.equal(snap.counters.referenceObserved, 1);
  assert.equal(snap.counters.observed, 0);
  assert.equal(snap.enforcement, 'none');
});

test('invalid options throw HerdTightnessError', () => {
  assert.throws(() => createHerdTightnessSignal({ periodSec: 0 }), HerdTightnessError);
  assert.throws(() => createHerdTightnessSignal({ minEvents: 1 }), HerdTightnessError);
  assert.throws(() => createHerdTightnessSignal({ tightnessBar: -1 }), HerdTightnessError);
  assert.throws(() => createHerdTightnessSignal({ tightnessBar: Number.NaN }), HerdTightnessError);
  const sig = createHerdTightnessSignal();
  assert.throws(() => sig.observe({ identity: '', ts: BASE }), HerdTightnessError);
  assert.throws(() => sig.evaluate({ asOfTs: Number.POSITIVE_INFINITY }), HerdTightnessError);
});
