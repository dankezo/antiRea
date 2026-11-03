const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ---------------------------------------------------------------------------
// Asset/referrer profile signal (HARVEST2 candidate C9). These tests port
// the decisive cells of the study lab (C9-DESIGN.md / C9-RESULTS.md) to
// the SDK module:
//   - legitimate browser streams: 0 flags through the conjunctive rule
//     (lab: 0/6,658 VALID, 0/923 SALE, 0/150 cohorts - simulation numbers,
//     reproduced here as a mechanics cell on synthetic streams, not as a
//     real-world false-positive claim);
//   - naive bots (raw / polite / low-novelty revisit shapes) flagged;
//   - declared-API identities flagged 1,500/1,500 when scored as
//     browsers and 0 once stratified - the stratification law is
//     load-bearing, and here it is a hard condition in code: without a
//     declared stratification the module is disabled entirely;
//   - the full-profile evader (evFull) SLIPS this signal - expected,
//     documented behavior (C9-RESULTS section 4, docs/LIMITATIONS.md):
//     the feature is a bandwidth tax (~22.8x request volume, lab
//     measurement), not a standalone detector.
// All streams are produced by the seeded generators below; no network,
// no wall-clock dependence.
//
// POST-LAB TIGHTENING (operator-requested, after the lab verdict):
// the SDK rule now differs from the lab's single-window rule in two
// documented ways, and the affected tests below were adjusted ONLY
// at those points (each adjustment carries an inline note):
//   A. gateSafetyMargin (default 0.25) pads the fitted gates away
//      from the legitimate region;
//   B. two-window persistence: a first violating window is only a
//      "watch"; "flag" requires two CONSECUTIVE violating windows.
// The measured price of B is asserted, not hidden: a persistent
// naive profile now flags at page 100 instead of page 50 (identity)
// and at pooled page 240 instead of 120 (cohort).
// ---------------------------------------------------------------------------

/* ---------------- deterministic generators ---------------- */

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
  // Box-Muller.
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function poisson(rng, lambda) {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > l);
  return k - 1;
}

// Legitimate page view, harness-v2 parameters: images lognormal
// (median 19.1, sigma 0.565 -> mean ~22.4), assets = images + 2 +
// Poisson(4), empty referrer ~5% of accumulated pages.
function legitPage(rng) {
  const images = Math.max(0, Math.round(Math.exp(Math.log(19.1) + 0.565 * gauss(rng))));
  return { images, assets: images + 2 + poisson(rng, 4), referrerEmpty: rng() < 0.05 };
}

// Naive bot page view, the published profile the lab registered:
// images Bernoulli(0.3) (mean 0.3/page), assets = images, empty
// referrer 98.4%.
function naivePage(rng) {
  const images = rng() < 0.3 ? 1 : 0;
  return { images, assets: images, referrerEmpty: rng() < 0.984 };
}

// Declared-API client page: loads no page assets, sends no referrer.
// This profile sits exactly in the bot corner by definition.
function apiPage() {
  return { images: 0, assets: 0, referrerEmpty: true };
}

function streamOf(rng, pages, gen) {
  const out = [];
  for (let i = 0; i < pages; i++) out.push(gen(rng));
  return out;
}

const STRATIFICATION = { browserStratum: 'browser', neutralStrata: ['api'] };

function enabledInstance(extra = {}) {
  return sdk.createAssetReferrerProfile({ stratification: STRATIFICATION, ...extra });
}

// Fit an instance on TRAIN legit streams from a fixed seed.
function fittedInstance(seed = 20261102, trainStreams = 400) {
  const inst = enabledInstance();
  const rng = mulberry32(seed);
  const train = [];
  for (let i = 0; i < trainStreams; i++) train.push(streamOf(rng, 60, legitPage));
  const fit = inst.fitCalibration(train);
  assert.equal(fit.fitted, true);
  return inst;
}

function feed(inst, identity, pages, { clientType = 'browser', cohortId, tsStart = 0 } = {}) {
  let last;
  pages.forEach((page, i) => {
    last = inst.observe({ identity, clientType, cohortId, ts: tsStart + i, ...page });
  });
  return last;
}

/* ---------------- hard condition 1: stratification ---------------- */

test('no stratification declaration: the module is disabled and scores nothing', () => {
  const inst = sdk.createAssetReferrerProfile();
  assert.equal(inst.enabled, false);

  const obs = inst.observe({ identity: 'bot-1', clientType: 'browser', ...naivePage(mulberry32(1)) });
  assert.equal(obs.status, 'disabled');
  assert.equal(obs.reason, 'stratification_not_declared');
  assert.equal(obs.scored, false);
  assert.equal(obs.counted, false);

  const fit = inst.fitCalibration([streamOf(mulberry32(2), 60, legitPage)]);
  assert.equal(fit.fitted, false);
  assert.equal(fit.status, 'disabled');

  const signal = inst.evaluateIdentity('bot-1');
  assert.equal(signal.status, 'disabled');
  assert.equal(signal.flagged, false);
  assert.equal(signal.enforcement, 'none');

  const snap = inst.snapshot();
  assert.equal(snap.enabled, false);
  assert.equal(snap.disabledReason, 'stratification_not_declared');
  assert.equal(snap.identitiesTracked, 0);
  assert.equal(snap.counters.recorded, 0);
});

test('malformed stratification declarations and options throw named errors', () => {
  const bad = [
    { stratification: { browserStratum: '', neutralStrata: ['api'] } },
    { stratification: { browserStratum: 'browser', neutralStrata: [] } },
    { stratification: { browserStratum: 'browser', neutralStrata: ['browser'] } },
    { stratification: { browserStratum: 'browser', neutralStrata: ['api', 'api'] } },
    { stratification: 'browser' },
    { stratification: STRATIFICATION, horizonPages: 0 },
    { stratification: STRATIFICATION, alpha: 0 },
    { stratification: STRATIFICATION, alpha: 0.9 },
  ];
  for (const opts of bad) {
    assert.throws(
      () => sdk.createAssetReferrerProfile(opts),
      (err) => err.name === 'AssetReferrerProfileError',
      `expected AssetReferrerProfileError for ${JSON.stringify(opts)}`,
    );
  }
});

test('declared API stratum is never scored; the same profile scored as browser is flagged', () => {
  const inst = fittedInstance();

  // The load-bearing law (lab section 5): a declared API client's
  // profile is the bot corner by definition, so it must never even
  // be accumulated.
  const rng = mulberry32(777);
  for (let i = 0; i < 60; i++) {
    const obs = inst.observe({ identity: 'api-client-1', clientType: 'api', ...apiPage() });
    assert.equal(obs.status, 'neutral_stratum');
    assert.equal(obs.scored, false);
  }
  assert.equal(inst.snapshot().identitiesTracked, 0);
  const apiSignal = inst.evaluateIdentity('api-client-1');
  assert.equal(apiSignal.status, 'insufficient_data');
  assert.equal(apiSignal.flagged, false);

  // Control: the identical page profile declared as browser IS
  // flagged - the stratum declaration, not the profile math, is
  // what protects the API client.
  // ADJUSTED for tightening B (persistence): one violating window
  // (50 pages) is now only a "watch"; the flag lands when the
  // second consecutive window closes (page 100).
  const control = fittedInstance();
  feed(control, 'api-shaped-browser', streamOf(rng, 60, () => apiPage()));
  const watchSignal = control.evaluateIdentity('api-shaped-browser');
  assert.equal(watchSignal.status, 'scored');
  assert.equal(watchSignal.level, 'watch');
  assert.equal(watchSignal.flagged, false);
  feed(control, 'api-shaped-browser', streamOf(rng, 50, () => apiPage()));
  const controlSignal = control.evaluateIdentity('api-shaped-browser');
  assert.equal(controlSignal.status, 'scored');
  assert.equal(controlSignal.level, 'flag');
  assert.equal(controlSignal.flagged, true);
});

test('unstratified and undeclared-stratum pages are never scored', () => {
  const inst = fittedInstance();
  const rng = mulberry32(4242);
  const pages = streamOf(rng, 60, naivePage);

  for (const page of pages) {
    const obs = inst.observe({ identity: 'mystery-1', ...page });
    assert.equal(obs.status, 'unstratified');
    assert.equal(obs.scored, false);
  }
  for (const page of pages) {
    const obs = inst.observe({ identity: 'mystery-1', clientType: 'mobile-app', ...page });
    assert.equal(obs.status, 'undeclared_stratum');
    assert.equal(obs.scored, false);
  }
  const snap = inst.snapshot();
  assert.equal(snap.counters.unstratified, 60);
  assert.equal(snap.counters.undeclaredStratum, 60);
  assert.equal(snap.identitiesTracked, 0);
  assert.equal(inst.evaluateIdentity('mystery-1').flagged, false);
});

/* ---------------- the lab's decisive cells ---------------- */

test('legitimate browser streams are never flagged (lab FP cell, mechanics)', () => {
  const inst = fittedInstance();
  const rng = mulberry32(20261103);
  let flagged = 0;
  let watched = 0;
  for (let i = 0; i < 300; i++) {
    const identity = `legit-${i}`;
    feed(inst, identity, streamOf(rng, 60, legitPage));
    const signal = inst.evaluateIdentity(identity);
    assert.equal(signal.status, 'scored');
    if (signal.flagged) flagged++;
    // Tightening B adds a "watch" state below the flag; a watch on a
    // legitimate stream is not a flag, but it is reported here, not
    // hidden: the count must be exactly 0 for these generators.
    if (signal.level === 'watch') watched++;
  }
  assert.equal(flagged, 0);
  assert.equal(watched, 0);
});

test('legitimate streams stay at level none across two full windows', () => {
  const inst = fittedInstance();
  const rng = mulberry32(20261105);
  for (let i = 0; i < 150; i++) {
    const identity = `legit2-${i}`;
    feed(inst, identity, streamOf(rng, 110, legitPage));
    const signal = inst.evaluateIdentity(identity);
    assert.equal(signal.status, 'scored');
    assert.equal(signal.level, 'none');
    assert.equal(signal.consecutiveViolations, 0);
    assert.equal(signal.flagged, false);
  }
});

test('naive bots are flagged: raw, polite and low-novelty revisit shapes', () => {
  const inst = fittedInstance();
  // In the harness these shapes differ in timing and novelty
  // structure; the asset/referrer profile - all this signal reads -
  // is the naive profile in all three. naiveRevisit is the cell the
  // lab's novelty CUSUM missed (6/9) and this profile caught (9/9).
  //
  // ADJUSTED for tightening A+B: the padded gates still pass for
  // the naive profile (asserted below via gateOk), and persistence
  // moves the flag from the first window close to the second. The
  // price is measured per rep: watch at page 50, flag at page 100 -
  // exactly +50 pages (one extra horizon) over the lab's
  // single-window rule. Feeding is therefore 110 pages, not 60.
  const shapes = ['raw', 'polite', 'naiveRevisit'];
  shapes.forEach((shape, s) => {
    for (let rep = 0; rep < 3; rep++) {
      const rng = mulberry32(91000 + s * 100 + rep);
      const identity = `${shape}-${rep}`;
      let firstWatchPage = null;
      let firstFlagPage = null;
      let firstWindowSignal = null;
      streamOf(rng, 110, naivePage).forEach((page, i) => {
        const obs = inst.observe({ identity, clientType: 'browser', ts: i, ...page });
        if (obs.signal) {
          if (firstWindowSignal === null) firstWindowSignal = obs.signal;
          if (obs.signal.level === 'watch' && firstWatchPage === null) firstWatchPage = i + 1;
          if (obs.signal.flagged && firstFlagPage === null) firstFlagPage = i + 1;
        }
      });
      const signal = inst.evaluateIdentity(identity);
      assert.equal(signal.status, 'scored');
      assert.equal(signal.scorePass, true, `${shape}-${rep} should pass the score`);
      assert.equal(signal.gateOk, true, `${shape}-${rep} should pass the padded gates`);
      assert.equal(signal.level, 'flag', `${shape}-${rep} should reach flag level`);
      assert.equal(signal.flagged, true, `${shape}-${rep} should be flagged`);
      assert.equal(signal.consecutiveViolations, 2);
      // The persistence price, in pages, identical for every rep:
      assert.equal(firstWatchPage, 50, `${shape}-${rep} watch should land at the first window close`);
      assert.equal(firstFlagPage, 100, `${shape}-${rep} flag should land at the second window close`);
      assert.equal(firstFlagPage - firstWatchPage, 50, 'tightening B costs exactly one extra horizon');
      if (rep === 0) {
        // The first window-closing observation carries a watch, not
        // a flag - the visible signature of the persistence layer.
        assert.ok(firstWindowSignal, 'window-closing observe should carry the signal');
        assert.equal(firstWindowSignal.level, 'watch');
        assert.equal(firstWindowSignal.flagged, false);
      }
    }
  });
});

test('full-profile evader slips this signal (known behavior, documented - not a detector)', () => {
  // C9-RESULTS section 4: an evader that loads the full legitimate
  // asset profile and chains referrers is invisible to this signal
  // (lab 0/9) and instead pays the ~22.8x bandwidth tax. This test
  // pins that slip as EXPECTED behavior so it can never be silently
  // "fixed" into a claim the lab did not support.
  const inst = fittedInstance();
  const rng = mulberry32(20261104);
  const gates = inst.snapshot().identityCalibration.gates;
  for (let rep = 0; rep < 3; rep++) {
    const identity = `evfull-${rep}`;
    feed(inst, identity, streamOf(rng, 60, legitPage));
    const signal = inst.evaluateIdentity(identity);
    assert.equal(signal.status, 'scored');
    assert.equal(signal.flagged, false);
    assert.ok(
      signal.stats.imgMean > gates.imgMeanMax,
      'the evader escapes through the gates, exactly as the lab measured',
    );
  }
});

test('cohort form flags a 1-hit herd whose members are individually invisible', () => {
  const inst = enabledInstance();
  // Cohort calibration: 60 legitimate cohorts of 24 members.
  const trainRng = mulberry32(31337);
  const trainCohorts = [];
  for (let c = 0; c < 60; c++) {
    const members = [];
    for (let m = 0; m < 24; m++) {
      const pages = streamOf(trainRng, 8, legitPage).map((p, i) => ({ ...p, ts: m * 100 + i }));
      members.push(pages);
    }
    trainCohorts.push(members);
  }
  const fit = inst.fitCohortCalibration(trainCohorts);
  assert.equal(fit.fitted, true);
  assert.equal(fit.scope, 'cohort');

  // Identity calibration too, so the member-level check below reads
  // as insufficient_data (5 pages < the 50-page horizon) rather than
  // uncalibrated.
  const idRng = mulberry32(31415);
  const idTrain = [];
  for (let i = 0; i < 60; i++) idTrain.push(streamOf(idRng, 60, legitPage));
  assert.equal(inst.fitCalibration(idTrain).fitted, true);

  // 1-hit herd: 24 identities x 5 naive pages - no member reaches
  // the 50-page identity horizon, but the pooled profile is extreme.
  const herdRng = mulberry32(555);
  let ts = 0;
  for (let m = 0; m < 24; m++) {
    const pages = streamOf(herdRng, 5, naivePage).map((p) => ({ ...p, ts: ts++ }));
    feed(inst, `herd-member-${m}`, pages, { cohortId: 'herd-1' });
  }
  assert.equal(inst.evaluateIdentity('herd-member-0').status, 'insufficient_data');
  // ADJUSTED for tightening B: the first pooled window (120 pages)
  // now raises only a cohort "watch"...
  const herdWatch = inst.evaluateCohort('herd-1');
  assert.equal(herdWatch.status, 'scored');
  assert.equal(herdWatch.level, 'watch');
  assert.equal(herdWatch.flagged, false);
  // ...and the flag lands when the second consecutive pooled window
  // closes - the cohort persistence price is +120 pooled pages over
  // the lab's single-window rule (240 instead of 120).
  for (let m = 0; m < 24; m++) {
    const pages = streamOf(herdRng, 5, naivePage).map((p) => ({ ...p, ts: ts++ }));
    feed(inst, `herd-member-${m}`, pages, { cohortId: 'herd-1' });
  }
  const herdSignal = inst.evaluateCohort('herd-1');
  assert.equal(herdSignal.status, 'scored');
  assert.equal(herdSignal.level, 'flag');
  assert.equal(herdSignal.flagged, true);

  // A legitimate cohort of the same shape stays clean across both
  // windows.
  const teamRng = mulberry32(556);
  ts = 0;
  for (let round = 0; round < 2; round++) {
    for (let m = 0; m < 24; m++) {
      const pages = streamOf(teamRng, 5, legitPage).map((p) => ({ ...p, ts: ts++ }));
      feed(inst, `team-member-${m}`, pages, { cohortId: 'team-1' });
    }
  }
  const teamSignal = inst.evaluateCohort('team-1');
  assert.equal(teamSignal.status, 'scored');
  assert.equal(teamSignal.level, 'none');
  assert.equal(teamSignal.flagged, false);
});

/* ---------------- calibration discipline ---------------- */

test('uncalibrated instances never flag, even on a textbook bot profile', () => {
  const inst = enabledInstance();
  const rng = mulberry32(8080);
  const last = feed(inst, 'raw-1', streamOf(rng, 60, naivePage));
  assert.equal(last.signal, undefined, 'no signal is emitted before calibration');
  const signal = inst.evaluateIdentity('raw-1');
  assert.equal(signal.status, 'uncalibrated');
  assert.equal(signal.flagged, false);
  assert.equal(signal.score, null);
});

// REWRITTEN for tightening B (was: 'fixed horizon: pages after the
// horizon cannot move the verdict'). The single fixed horizon is
// now a sequence of consecutive windows, so later pages DO move the
// level - that is the point of the persistence layer. The old
// mixed-b expectation (naive window, then legit flood -> flagged)
// is exactly the behavior the new law abolishes: a one-off
// violation that returns to normal must never become a flag.
test('windowed persistence: one violating window is a watch, two in a row are a flag, a clean window resets', () => {
  const inst = fittedInstance();
  const rng = mulberry32(60606);

  // Legit window, then a naive window: one violation -> watch only.
  const a = [...streamOf(rng, 50, legitPage), ...streamOf(rng, 50, naivePage)];
  const lastA = feed(inst, 'mixed-a', a);
  assert.equal(lastA.counted, true, 'pages past the first window now feed the next window');
  const sigA = inst.evaluateIdentity('mixed-a');
  assert.equal(sigA.flagged, false);
  assert.equal(sigA.level, 'watch');
  assert.equal(sigA.consecutiveViolations, 1);
  assert.equal(sigA.stats.pages, 50);

  // Naive window, then a legit window: the violation resolves and
  // never becomes a flag.
  const b = [...streamOf(rng, 50, naivePage), ...streamOf(rng, 50, legitPage)];
  feed(inst, 'mixed-b', b);
  const sigB = inst.evaluateIdentity('mixed-b');
  assert.equal(sigB.flagged, false);
  assert.equal(sigB.level, 'none');
  assert.equal(sigB.consecutiveViolations, 0);
  assert.equal(sigB.stats.pages, 50);

  // Naive window, then another naive window: flag.
  const c = [...streamOf(rng, 50, naivePage), ...streamOf(rng, 50, naivePage)];
  feed(inst, 'mixed-c', c);
  const sigC = inst.evaluateIdentity('mixed-c');
  assert.equal(sigC.flagged, true);
  assert.equal(sigC.level, 'flag');
  assert.equal(sigC.consecutiveViolations, 2);

  // Violation, clean window, violation: the chain is broken, so
  // the trailing run is 1 - a watch, not a flag.
  const d = [...streamOf(rng, 50, naivePage), ...streamOf(rng, 50, legitPage), ...streamOf(rng, 50, naivePage)];
  feed(inst, 'mixed-d', d);
  const sigD = inst.evaluateIdentity('mixed-d');
  assert.equal(sigD.flagged, false);
  assert.equal(sigD.level, 'watch');
  assert.equal(sigD.consecutiveViolations, 1);
});

test('calibration is reproducible and counts below-horizon streams as skipped', () => {
  const rng = mulberry32(121212);
  const train = [];
  for (let i = 0; i < 120; i++) train.push(streamOf(rng, 60, legitPage));
  for (let i = 0; i < 5; i++) train.push(streamOf(rng, 20, legitPage)); // below horizon

  const a = enabledInstance();
  const b = enabledInstance();
  const fitA = a.fitCalibration(train);
  const fitB = b.fitCalibration(train);
  assert.equal(fitA.streams, 120);
  assert.equal(fitA.skipped, 5);
  assert.equal(fitA.threshold, fitB.threshold);
  assert.deepEqual(fitA.gates, fitB.gates);
  assert.deepEqual(a.snapshot().identityCalibration, b.snapshot().identityCalibration);
});

test('fitting below the minimum stream floor throws a named error', () => {
  const inst = enabledInstance();
  const rng = mulberry32(3434);
  const few = [];
  for (let i = 0; i < 10; i++) few.push(streamOf(rng, 60, legitPage));
  assert.throws(
    () => inst.fitCalibration(few),
    (err) => err.name === 'AssetReferrerProfileError',
  );
  assert.throws(
    () => inst.fitCohortCalibration([few]),
    (err) => err.name === 'AssetReferrerProfileError',
  );
  assert.equal(inst.snapshot().calibrated, false);
});

/* ---------------- tightening A: gate safety margin ---------------- */

test('gate safety margin: margin 0 recovers the lab formulas, the default pads both gates', () => {
  const seed = 20261102;
  const rng = mulberry32(seed);
  const train = [];
  for (let i = 0; i < 400; i++) train.push(streamOf(rng, 60, legitPage));

  // The lab's registered formulas (C9-DESIGN 2.4) over the same
  // TRAIN prefixes, computed independently here.
  let minImg = Infinity;
  let maxRef = -Infinity;
  for (const stream of train) {
    const prefix = stream.slice(0, 50);
    const imgMean = prefix.reduce((s, p) => s + p.images, 0) / 50;
    const refShare = prefix.filter((p) => p.referrerEmpty).length / 50;
    if (imgMean < minImg) minImg = imgMean;
    if (refShare > maxRef) maxRef = refShare;
  }
  const rawImg = Math.sqrt(0.3 * minImg);
  const rawRef = (maxRef + 0.984) / 2;

  const labInst = enabledInstance({ gateSafetyMargin: 0 });
  const labFit = labInst.fitCalibration(train);
  assert.ok(Math.abs(labFit.gates.imgMeanMax - rawImg) < 1e-12, 'margin 0 keeps the lab imgMean gate');
  assert.ok(Math.abs(labFit.gates.refShareMin - rawRef) < 1e-12, 'margin 0 keeps the lab refShare gate');
  assert.equal(labFit.gateSafetyMargin, 0);

  const paddedInst = enabledInstance();
  const paddedFit = paddedInst.fitCalibration(train);
  assert.equal(paddedFit.gateSafetyMargin, 0.25);
  assert.equal(paddedInst.snapshot().gateSafetyMargin, 0.25);
  // imgMean gate scaled down by (1 - margin); refShare gate moved
  // the same fraction of its remaining headroom toward 1.
  assert.ok(Math.abs(paddedFit.gates.imgMeanMax - rawImg * 0.75) < 1e-12);
  assert.ok(Math.abs(paddedFit.gates.refShareMin - (rawRef + 0.25 * (1 - rawRef))) < 1e-12);
  assert.ok(paddedFit.gates.imgMeanMax < labFit.gates.imgMeanMax, 'imgMean gate moves away from legit');
  assert.ok(paddedFit.gates.refShareMin > labFit.gates.refShareMin, 'refShare gate moves away from legit');
});

test('invalid gate safety margins throw named errors', () => {
  for (const gateSafetyMargin of [-0.1, 0.91, 1, NaN, Infinity, 'wide']) {
    assert.throws(
      () => sdk.createAssetReferrerProfile({ stratification: STRATIFICATION, gateSafetyMargin }),
      (err) => err.name === 'AssetReferrerProfileError',
      `expected AssetReferrerProfileError for gateSafetyMargin=${String(gateSafetyMargin)}`,
    );
  }
});

/* ---------------- advisory-only surface ---------------- */

test('advisory-only surface: enforcement is none everywhere and no blocking API exists', () => {
  assert.equal(typeof sdk.createAssetReferrerProfile, 'function');
  const inst = fittedInstance();
  const rng = mulberry32(999);
  feed(inst, 'raw-x', streamOf(rng, 60, naivePage));
  const signal = inst.evaluateIdentity('raw-x');
  assert.equal(signal.enforcement, 'none');
  assert.equal(inst.snapshot().enforcement, 'none');
  // The instance offers observation, fitting, evaluation and
  // snapshots only - there is no decision/reservation surface.
  for (const name of ['checkServe', 'reserve', 'reserveServe', 'decide', 'block', 'enforce']) {
    assert.equal(inst[name], undefined, `instance must not expose ${name}`);
  }
});
