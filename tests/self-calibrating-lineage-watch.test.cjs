"use strict";
// R14-C (CALNULL-C, lab verdict ADVISORY-CONTINUE, upgraded under the
// frozen registration in docs/lab-notes/R14-C-UPGRADE-REGISTRATION.md):
// self-calibrating lineage watch - the module collects its own
// bootstrap-window traffic as reference R, freezes R, isolation-trims
// it (the upgrade: drop the 25% most locally isolated rows, replacing
// branch C's medoid-distance 10% trim), calibrates h_b once from the
// trimmed, rank-flattened, permuted R, and scores later populations
// at the frozen h_b. The decisive tests here re-measure ALL cells of
// the registration on NEW seed family 20280xxx: the 4 main gates at
// their ORIGINAL bars (CLEAN ARI >= 0.75, HONEST-FLAT-48 FMR <= 2%,
// EV-MERGE ARI >= 0.50, EV-SWITCH ARI >= 0.50) AND the 20%
// contamination cell under the literal all-4-gates reading.
// Measured on this run (raw runner output, 2026-11-18):
//   main: CLEAN ARI 0.935690, FLAT FMR 1.8351%, EV-MERGE 0.697615,
//         EV-SWITCH 0.657188, h_b 0.40 in all 4 cells;
//   poison: h_b 0.40 (the old trim flipped to 0.44), CLEAN ARI
//         0.922423, FLAT FMR 1.8351%, EV-MERGE 0.697615,
//         EV-SWITCH 0.657188 - all 4 gates hold under poisoning.
//         The diagnostic values equal the main-cell values exactly
//         because the poisoned calibration selects the same h_b
//         (0.40) and the diagnostic scored seeds are the main
//         cells' scored seeds, per the registration;
//   trim audit: 132 dropped rows, 94 of them bot rows (71.2% of
//         the dropped set, against the 20.8% base rate and the old
//         trim's 11 of 53); 94 of 110 bot rows removed.
// The lab generator, ari() and falseMergeRate() are reproduced
// verbatim below with the harness-v2 streamRng they depend on.
// The window time leg is satisfied with an injected clock advanced
// by 7 days before close, exactly as the registration declares.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSelfCalibratingLineageWatch, isolationTrimReference } = require("../dist/index.js");

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


/* ---- branch C recheck machinery (registration sections 4 and 5) ---- */
const FORESTS = 40;
const WARMUP = 11;
const CELLS = [
  { key: "clean", warmSeeds: Array.from({ length: WARMUP }, (_, i) => 20280101 + i), scoreSeeds: Array.from({ length: FORESTS }, (_, i) => 20280151 + i), gen: (s) => genForest(s) },
  { key: "flat48", warmSeeds: Array.from({ length: WARMUP }, (_, i) => 20280201 + i), scoreSeeds: Array.from({ length: FORESTS }, (_, i) => 20280251 + i), gen: (s) => genForestFlat(s, 48) },
  { key: "evMerge", warmSeeds: Array.from({ length: WARMUP }, (_, i) => 20280301 + i), scoreSeeds: Array.from({ length: FORESTS }, (_, i) => 20280351 + i), gen: (s) => genForestMerge(s) },
  { key: "evSwitch", warmSeeds: Array.from({ length: WARMUP }, (_, i) => 20280401 + i), scoreSeeds: Array.from({ length: FORESTS }, (_, i) => 20280451 + i), gen: (s) => genForestSwitch(s).leaves },
];
function rowsOf(leaves) { return leaves.map((l) => [...l.cfg.cat, ...l.cfg.num]); }
function buildInstance(R) {
  let t = 1000000;
  const inst = createSelfCalibratingLineageWatch({ now: () => t });
  inst.observeBootstrapBatch(R.map((r, i) => ({ id: "r" + i, traits: r })));
  t += 604800000;
  const close = inst.closeBootstrap();
  return { inst, close };
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
function scoreCell(inst, cell) {
  const perAri = [], perFmr = [];
  for (const seed of cell.scoreSeeds) {
    const leaves = cell.gen(seed);
    const truth = leaves.map((l) => l.lineage);
    const result = inst.evaluatePopulation(leaves.map((l, i) => ({ id: "m" + i, traits: [...l.cfg.cat, ...l.cfg.num] })));
    const pred = predLabels(result, leaves.length);
    perAri.push(ari(truth, pred));
    perFmr.push(falseMergeRate(truth, pred));
  }
  return { meanAri: mean(perAri), meanFmr: mean(perFmr) };
}
function buildR(cell) {
  let R = [];
  for (const seed of cell.warmSeeds) R = R.concat(rowsOf(genForest(seed)));
  return R;
}
function buildPoisonR() {
  let R = [];
  const botIdx = new Set();
  for (let wi = 0; wi < WARMUP; wi++) {
    let rows = rowsOf(genForest(20280501 + wi));
    const botRows = rowsOf(genForestFlat(20280551 + wi, 48)).slice(0, 10);
    rows = botRows.concat(rows.slice(10));
    const offset = R.length;
    for (let k = 0; k < 10; k++) botIdx.add(offset + k);
    R = R.concat(rows);
  }
  return { R, botIdx };
}

let cached = null;
function runRecheck() {
  if (cached) return cached;
  const cells = {};
  const instances = {};
  for (const cell of CELLS) {
    const { inst, close } = buildInstance(buildR(cell));
    instances[cell.key] = { inst, close };
    cells[cell.key] = { hB: close.h_b, status: close.status, ...scoreCell(inst, cell) };
  }
  // Poison cell: R with rows 0..9 of each warm-up forest replaced by flat bot rows.
  const { R: poisonR, botIdx } = buildPoisonR();
  const trim = isolationTrimReference(poisonR);
  const droppedBot = trim.droppedIndices.filter((i) => botIdx.has(i)).length;
  const trimAudit = { droppedTotal: trim.droppedIndices.length, droppedBot, botTotal: botIdx.size };
  const poisonBuilt = buildInstance(poisonR);
  const poisonScored = scoreCell(poisonBuilt.inst, { gen: (s) => genForest(s), scoreSeeds: Array.from({ length: FORESTS }, (_, i) => 20280601 + i) });
  const poisonDiag = {};
  for (const cell of CELLS.slice(1)) {
    poisonDiag[cell.key] = scoreCell(poisonBuilt.inst, cell);
  }
  const poison = { hB: poisonBuilt.close.h_b, status: poisonBuilt.close.status, ...poisonScored };
  // Honesty: cut equivalence on CLEAN scored forests at the frozen h_b,
  // using the clean instance itself (no extra calibration).
  const cleanCell = CELLS[0];
  const cleanInst = instances.clean.inst;
  const cleanHB = instances.clean.close.h_b;
  let totalDiscordant = 0, checked = 0;
  for (const seed of cleanCell.scoreSeeds) {
    const leaves = cleanCell.gen(seed);
    const result = cleanInst.evaluatePopulation(leaves.map((l, i) => ({ id: "m" + i, traits: [...l.cfg.cat, ...l.cfg.num] })));
    const pred = predLabels(result, leaves.length);
    const D = labDistMatrix(leaves);
    const lab = labClusterAt(D, cleanHB === null ? -1 : cleanHB, "average");
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        if ((pred[i] === pred[j]) !== (lab[i] === lab[j])) totalDiscordant++;
      }
    }
    checked++;
  }
  // Honesty: determinism - closing the same R twice.
  const second = buildInstance(buildR(cleanCell));
  const determinismOk = second.close.h_b === cleanHB &&
    JSON.stringify(second.close.calibration.fmrByH) === JSON.stringify(instances.clean.close.calibration.fmrByH);
  cached = { cells, poison, poisonDiag, trimAudit, totalDiscordant, checked, determinismOk };
  return cached;
}

test("main gates: CLEAN ARI and HONEST-FLAT-48 FMR clear their bars", () => {
  const r = runRecheck();
  assert.equal(r.cells.clean.hB, 0.4);
  approx(r.cells.clean.meanAri, 0.935690, 1e-4, "CLEAN ARI vs recorded run");
  assert.ok(r.cells.clean.meanAri >= 0.75, "CLEAN ARI " + r.cells.clean.meanAri + " < 0.75 bar");
  approx(r.cells.flat48.meanFmr, 0.018351, 1e-5, "FLAT FMR vs recorded run");
  assert.ok(r.cells.flat48.meanFmr <= 0.02, "FLAT FMR " + r.cells.flat48.meanFmr + " > 0.02 bar");
});

test("main gates: EV-MERGE and EV-SWITCH ARI clear their bars", () => {
  const r = runRecheck();
  approx(r.cells.evMerge.meanAri, 0.697615, 1e-4, "EV-MERGE ARI vs recorded run");
  approx(r.cells.evSwitch.meanAri, 0.657188, 1e-4, "EV-SWITCH ARI vs recorded run");
  assert.ok(r.cells.evMerge.meanAri >= 0.50, "EV-MERGE ARI " + r.cells.evMerge.meanAri + " < 0.50 bar");
  assert.ok(r.cells.evSwitch.meanAri >= 0.50, "EV-SWITCH ARI " + r.cells.evSwitch.meanAri + " < 0.50 bar");
});

test("contamination cell: all 4 gates hold at 20% poisoning", () => {
  const r = runRecheck();
  assert.equal(r.poison.hB, 0.4);
  approx(r.poison.meanAri, 0.922423, 1e-4, "POISON CLEAN ARI vs recorded run");
  assert.ok(r.poison.meanAri >= 0.75, "POISON CLEAN ARI " + r.poison.meanAri + " < 0.75 bar");
  approx(r.poisonDiag.flat48.meanFmr, 0.018351, 1e-5, "POISON FLAT FMR vs recorded run");
  assert.ok(r.poisonDiag.flat48.meanFmr <= 0.02, "POISON FLAT FMR " + r.poisonDiag.flat48.meanFmr + " > 0.02 bar");
  assert.ok(r.poisonDiag.evMerge.meanAri >= 0.50, "POISON EV-MERGE ARI " + r.poisonDiag.evMerge.meanAri + " < 0.50 bar");
  assert.ok(r.poisonDiag.evSwitch.meanAri >= 0.50, "POISON EV-SWITCH ARI " + r.poisonDiag.evSwitch.meanAri + " < 0.50 bar");
});

test("honesty: isolation trim audit on the poisoned reference", () => {
  const r = runRecheck();
  assert.equal(r.trimAudit.droppedTotal, 132);
  assert.equal(r.trimAudit.botTotal, 110);
  assert.equal(r.trimAudit.droppedBot, 94);
  assert.ok(r.trimAudit.droppedBot / r.trimAudit.droppedTotal > 0.5, "trim is not targeting bot rows");
});

test("honesty: cut equivalence with lab clusterAt and determinism of close", () => {
  const r = runRecheck();
  assert.equal(r.checked, 40);
  assert.equal(r.totalDiscordant, 0);
  assert.equal(r.determinismOk, true);
});

test("contract: no clusters before close, frozen reference after close", () => {
  let t = 5000;
  const inst = createSelfCalibratingLineageWatch({ minBootstrapMembers: 4, minBootstrapWindowMs: 1000, now: () => t });
  const members = genForest(20280101).slice(0, 4).map((l, i) => ({ id: "b" + i, traits: [...l.cfg.cat, ...l.cfg.num] }));
  for (const m of members) inst.observeBootstrap(m);
  const open = inst.evaluatePopulation(members);
  assert.equal(open.status, "bootstrap_open");
  assert.equal(open.h_b, null);
  assert.deepEqual(open.clusters, []);
  assert.equal(open.enforcement, "none");
  t += 1000;
  const close = inst.closeBootstrap();
  assert.ok(close.status === "ready" || close.status === "uncalibratable");
  assert.throws(() => inst.observeBootstrap({ id: "late", traits: members[0].traits }));
});
