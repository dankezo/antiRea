'use strict';

/*
 * fit-cusum-calibration.cjs - offline CUSUM calibration fitter (lab only).
 *
 * Run from the repo root:  node scripts/fit-cusum-calibration.cjs
 * Uses the built SDK in ../dist. Deterministic: every trace is generated
 * from mulberry32 PRNGs seeded per (family, trace) from SEED below, and
 * the manifest validity window is a fixed constant, so re-running the
 * script reproduces byte-identical tables and summary numbers.
 *
 * DATA HONESTY: all traces are scripted lab simulations of the personas
 * described in CUSUM-SPEC.md section 5 (polite readers, a NAT group, an
 * onboarding cohort, a 3-seat review team, support deep-link sessions,
 * and four attacker shapes: served-set slicing, cold ID walk, an
 * REA-like fast cursor chain with light preamble identities, and a
 * time-dispersed walk). No real population data is used. The fitted
 * tables therefore ship with uncalibrated: true, exactly like the
 * bundled r6-calib-1 tables, and this script NEVER changes the SDK
 * default tables - it only writes an opt-in tables JSON, a sample
 * manifest, and a fit summary.
 *
 * METHOD (mirrors CUSUM-SPEC.md section 5, steps 1-3):
 * 1. Replay every trace through createCusumTripwire in mode 'observe'
 *    with the bundled r6 tables (alpha 1e-3). Collect, per family and
 *    per stream, the histogram of raw bin labels from
 *    CusumDecision.bins (only events whose bin is not null count), and
 *    each trace's crossing outcome with the cohort union size at the
 *    first crossing.
 * 2. LOAFO fitting: a fold removes one family; the train set is every
 *    other family. For each stream, f0(bin) is the pooled legit-train
 *    bin frequency. For each attacker family j in train, fj(bin) is
 *    that family's bin frequency. The fitted increment is
 *      LLR(bin) = log( mean_j fj_smooth(bin) / f0_smooth(bin) )
 *    with Laplace smoothing: 0.5 is added to every bin of the stream
 *    alphabet before normalizing (per family for fj, pooled for f0),
 *    so a bin unseen on either side still yields a finite LLR. Every
 *    LLR is clamped to [-3, 3] so a rare bin cannot dominate the
 *    accumulator on its own.
 *    Deviation, recorded deliberately: an attacker family with zero
 *    evaluated events for a stream has no empirical fj for that
 *    stream (its frequency is undefined, not uniform), so it is
 *    excluded from that stream's mixture mean. If no train attacker
 *    family has data for a stream, that stream's fitted LLRs are all
 *    0 (no evidence either way). In this lab set no attacker family
 *    emits range predicates, so the fitted adjacency table is all
 *    zeros - the honest fit for the traces provided.
 * 3. N_eff fit: from the legit families that form cohorts
 *    (review-team, nat-group, onboarding), collect (sum, eta) pairs
 *    during the r6 replay: sum is the summed per-member served count
 *    and eta is the SDK snapshot's exact unionRecords divided by sum,
 *    sampled once per (trace, 100-record sum bucket) so event-dense
 *    traces do not swamp the fit. N_eff is the grid value in
 *    50..2000 (step 1) minimizing the sum of squared errors between
 *    eta and the SDK's etaExp formula,
 *      etaExp(sum, N) = N * (1 - exp(-sum / N)) / sum,
 *    read from src/tier2-active/cusum-tripwire.ts (tiling stream).
 *    Each fold refits N_eff on its own train pairs the same way.
 * 4. The shipped table r7-labfit-1 is the full fit (no family held
 *    out) with the full-fit N_eff.
 * 5. Holdout evaluation: every trace is replayed twice in 'observe'
 *    mode at alpha 1e-3 - once with its own family's LOAFO fold-fit
 *    table, once with r6. FP = legit traces that cross; FN = attack
 *    traces that do not cross; detection point = cohort unionRecords
 *    at the first crossing (median per family and overall).
 * 6. The sample manifest reports the fold-fit holdout rates with
 *    sampleSizes { legit: 36, attack: 24 } (trace counts) and is
 *    evaluated with evaluateCalibrationManifest at a fixed instant
 *    inside its validity window for determinism.
 * 7. Default-table proposal rule: propose switching the SDK default
 *    only if the r7 fold-fit beats r6 on BOTH holdout FP and FN.
 *    Otherwise the summary proposes keeping r6-calib-1 as default.
 */

const fs = require('node:fs');
const path = require('node:path');

const sdk = require(path.join(__dirname, '..', 'dist', 'index.js'));

const SEED = 0xC0FFEE;
const ALPHA = 1e-3;
const DOMAIN_MAX = 10000;
const BASE_TS = Date.UTC(2026, 9, 26, 0, 0, 0); // 2026-10-26T00:00:00Z
const TRACES_PER_FAMILY = 6;

const STREAMS = ['adjacency', 'tiling', 'cold', 'velocity'];
const ALPHABETS = {
  adjacency: ['null', 'c2', 'c3', 'c4', 'c5plus'],
  tiling: ['z_lt_0_3', 'z_0_3_0_5', 'z_0_5_0_65', 'z_0_65_0_78', 'z_ge_0_78'],
  cold: ['warm', 'low', 'mid', 'high', 'high_regular'],
  velocity: ['human', 'v80_200', 'v30_80', 'v_lt_30'],
};

const LEGIT_FAMILIES = [
  'ordinary-reader',
  'heavy-reader',
  'review-team',
  'nat-group',
  'onboarding',
  'support-deeplink',
];
const ATTACK_FAMILIES = ['slicing', 'id-walk', 'rea-like', 'dispersed'];
const NEFF_FAMILIES = ['review-team', 'nat-group', 'onboarding'];

/* ---------------- deterministic PRNG (mulberry32) ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(familyIndex, traceIdx) {
  return mulberry32((SEED ^ Math.imul(familyIndex + 1, 0x9E3779B1) ^ Math.imul(traceIdx + 1, 0x85EBCA6B)) >>> 0);
}

const ri = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const ids = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const PRED = (min, max) => ({ field: 'id', min, max, domainMin: 0, domainMax: DOMAIN_MAX });
const idFor = (fam, t, k) => `account:${fam}-${t}-${k + 1}`;
const traceBase = (t) => BASE_TS + t * 420000; // 7 min between trace starts

/* ---------------- trace generators ----------------
 * Each generator returns CusumEvent[] in chronological order.
 * Identity form: account:<family>-<traceIdx>-<k> with k 1-based.
 * Detail events carry recordIds: [detailId] when the served union is
 * meant to grow (per the SDK: served sets grow only via recordIds).
 */

function genOrdinaryReader(rng, t) {
  const fam = 'ordinary-reader';
  const identity = idFor(fam, t, 0);
  const events = [];
  let clock = traceBase(t) + ri(rng, 0, 300000);
  let pos = 1500 + ((t * 211) % 3000);
  let prevPageTs = null;
  let prevPageSize = 0;
  for (let page = 0; page < 14; page++) {
    if (page > 0) clock += ri(rng, 20000, 120000);
    const pageSize = ri(rng, 10, 20);
    const recordIds = ids(pos, pageSize);
    const ev = { type: 'list', identity, recordIds, predicate: PRED(pos, pos + 99), ts: clock };
    if (page > 0) {
      // Cursor issued at the previous page: dwell per record is the
      // 20-120 s page gap divided by page size - firmly human.
      ev.cursor = { issuedAtMs: prevPageTs, pageSize: prevPageSize, step: page };
    }
    events.push(ev);
    prevPageTs = clock;
    prevPageSize = pageSize;
    for (let d = 0; d < 2; d++) {
      clock += ri(rng, 5000, 15000);
      const detailId = recordIds[ri(rng, 0, pageSize - 1)];
      events.push({ type: 'detail', identity, detailId, recordIds: [detailId], ts: clock });
    }
    pos += pageSize + ri(rng, 0, 4);
  }
  return events;
}

function genHeavyReader(rng, t) {
  const fam = 'heavy-reader';
  const identity = idFor(fam, t, 0);
  const events = [];
  let clock = traceBase(t) + ri(rng, 0, 300000);
  let pos = 500 + t * 300;
  let prevPageTs = null;
  const coldPages = new Set([7, 19, 31, 43]);
  for (let page = 0; page < 48; page++) {
    if (page > 0) clock += ri(rng, 10000, 30000);
    const pageSize = 20;
    const recordIds = ids(pos, pageSize);
    const ev = { type: 'list', identity, recordIds, predicate: PRED(pos, pos + 99), ts: clock };
    if (page > 0) ev.cursor = { issuedAtMs: prevPageTs, pageSize, step: page };
    events.push(ev);
    prevPageTs = clock;
    clock += ri(rng, 3000, 8000);
    const warmId = recordIds[ri(rng, 0, pageSize - 1)];
    events.push({ type: 'detail', identity, detailId: warmId, recordIds: [warmId], ts: clock });
    if (coldPages.has(page)) {
      // A lone cold deep link, isolated by over a minute on both
      // sides so the 60 s cold window count stays 1 (bin: low).
      clock += ri(rng, 65000, 90000);
      const coldId = 9000 - t * 100 - page;
      events.push({ type: 'detail', identity, detailId: coldId, recordIds: [coldId], ts: clock });
    }
    pos += pageSize + ri(rng, 0, 10);
  }
  return events;
}

function genReviewTeam(rng, t) {
  const fam = 'review-team';
  const events = [];
  let clock = traceBase(t) + ri(rng, 0, 120000);
  // Three seats, each working one continuous 400-record segment,
  // interleaved in near-real time (the compliance-audit shape).
  for (let i = 0; i < 400; i++) {
    for (let k = 0; k < 3; k++) {
      clock += ri(rng, 2500, 3500);
      const detailId = 500 + t * 50 + k * 400 + i;
      events.push({ type: 'detail', identity: idFor(fam, t, k), detailId, recordIds: [detailId], ts: clock });
    }
  }
  return events;
}

function genNatGroup(rng, t) {
  const fam = 'nat-group';
  const events = [];
  let clock = traceBase(t) + ri(rng, 0, 120000);
  const base = 3000 + t * 120;
  // Phase A: five users behind one NAT open abutting narrow ranges
  // around the same popular section - adjacency merges them.
  for (let k = 0; k < 5; k++) {
    clock += ri(rng, 4000, 8000);
    const min = base + k * 45;
    events.push({
      type: 'list', identity: idFor(fam, t, k),
      predicate: PRED(min, min + 40), recordIds: ids(min, 12), ts: clock,
    });
  }
  // Phase B: all five read the same shared pages (identical predicate
  // per page, IoU 1, so no new adjacency edges; served sets overlap
  // almost fully, which is what drives tiling eta down).
  const sharedBase = 6000 + t * 200;
  for (let p = 0; p < 20; p++) {
    const pageIds = ids(sharedBase + p * 20, 20);
    for (let k = 0; k < 5; k++) {
      clock += ri(rng, 3000, 6000);
      events.push({
        type: 'list', identity: idFor(fam, t, k),
        predicate: PRED(sharedBase + p * 20, sharedBase + p * 20 + 99),
        recordIds: pageIds, ts: clock,
      });
    }
  }
  // Phase C: warm details from the shared pages.
  for (let k = 0; k < 5; k++) {
    for (let d = 0; d < 3; d++) {
      clock += ri(rng, 10000, 20000);
      const detailId = sharedBase + ri(rng, 0, 399);
      events.push({ type: 'detail', identity: idFor(fam, t, k), detailId, recordIds: [detailId], ts: clock });
    }
  }
  return events;
}

function genOnboarding(rng, t) {
  const fam = 'onboarding';
  const events = [];
  let clock = traceBase(t) + ri(rng, 0, 120000);
  const base = 1000 + t * 90;
  // Phase A: six new accounts in one session take an abutting starter
  // tour of the catalog - adjacency merges them into one cohort.
  for (let k = 0; k < 6; k++) {
    clock += ri(rng, 4000, 7000);
    const min = base + k * 55;
    events.push({
      type: 'list', identity: idFor(fam, t, k),
      predicate: PRED(min, min + 50), recordIds: ids(min, 20), ts: clock,
    });
  }
  // Phase B1: everyone exports the same shared core (identical
  // predicates, heavy overlap).
  const coreBase = 5500 + t * 150;
  for (let p = 0; p < 8; p++) {
    const pageIds = ids(coreBase + p * 25, 25);
    for (let k = 0; k < 6; k++) {
      clock += ri(rng, 3000, 6000);
      events.push({
        type: 'list', identity: idFor(fam, t, k),
        predicate: PRED(coreBase + p * 25, coreBase + p * 25 + 99),
        recordIds: pageIds, ts: clock,
      });
    }
  }
  // Phase B2: each account then exports its own individual segment.
  for (let p = 0; p < 4; p++) {
    for (let k = 0; k < 6; k++) {
      clock += ri(rng, 3000, 6000);
      const start = 7000 + t * 10 + k * 80 + p * 20;
      events.push({ type: 'export', identity: idFor(fam, t, k), recordIds: ids(start, 20), ts: clock });
    }
  }
  // Phase C: warm details from the shared core.
  for (let k = 0; k < 6; k++) {
    for (let d = 0; d < 2; d++) {
      clock += ri(rng, 8000, 16000);
      const detailId = coreBase + ri(rng, 0, 199);
      events.push({ type: 'detail', identity: idFor(fam, t, k), detailId, recordIds: [detailId], ts: clock });
    }
  }
  return events;
}

function genSupportDeeplink(rng, t) {
  const fam = 'support-deeplink';
  const events = [];
  // Two support identities, 80 cold deep links each, spread over
  // hours. Gaps of 200-300 s keep the 60 s cold window at count 1
  // (bin: low), and the pair's total cold union (160) stays below the
  // 300-record formation floor, so no cohort ever forms.
  for (let k = 0; k < 2; k++) {
    let clock = traceBase(t) + k * 1800000 + ri(rng, 0, 60000);
    for (let j = 0; j < 80; j++) {
      clock += ri(rng, 200000, 300000);
      const detailId = (k * 4000 + t * 300 + j * 47) % DOMAIN_MAX;
      events.push({ type: 'detail', identity: idFor(fam, t, k), detailId, recordIds: [detailId], ts: clock });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

function genSlicing(rng, t) {
  const fam = 'slicing';
  const events = [];
  let clock = traceBase(t) + ri(rng, 0, 120000);
  // Six identities, list events carrying recordIds only (no predicate,
  // no cursor). Each serves a disjoint atom of about 300 records plus
  // a light shared dilution of 15 popular ids. Cohort formation is
  // served-set slice complementarity; evidence is the tiling stream.
  const dilution = ids(9500, 15);
  const sequences = [];
  for (let k = 0; k < 6; k++) {
    const atom = ids(t * 37 + k * 1500, 285);
    sequences.push([...dilution, ...atom].reduce((acc, _, i, arr) => {
      if (i % 25 === 0) acc.push(arr.slice(i, i + 25));
      return acc;
    }, []));
  }
  for (let p = 0; p < 12; p++) {
    for (let k = 0; k < 6; k++) {
      clock += ri(rng, 6000, 10000);
      events.push({ type: 'list', identity: idFor(fam, t, k), recordIds: sequences[k][p], ts: clock });
    }
  }
  return events;
}

function genIdWalk(rng, t) {
  const fam = 'id-walk';
  const events = [];
  let clock = traceBase(t) + ri(rng, 0, 120000);
  // Four walkers, cold detail fetches only, each walking one
  // continuous disjoint 500-record chunk, interleaved in real time.
  for (let i = 0; i < 500; i++) {
    for (let k = 0; k < 4; k++) {
      clock += ri(rng, 1500, 2500);
      const detailId = 500 + t * 61 + k * 2000 + i;
      events.push({ type: 'detail', identity: idFor(fam, t, k), detailId, recordIds: [detailId], ts: clock });
    }
  }
  return events;
}

function genReaLike(rng, t) {
  const fam = 'rea-like';
  const events = [];
  let clock = traceBase(t) + ri(rng, 0, 120000);
  const main = idFor(fam, t, 0);
  const preA = idFor(fam, t, 1);
  const preB = idFor(fam, t, 2);
  // Preamble: two light identities each serve 170 records from
  // disjoint segments, recordIds only, interleaved - they merge via
  // slice complementarity near the end of the preamble.
  const segA = ids(3200 + t * 40, 170);
  const segB = ids(5200 + t * 40, 170);
  for (let p = 0; p < 9; p++) {
    for (const [identity, seg] of [[preA, segA], [preB, segB]]) {
      clock += ri(rng, 15000, 25000);
      events.push({ type: 'list', identity, recordIds: seg.slice(p * 20, p * 20 + 20), ts: clock });
    }
  }
  // Main chain starts within the 60 s formation window of the
  // preamble's last activity: 20 unfiltered list pages of 100 records
  // at wire speed, chained by fast cursors (dwell 3-7 ms per record).
  clock += ri(rng, 20000, 40000);
  for (let p = 0; p < 20; p++) {
    clock += ri(rng, 1500, 2500);
    events.push({
      type: 'list', identity: main,
      recordIds: ids(p * 100, 100),
      cursor: { issuedAtMs: clock - ri(rng, 300, 700), pageSize: 100, step: p + 1 },
      ts: clock,
    });
  }
  return events;
}

function genDispersed(rng, t) {
  const fam = 'dispersed';
  const events = [];
  // Six walkers over disjoint chunks, but each walker is active in
  // its own time block, with block starts 45 minutes apart - far
  // outside the 60 s formation window. The honest hard case: no
  // cohort ever forms, so no trace can cross, whatever the tables.
  for (let k = 0; k < 6; k++) {
    let clock = traceBase(t) + k * 2700000 + ri(rng, 0, 60000);
    for (let i = 0; i < 500; i++) {
      clock += ri(rng, 2800, 3600);
      const detailId = 300 + t * 23 + k * 1600 + i;
      events.push({ type: 'detail', identity: idFor(fam, t, k), detailId, recordIds: [detailId], ts: clock });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

const GENERATORS = {
  'ordinary-reader': genOrdinaryReader,
  'heavy-reader': genHeavyReader,
  'review-team': genReviewTeam,
  'nat-group': genNatGroup,
  'onboarding': genOnboarding,
  'support-deeplink': genSupportDeeplink,
  'slicing': genSlicing,
  'id-walk': genIdWalk,
  'rea-like': genReaLike,
  'dispersed': genDispersed,
};

const ALL_FAMILIES = [...LEGIT_FAMILIES, ...ATTACK_FAMILIES];

function buildTraces() {
  const traces = [];
  ALL_FAMILIES.forEach((fam, familyIndex) => {
    for (let t = 0; t < TRACES_PER_FAMILY; t++) {
      traces.push({
        family: fam,
        traceIdx: t,
        isLegit: LEGIT_FAMILIES.includes(fam),
        events: GENERATORS[fam](rngFor(familyIndex, t), t),
      });
    }
  });
  return traces;
}

/* ---------------- replay ---------------- */

function emptyHist() {
  const hist = {};
  for (const stream of STREAMS) {
    hist[stream] = {};
    for (const bin of ALPHABETS[stream]) hist[stream][bin] = 0;
    hist[stream]._total = 0;
  }
  return hist;
}

function addHist(target, source) {
  for (const stream of STREAMS) {
    for (const bin of ALPHABETS[stream]) target[stream][bin] += source[stream][bin];
    target[stream]._total += source[stream]._total;
  }
}

// Replay one trace in observe mode. Returns the bin histogram, the
// crossing outcome, and - when collectPairs is set - (sum, eta) pairs
// sampled once per 100-record sum bucket from cohort snapshots.
async function replayTrace(trace, tables, collectPairs) {
  const tw = sdk.createCusumTripwire({ mode: 'observe', alpha: ALPHA, llrTables: tables });
  const hist = emptyHist();
  const servedMirror = new Map();
  const seenBuckets = new Set();
  const pairs = [];
  let crossed = false;
  let unionAtCrossing = null;
  for (const ev of trace.events) {
    const dec = await tw.observe(ev);
    for (const stream of STREAMS) {
      const bin = dec.bins[stream];
      if (bin !== null && bin !== undefined) {
        hist[stream][bin] += 1;
        hist[stream]._total += 1;
      }
    }
    if (ev.recordIds) {
      let set = servedMirror.get(ev.identity);
      if (!set) { set = new Set(); servedMirror.set(ev.identity, set); }
      for (const id of ev.recordIds) set.add(id);
    }
    if (!crossed && dec.crossed) {
      crossed = true;
      const snap = await tw.snapshotFor(ev.identity);
      unionAtCrossing = snap ? snap.unionRecords : null;
    }
    if (collectPairs) {
      const snap = await tw.snapshotFor(ev.identity);
      if (snap && snap.members.length >= 2) {
        let sum = 0;
        for (const member of snap.members) sum += servedMirror.get(member)?.size ?? 0;
        if (sum > 0) {
          const bucket = Math.floor(sum / 100);
          if (!seenBuckets.has(bucket)) {
            seenBuckets.add(bucket);
            pairs.push({ sum, eta: snap.unionRecords / sum });
          }
        }
      }
    }
  }
  return { hist, crossed, unionAtCrossing, pairs };
}

/* ---------------- fitting ---------------- */

const etaExp = (sum, nEff) => (nEff * (1 - Math.exp(-sum / nEff))) / sum;

function fitNEff(pairs) {
  if (pairs.length === 0) return { nEff: sdk.R6_CALIB_1_LLR_TABLES.nEff, sse: null, pairCount: 0, fallback: true };
  let best = null;
  for (let n = 50; n <= 2000; n++) {
    let sse = 0;
    for (const pair of pairs) {
      const diff = pair.eta - etaExp(pair.sum, n);
      sse += diff * diff;
    }
    if (best === null || sse < best.sse) best = { nEff: n, sse };
  }
  return { nEff: best.nEff, sse: best.sse, pairCount: pairs.length, fallback: false };
}

const clampLlr = (v) => Math.max(-3, Math.min(3, v));
const round4 = (v) => {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
};

// Fit LLR tables on the train set implied by excludedFamily (null =
// full fit on every family). histByFamily / pairsByFamily come from
// the r6 replay pass. See the header for the exact method and the
// recorded empty-stream deviation.
function fitTables(excludedFamily, histByFamily, pairsByFamily, version) {
  const legitTrain = LEGIT_FAMILIES.filter((f) => f !== excludedFamily);
  const attackTrain = ATTACK_FAMILIES.filter((f) => f !== excludedFamily);
  const tables = { version, uncalibrated: true, nEff: 0 };
  for (const stream of STREAMS) {
    const alphabet = ALPHABETS[stream];
    const k = alphabet.length;
    const pooled = {};
    let pooledTotal = 0;
    for (const bin of alphabet) {
      pooled[bin] = legitTrain.reduce((acc, f) => acc + histByFamily[f][stream][bin], 0);
      pooledTotal += pooled[bin];
    }
    const f0smooth = {};
    for (const bin of alphabet) {
      f0smooth[bin] = pooledTotal > 0
        ? (pooled[bin] + 0.5) / (pooledTotal + 0.5 * k)
        : 1 / k;
    }
    // Attacker families with zero evaluated events on this stream
    // have no empirical distribution here and are excluded from the
    // mixture mean (see header). No data at all means no evidence.
    const withData = attackTrain.filter((f) => histByFamily[f][stream]._total > 0);
    tables[stream] = {};
    for (const bin of alphabet) {
      if (withData.length === 0) {
        tables[stream][bin] = 0;
        continue;
      }
      let meanFj = 0;
      for (const f of withData) {
        const total = histByFamily[f][stream]._total;
        meanFj += (histByFamily[f][stream][bin] + 0.5) / (total + 0.5 * k);
      }
      meanFj /= withData.length;
      tables[stream][bin] = round4(clampLlr(Math.log(meanFj / f0smooth[bin])));
    }
  }
  const trainPairs = [];
  for (const fam of NEFF_FAMILIES) {
    if (fam === excludedFamily) continue;
    for (const pairs of pairsByFamily[fam] ?? []) trainPairs.push(...pairs);
  }
  const nEffFit = fitNEff(trainPairs);
  tables.nEff = nEffFit.nEff;
  return { tables, nEffFit };
}

/* ---------------- holdout aggregation ---------------- */

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function aggregateHoldout(results, traces) {
  const perFamily = {};
  let fp = 0;
  let fn = 0;
  const attackUnions = [];
  for (const fam of ALL_FAMILIES) {
    const famTraces = traces.filter((tr) => tr.family === fam);
    const famResults = famTraces.map((tr) => results.get(`${fam}:${tr.traceIdx}`));
    const crossedCount = famResults.filter((r) => r.crossed).length;
    const unions = famResults.filter((r) => r.crossed && r.unionAtCrossing !== null).map((r) => r.unionAtCrossing);
    perFamily[fam] = {
      traces: famTraces.length,
      crossed: crossedCount,
      detectionMedianUnion: median(unions),
    };
    if (LEGIT_FAMILIES.includes(fam)) fp += crossedCount;
    else {
      fn += famTraces.length - crossedCount;
      attackUnions.push(...unions);
    }
  }
  return {
    falsePositives: fp,
    falseNegatives: fn,
    falsePositiveRate: fp / (LEGIT_FAMILIES.length * TRACES_PER_FAMILY),
    falseNegativeRate: fn / (ATTACK_FAMILIES.length * TRACES_PER_FAMILY),
    attackerDetectionMedianUnion: median(attackUnions),
    perFamily,
  };
}

/* ---------------- main ---------------- */

async function main() {
  const r6 = sdk.R6_CALIB_1_LLR_TABLES;
  const traces = buildTraces();
  const totalEvents = traces.reduce((acc, tr) => acc + tr.events.length, 0);
  console.log(`fit-cusum-calibration: ${traces.length} traces, ${totalEvents} events, seed ${SEED}`);

  // Pass 1: r6 replay - histograms per family plus N_eff pairs.
  const histByFamily = {};
  const pairsByFamily = {};
  for (const fam of ALL_FAMILIES) { histByFamily[fam] = emptyHist(); pairsByFamily[fam] = []; }
  for (const trace of traces) {
    const collectPairs = NEFF_FAMILIES.includes(trace.family);
    const result = await replayTrace(trace, r6, collectPairs);
    addHist(histByFamily[trace.family], result.hist);
    if (collectPairs) pairsByFamily[trace.family].push(result.pairs);
  }
  console.log('pass 1 done: r6 histograms and N_eff pairs collected');

  // Fits: one LOAFO fold per family, plus the full fit.
  const foldFits = {};
  const perFoldNEff = {};
  for (const fam of ALL_FAMILIES) {
    const fit = fitTables(fam, histByFamily, pairsByFamily, `r7-labfit-1-loafo-${fam}`);
    foldFits[fam] = fit.tables;
    perFoldNEff[fam] = fit.nEffFit;
  }
  const fullFit = fitTables(null, histByFamily, pairsByFamily, 'r7-labfit-1');
  const r7Tables = fullFit.tables;
  console.log(`fits done: full-fit N_eff ${r7Tables.nEff} from ${fullFit.nEffFit.pairCount} (sum, eta) pairs`);

  // Pass 2: holdout evaluation - fold-fit table and r6 per trace.
  const foldResults = new Map();
  const r6Results = new Map();
  for (const trace of traces) {
    const key = `${trace.family}:${trace.traceIdx}`;
    const foldReplay = await replayTrace(trace, foldFits[trace.family], false);
    foldResults.set(key, { crossed: foldReplay.crossed, unionAtCrossing: foldReplay.unionAtCrossing });
    const r6Replay = await replayTrace(trace, r6, false);
    r6Results.set(key, { crossed: r6Replay.crossed, unionAtCrossing: r6Replay.unionAtCrossing });
  }
  const holdoutR7 = aggregateHoldout(foldResults, traces);
  const holdoutR6 = aggregateHoldout(r6Results, traces);
  console.log(`holdout done: r7 fold-fit FP ${holdoutR7.falsePositives} FN ${holdoutR7.falseNegatives}; r6 FP ${holdoutR6.falsePositives} FN ${holdoutR6.falseNegatives}`);

  // Manifest (fixed validity window, evaluated at a fixed instant).
  const issuedAtMs = Date.UTC(2026, 10, 2, 0, 0, 0); // 2026-11-02T00:00:00Z
  const expiresAtMs = issuedAtMs + 180 * 24 * 3600 * 1000; // +180 days
  const legitTotal = LEGIT_FAMILIES.length * TRACES_PER_FAMILY;
  const attackTotal = ATTACK_FAMILIES.length * TRACES_PER_FAMILY;
  const manifest = {
    modelVersion: 'cusum-1',
    calibrationVersion: 'r7-labfit-1',
    sampleSizes: { legit: legitTotal, attack: attackTotal },
    holdout: {
      falsePositiveRate: holdoutR7.falsePositives / legitTotal,
      falseNegativeRate: holdoutR7.falseNegatives / attackTotal,
    },
    method: 'LOAFO trace-fitted LLR tables on lab-simulated traces; Laplace smoothing 0.5 per bin; LLR clamped to [-3, 3]; N_eff grid fit 50..2000 on legit cohort (sum, eta) pairs',
    attestedBy: 'fit-cusum-calibration.cjs (lab-simulated)',
    issuedAtMs,
    expiresAtMs,
  };
  const evaluation = sdk.evaluateCalibrationManifest(manifest, { now: issuedAtMs + 3600000 });

  const r7WinsBoth = holdoutR7.falsePositives < holdoutR6.falsePositives
    && holdoutR7.falseNegatives < holdoutR6.falseNegatives;
  const proposal = r7WinsBoth
    ? 'propose switching the SDK default to r7-labfit-1 (r7 fold-fit beats r6 on both holdout FP and FN)'
    : 'keep r6-calib-1 as the SDK default; r7-labfit-1 ships as opt-in only (r7 fold-fit does not beat r6 on both holdout FP and FN)';

  // Outputs.
  const tablesPath = path.join(__dirname, 'r7-labfit-1.tables.json');
  const manifestPath = path.join(__dirname, 'r7-labfit-1.manifest.json');
  const summaryPath = path.resolve(
    __dirname, '..', '..', 'antirea-study-2026-11-01', 'overnight-2026-11-02',
    'runs', 'v241-calib', 'fit-summary.json',
  );
  fs.writeFileSync(tablesPath, `${JSON.stringify(r7Tables, null, 2)}\n`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const summary = {
    artifact: 'r7-labfit-1',
    generatedBy: 'scripts/fit-cusum-calibration.cjs',
    seed: SEED,
    dataNotice: 'lab-simulated traces only - no real population data; tables remain uncalibrated: true',
    sdkDefaultChanged: false,
    families: {
      legit: LEGIT_FAMILIES,
      attack: ATTACK_FAMILIES,
      tracesPerFamily: TRACES_PER_FAMILY,
      totalTraces: traces.length,
      totalEvents,
    },
    method: {
      replay: "mode 'observe', alpha 1e-3, bins from CusumDecision.bins under r6 tables",
      loafo: 'one fold per family; train is every other family; holdout traces are scored with their own fold-fit table',
      llr: 'log( mean_j fj_smooth(bin) / f0_smooth(bin) ), Laplace 0.5 added to every bin of the stream alphabet before normalizing',
      clamp: 'every fitted LLR clamped to [-3, 3]',
      nEff: 'grid 50..2000 step 1 minimizing SSE of eta vs etaExp(sum, N) = N * (1 - exp(-sum / N)) / sum, pairs sampled once per (trace, 100-record sum bucket) from SDK snapshots of legit cohort families (review-team, nat-group, onboarding)',
    },
    deviations: [
      'Attacker families with zero evaluated events for a stream are excluded from that stream mixture mean (their bin frequency is undefined, not uniform). If no train attacker family has data for a stream, its fitted LLRs are all 0. In this lab set no attacker family emits range predicates, so the fitted adjacency table is all zeros.',
      'The r6 holdout column comes from a fresh replay in the holdout pass, not from pass 1, although the configuration is identical (observe, alpha 1e-3, r6 tables).',
      'The manifest is evaluated at the fixed instant issuedAtMs + 1h so the script output is deterministic.',
    ],
    histogramsR6: histByFamily,
    nEff: {
      full: fullFit.nEffFit,
      perFold: Object.fromEntries(ALL_FAMILIES.map((f) => [f, perFoldNEff[f].nEff])),
    },
    tables: r7Tables,
    holdout: { r6: holdoutR6, r7FoldFit: holdoutR7 },
    manifest: {
      file: 'scripts/r7-labfit-1.manifest.json',
      tier: evaluation.tier,
      calibrated: evaluation.calibrated,
      reasons: evaluation.reasons,
      sampleSizes: manifest.sampleSizes,
      holdout: manifest.holdout,
      issuedAtMs,
      expiresAtMs,
    },
    proposal,
    proposalRule: 'propose switching the SDK default only if the r7 fold-fit beats r6 on both holdout FP and FN',
  };
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(JSON.stringify({
    tablesPath,
    manifestPath,
    summaryPath,
    nEff: r7Tables.nEff,
    holdout: {
      r6: {
        falsePositives: holdoutR6.falsePositives,
        falseNegatives: holdoutR6.falseNegatives,
        attackerDetectionMedianUnion: holdoutR6.attackerDetectionMedianUnion,
      },
      r7FoldFit: {
        falsePositives: holdoutR7.falsePositives,
        falseNegatives: holdoutR7.falseNegatives,
        attackerDetectionMedianUnion: holdoutR7.attackerDetectionMedianUnion,
      },
    },
    manifestTier: evaluation.tier,
    manifestReasons: evaluation.reasons,
    proposal,
  }, null, 2));
}

main().catch((err) => {
  console.error('fit-cusum-calibration: failed:', err);
  process.exit(1);
});
