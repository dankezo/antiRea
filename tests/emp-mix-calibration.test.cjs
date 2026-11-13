"use strict";
// RECOMB-05 CONTAM-EMP (PASS-lab) - EMP-MIX: the calibration set is a
// 50/50 mix by sample count of null-permutation FMR samples and flat
// empirical FMR samples; mixed FMR at h is the pooled mean over both
// components; the selected threshold is the LARGEST grid h with mixed
// FMR <= target (default 0.01), or null when none qualifies. The first
// test reproduces the RESULTS.md table values from the lab run.
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectEmpMixThreshold, mixedFmrAt } = require("../dist/index.js");

function approx(actual, expected, tol, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    label + ": expected ~" + expected + ", got " + actual,
  );
}

test("RESULTS table example: mixed FMR and threshold 0.36 at target 0.01", () => {
  // Component means from recomb05-lab/RESULTS.md section on the h grid,
  // encoded as single-sample arrays per grid point.
  const r = selectEmpMixThreshold({
    grid: [0.36, 0.4, 0.44],
    nullFmr: [[0.0041], [0.00644], [0.00992]],
    flatFmr: [[0.01095], [0.01835], [0.02784]],
  });
  approx(r.nullMean[0], 0.0041, 1e-12, "nullMean[0]");
  approx(r.nullMean[1], 0.00644, 1e-12, "nullMean[1]");
  approx(r.nullMean[2], 0.00992, 1e-12, "nullMean[2]");
  approx(r.flatMean[0], 0.01095, 1e-12, "flatMean[0]");
  approx(r.flatMean[1], 0.01835, 1e-12, "flatMean[1]");
  approx(r.flatMean[2], 0.02784, 1e-12, "flatMean[2]");
  // Exact pooled values, and the rounded values printed in RESULTS.md.
  approx(r.mixedFmr[0], 0.007525, 1e-12, "mixedFmr[0]");
  approx(r.mixedFmr[1], 0.012395, 1e-12, "mixedFmr[1]");
  approx(r.mixedFmr[2], 0.01888, 1e-12, "mixedFmr[2]");
  approx(r.mixedFmr[0], 0.00753, 1e-4, "mixedFmr[0] vs RESULTS");
  approx(r.mixedFmr[1], 0.01239, 1e-4, "mixedFmr[1] vs RESULTS");
  assert.equal(r.threshold, 0.36);
});

test("multi-sample components: component means and pooled mix", () => {
  const r = selectEmpMixThreshold({
    grid: [0.36],
    nullFmr: [[0.002, 0.006]],
    flatFmr: [[0.01, 0.012]],
  });
  approx(r.nullMean[0], 0.004, 1e-12, "nullMean");
  approx(r.flatMean[0], 0.011, 1e-12, "flatMean");
  approx(r.mixedFmr[0], 0.0075, 1e-12, "mixedFmr");
  assert.equal(r.threshold, 0.36);
});

test("the LARGEST qualifying grid point wins", () => {
  const r = selectEmpMixThreshold({
    grid: [0.36, 0.4, 0.44],
    nullFmr: [[0.001], [0.002], [0.5]],
    flatFmr: [[0.001], [0.002], [0.5]],
    targetFmr: 0.01,
  });
  assert.equal(r.threshold, 0.4);
});

test("uncalibratable: all mixed FMR above target -> threshold null", () => {
  const r = selectEmpMixThreshold({
    grid: [0.36, 0.4, 0.44],
    nullFmr: [[0.0041], [0.00644], [0.00992]],
    flatFmr: [[0.01095], [0.01835], [0.02784]],
    targetFmr: 0.001,
  });
  assert.equal(r.threshold, null);
});

test("misalignment throws RangeError", () => {
  assert.throws(
    () => selectEmpMixThreshold({ grid: [0.36, 0.4], nullFmr: [[0.001]], flatFmr: [[0.001], [0.002]] }),
    RangeError,
  );
  assert.throws(
    () => selectEmpMixThreshold({ grid: [0.36], nullFmr: [[0.001]], flatFmr: [] }),
    RangeError,
  );
  assert.throws(
    () => selectEmpMixThreshold({ grid: [], nullFmr: [], flatFmr: [] }),
    RangeError,
  );
  assert.throws(
    () => selectEmpMixThreshold({ grid: [0.36], nullFmr: [[]], flatFmr: [[0.001]] }),
    RangeError,
  );
});

test("mixedFmrAt pools both components; empty input throws", () => {
  approx(mixedFmrAt([0.004, 0.006], [0.01, 0.012]), 0.008, 1e-12, "mixedFmrAt");
  approx(mixedFmrAt([0.0041], [0.01095]), 0.007525, 1e-12, "mixedFmrAt single");
  assert.throws(() => mixedFmrAt([], []), RangeError);
});
