const { test } = require('node:test');
const assert = require('node:assert/strict');
// NOTE: this phase ships the module file only; src/index.ts wiring
// is a separate integration step, so the test imports the built
// module directly from its dist path.
const mod = require('../dist/tier2-active/shrink-slope.js');
const { createShrinkSlopeSignal, shrinkSlopePosteriorExceed, ShrinkSlopeError } = mod;

// ---------------------------------------------------------------------------
// Shrink-slope signal (HARVEST2 candidate C27). These tests port the
// decisive cells of the study lab (C27-DESIGN.md / C27-RESULTS.md)
// to the SDK module:
//   - VALID legit identities: lab FP 0/1,200 in both steps; here a
//     fresh legit sample from the fitted generator must flag ~0;
//   - plateau K=20 sustained: lab 100% flagged (K=7 and K=50 too);
//   - EV-FRONTLOAD (50/day for 30 days, then ~3/day) is a REGISTERED
//     STRUCTURAL BLIND SPOT of the late-window estimand (lab 0/300)
//     and is pinned NOT flagged below;
//   - identities under 90 observation days are never scored
//     (insufficient_history) and an unfitted instance scores nothing;
//   - the posterior is computed in log space: the lab's first run
//     died of density underflow at theta = 50 (both mixture
//     densities -> 0, plateau read 0/200). The self-check pins the
//     lab's own values: theta = 50 -> 1.0000, theta = 2.4 -> 0.0000
//     under the lab's Step-0 stratum-0 constants.
// The generator is a simplified stand-in for the lab's harness-v2
// population, calibrated to the lab's published late-window shape:
// legit novelty saturates hard (per-identity late rate ~ N(2.4,
// 0.22)) with bursty day-to-day counts (daily sd ~ 2.8, so the raw
// theta-hat spread and the fitted tau land at the lab's levels:
// m ~ 2.4, tau ~ 0.22, c ~ 3.4). Plateau series use the lab's c25
// form (K + uniform jitter +/-10%), whose tiny daily variance is
// exactly what lets the posterior concentrate.
// ---------------------------------------------------------------------------

const DAY = 86400e3;
const BASE_DAY = 20000; // arbitrary UTC day anchor for fed identities

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// One legit identity in the lab's shape: novelty starts high and
// saturates to a tight per-identity late rate; counts are bursty.
function legitSeries(rng) {
  const theta = Math.min(3.6, Math.max(0.9, 2.4 + gauss(rng) * 0.22));
  const activity = 0.7 + rng() * 1.1;
  const dailyNovel = new Array(90);
  for (let d = 0; d < 90; d++) {
    const lam = d < 30 ? theta + (13 - theta) * Math.exp(-d / 9) : theta;
    dailyNovel[d] = Math.max(0, Math.round(lam + gauss(rng) * 2.8));
  }
  dailyNovel[89] = Math.max(1, dailyNovel[89]); // guarantee a day-90 sighting
  let earlyNovel = 0;
  for (let d = 0; d < 30; d++) earlyNovel += dailyNovel[d];
  const earlyRequests = Math.round(earlyNovel * 1.7 * activity);
  const dailyTotal = dailyNovel.map((n, d) => Math.max(n, Math.round(n * 1.7 * (d < 30 ? activity : 1))));
  return { dailyNovel, earlyRequests, dailyTotal };
}

// Plateau series, c25 form extended to 90 days (lab common.cjs).
function plateauSeries(rng, K) {
  const dailyNovel = new Array(90);
  for (let d = 0; d < 90; d++) dailyNovel[d] = Math.max(0, Math.round(K + (rng() - 0.5) * 0.2 * K));
  const dailyTotal = dailyNovel.map((n) => Math.round(n * 1.7));
  let earlyRequests = 0;
  for (let d = 0; d < 30; d++) earlyRequests += dailyTotal[d];
  return { dailyNovel, earlyRequests, dailyTotal };
}

function frontloadSeries(rng) {
  const dailyNovel = new Array(90);
  for (let d = 0; d < 90; d++) {
    dailyNovel[d] = d < 30
      ? Math.max(0, Math.round(50 + (rng() - 0.5) * 10))
      : Math.max(0, Math.round(3 + gauss(rng) * 1.0));
  }
  const dailyTotal = dailyNovel.map((n) => Math.round(n * 1.7));
  let earlyRequests = 0;
  for (let d = 0; d < 30; d++) earlyRequests += dailyTotal[d];
  return { dailyNovel, earlyRequests, dailyTotal };
}

// Feed one daily series through observe(): novel counts become
// fresh resources, the remaining totals revisit the first resource.
function feedSeries(inst, identity, series, days = 90) {
  let counter = 0;
  for (let d = 0; d < days; d++) {
    const novel = series.dailyNovel[d];
    const total = Math.max(series.dailyTotal[d], novel);
    for (let j = 0; j < total; j++) {
      const resourceId = j < novel ? `${identity}-r${counter++}` : `${identity}-r0`;
      const obs = inst.observe({ identity, resourceId, ts: BASE_DAY * DAY + d * DAY + j * 1000 });
      assert.equal(obs.status, 'recorded');
    }
  }
}

function fittedInstance() {
  const inst = createShrinkSlopeSignal();
  const rng = mulberry32(20261102);
  const train = [];
  for (let i = 0; i < 600; i++) {
    const s = legitSeries(rng);
    train.push({ dailyNovel: s.dailyNovel, earlyRequests: s.earlyRequests });
  }
  const fit = inst.fitFromDailySeries(train);
  assert.equal(fit.fitted, true);
  assert.equal(fit.identities, 600);
  assert.equal(fit.calibration.strata.length, 3);
  for (const par of fit.calibration.strata) {
    assert.ok(par.n >= 150, `stratum n=${par.n}`);
    assert.ok(par.m > 1.8 && par.m < 3.0, `stratum m=${par.m} at the lab level ~2.4`);
    assert.ok(par.c > par.m, 'threshold above prior location');
  }
  return inst;
}

/* ---------------- the lab's decisive cells ---------------- */

test('VALID legit identities flag at ~0 (lab FP cell: 0/1,200 in both steps)', () => {
  const inst = fittedInstance();
  const rng = mulberry32(20267501);
  const N = 60;
  let flagged = 0;
  for (let i = 0; i < N; i++) {
    const s = legitSeries(rng);
    feedSeries(inst, `valid-${i}`, s);
    const sig = inst.evaluateIdentity(`valid-${i}`);
    assert.equal(sig.status, 'scored');
    assert.equal(sig.enforcement, 'none');
    if (sig.flagged) flagged++;
  }
  assert.ok(flagged / N <= 0.02, `VALID FP ${flagged}/${N} must stay inside the lab gate of 2%`);
});

test('sustained plateau K=20 is flagged (lab sensitivity: 100% at K=7/20/50)', () => {
  const inst = fittedInstance();
  const rng = mulberry32(20267511);
  for (let i = 0; i < 12; i++) {
    const s = plateauSeries(rng, 20);
    feedSeries(inst, `plat-${i}`, s);
    const sig = inst.evaluateIdentity(`plat-${i}`);
    assert.equal(sig.status, 'scored');
    assert.equal(sig.flagged, true, `plateau ${i} must flag (theta=${sig.thetaHat}, p=${sig.posterior})`);
    assert.ok(sig.posterior >= 0.975);
    assert.ok(Math.abs(sig.thetaHat - 20) < 1.5);
  }
});

test('EV-FRONTLOAD is NOT flagged (registered structural blind spot, pinned)', () => {
  // C27-DESIGN section 3: front-loading 50/day for 30 days and then
  // dropping to ~3/day leaves a late-window theta of ~3, which the
  // estimand acquits BY DESIGN (lab: 0/300). The price the shape
  // pays is 30 days exposed at 50/day to the budget/CUSUM layer.
  const inst = fittedInstance();
  const rng = mulberry32(20267521);
  for (let i = 0; i < 6; i++) {
    const s = frontloadSeries(rng);
    feedSeries(inst, `front-${i}`, s);
    const sig = inst.evaluateIdentity(`front-${i}`);
    assert.equal(sig.status, 'scored');
    assert.equal(sig.flagged, false, `frontload ${i} must stay unflagged by design (theta=${sig.thetaHat}, p=${sig.posterior})`);
    assert.ok(sig.thetaHat < 4);
  }
});

/* ---------------- history / fit discipline ---------------- */

test('young identities are insufficient_history and never flagged', () => {
  const inst = fittedInstance();
  const rng = mulberry32(7);
  const s = plateauSeries(rng, 50); // even a maximal young extractor
  feedSeries(inst, 'young-1', s, 30);
  const sig = inst.evaluateIdentity('young-1');
  assert.equal(sig.status, 'insufficient_history');
  assert.equal(sig.daysObserved, 30);
  assert.equal(sig.flagged, false);
  assert.equal(sig.thetaHat, null);
  assert.equal(sig.posterior, null);
});

test('an unfitted instance scores nothing', () => {
  const inst = createShrinkSlopeSignal();
  const rng = mulberry32(9);
  const s = plateauSeries(rng, 50);
  feedSeries(inst, 'unfit-1', s);
  const sig = inst.evaluateIdentity('unfit-1');
  assert.equal(sig.status, 'unfitted');
  assert.equal(sig.flagged, false);
  assert.equal(inst.snapshot().fitted, false);
  assert.equal(inst.snapshot().calibration, null);
});

test('the host clock ages a silent identity (lab fixed-window semantics)', () => {
  // ~26% of the lab harness's legit identities have event spans
  // shorter than 90 days (they arrive late or go quiet); the lab
  // still scored them on the full zero-filled 90-day window. The
  // SDK reaches the same semantics when the host supplies its
  // "now": without asOfTs a 40-day-active identity is
  // insufficient_history; aged to day 90 by the host clock it is
  // scored on its zero-filled window - and a host clock that has
  // not reached day 90 changes nothing.
  const inst = fittedInstance();
  const rng = mulberry32(21);
  const s = legitSeries(rng);
  feedSeries(inst, 'silent-1', s, 40);
  const noClock = inst.evaluateIdentity('silent-1');
  assert.equal(noClock.status, 'insufficient_history');
  assert.ok(noClock.daysObserved <= 40, `event span ${noClock.daysObserved} <= 40 fed days`);
  const youngClock = inst.evaluateIdentity('silent-1', BASE_DAY * DAY + 59 * DAY);
  assert.equal(youngClock.status, 'insufficient_history');
  assert.equal(youngClock.daysObserved, 60);
  const aged = inst.evaluateIdentity('silent-1', BASE_DAY * DAY + 89 * DAY);
  assert.equal(aged.status, 'scored');
  assert.equal(aged.daysObserved, 90);
  assert.equal(aged.flagged, false);
});

test('unknown identities report unknown_identity', () => {
  const inst = fittedInstance();
  const sig = inst.evaluateIdentity('never-seen');
  assert.equal(sig.status, 'unknown_identity');
  assert.equal(sig.flagged, false);
  assert.equal(sig.daysObserved, 0);
});

test('fitting rejects malformed or undersized reference populations', () => {
  const inst = createShrinkSlopeSignal();
  assert.throws(() => inst.fitFromDailySeries([]), (err) => err.name === 'ShrinkSlopeError');
  assert.throws(
    () => inst.fitFromDailySeries([{ dailyNovel: [1, 2], earlyRequests: 10 }]),
    (err) => err.name === 'ShrinkSlopeError',
  );
  const rng = mulberry32(3);
  const bad = [];
  for (let i = 0; i < 40; i++) {
    const s = legitSeries(rng);
    bad.push({ dailyNovel: s.dailyNovel, earlyRequests: s.earlyRequests });
  }
  bad[5].dailyNovel[40] = -1;
  assert.throws(() => inst.fitFromDailySeries(bad), (err) => err.name === 'ShrinkSlopeError');
  assert.ok(new ShrinkSlopeError('x') instanceof Error);
});

/* ---------------- feed discipline ---------------- */

test('the module derives novelty itself: a revisit is not novel', () => {
  const inst = createShrinkSlopeSignal();
  const first = inst.observe({ identity: 'n1', resourceId: 42, ts: BASE_DAY * DAY });
  assert.equal(first.novel, true);
  const again = inst.observe({ identity: 'n1', resourceId: 42, ts: BASE_DAY * DAY + DAY });
  assert.equal(again.novel, false);
  assert.equal(again.dayIndex, 1);
  const other = inst.observe({ identity: 'n2', resourceId: 42, ts: BASE_DAY * DAY });
  assert.equal(other.novel, true); // novelty is per identity
});

test('invalid timestamps are refused as no-ops; malformed fields throw', () => {
  const inst = fittedInstance();
  for (const ts of [NaN, Infinity, 8.64e15 + 1]) {
    const obs = inst.observe({ identity: 'a', resourceId: 1, ts });
    assert.equal(obs.status, 'invalid_ts');
    assert.equal(obs.counted, false);
  }
  assert.equal(inst.snapshot().counters.invalidTs, 3);
  assert.throws(() => inst.observe({ identity: '', resourceId: 1, ts: 0 }), (err) => err.name === 'ShrinkSlopeError');
  assert.throws(() => inst.observe({ identity: 'a', resourceId: NaN, ts: 0 }), (err) => err.name === 'ShrinkSlopeError');
});

/* ---------------- log-space posterior self-check (the lab's fix) ---------------- */

test('posterior self-check in log space (lab Step-0 underflow fix)', () => {
  // Lab Step-0 stratum-0 constants (step0-results.json).
  const par = { m: 2.4, tau: 0.22360679774997896, c: 3.6666666666666665 };
  const far = shrinkSlopePosteriorExceed(50, 0.37, par);
  assert.ok(far > 0.9999, `theta=50 must give posterior ~1.0000, got ${far}`);
  const atPrior = shrinkSlopePosteriorExceed(2.4, 0.2, par);
  assert.ok(atPrior < 0.0001, `theta=2.4 must give posterior ~0.0000, got ${atPrior}`);
});

test('advisory-only surface: enforcement is none everywhere and no blocking API exists', () => {
  assert.equal(typeof createShrinkSlopeSignal, 'function');
  const inst = fittedInstance();
  assert.equal(inst.snapshot().enforcement, 'none');
  for (const name of ['checkServe', 'reserve', 'reserveServe', 'decide', 'block', 'enforce']) {
    assert.equal(inst[name], undefined, `instance must not expose ${name}`);
  }
});
