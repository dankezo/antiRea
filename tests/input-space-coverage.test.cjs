'use strict';

/*
 * C6 input-space coverage (ISC) - SDK tests.
 *
 * The statistical cells port the DECISIVE cells of the pre-registered
 * lab (overnight-2026-11-02/c6-lab: C6-DESIGN.md, C6-RESULTS.md) at
 * reduced scale with fixed seeds: the honest FP band around the
 * nominal ~1% (asserted <= 2.0% and > 0 - this detector flags by
 * design, demanding 0 would be a lie), the SALE gate, the P10
 * feature-space cells (sweep / randprobe / slow-sweep flagged at the
 * first checkpoint, the dispersed feature herd flagged per member
 * and per cohort while the union-resource control stays blind), the
 * rotator evader, the bulk declared-cohort calibration (criterion 2),
 * and family R's honest slowness on the classic resource cells
 * (flagged, but hundreds of events later than the novelty-CUSUM
 * baseline - the delays are asserted, not hidden).
 *
 * Full-scale fidelity against the lab's own harness populations is
 * NOT re-proven here; that is what c6-lab/sdk-recheck.cjs does (it
 * reproduces the lab's verdict cells with this module: VALID FP
 * 1.15% vs lab 1.26%, SALE 1.08% vs 1.20%, bulk 0.50% and
 * bulk-vs-casual 100%, herd 72/72 + cohort 3/3 with the union
 * control blind, idwalk R delays 624/608/688 identical to the lab).
 * The generators below are simplified ports of the lab's shapes
 * (same directory embedding, same attack forms, same bulk burst
 * shape) so the cells run inside the unit suite.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createInputSpaceCoverage,
  InputSpaceCoverageError,
} = require('../dist/index.js');

/* ---------------- deterministic helpers ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NRES = 2000;
const M = 100000;
const dirId = (r) => 47 * r + 13;
const isPop = (id) => {
  const d = (id - 13) / 47;
  return Number.isInteger(d) && d >= 0 && d < NRES;
};

function zipfCdf(n, s) {
  const cdf = new Float64Array(n);
  let tot = 0;
  const w = [];
  for (let r = 0; r < n; r++) {
    const x = 1 / Math.pow(r + 1, s);
    w.push(x);
    tot += x;
  }
  let acc = 0;
  for (let r = 0; r < n; r++) {
    acc += w[r] / tot;
    cdf[r] = acc;
  }
  return cdf;
}
const CDF = zipfCdf(NRES, 1.05);
function zipfPick(R) {
  const u = R();
  let lo = 0;
  let hi = NRES - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (CDF[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function poisson(R, lam) {
  const L = Math.exp(-lam);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= R();
  } while (p > L);
  return k - 1;
}
function conformalThreshold(scores, level) {
  const s = [...scores].sort((a, b) => a - b);
  let rank = Math.ceil((s.length + 1) * (1 - level));
  rank = Math.max(1, Math.min(s.length, rank));
  return s[rank - 1];
}

/* Simplified legit model (lab shapes): clustered browsing over a
 * Zipf site; feature queries mostly target the identity's own
 * viewed resources (80%), 4% miss. */
function browse(R, interests) {
  const events = [];
  const viewed = new Set();
  for (let d = 0; d < 7; d++) {
    const sessions = R() < 0.6 ? 1 : 2;
    for (let s = 0; s < sessions; s++) {
      const len = 5 + Math.floor(R() * 36);
      for (let i = 0; i < len; i++) {
        let r;
        if (R() < 0.85) {
          const base = interests[Math.floor(R() * interests.length)];
          r = Math.min(NRES - 1, Math.max(0, base + Math.floor((R() - 0.5) * 60)));
        } else {
          r = zipfPick(R);
        }
        events.push(r);
        viewed.add(r);
      }
    }
  }
  return { events, viewed };
}

function legitStream(R) {
  const interests = [];
  const ni = 3 + Math.floor(R() * 28);
  for (let i = 0; i < ni; i++) interests.push(zipfPick(R));
  const { events, viewed } = browse(R, interests);
  const queries = [];
  if (R() < 0.6) {
    const n = poisson(R, 30);
    const viewedArr = [...viewed];
    for (let i = 0; i < n; i++) {
      if (R() < 0.04) {
        queries.push({ inputId: Math.floor(R() * M), hit: false });
      } else {
        const r = R() < 0.8 && viewedArr.length ? viewedArr[Math.floor(R() * viewedArr.length)] : zipfPick(R);
        queries.push({ inputId: dirId(r), hit: true });
      }
    }
  }
  return { queries, events };
}

/* Port of the lab's sale event (applySaleEvent): Poisson(1.8) EXTRA
 * sessions inside one evening window, navigating normally (mostly
 * global Zipf) - only their RATE is abnormal, not their shape. The
 * extra events are spliced in at ~day 5 of 7, as in the lab. */
function saleStream(R) {
  const s = legitStream(R);
  const extra = [];
  const nSessions = poisson(R, 1.8);
  for (let i = 0; i < nSessions; i++) {
    const len = 5 + Math.floor(R() * 36);
    const seq = [];
    for (let step = 0; step < len; step++) {
      let r;
      if (step === 0 || seq.length === 0) r = R() < 0.5 ? 0 : zipfPick(R);
      else if (seq.length >= 2 && R() < 0.1) r = seq[seq.length - 2];
      else r = zipfPick(R);
      seq.push(r);
      extra.push(r);
    }
  }
  const at = Math.floor((s.events.length * 5) / 7);
  s.events.splice(at, 0, ...extra);
  return s;
}

/* Port of the lab's genBulkQueries shape: bursts of 150-400 stored
 * ids, 45% populated, almost all distinct (hitRate ~0.45 - nothing
 * like casual traffic, which is exactly why criterion 2 exists). */
function bulkStream(R) {
  const queries = [];
  const nBursts = 1 + poisson(R, 1.2);
  for (let b = 0; b < nBursts; b++) {
    const size = 150 + Math.floor(R() * 251);
    for (let i = 0; i < size; i++) {
      if (R() < 0.45) {
        queries.push({ inputId: dirId(zipfPick(R)), hit: true });
      } else {
        let id;
        do {
          id = Math.floor(R() * M);
        } while (isPop(id));
        queries.push({ inputId: id, hit: false });
      }
    }
  }
  return { queries, events: [] };
}

const surface = () => ({
  features: [{ featureId: 'directory', spaceSize: M, isPopulated: isPop }],
  resources: { spaceSize: NRES, tailRank: 1000 },
  declaredCohorts: ['bulk'],
});

const toSample = (s) => ({
  queries: s.queries.map((q) => ({ featureId: 'directory', inputId: q.inputId, hit: q.hit })),
  events: s.events.map((r) => ({ resourceId: r })),
});

/* Novelty-CUSUM baseline (A0) + union control (A1), ported from the
 * lab's baseline.cjs to serve as controls inside the cells. */
function calibrateBaseline(trainToks) {
  let novelSum = 0;
  let stepSum = 0;
  for (const toks of trainToks) {
    const seen = new Set();
    for (const x of toks) {
      if (!seen.has(x)) {
        seen.add(x);
        novelSum++;
      }
      stepSum++;
    }
  }
  const mu0 = novelSum / stepSum;
  const maxima = trainToks.map((toks) => {
    const seen = new Set();
    let s = 0;
    let maxS = 0;
    for (const x of toks) {
      const novel = !seen.has(x);
      if (novel) seen.add(x);
      s = Math.max(0, s + (novel ? 1 : 0) - mu0 - mu0 / 2);
      if (s > maxS) maxS = s;
    }
    return maxS;
  });
  return { mu0, hBase: conformalThreshold(maxima, 0.01) };
}
function runBaseline(toks, mu0, hBase) {
  const seen = new Set();
  let s = 0;
  let flagStep = null;
  for (let i = 0; i < toks.length; i++) {
    const novel = !seen.has(toks[i]);
    if (novel) seen.add(toks[i]);
    s = Math.max(0, s + (novel ? 1 : 0) - mu0 - mu0 / 2);
    if (flagStep === null && s >= hBase) flagStep = i + 1;
  }
  return { flagStep };
}

/* ---------------- disabled + declaration ---------------- */

test('no surface declared: module disables itself and scores nothing', () => {
  const inst = createInputSpaceCoverage();
  assert.equal(inst.enabled, false);
  const obs = inst.observeQuery({ identity: 'u1', featureId: 'directory', inputId: dirId(3) });
  assert.equal(obs.status, 'disabled');
  assert.equal(obs.reason, 'surface_not_declared');
  assert.equal(obs.scored, false);
  const obsR = inst.observeResource({ identity: 'u1', resourceId: 5 });
  assert.equal(obsR.status, 'disabled');
  const sig = inst.evaluateIdentity('u1');
  assert.equal(sig.status, 'disabled');
  assert.equal(sig.flagged, false);
  assert.equal(sig.enforcement, 'none');
  assert.deepEqual(inst.fitCalibration([]), {
    fitted: false,
    status: 'disabled',
    scope: 'identity',
    feature: null,
    features: {},
    resource: null,
    skipped: 0,
  });
  const snap = inst.snapshot();
  assert.equal(snap.enabled, false);
  assert.equal(snap.disabledReason, 'surface_not_declared');
  assert.equal(snap.calibrated, false);
  assert.equal(snap.identitiesTracked, 0);
});

test('malformed surface declarations throw the named error', () => {
  assert.throws(
    () => createInputSpaceCoverage({ surface: { features: [] } }),
    (err) => err instanceof InputSpaceCoverageError && /at least one enumerable feature/.test(err.message),
  );
  assert.throws(
    () =>
      createInputSpaceCoverage({
        surface: {
          features: [
            { featureId: 'directory', spaceSize: M, isPopulated: isPop },
            { featureId: 'directory', spaceSize: M, isPopulated: isPop },
          ],
        },
      }),
    /duplicate featureId/,
  );
  assert.throws(
    () =>
      createInputSpaceCoverage({
        surface: {
          features: [{ featureId: 'directory', spaceSize: M, populatedIds: [dirId(1)], isPopulated: isPop }],
        },
      }),
    /not both/,
  );
  assert.throws(() => createInputSpaceCoverage({ alpha: 0 }), InputSpaceCoverageError);
});

test('undeclared features, undeclared resource space and unknown ranks are never scored', () => {
  const inst = createInputSpaceCoverage({
    surface: { features: [{ featureId: 'directory', spaceSize: M, isPopulated: isPop }] },
  });
  const ghost = inst.observeQuery({ identity: 'u1', featureId: 'ghost', inputId: 1 });
  assert.equal(ghost.status, 'undeclared_feature');
  assert.equal(ghost.scored, false);
  const noSpace = inst.observeResource({ identity: 'u1', resourceId: 5 });
  assert.equal(noSpace.status, 'space_not_declared');
  const snap = inst.snapshot();
  assert.equal(snap.counters.undeclaredFeature, 1);
  assert.equal(snap.counters.resourceSpaceNotDeclared, 1);
  assert.equal(inst.evaluateIdentity('u1').status, 'insufficient_data');

  const inst2 = createInputSpaceCoverage({ surface: surface() });
  const unknown = inst2.observeResource({ identity: 'u2', resourceId: 'sku-xyz' });
  assert.equal(unknown.status, 'rank_unknown');
  assert.equal(unknown.scored, false);
  assert.equal(inst2.snapshot().counters.rankUnknown, 1);
  assert.equal(inst2.evaluateIdentity('u2').status, 'insufficient_data');
});

test('uncalibrated instances never flag, however extreme the stream', () => {
  const inst = createInputSpaceCoverage({ surface: surface() });
  for (let i = 0; i < 600; i++) {
    inst.observeQuery({ identity: 'sweeper', featureId: 'directory', inputId: i, hit: isPop(i) });
  }
  const sig = inst.evaluateIdentity('sweeper');
  assert.equal(sig.feature.status, 'uncalibrated');
  assert.equal(sig.flagged, false);
});

/* ---------------- fit floors + declared-cohort guards ---------------- */

test('fit floors: undersized training pools are refused', () => {
  const inst = createInputSpaceCoverage({ surface: surface() });
  const R = mulberry32(4242);
  const few = [];
  for (let i = 0; i < 20; i++) few.push(toSample(legitStream(R)));
  assert.throws(() => inst.fitCalibration(few), /minTrainStreams/);
});

test('bulk calibration requires declared cohorts; declared members never fall back to casual pools', () => {
  // No declared cohorts in the declaration: the bulk fit is refused.
  const noDeclared = createInputSpaceCoverage({
    surface: {
      features: [{ featureId: 'directory', spaceSize: M, isPopulated: isPop }],
      resources: { spaceSize: NRES, tailRank: 1000 },
    },
    minTrainStreams: 20,
  });
  const Rb = mulberry32(777);
  const bulkTrain = [];
  for (let i = 0; i < 30; i++) bulkTrain.push(toSample(bulkStream(Rb)).queries);
  assert.throws(() => noDeclared.fitBulkCalibration(bulkTrain), /declared cohort/);

  // Declared cohorts exist but the bulk fit was never done: a member's
  // family is "uncalibrated" (calibration: declared_cohort) - it is
  // NOT silently scored against the casual pool (lab ablation: bulk
  // streams against casual pools flag ~100%).
  const inst = createInputSpaceCoverage({ surface: surface(), minTrainStreams: 20 });
  const R = mulberry32(20261102);
  const train = [];
  for (let i = 0; i < 60; i++) train.push(toSample(legitStream(R)));
  inst.fitCalibration(train);
  const bulk = bulkStream(mulberry32(31));
  for (const q of bulk.queries) {
    inst.observeQuery({ identity: 'importer', featureId: 'directory', inputId: q.inputId, hit: q.hit, cohortId: 'bulk' });
  }
  const sig = inst.evaluateIdentity('importer');
  assert.equal(sig.feature.status, 'uncalibrated');
  assert.equal(sig.feature.calibration, 'declared_cohort');
  assert.equal(sig.flagged, false);
  const cohortSig = inst.evaluateCohort('bulk');
  assert.equal(cohortSig.status, 'declared_cohort');
  assert.equal(cohortSig.flagged, false);
});

/* ---------------- the lab cells ---------------- */

test('lab cells: FP band, SALE gate, P10 attacks, herd, R slowness, bulk routing', () => {
  const inst = createInputSpaceCoverage({ surface: surface() });
  const R = mulberry32(20261102);

  const trainRaw = [];
  const train = [];
  for (let i = 0; i < 800; i++) {
    const s = legitStream(R);
    trainRaw.push(s);
    train.push(toSample(s));
  }
  const fit = inst.fitCalibration(train);
  assert.equal(fit.fitted, true);
  assert.ok(fit.features.directory.streams >= 50);
  assert.ok(fit.resource.streams >= 50);

  const Rb = mulberry32(777);
  const bulkTrain = [];
  for (let i = 0; i < 300; i++) bulkTrain.push(toSample(bulkStream(Rb)).queries);
  assert.equal(inst.fitBulkCalibration(bulkTrain).fitted, true);

  const Rc = mulberry32(555);
  const cohortSamples = [];
  for (let c = 0; c < 120; c++) {
    const mem = new Set();
    while (mem.size < 24) mem.add(Math.floor(Rc() * train.length));
    cohortSamples.push([...mem].map((i) => train[i]));
  }
  assert.equal(inst.fitCohortCalibration(cohortSamples).fitted, true);

  let uid = 0;
  const feed = (sample, cohortId) => {
    const id = 't' + uid++;
    for (const q of sample.queries) {
      inst.observeQuery({ identity: id, featureId: 'directory', inputId: q.inputId, hit: q.hit, ...(cohortId ? { cohortId } : {}) });
    }
    for (const r of sample.events) {
      inst.observeResource({ identity: id, resourceId: typeof r === 'number' ? r : r.resourceId, ...(cohortId ? { cohortId } : {}) });
    }
    return inst.evaluateIdentity(id);
  };
  const feedQ = (qs, cohortId) => feed({ queries: qs.map((q) => ({ featureId: 'directory', inputId: q.inputId, hit: q.hit })), events: [] }, cohortId);

  /* VALID: FP in the honest band around the nominal ~1% (lab pooled
   * 1.26% under the registered 2.0% bar). Zero is NOT demanded: this
   * detector flags by design, and the band's lower edge proves the
   * detector is alive on this population. */
  let fF = 0;
  let fR = 0;
  let fU = 0;
  const NV = 1200;
  for (let i = 0; i < NV; i++) {
    const sig = feed(toSample(legitStream(R)));
    if (sig.feature && sig.feature.flagged) fF++;
    if (sig.resource && sig.resource.flagged) fR++;
    if (sig.flagged) fU++;
  }
  assert.ok(fU >= 1, `detector must flag some legit streams (nominal ~1%), got 0/${NV}`);
  assert.ok(fU / NV <= 0.02, `VALID pooled FP ${(fU / NV).toFixed(4)} above the registered 2.0% bar`);
  assert.ok(fF / NV <= 0.02, `VALID F FP ${(fF / NV).toFixed(4)} above 2.0%`);
  assert.ok(fR / NV <= 0.02, `VALID R FP ${(fR / NV).toFixed(4)} above 2.0%`);

  /* SALE: a mild volume surge must not collapse the gate (lab 1.20%;
   * the C3 candidate died on exactly this cell at 100%). */
  let sU = 0;
  const NS = 400;
  for (let i = 0; i < NS; i++) {
    if (feed(toSample(saleStream(R))).flagged) sU++;
  }
  assert.ok(sU / NS <= 0.02, `SALE FP ${(sU / NS).toFixed(4)} above the registered 2.0% bar`);

  /* P10 feature-space attacks (lab forms): sequential id-space sweep,
   * systematic-random probing, throttled slow sweep - all flagged at
   * the FIRST checkpoint (query 20), where the resource baseline sees
   * nothing at all. */
  const sweepFlag = (start, total) => {
    const qs = [];
    for (let i = 0; i < total; i++) {
      const id = (start + i) % M;
      qs.push({ inputId: id, hit: isPop(id) });
    }
    return feedQ(qs).feature;
  };
  for (let rep = 0; rep < 3; rep++) {
    const f = sweepFlag(Math.floor(R() * M), 600);
    assert.equal(f.flagged, true, `sweep rep ${rep} must flag`);
    assert.equal(f.firstFlagAt, 20, `sweep rep ${rep} must flag at the first checkpoint`);
  }
  for (let rep = 0; rep < 2; rep++) {
    const f = sweepFlag(Math.floor(R() * M), 210);
    assert.equal(f.flagged, true, `slow-sweep rep ${rep} must flag (throttling buys time, not shape)`);
    assert.equal(f.firstFlagAt, 20);
  }
  const Ra = mulberry32(99);
  for (let rep = 0; rep < 3; rep++) {
    const qs = [];
    const seen = new Set();
    while (qs.length < 600) {
      const id = Math.floor(Ra() * M);
      if (seen.has(id)) continue;
      seen.add(id);
      qs.push({ inputId: id, hit: isPop(id) });
    }
    const f = feedQ(qs).feature;
    assert.equal(f.flagged, true, `randprobe rep ${rep} must flag`);
    assert.equal(f.firstFlagAt, 20);
  }

  /* Rotator evader: a fixed populated subset cycled in order is
   * flagged once its distinctRate falls under the legit floor (lab
   * delays 356-500 queries at full scale). */
  {
    const subset = new Set();
    while (subset.size < 120) subset.add(zipfPick(Ra));
    const sub = [...subset].map(dirId);
    const qs = [];
    for (let i = 0; i < 600; i++) {
      let id = sub[i % sub.length];
      if (Ra() < 0.04) {
        do {
          id = Math.floor(Ra() * M);
        } while (isPop(id));
      }
      qs.push({ inputId: id, hit: isPop(id) });
    }
    const f = feedQ(qs).feature;
    assert.equal(f.flagged, true, 'rotator must flag');
    assert.ok(f.firstFlagAt > 20 && f.firstFlagAt <= 600, `rotator delay ${f.firstFlagAt} outside (20, 600]`);
  }

  /* Dispersed feature herd: each member sweeps its own slice of the
   * id space (500 queries). Every member flags, the cohort flags,
   * and the union-resource control (A1) stays blind - the exact
   * division of labour the lab registered (72/72 + 3/3 vs 0/3). */
  {
    let membersFlagged = 0;
    const herdUnion = new Set();
    for (let k = 0; k < 24; k++) {
      const s = legitStream(Ra);
      for (const r of s.events) herdUnion.add(r);
      const slice = Math.floor(M / 24);
      const start = k * slice;
      const qs = [];
      for (let j = 0; j < 500; j++) {
        const id = start + j;
        qs.push({ inputId: id, hit: isPop(id) });
      }
      const sig = feedQ(qs, 'herd-x');
      if (sig.feature && sig.feature.flagged) membersFlagged++;
    }
    assert.equal(membersFlagged, 24, 'all herd members must flag individually');
    const cohortSig = inst.evaluateCohort('herd-x');
    assert.equal(cohortSig.feature.flagged, true, 'herd cohort must flag via the cohort-max rule');
    // A1 control: union of the members' browsed resources vs the
    // conformal union threshold fitted on TRAIN cohorts.
    const Ru = mulberry32(555);
    const unions = [];
    for (let c = 0; c < 120; c++) {
      const mem = new Set();
      while (mem.size < 24) mem.add(Math.floor(Ru() * train.length));
      const u = new Set();
      for (const i of mem) for (const e of train[i].events) u.add(e.resourceId);
      unions.push(u.size);
    }
    const hUnion = conformalThreshold(unions, 0.01);
    assert.ok(herdUnion.size <= hUnion, `union control must stay blind (union ${herdUnion.size} vs hUnion ${hUnion})`);
  }

  /* Classic resource cells: family R flags the sequential walk and
   * the tail slicing, but SLOWLY - hundreds of events where the
   * novelty-CUSUM baseline needs a dozen steps. Both delays are
   * asserted; R is not the tool for this shape and the test says so. */
  {
    const { mu0, hBase } = calibrateBaseline(train.map((s) => s.events.map((e) => e.resourceId)));
    const walk = [];
    for (let i = 0; i < 3000; i++) walk.push(i % NRES);
    const walkSig = feed({ queries: [], events: walk });
    assert.equal(walkSig.resource.flagged, true, 'idwalk must flag in family R');
    const a0Walk = runBaseline(walk, mu0, hBase);
    assert.ok(a0Walk.flagStep !== null && a0Walk.flagStep <= 100, `baseline should flag idwalk fast, got ${a0Walk.flagStep}`);
    assert.ok(
      walkSig.resource.firstFlagAt >= 200 && walkSig.resource.firstFlagAt > a0Walk.flagStep,
      `R idwalk delay ${walkSig.resource.firstFlagAt} must honestly exceed the baseline's ${a0Walk.flagStep}`,
    );
    const slicing = [];
    for (let i = 0; i < 1500; i++) slicing.push(1000 + (i % 1000));
    const sliceSig = feed({ queries: [], events: slicing });
    assert.equal(sliceSig.resource.flagged, true, 'slicing must flag in family R');
    const a0Slice = runBaseline(slicing, mu0, hBase);
    assert.ok(
      sliceSig.resource.firstFlagAt > a0Slice.flagStep,
      `R slicing delay ${sliceSig.resource.firstFlagAt} must exceed the baseline's ${a0Slice.flagStep}`,
    );
    // Browser-shaped browsing (clustered Zipf) is not flagged by R.
    const Rb2 = mulberry32(31);
    const interests = [zipfPick(Rb2), zipfPick(Rb2)];
    const evs = [];
    for (let i = 0; i < 3000; i++) {
      if (Rb2() < 0.85) {
        const b = interests[Math.floor(Rb2() * 2)];
        evs.push(Math.min(NRES - 1, Math.max(0, b + Math.floor((Rb2() - 0.5) * 60))));
      } else {
        evs.push(zipfPick(Rb2));
      }
    }
    assert.equal(feed({ queries: [], events: evs }).resource.flagged, false, 'browser-shaped browsing must not flag');
  }

  /* Bulk streams (criterion 2): scored through the declared routing
   * they sit inside the bulk calibration's band; scored against the
   * casual pool the same streams flag en masse (lab: 100%). */
  {
    let bFlag = 0;
    let bCasual = 0;
    const NB = 300;
    for (let i = 0; i < NB; i++) {
      const s = bulkStream(Rb);
      const sample = { queries: s.queries.map((q) => ({ featureId: 'directory', inputId: q.inputId, hit: q.hit })), events: [] };
      const sigBulk = feed(sample, 'bulk');
      if (sigBulk.feature && sigBulk.feature.flagged) bFlag++;
      const sigCasual = feed(sample);
      if (sigCasual.feature && sigCasual.feature.flagged) bCasual++;
    }
    assert.ok(bFlag / NB <= 0.02, `bulk FP under bulk calibration ${(bFlag / NB).toFixed(4)} above 2.0%`);
    assert.ok(bCasual / NB >= 0.5, `bulk streams against casual pools must flag en masse, got ${(bCasual / NB).toFixed(4)}`);
  }
});

/* ---------------- API surface ---------------- */

test('API surface is advisory only: no decision or blocking function exists', () => {
  const inst = createInputSpaceCoverage({ surface: surface() });
  assert.deepEqual(Object.keys(inst).sort(), [
    'enabled',
    'evaluateCohort',
    'evaluateIdentity',
    'fitBulkCalibration',
    'fitCalibration',
    'fitCohortCalibration',
    'observeQuery',
    'observeResource',
    'snapshot',
  ]);
  const sig = inst.evaluateIdentity('nobody');
  assert.equal(sig.enforcement, 'none');
  assert.equal(sig.kind, 'input_space_coverage');
  const snap = inst.snapshot();
  assert.equal(snap.enforcement, 'none');
  assert.deepEqual(snap.declaredCohorts, ['bulk']);
  assert.equal(snap.features.length, 1);
  assert.equal(snap.resourceSpaceSize, NRES);
});
