"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { applyVolumeRankRule, volumeStratumOf, mixedFmrAt, selectEmpMixThreshold } = require("../dist/index.js");

function rng(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function shuffle(array, next) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}
function oracle(cells, topFrac, topFracDescriptive) {
  const sorted = cells.slice().sort((a, b) => b.score - a.score);
  const result = new Map();
  for (const cell of cells) if (!result.has(cell.identityId)) result.set(cell.identityId, { a: 0, b: 0, rare: 0 });
  sorted.forEach((cell, index) => {
    if (cell.rare) {
      const row = result.get(cell.identityId);
      row.rare++;
      if (index < Math.floor(cells.length * topFrac)) row.a++;
      if (index < Math.floor(cells.length * topFracDescriptive)) row.b++;
    }
  });
  return result;
}

test("volume seeded oracle and permutation invariance without score ties", () => {
  const next = rng(2026131301);
  for (let run = 0; run < 150; run++) {
    const count = 20 + Math.floor(next() * 200);
    const cells = Array.from({ length: count }, (_, i) => ({ identityId: "id" + Math.floor(next() * 15), score: i + next() * 0.25, rare: next() < 0.65 }));
    const topFrac = [.05, .1, .23, 1][run % 4];
    const topFracDescriptive = [.1, .4, .63, 1][run % 4];
    const identityVolumes = Object.fromEntries(cells.map(c => [c.identityId, 100]));
    const expected = oracle(cells, topFrac, topFracDescriptive);
    const input = { cells, identityVolumes, topFrac, topFracDescriptive };
    const actual = applyVolumeRankRule(input);
    for (const [id, row] of expected) {
      const a = actual.identities[id];
      assert.equal(a.rareCellsInTop, row.a);
      assert.equal(a.rareCellsInTopDescriptive, row.b);
      assert.equal(a.rareCellCount, row.rare);
      assert.equal(a.flagged, row.a >= 2);
      assert.equal(a.flaggedDescriptive, row.b >= 2);
    }
    assert.deepEqual(applyVolumeRankRule({ ...input, cells: shuffle(cells, next) }), actual);
    assert.equal(actual.summary.MID.identities, expected.size);
    assert.equal(actual.summary.MID.flagged, [...expected.values()].filter(r => r.a >= 2).length);
    assert.equal(actual.summary.MID.flaggedDescriptive, [...expected.values()].filter(r => r.b >= 2).length);
    assert.equal(actual.cellCount, cells.length);
  }
});

test("volume stable ties keep input order at both boundaries", () => {
  const cells = Array.from({ length: 100 }, (_, i) => ({ identityId: i < 2 ? "first" : "later", score: 1, rare: true }));
  const a = applyVolumeRankRule({ cells, identityVolumes: {} });
  assert.equal(a.identities.first.rareCellsInTop, 2);
  assert.equal(a.identities.later.rareCellsInTop, 3);
  assert.equal(a.identities.later.rareCellsInTopDescriptive, 8);
});

test("volume prototype-shaped identities remain own enumerable keys", () => {
  const identityVolumes = Object.create({ inherited: 100 });
  for (const identityId of ["__proto__", "constructor", "toString", "hasOwnProperty", "inherited"]) {
    const actual = applyVolumeRankRule({ cells: [{ identityId, score: 1, rare: true }], identityVolumes, topFrac: 1 });
    assert.equal(Object.hasOwn(actual.identities, identityId), true);
    assert.deepEqual(Object.keys(actual.identities), [identityId]);
    assert.equal(Object.getPrototypeOf(actual.identities), Object.prototype);
    assert.equal(actual.identities[identityId].stratum, null);
    assert.equal(actual.identities[identityId].rareCellCount, 1);
  }
});

test("volume exact boundary, invalid numeric inputs and empty batches", () => {
  assert.equal(volumeStratumOf(63.2), "MID");
  assert.equal(volumeStratumOf(63.15), "LOW");
  assert.equal(volumeStratumOf(632.5), "MID");
  assert.equal(volumeStratumOf(632.45), "MID");
  assert.equal(volumeStratumOf(-1), null);
  for (const bad of [NaN, Infinity, -Infinity]) assert.equal(volumeStratumOf(bad), null);
  assert.equal(volumeStratumOf(0), "LOW");
  const empty = applyVolumeRankRule({ cells: [], identityVolumes: {} });
  assert.deepEqual(empty.identities, {});
  assert.equal(empty.cellCount, 0);
  for (const field of ["topFrac", "topFracDescriptive"]) {
    for (const bad of [0, -.1, 1.1, Infinity, NaN]) assert.throws(() => applyVolumeRankRule({ cells: [], identityVolumes: {}, [field]: bad }), RangeError);
  }
  for (const score of [NaN, Infinity, -Infinity]) assert.throws(() => applyVolumeRankRule({ cells: [{ identityId: "a", score, rare: true }], identityVolumes: {} }), RangeError);
  for (const identityId of ["", "a".repeat(1025), 1, null]) assert.throws(() => applyVolumeRankRule({ cells: [{ identityId, score: 1, rare: true }], identityVolumes: {} }), RangeError);
  for (const rare of [1, 0, null, "true"]) assert.throws(() => applyVolumeRankRule({ cells: [{ identityId: "a", score: 1, rare }], identityVolumes: {} }), RangeError);
  assert.throws(() => applyVolumeRankRule({ cells: [null], identityVolumes: {} }), RangeError);
});

test("volume accepts the documented resource limit and rejects one excess cell", () => {
  const cell = { identityId: "a", score: 1, rare: false };
  const result = applyVolumeRankRule({ cells: Array(100000).fill(cell), identityVolumes: {} });
  assert.equal(result.cellCount, 100000);
  assert.throws(() => applyVolumeRankRule({ cells: Array(100001).fill(cell), identityVolumes: {} }), RangeError);
});

test("EMP seeded pooled oracle, reversed grids and exact selection boundary", () => {
  const next = rng(2026131302);
  for (let run = 0; run < 150; run++) {
    const grid = shuffle([.2, .36, .4, .44, .52], next);
    const nullFmr = grid.map(() => Array.from({ length: 1 + Math.floor(next() * 8) }, () => next() * .03));
    const flatFmr = grid.map(() => Array.from({ length: 1 + Math.floor(next() * 8) }, () => next() * .03));
    const targetFmr = [.01, .02, 0, 1][run % 4];
    const expectedMix = grid.map((_, i) => {
      const values = [...nullFmr[i], ...flatFmr[i]];
      return values.reduce((a, b) => a + b, 0) / values.length;
    });
    const eligible = grid.filter((_, i) => expectedMix[i] <= targetFmr);
    const actual = selectEmpMixThreshold({ grid, nullFmr, flatFmr, targetFmr });
    assert.equal(actual.threshold, eligible.length ? Math.max(...eligible) : null);
    assert.deepEqual(actual.mixedFmr, expectedMix);
    assert.deepEqual(actual.nullMean, nullFmr.map(v => v.reduce((a, b) => a + b, 0) / v.length));
    assert.deepEqual(actual.flatMean, flatFmr.map(v => v.reduce((a, b) => a + b, 0) / v.length));
  }
  assert.equal(selectEmpMixThreshold({ grid: [.1, .2, .3], nullFmr: [[.01], [.01], [.1]], flatFmr: [[.01], [.01], [.1]] }).threshold, .2);
  assert.equal(mixedFmrAt([], [.5]), .5);
  assert.equal(mixedFmrAt([.5], []), .5);
  assert.equal(mixedFmrAt([0], [1]), .5);
  assert.equal(selectEmpMixThreshold({ grid: [.1], nullFmr: [[0]], flatFmr: [[0]], targetFmr: 0 }).threshold, .1);
  assert.equal(selectEmpMixThreshold({ grid: [.1], nullFmr: [[1]], flatFmr: [[1]], targetFmr: 1 }).threshold, .1);
});

test("EMP rejects hostile probabilities, misalignment and invalid grids", () => {
  const base = { grid: [.36], nullFmr: [[.01]], flatFmr: [[.01]] };
  for (const bad of [-1, 1.01, NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    assert.throws(() => mixedFmrAt([bad], [0]), RangeError);
    assert.throws(() => mixedFmrAt([0], [bad]), RangeError);
    assert.throws(() => selectEmpMixThreshold({ ...base, nullFmr: [[bad]] }), RangeError);
    assert.throws(() => selectEmpMixThreshold({ ...base, flatFmr: [[bad]] }), RangeError);
  }
  for (const targetFmr of [-1, 1.01, NaN, Infinity]) assert.throws(() => selectEmpMixThreshold({ ...base, targetFmr }), RangeError);
  for (const h of [NaN, Infinity, -Infinity]) assert.throws(() => selectEmpMixThreshold({ ...base, grid: [h] }), RangeError);
  assert.throws(() => selectEmpMixThreshold({ grid: [], nullFmr: [], flatFmr: [] }), RangeError);
  assert.throws(() => selectEmpMixThreshold({ ...base, nullFmr: [] }), RangeError);
  assert.throws(() => selectEmpMixThreshold({ ...base, flatFmr: [] }), RangeError);
  assert.throws(() => selectEmpMixThreshold({ ...base, nullFmr: [[]] }), RangeError);
  assert.throws(() => selectEmpMixThreshold({ ...base, flatFmr: [[]] }), RangeError);
  assert.throws(() => mixedFmrAt([], []), RangeError);
});

test("EMP resource boundaries cover component totals and all grid points", () => {
  assert.equal(mixedFmrAt(Array(100000).fill(.5), []), .5);
  assert.throws(() => mixedFmrAt(Array(100001).fill(.5), []), RangeError);
  const valid = { grid: Array(10000).fill(.36), nullFmr: Array.from({ length: 10000 }, () => [0]), flatFmr: Array.from({ length: 10000 }, () => [0]) };
  assert.equal(selectEmpMixThreshold(valid).threshold, .36);
  assert.throws(() => selectEmpMixThreshold({ grid: Array(10001).fill(.36), nullFmr: Array(10001).fill([0]), flatFmr: Array(10001).fill([0]) }), RangeError);
  assert.equal(selectEmpMixThreshold({ grid: [.36], nullFmr: [Array(50000).fill(0)], flatFmr: [Array(50000).fill(0)] }).threshold, .36);
  assert.throws(() => selectEmpMixThreshold({ grid: [.36], nullFmr: [Array(50000).fill(0)], flatFmr: [Array(50001).fill(0)] }), RangeError);
  assert.throws(() => selectEmpMixThreshold({ grid: [.36, .4], nullFmr: [Array(25000).fill(0), Array(25000).fill(0)], flatFmr: [Array(25000).fill(0), Array(25001).fill(0)] }), RangeError);
});
