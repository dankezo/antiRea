"use strict";
// R14-v2b (PASS-lab, SDK port RECHECK-FAIL, upgraded under the frozen
// registration in docs/lab-notes/R14-V2B-UPGRADE-REGISTRATION.md):
// lineage watch with the uniformized-marginal flat null (UM-null).
// The decisive test in this file is the LOCKED RECHECK of the
// upgraded module: lab common.cjs generator, ari() and
// falseMergeRate() reproduced verbatim below (with the harness-v2
// streamRng they depend on), NEW seed family 20279xxx from the
// registration, 40 forests per cell, n = 48, every forest
// self-calibrates through the built SDK module with
// traits = [...cat, ...num]. Bars are the ORIGINAL locked bars,
// not loosened: CLEAN ARI >= 0.75, HONEST-FLAT-48 FMR <= 2%,
// EV-MERGE ARI >= 0.50, EV-SWITCH ARI >= 0.50.
// Measured on this run (raw runner output, 2026-11-18):
//   CLEAN ARI 0.789869, HONEST-FLAT-48 FMR 0.5696%,
//   EV-MERGE ARI 0.690928, EV-SWITCH ARI 0.528211,
//   h_b 0.32 in 159 of 160 forests (one flat forest at 0.36),
//   cut equivalence 0 discordant pairs over 40 CLEAN forests,
//   determinism byte-identical on re-evaluation.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createLineageWatch } = require("../dist/index.js");

function approx(actual, expected, tol, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    label + ": expected ~" + expected + ", got " + actual,
  );
}

/* ---- harness-v2 rng (verbatim, lib/rng.cjs mulberry32 + streamRng) ---- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function streamRng(baseSeed, streamIndex, runIdx) {
  return mulberry32(
    (baseSeed ^ Math.imul(streamIndex + 1, 0x9e3779b1) ^ Math.imul(runIdx + 1, 0x85ebca6b)) >>> 0,
  );
}

/* ---- lab common.cjs (verbatim generator, distance, ARI, FMR) ---- */
function randn(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function rootConfig(rng) {
  const cat = [], num = [];
  for (let i = 0; i < 8; i++) cat.push(Math.floor(rng() * 4));
  for (let i = 0; i < 4; i++) num.push(rng() * 100);
  return { cat, num };
}
function mutate(cfg, rng, mu = 0.1) {
  const cat = cfg.cat.map((v) => {
    if (rng() < mu) { let nv = Math.floor(rng() * 4); if (nv === v) nv = (nv + 1) % 4; return nv; }
    return v;
  });
  const num = cfg.num.map((v) => {
    if (rng() < mu) return Math.min(100, Math.max(0, v + randn(rng) * 10));
    return v;
  });
  return { cat, num };
}
function evolve(root, rng, mu = 0.1) {
  let generation = [root];
  for (let round = 0; round < 3; round++) {
    const next = [];
    for (const cfg of generation) { next.push(mutate(cfg, rng, mu)); next.push(mutate(cfg, rng, mu)); }
    generation = next;
  }
  return generation;
}
function genForest(seed, L = 6) {
  const rng = streamRng(seed, 60606, 0);
  const leaves = [];
  for (let lin = 0; lin < L; lin++) {
    for (const cfg of evolve(rootConfig(rng), rng)) leaves.push({ cfg, lineage: lin });
  }
  return leaves;
}
function genForestMerge(seed) {
  const rng = streamRng(seed, 60606, 0);
  const leaves = [];
  for (let pair = 0; pair < 3; pair++) {
    const ancestor = rootConfig(rng);
    for (let side = 0; side < 2; side++) {
      const lin = pair * 2 + side;
      const root = mutate(ancestor, rng, 0.25);
      for (const cfg of evolve(root, rng)) leaves.push({ cfg, lineage: lin });
    }
  }
  return leaves;
}
function genForestFlat(seed, n = 48) {
  const rng = streamRng(seed, 60606, 0);
  const leaves = [];
  for (let i = 0; i < n; i++) leaves.push({ cfg: rootConfig(rng), lineage: i });
  return leaves;
}
function genForestSwitch(seed) {
  const leaves = genForest(seed);
  const rng = streamRng(seed, 70707, 0);
  const byLineage = new Map();
  leaves.forEach((l, i) => { if (!byLineage.has(l.lineage)) byLineage.set(l.lineage, []); byLineage.get(l.lineage).push(i); });
  const idxs = leaves.map((_, i) => i);
  for (let i = idxs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = idxs[i]; idxs[i] = idxs[j]; idxs[j] = t; }
  const chimeraIdx = idxs.slice(0, Math.floor(leaves.length * 0.25));
  for (const i of chimeraIdx) {
    const X = leaves[i].lineage;
    let Y = Math.floor(rng() * 6);
    if (Y === X) Y = (Y + 1) % 6;
    const donorPool = byLineage.get(Y).filter((j) => !chimeraIdx.includes(j));
    const donor = leaves[donorPool[Math.floor(rng() * donorPool.length)]];
    const src = leaves[i].cfg;
    leaves[i] = { cfg: { cat: src.cat.slice(0, 6).concat(donor.cfg.cat.slice(6)), num: [...donor.cfg.num] }, lineage: X, chimera: true };
  }
  return { leaves };
}
function labDist(a, b) {
  let s = 0;
  for (let i = 0; i < 8; i++) s += a.cat[i] === b.cat[i] ? 0 : 1;
  for (let i = 0; i < 4; i++) s += Math.abs(a.num[i] - b.num[i]) / 100;
  return s / 12;
}
function labDistMatrix(leaves) {
  const n = leaves.length;
  const D = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const d = labDist(leaves[i].cfg, leaves[j].cfg); D[i][j] = d; D[j][i] = d; }
  return D;
}
function labClusterAt(D, thresh, linkage) {
  const n = D.length;
  let clusters = Array.from({ length: n }, (_, i) => [i]);
  const cdist = (A, B) => {
    if (linkage === "single") { let m = Infinity; for (const a of A) for (const b of B) m = Math.min(m, D[a][b]); return m; }
    let s = 0, c = 0; for (const a of A) for (const b of B) { s += D[a][b]; c++; } return s / c;
  };
  for (;;) {
    let best = null, bd = Infinity;
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
      const d = cdist(clusters[i], clusters[j]);
      if (d < bd) { bd = d; best = [i, j]; }
    }
    if (best === null || bd > thresh) break;
    const [i, j] = best;
    clusters[i] = clusters[i].concat(clusters[j]);
    clusters.splice(j, 1);
  }
  const labels = new Array(n);
  clusters.forEach((c, ci) => c.forEach((idx) => { labels[idx] = ci; }));
  return labels;
}
function ari(trueL, predL) {
  const n = trueL.length;
  const cont = new Map();
  const rows = new Map(), cols = new Map();
  for (let i = 0; i < n; i++) {
    const key = trueL[i] + "|" + predL[i];
    cont.set(key, (cont.get(key) || 0) + 1);
    rows.set(trueL[i], (rows.get(trueL[i]) || 0) + 1);
    cols.set(predL[i], (cols.get(predL[i]) || 0) + 1);
  }
  const c2 = (x) => (x * (x - 1)) / 2;
  let sumC = 0; for (const v of cont.values()) sumC += c2(v);
  let sumR = 0; for (const v of rows.values()) sumR += c2(v);
  let sumK = 0; for (const v of cols.values()) sumK += c2(v);
  const total = c2(n);
  const expected = total > 0 ? (sumR * sumK) / total : 0;
  const maxIdx = 0.5 * (sumR + sumK);
  return maxIdx - expected === 0 ? 1 : (sumC - expected) / (maxIdx - expected);
}
function falseMergeRate(truth, pred) {
  let cross = 0, merged = 0;
  for (let i = 0; i < truth.length; i++) for (let j = i + 1; j < truth.length; j++) {
    if (truth[i] !== truth[j]) { cross++; if (pred[i] === pred[j]) merged++; }
  }
  return cross ? merged / cross : 0;
}

/* ---- locked recheck (registration section 4 and 5) ---- */
const FORESTS = 40;
const CELLS = [
  { key: "clean", seeds: Array.from({ length: FORESTS }, (_, i) => 20279101 + i), gen: (s) => genForest(s) },
  { key: "flat48", seeds: Array.from({ length: FORESTS }, (_, i) => 20279201 + i), gen: (s) => genForestFlat(s, 48) },
  { key: "evMerge", seeds: Array.from({ length: FORESTS }, (_, i) => 20279301 + i), gen: (s) => genForestMerge(s) },
  { key: "evSwitch", seeds: Array.from({ length: FORESTS }, (_, i) => 20279401 + i), gen: (s) => genForestSwitch(s).leaves },
];
function toMembers(leaves) {
  return leaves.map((l, i) => ({ id: "m" + i, traits: [...l.cfg.cat, ...l.cfg.num] }));
}
function predLabels(result, n) {
  const labels = new Array(n);
  for (let i = 0; i < n; i++) labels[i] = 10000 + i;
  result.clusters.forEach((cluster, ci) => {
    for (const id of cluster.memberIds) labels[Number(id.slice(1))] = ci;
  });
  return labels;
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

let cached = null;
function runRecheck() {
  if (cached) return cached;
  const inst = createLineageWatch();
  const cells = {};
  let totalDiscordant = 0;
  let cleanForestsChecked = 0;
  let determinismOk = true;
  for (const cell of CELLS) {
    const perAri = [], perFmr = [], hbDist = {};
    let uncalibratable = 0;
    for (const seed of cell.seeds) {
      const leaves = cell.gen(seed);
      const truth = leaves.map((l) => l.lineage);
      const result = inst.evaluatePopulation(toMembers(leaves));
      if (result.status === "uncalibratable") uncalibratable++;
      const hbKey = result.h_b === null ? "null" : result.h_b.toFixed(2);
      hbDist[hbKey] = (hbDist[hbKey] || 0) + 1;
      const pred = predLabels(result, leaves.length);
      perAri.push(ari(truth, pred));
      perFmr.push(falseMergeRate(truth, pred));
      if (cell.key === "clean" && result.h_b !== null) {
        const D = labDistMatrix(leaves);
        const labLabels = labClusterAt(D, result.h_b, "average");
        for (let i = 0; i < leaves.length; i++) {
          for (let j = i + 1; j < leaves.length; j++) {
            if ((pred[i] === pred[j]) !== (labLabels[i] === labLabels[j])) totalDiscordant++;
          }
        }
        cleanForestsChecked++;
        if (cleanForestsChecked <= 3) {
          const again = inst.evaluatePopulation(toMembers(leaves));
          if (JSON.stringify(again) !== JSON.stringify(result)) determinismOk = false;
        }
      }
    }
    cells[cell.key] = {
      meanAri: mean(perAri), meanFmr: mean(perFmr), hbDist, uncalibratable,
    };
  }
  cached = { cells, totalDiscordant, cleanForestsChecked, determinismOk };
  return cached;
}

test("locked recheck: CLEAN pooled ARI clears the 0.75 bar", () => {
  const r = runRecheck();
  approx(r.cells.clean.meanAri, 0.789869, 1e-4, "CLEAN ARI vs recorded run");
  assert.ok(r.cells.clean.meanAri >= 0.75, "CLEAN ARI " + r.cells.clean.meanAri + " < 0.75 bar");
  assert.equal(r.cells.clean.uncalibratable, 0);
});

test("locked recheck: HONEST-FLAT-48 pooled FMR clears the 2% bar", () => {
  const r = runRecheck();
  approx(r.cells.flat48.meanFmr, 0.005696, 1e-5, "FLAT FMR vs recorded run");
  assert.ok(r.cells.flat48.meanFmr <= 0.02, "FLAT FMR " + r.cells.flat48.meanFmr + " > 0.02 bar");
});

test("locked recheck: EV-MERGE and EV-SWITCH pooled ARI clear the 0.50 bars", () => {
  const r = runRecheck();
  approx(r.cells.evMerge.meanAri, 0.690928, 1e-4, "EV-MERGE ARI vs recorded run");
  approx(r.cells.evSwitch.meanAri, 0.528211, 1e-4, "EV-SWITCH ARI vs recorded run");
  assert.ok(r.cells.evMerge.meanAri >= 0.50, "EV-MERGE ARI " + r.cells.evMerge.meanAri + " < 0.50 bar");
  assert.ok(r.cells.evSwitch.meanAri >= 0.50, "EV-SWITCH ARI " + r.cells.evSwitch.meanAri + " < 0.50 bar");
});

test("honesty: cut equivalence with lab clusterAt and determinism", () => {
  const r = runRecheck();
  assert.equal(r.cleanForestsChecked, 40);
  assert.equal(r.totalDiscordant, 0);
  assert.equal(r.determinismOk, true);
});

test("contract: advisory only, no invented threshold on uncalibratable input", () => {
  const inst = createLineageWatch({ calibrationTargetFmr: 0.000001 });
  // A tiny identical-traits population: every null merges at the
  // smallest grid h, so no grid h can earn the extreme target.
  const members = Array.from({ length: 12 }, (_, i) => ({ id: "x" + i, traits: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }));
  const result = inst.evaluatePopulation(members);
  assert.equal(result.enforcement, "none");
  if (result.status === "uncalibratable") {
    assert.equal(result.h_b, null);
    assert.deepEqual(result.clusters, []);
  }
  const normal = createLineageWatch().evaluatePopulation(toMembers(genForest(20279101)));
  assert.equal(normal.enforcement, "none");
  assert.equal(normal.kind, "lineage_watch");
});
