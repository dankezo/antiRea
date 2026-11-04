const { test } = require('node:test');
const assert = require('node:assert/strict');
// NOTE: this module is not yet re-exported from src/index.ts in this
// phase, so the test drives the compiled module file directly.
const mod = require('../dist/tier2-active/watchlist-signal.js');
const { createWatchlistSignal, WatchlistSignalError, WATCHLIST_LAB_TAU } = mod;

// ---------------------------------------------------------------------------
// Watchlist signal (HARVEST2 candidate C30). These tests port the
// decisive cells of the study lab (C30-DESIGN.md / C30-RESULTS.md /
// C30-RESULTS-EVENT.md) to the SDK module at test scale:
//   - unjittered pollers (period 1 and 2 days) flag - lab 120/120;
//   - legitimate mixed-rhythm identities do not flag (lab FP VALID
//     1.33% at n=1,200; here a small pooled rate is asserted);
//   - identities below the eligibility floors (>= 3 resources with
//     >= 5 distinct visit days) are ineligible and never flag;
//   - a strongly habitual construction (majority of qualifying
//     resources checked daily) flags - the descriptive HABITUAL
//     shape (lab FP 4.83% on diluted constructions; the strong
//     undiluted construction here is the poller shape itself);
//   - invalid timestamps are structured no-ops (F-21 discipline);
//   - scoring is deterministic: same stream, same verdict.
// The legit generator is a simplified self-contained stand-in with
// the lab's shape: several resources revisited at irregular
// (random-gap) rhythms over 90 days.
// ---------------------------------------------------------------------------

const DAY = 86400e3;

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

function feedDays(inst, identity, resourceId, days) {
  for (const d of days) {
    const obs = inst.observe({ identity, resourceId, ts: d * DAY + 7 * 3600e3 });
    assert.equal(obs.status, 'recorded');
  }
}

function rangeDays(step, count, start = 0) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(start + i * step);
  return out;
}

// Irregular visit days for one resource: each day visited with
// probability 0.30 independently. The gaps are then geometric -
// mean ~3.3 days, CV ~0.84, the lab legit shape (TRAIN median
// identity CV 0.746). A uniform-gap generator would be far too
// regular (CV ~0.49) and is NOT the lab shape.
function irregularDays(rng, days = 90) {
  const out = [];
  for (let d = 0; d < days; d++) if (rng() < 0.3) out.push(d);
  return out;
}

function feedLegitIdentity(inst, rng, identity, nResources = 6) {
  for (let r = 0; r < nResources; r++) {
    feedDays(inst, identity, 100 + r, irregularDays(rng));
  }
}

/* ------------------------------ teeth ---------------------------------- */

test('poller polling every resource daily flags (lab: 120/120, statistic 0)', () => {
  const inst = createWatchlistSignal();
  for (let r = 0; r < 8; r++) feedDays(inst, 'poller-1', 500 + r, rangeDays(1, 90));
  const ev = inst.evaluateIdentity('poller-1');
  assert.equal(ev.status, 'scored');
  assert.equal(ev.flagged, true);
  assert.equal(ev.statistic, 0);
  assert.equal(ev.eligibleResources, 8);
  assert.equal(ev.tau, WATCHLIST_LAB_TAU);
  assert.equal(ev.tau, 0.6130895965797241);
  assert.equal(ev.enforcement, 'none');
});

test('poller on a 2-day period flags (constant gaps of 2, CV 0)', () => {
  const inst = createWatchlistSignal();
  for (let r = 0; r < 5; r++) feedDays(inst, 'poller-2', 700 + r, rangeDays(2, 45));
  const ev = inst.evaluateIdentity('poller-2');
  assert.equal(ev.status, 'scored');
  assert.equal(ev.flagged, true);
  assert.equal(ev.statistic, 0);
});

/* --------------------------- legit population --------------------------- */

test('legit mixed-rhythm identities flag only at a small pooled rate (lab FP VALID 1.33%)', () => {
  const inst = createWatchlistSignal();
  const rng = mulberry32(20267350);
  const N = 60;
  let flagged = 0;
  let scored = 0;
  for (let i = 0; i < N; i++) {
    const id = `legit-${i}`;
    feedLegitIdentity(inst, rng, id);
    const ev = inst.evaluateIdentity(id);
    if (ev.status === 'scored') scored++;
    if (ev.flagged) flagged++;
  }
  assert.equal(scored, N, 'every generated legit identity should be eligible');
  // Test-scale assertion of the lab cell: the pooled rate must stay
  // in the low single digits, nowhere near the poller rate.
  assert.ok(flagged / N <= 0.1, `legit flag rate ${flagged}/${N} must stay <= 10% at test scale`);
});

test('a single irregular identity is scored and not flagged', () => {
  const inst = createWatchlistSignal();
  const rng = mulberry32(42);
  feedLegitIdentity(inst, rng, 'reader');
  const ev = inst.evaluateIdentity('reader');
  assert.equal(ev.status, 'scored');
  assert.equal(ev.flagged, false);
  assert.ok(ev.statistic > WATCHLIST_LAB_TAU, `statistic ${ev.statistic} should sit above tau`);
});

/* ------------------------------ HABITUAL -------------------------------- */

test('strong HABITUAL construction flags: daily checks dominate the median', () => {
  // Descriptive HABITUAL shape at full strength: 3 resources checked
  // every day (CV 0) plus 1 irregular resource. Sorted CVs are
  // [0, 0, 0, high], the lab median (index floor(4/2) = 2) is 0.
  const inst = createWatchlistSignal();
  const rng = mulberry32(7);
  for (let r = 0; r < 3; r++) feedDays(inst, 'habitual-strong', 900 + r, rangeDays(1, 90));
  feedDays(inst, 'habitual-strong', 999, irregularDays(rng));
  const ev = inst.evaluateIdentity('habitual-strong');
  assert.equal(ev.status, 'scored');
  assert.equal(ev.flagged, true);
  assert.equal(ev.statistic, 0);
});

/* ---------------------------- eligibility ------------------------------- */

test('ineligible identities never flag: too few qualifying resources', () => {
  const inst = createWatchlistSignal();
  // Only 2 resources, both perfectly periodic - still ineligible.
  for (let r = 0; r < 2; r++) feedDays(inst, 'thin', 300 + r, rangeDays(1, 90));
  const ev = inst.evaluateIdentity('thin');
  assert.equal(ev.status, 'ineligible');
  assert.equal(ev.flagged, false);
  assert.equal(ev.statistic, null);
  assert.equal(ev.eligibleResources, 2);
});

test('ineligible: resources below the 5-visit-day floor do not qualify', () => {
  const inst = createWatchlistSignal();
  for (let r = 0; r < 4; r++) feedDays(inst, 'sparse', 300 + r, rangeDays(1, 4));
  const ev = inst.evaluateIdentity('sparse');
  assert.equal(ev.status, 'ineligible');
  assert.equal(ev.eligibleResources, 0);
  assert.equal(ev.flagged, false);
});

test('unknown identities report unknown_identity and never flag', () => {
  const inst = createWatchlistSignal();
  const ev = inst.evaluateIdentity('nobody');
  assert.equal(ev.status, 'unknown_identity');
  assert.equal(ev.flagged, false);
  assert.equal(ev.statistic, null);
});

/* ------------------------------ window ---------------------------------- */

test('trailing window: regularity older than the window no longer qualifies', () => {
  const inst = createWatchlistSignal();
  // 3 resources checked daily on days 0..9, then only 2 recent days
  // each; the identity's latest day is 100, so the 90-day trailing
  // window starts at day 11 and the old daily runs fall out.
  for (let r = 0; r < 3; r++) {
    feedDays(inst, 'stale', 300 + r, [...rangeDays(1, 10), 95, 100]);
  }
  const ev = inst.evaluateIdentity('stale');
  assert.equal(ev.status, 'ineligible');
  assert.equal(ev.flagged, false);
});

/* --------------------------- ts discipline ------------------------------ */

test('invalid timestamps are refused as no-ops and touch no state', () => {
  const inst = createWatchlistSignal();
  for (const ts of [NaN, Infinity, -Infinity, 8.64e15 + 1, -8.64e15 - 1]) {
    const obs = inst.observe({ identity: 'victim', resourceId: 500, ts });
    assert.equal(obs.status, 'invalid_ts');
    assert.equal(obs.counted, false);
  }
  assert.equal(inst.snapshot().counters.invalidTs, 5);
  assert.equal(inst.evaluateIdentity('victim').status, 'unknown_identity');
});

test('malformed fields throw the named error', () => {
  const inst = createWatchlistSignal();
  assert.throws(
    () => inst.observe({ identity: '', resourceId: 500, ts: 0 }),
    (err) => err.name === 'WatchlistSignalError' && err instanceof WatchlistSignalError,
  );
  assert.throws(
    () => inst.observe({ identity: 'a', resourceId: NaN, ts: 0 }),
    (err) => err.name === 'WatchlistSignalError',
  );
  assert.throws(() => inst.evaluateIdentity(''), (err) => err.name === 'WatchlistSignalError');
  assert.throws(() => createWatchlistSignal({ tau: 0 }), (err) => err.name === 'WatchlistSignalError');
  assert.throws(() => createWatchlistSignal({ minVisitDays: 1 }), (err) => err.name === 'WatchlistSignalError');
});

/* ----------------------------- calibration ------------------------------ */

test('fitThreshold sets tau to the reference q01 and pollers still flag under it', () => {
  const inst = createWatchlistSignal();
  const rng = mulberry32(20267400);
  const reference = [];
  for (let i = 0; i < 60; i++) {
    for (let r = 0; r < 6; r++) {
      for (const d of irregularDays(rng)) reference.push({ identity: `ref-${i}`, resourceId: 100 + r, day: d });
    }
  }
  const fit = inst.fitThreshold(reference);
  assert.equal(fit.fitted, true);
  assert.equal(fit.referenceIdentities, 60);
  assert.equal(fit.eligibleIdentities, 60);
  assert.ok(fit.tau > 0 && fit.tau <= WATCHLIST_LAB_TAU + 0.2, `fitted tau ${fit.tau} in a sane range`);
  assert.equal(inst.snapshot().tau, fit.tau);
  assert.equal(inst.snapshot().tauFitted, true);
  // The fitted threshold is a 1% quantile of legit statistics, so a
  // zero-CV poller remains far below it.
  for (let r = 0; r < 4; r++) feedDays(inst, 'poller-fit', 500 + r, rangeDays(1, 90));
  assert.equal(inst.evaluateIdentity('poller-fit').flagged, true);
});

test('fitThreshold also accepts trace-shaped samples', () => {
  const inst = createWatchlistSignal();
  const rng = mulberry32(99);
  const traces = [];
  for (let i = 0; i < 30; i++) {
    const events = [];
    for (let r = 0; r < 5; r++) {
      for (const d of irregularDays(rng)) events.push({ resourceId: 100 + r, ts: d * DAY + 3600e3 });
    }
    traces.push({ id: `trace-${i}`, events });
  }
  const fit = inst.fitThreshold(traces);
  assert.equal(fit.fitted, true);
  assert.equal(fit.eligibleIdentities, 30);
});

test('fitThreshold with no eligible reference identity throws', () => {
  const inst = createWatchlistSignal();
  assert.throws(
    () => inst.fitThreshold([{ identity: 'x', resourceId: 1, day: 0 }]),
    (err) => err.name === 'WatchlistSignalError',
  );
});

/* --------------------------- caps + determinism -------------------------- */

test('identity cap evicts the least recently seen identity', () => {
  const inst = createWatchlistSignal({ maxIdentities: 2 });
  for (const id of ['a', 'b', 'c']) {
    for (let r = 0; r < 3; r++) feedDays(inst, id, 300 + r, rangeDays(1, 10));
  }
  assert.equal(inst.snapshot().identitiesTracked, 2);
  assert.equal(inst.evaluateIdentity('a').status, 'unknown_identity');
  assert.equal(inst.evaluateIdentity('c').status, 'scored');
});

test('determinism: identical streams give identical evaluations and snapshots', () => {
  const build = () => {
    const inst = createWatchlistSignal();
    const rng = mulberry32(20267500);
    feedLegitIdentity(inst, rng, 'legit');
    for (let r = 0; r < 8; r++) feedDays(inst, 'poller', 500 + r, rangeDays(1, 90));
    return inst;
  };
  const a = build();
  const b = build();
  assert.deepEqual(a.evaluateIdentity('legit'), b.evaluateIdentity('legit'));
  assert.deepEqual(a.evaluateIdentity('poller'), b.evaluateIdentity('poller'));
  assert.deepEqual(a.snapshot(), b.snapshot());
});

test('advisory-only surface: enforcement is none everywhere and no blocking API exists', () => {
  assert.equal(typeof createWatchlistSignal, 'function');
  const inst = createWatchlistSignal();
  assert.equal(inst.snapshot().enforcement, 'none');
  for (const name of ['checkServe', 'reserve', 'reserveServe', 'decide', 'block', 'enforce']) {
    assert.equal(inst[name], undefined, `instance must not expose ${name}`);
  }
});
