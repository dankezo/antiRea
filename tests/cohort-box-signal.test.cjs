const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ---------------------------------------------------------------------------
// Cohort box signal (HARVEST2 candidate C19, BLS-COHORT). These tests
// port the decisive cells of the study lab (C19-STEP0.md /
// C19-DESIGN.md / C19-RESULTS.md) to the SDK module:
//   - legitimate cohorts: 0 flags (lab: 0/150 RAND + 0/50 CHUNK-POOL -
//     the family where phase folding, C15, died at 9.8% FP);
//   - sale cohorts: 0 flags (lab: 0/50 - the harness sale spike is a
//     single day-5 episode, not a periodic box, so BLS + day-block
//     bootstrap does not convict it; contrast C18's 80% FP death);
//   - shift herds: 36h rotation flagged 9/9 and 48h 8/9 in the lab;
//     here one cohort of each rotation must flag;
//   - SHIFT-24 (24h rotation aligned to the day) is a STRUCTURAL
//     BLIND SPOT, registered before the lab ran: the day-block
//     bootstrap preserves circadian phase, so a day-aligned box is
//     the null's own shape (lab: 0/9, p 0.015-0.865). The test below
//     pins the blindness as designed behavior;
//   - declared stratification: a shift-shaped cohort the host
//     declares as a legitimate stratum is never flagged, and its
//     statistics are still reported.
// The generators below are simplified stand-ins for the lab's
// harness-v2 populations, calibrated to the same shapes (daytime
// sessions for legit; shared shift schedules for herds). Absolute
// S_beta levels differ from the lab's by generator construction;
// the separations and the verdicts are the lab's.
// ---------------------------------------------------------------------------

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
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

const HOUR = 3600e3;
const DAY = 86400e3;

// Legitimate member: daytime sessions on ~85% of days.
function legitMember(rng) {
  const ts = [];
  for (let d = 0; d < 14; d++) {
    if (rng() > 0.85) continue;
    const sessions = 2 + Math.floor(rng() * 3);
    for (let s = 0; s < sessions; s++) {
      let t = d * DAY + (7 + rng() * 15) * HOUR + rng() * HOUR;
      const events = 8 + Math.floor(rng() * 25);
      for (let i = 0; i < events; i++) {
        ts.push(t);
        t += (1 + rng() * 7) * 60e3;
      }
    }
  }
  return ts;
}

// Sale member: legit plus a shared day-5 evening session (the
// harness sale shape: one episode, same evening, every member).
function saleMember(rng) {
  const ts = legitMember(rng);
  let t = 5 * DAY + 19 * HOUR;
  for (let i = 0; i < 40; i++) {
    ts.push(t);
    t += (1 + rng() * 3) * 60e3;
  }
  return ts.sort((a, b) => a - b);
}

// Shift herd member: a schedule shared by the whole cohort -
// shifts of `shiftH` hours every `periodH` hours, in-shift
// renewal gaps ~900s (the lab's frozen construction).
function shiftMember(rng, periodH, shiftH, phaseH) {
  const ts = [];
  const period = periodH * HOUR;
  const shift = shiftH * HOUR;
  for (let start = phaseH * HOUR; start < 14 * DAY; start += period) {
    let t = start + Math.max(60e3, (900 + gauss(rng) * 30) * 1e3);
    while (t < start + shift && t < 14 * DAY) {
      ts.push(t);
      t += Math.max(60e3, (900 + gauss(rng) * 30) * 1e3);
    }
  }
  return ts;
}

function feedCohort(inst, cohortId, memberTs, extra = {}) {
  memberTs.forEach((list, m) => {
    for (const ts of list) inst.observe({ identity: `m${m}`, cohortId, ts, ...extra });
  });
}

/* ---------------- the lab's decisive cells ---------------- */

test('legitimate cohorts are not flagged (lab FP cell: 0/150 RAND, 0/50 CHUNK)', () => {
  for (let seed = 0; seed < 3; seed++) {
    const inst = sdk.createCohortBoxSignal();
    const rng = mulberry32(1000 + seed);
    feedCohort(inst, 'c', Array.from({ length: 24 }, () => legitMember(rng)));
    const sig = inst.evaluateCohort('c');
    assert.equal(sig.status, 'scored');
    assert.equal(sig.flagged, false, `legit seed ${seed} must not flag (p=${sig.pValue})`);
    assert.ok(sig.pValue > 0.01, `legit seed ${seed} p must stay above alpha`);
    assert.equal(sig.enforcement, 'none');
    assert.equal(sig.members, 24);
  }
});

test('sale cohorts are not flagged (lab FP cell: 0/50)', () => {
  const inst = sdk.createCohortBoxSignal();
  const rng = mulberry32(2000);
  feedCohort(inst, 'c', Array.from({ length: 24 }, () => saleMember(rng)));
  const sig = inst.evaluateCohort('c');
  assert.equal(sig.status, 'scored');
  assert.equal(sig.flagged, false, `sale cohort must not flag (p=${sig.pValue})`);
});

test('shift herds on 36h and 48h rotations are flagged (lab teeth: 9/9 and 8/9)', () => {
  for (const [periodH, shiftH] of [[36, 12], [48, 12]]) {
    const inst = sdk.createCohortBoxSignal();
    const phase = mulberry32(3000 + periodH)() * periodH;
    const members = Array.from({ length: 24 }, (_, m) =>
      shiftMember(mulberry32(4000 + periodH * 100 + m), periodH, shiftH, phase));
    feedCohort(inst, 'c', members);
    const sig = inst.evaluateCohort('c');
    assert.equal(sig.status, 'scored');
    assert.equal(sig.flagged, true, `${periodH}h rotation must flag (p=${sig.pValue})`);
    assert.ok(sig.pValue <= 0.01);
    // The winning period recovers the rotation (lab SHIFT-36: ~36.4h).
    assert.ok(
      Math.abs(sig.bestPeriodHours - periodH) < periodH * 0.15,
      `best period ${sig.bestPeriodHours} should recover the ${periodH}h rotation`,
    );
    assert.ok(sig.beta >= 1, 'beta is floored at 1 by construction');
    assert.ok(sig.scoreSBeta <= sig.scoreS, 'deflation never inflates the statistic');
  }
});

test('SHIFT-24 day-aligned rotation is NOT flagged (registered structural blind spot)', () => {
  // C19-STEP0 section 5 + C19-RESULTS: the day-block bootstrap
  // keeps circadian phase, so a 24h box aligned to the day is a
  // shape the null itself generates (lab 0/9). This test pins the
  // blindness so it can never be silently "fixed" into a claim -
  // and it is exactly why declared stratification exists: a
  // day-rhythm legitimate operation and a day-rhythm herd are the
  // same shape to this statistic.
  const inst = sdk.createCohortBoxSignal();
  const phase = 2; // shifts start at 02:00 daily, squarely inside the day.
  const members = Array.from({ length: 24 }, (_, m) =>
    shiftMember(mulberry32(4000 + 24 * 100 + m), 24, 8, phase));
  feedCohort(inst, 'c', members);
  const sig = inst.evaluateCohort('c');
  assert.equal(sig.status, 'scored');
  assert.equal(sig.flagged, false, `day-aligned rotation must stay inside the null (p=${sig.pValue})`);
  assert.ok(sig.pValue > 0.01);
});

test('declared stratum: a shift-shaped declared cohort is never flagged, statistics still reported', () => {
  const inst = sdk.createCohortBoxSignal({ declaredStrata: ['declared-shift-team'] });
  const phase = mulberry32(3036)() * 36;
  const members = Array.from({ length: 24 }, (_, m) =>
    shiftMember(mulberry32(4000 + 36 * 100 + m), 36, 12, phase));
  feedCohort(inst, 'c', members, { stratum: 'declared-shift-team' });
  const sig = inst.evaluateCohort('c');
  assert.equal(sig.status, 'declared_stratum');
  assert.equal(sig.flagged, false);
  assert.equal(sig.stratum, 'declared-shift-team');
  // Transparency: the numbers are computed and visible - the
  // declaration changes the verdict, not the evidence.
  assert.ok(sig.pValue !== null && sig.pValue <= 0.01, 'the underlying shape is still measured');
  assert.ok(sig.scoreSBeta !== null);
});

/* ---------------- determinism, windows, discipline ---------------- */

test('evaluation is deterministic: identical retained data gives identical p', () => {
  const inst = sdk.createCohortBoxSignal();
  const rng = mulberry32(1000);
  feedCohort(inst, 'c', Array.from({ length: 24 }, () => legitMember(rng)));
  const a = inst.evaluateCohort('c');
  const b = inst.evaluateCohort('c');
  assert.equal(a.pValue, b.pValue);
  assert.equal(a.scoreSBeta, b.scoreSBeta);
  assert.equal(a.beta, b.beta);
  assert.equal(a.bestPeriodHours, b.bestPeriodHours);
});

test('insufficient data: unknown and tiny cohorts are never scored', () => {
  const inst = sdk.createCohortBoxSignal();
  const unknown = inst.evaluateCohort('nope');
  assert.equal(unknown.status, 'insufficient_data');
  assert.equal(unknown.flagged, false);
  assert.equal(unknown.pValue, null);

  const rng = mulberry32(7);
  const few = legitMember(rng).slice(0, 30); // 30 events < minCohortEvents (100)
  feedCohort(inst, 'tiny', [few]);
  const tiny = inst.evaluateCohort('tiny');
  assert.equal(tiny.status, 'insufficient_data');
  assert.equal(tiny.flagged, false);
  assert.equal(tiny.eventsInWindow, 30);
});

test('invalid timestamps are refused as no-ops before any state is touched', () => {
  const inst = sdk.createCohortBoxSignal();
  for (const ts of [NaN, Infinity, -Infinity, 8.64e15 + 1]) {
    const obs = inst.observe({ identity: 'a', cohortId: 'c', ts });
    assert.equal(obs.status, 'invalid_ts');
    assert.equal(obs.counted, false);
    assert.equal(obs.events, 0);
  }
  assert.equal(inst.snapshot().counters.invalidTs, 4);
  assert.equal(inst.snapshot().cohortsTracked, 0);
});

test('malformed options and events throw named errors', () => {
  for (const opts of [{ windowDays: 0 }, { alpha: 0 }, { alpha: 0.9 }, { bootstrapReplicas: 3 }, { declaredStrata: [''] }]) {
    assert.throws(
      () => sdk.createCohortBoxSignal(opts),
      (err) => err.name === 'CohortBoxSignalError',
      `expected CohortBoxSignalError for ${JSON.stringify(opts)}`,
    );
  }
  const inst = sdk.createCohortBoxSignal();
  assert.throws(
    () => inst.observe({ identity: '', cohortId: 'c', ts: 0 }),
    (err) => err.name === 'CohortBoxSignalError',
  );
  // A non-numeric ts is not a programming-shape error but a bad
  // timestamp: refused as an invalid_ts no-op (F-21 discipline).
  const obs = inst.observe({ identity: 'a', cohortId: 'c', ts: 'now' });
  assert.equal(obs.status, 'invalid_ts');
  assert.equal(obs.counted, false);
});

test('advisory-only surface: enforcement is none everywhere and no blocking API exists', () => {
  assert.equal(typeof sdk.createCohortBoxSignal, 'function');
  const inst = sdk.createCohortBoxSignal();
  assert.equal(inst.snapshot().enforcement, 'none');
  for (const name of ['checkServe', 'reserve', 'reserveServe', 'decide', 'block', 'enforce']) {
    assert.equal(inst[name], undefined, `instance must not expose ${name}`);
  }
});
