const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/* Defaults used across this file (module defaults):
 * mu0 = 0.2, alpha = 0.05 (threshold 20), scaleRecords = 50,
 * designAlternative mu1* = min(1, 2*mu0) = 0.4, shrinkKappa = 20.
 * Stake rule (module header, Amendment 1):
 *   lambda_max = 0.5 / mu0 = 2.5
 *   lambda_design = (0.4 - 0.2) / (0.2 * 0.8) = 1.25
 *   lambda_floor = lambda_design / 2 = 0.625
 *   mu_hat = (S + 20 * 0.2) / (n + 20)   from PAST steps only
 *   lambda_raw = max(0, (mu_hat - 0.2) / 0.16)
 *   lambda_t = clip((1.25 + lambda_raw) / 2, 0.625, 2.5)
 *   e_t = 1 + lambda_t (x_t - 0.2),  K_t = prod e_s, K_0 = 1.
 */

const novel = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

test('evalue: hand-computed capital sequence (expected values derived from the formula)', () => {
  const tw = sdk.createEvalueTripwire();
  // Step 1: x = 25/50 = 0.5. No history: mu_hat = 0.2, raw = 0,
  // lambda = (1.25 + 0)/2 = 0.625. e = 1 + 0.625*0.3 = 1.1875. K = 1.1875.
  const d1 = tw.observe({ cohortId: 'c', identityId: 'u1', records: novel(0, 25) });
  assert.ok(approx(d1.lambda, 0.625));
  assert.ok(approx(d1.eValue, 1.1875));
  assert.ok(approx(d1.capital, 1.1875));
  // Step 2: x = 0.5 again. S = 0.5, n = 1: mu_hat = 4.5/21 = 0.2142857,
  // raw = 0.0142857/0.16 = 0.0892857, lambda = 0.6696429.
  // e = 1 + 0.6696429*0.3 = 1.2008929. K = 1.1875 * 1.2008929 = 1.4260603.
  const d2 = tw.observe({ cohortId: 'c', identityId: 'u1', records: novel(100, 25) });
  assert.ok(approx(d2.lambda, 0.6696428571428571));
  assert.ok(approx(d2.eValue, 1.2008928571428572));
  assert.ok(approx(d2.capital, 1.426060267857143));
  // Step 3: x = 0 (all repeats). S = 1.0, n = 2: mu_hat = 5/22 = 0.2272727,
  // raw = 0.1704545, lambda = 0.7102273. e = 1 - 0.7102273*0.2 = 0.8579545.
  // K = 1.4260603 * 0.8579545 = 1.2234949.
  const d3 = tw.observe({ cohortId: 'c', identityId: 'u1', records: novel(0, 25) });
  assert.equal(d3.novelRecords, 0);
  assert.ok(approx(d3.lambda, 0.7102272727272727));
  assert.ok(approx(d3.eValue, 0.8579545454545454));
  assert.ok(approx(d3.capital, 1.2234948889001624));
  // Step 4: x = 50/50 = 1. S = 1.0, n = 3: mu_hat = 5/23 = 0.2173913,
  // raw = 0.1086957, lambda = 0.6793478. e = 1 + 0.6793478*0.8 = 1.5434783.
  // K = 1.2234949 * 1.5434783 = 1.8884378.
  const d4 = tw.observe({ cohortId: 'c', identityId: 'u1', records: novel(200, 50) });
  assert.ok(approx(d4.lambda, 0.6793478260869564));
  assert.ok(approx(d4.eValue, 1.5434782608695652));
  assert.ok(approx(d4.capital, 1.8884377633024245));
  const snap = tw.getSnapshot('c');
  assert.equal(snap.steps, 4);
  assert.equal(snap.crossed, false);
  assert.equal(snap.crossedAtStep, null);
  assert.equal(snap.unionRecords, 100);
});

test('evalue: fresh cohort starts at K = 1 (first capital equals the first e-value)', () => {
  const tw = sdk.createEvalueTripwire();
  const d = tw.observe({ cohortId: 'fresh', records: novel(0, 10) });
  assert.ok(approx(d.capital, d.eValue, 1e-12));
  assert.equal(tw.getSnapshot('unknown-cohort'), null);
});

test('evalue: per-step multiplier is bounded and capital never goes negative', () => {
  const tw = sdk.createEvalueTripwire();
  // Bounds from the header: e_t in [0.5, 1 + lambda_max (1 - mu0)] = [0.5, 3].
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let base = 0;
  for (let i = 0; i < 500; i++) {
    const count = Math.floor(rnd() * 60);
    const d = tw.observe({ cohortId: 'bounded', records: novel(base, count) });
    base += 60;
    assert.ok(d.eValue >= 0.5 - 1e-12, `eValue ${d.eValue} below 0.5`);
    assert.ok(d.eValue <= 3 + 1e-12, `eValue ${d.eValue} above 3`);
    assert.ok(d.lambda >= 0.625 - 1e-12 && d.lambda <= 2.5 + 1e-12);
    assert.ok(d.capital >= 0 && Number.isFinite(d.logCapital));
    assert.ok(d.score >= 0 && d.score <= 1);
  }
});

test('evalue: crossing fires exactly at K >= 1/alpha, once, with crossedAtStep', () => {
  const crosses = [];
  const tw = sdk.createEvalueTripwire({ onCross: snap => crosses.push(snap) });
  // Independent re-derivation of the crossing step from the header
  // formula for a constant x = 1 stream (50 novel records per step).
  let S = 0, n = 0, K = 1, expectedStep = 0;
  while (K < 20) {
    const muHat = (S + 20 * 0.2) / (n + 20);
    const raw = Math.max(0, (muHat - 0.2) / 0.16);
    const lambda = Math.min(2.5, Math.max(0.625, (1.25 + raw) / 2));
    K *= 1 + lambda * 0.8;
    S += 1; n += 1; expectedStep += 1;
  }
  let prev = null;
  let crossing = null;
  for (let step = 1; step <= expectedStep; step++) {
    const d = tw.observe({ cohortId: 'atk', records: novel(step * 1000, 50) });
    if (step < expectedStep) {
      assert.equal(d.crossed, false, `crossed early at step ${step}`);
      assert.equal(d.crossedNow, false);
      assert.ok(d.capital < 20);
    } else {
      crossing = d;
    }
    prev = d;
  }
  assert.equal(crossing.crossedNow, true);
  assert.equal(crossing.crossed, true);
  assert.ok(crossing.capital >= 20);
  assert.ok(approx(crossing.capital, K, 1e-6));
  const snap = tw.getSnapshot('atk');
  assert.equal(snap.crossedAtStep, expectedStep);
  assert.equal(crosses.length, 1);
  assert.equal(crosses[0].crossedAtStep, expectedStep);
  // Further steps do not re-fire.
  tw.observe({ cohortId: 'atk', records: novel(999000, 50) });
  assert.equal(crosses.length, 1);
});

test('evalue: stake is predictable - identical histories give identical stakes, current step cannot move its own stake', () => {
  const tw = sdk.createEvalueTripwire();
  const feed = (cohort, xs) => xs.map((count, i) =>
    tw.observe({ cohortId: cohort, records: novel(i * 1000, count) }));
  const a = feed('A', [25, 25, 0]);
  const b = feed('B', [25, 25, 0]);
  assert.deepEqual(a.map(d => d.lambda), b.map(d => d.lambda));
  // Step 4: A serves a maximal step, B serves nothing. The step-4
  // stake is computed from steps 1-3 only, so it must be identical
  // even though the step-4 scores differ maximally.
  const a4 = tw.observe({ cohortId: 'A', records: novel(9000, 50) });
  const b4 = tw.observe({ cohortId: 'B', records: [] });
  assert.equal(a4.lambda, b4.lambda);
  // Step 5 stakes may now differ (history diverged) - adaptation is
  // through history only.
  const a5 = tw.observe({ cohortId: 'A', records: [] });
  const b5 = tw.observe({ cohortId: 'B', records: [] });
  assert.ok(a5.lambda > b5.lambda);
});

test('evalue: a stake that would require future data is impossible by API shape', () => {
  const tw = sdk.createEvalueTripwire();
  // Smuggled stake fields on the input are ignored: the first-step
  // stake is the internal floor regardless.
  const d = tw.observe({ cohortId: 'shape', records: novel(0, 25), lambda: 999, stake: 999, lambda_t: 999 });
  assert.ok(approx(d.lambda, 0.625));
  // The tripwire surface exposes no stake-setting method at all.
  assert.deepEqual(Object.keys(tw).sort(), ['clearCohort', 'getSnapshot', 'mergeCohorts', 'observe']);
});

test('evalue: stake floor survives a long quiet period (Amendment 1, Argon attack 4)', () => {
  const tw = sdk.createEvalueTripwire();
  for (let i = 0; i < 200; i++) tw.observe({ cohortId: 'quiet', records: [] });
  const d = tw.observe({ cohortId: 'quiet', records: novel(0, 50) });
  assert.ok(d.lambda >= 0.625 - 1e-12, `stake collapsed to ${d.lambda}`);
});

test('evalue: merge combines capitals by step-weighted average (Amendment 1)', () => {
  const tw = sdk.createEvalueTripwire();
  // Cohort A: the hand-computed sequence - 4 steps, K_A = 1.8884377633024245.
  tw.observe({ cohortId: 'A', records: novel(0, 25) });
  tw.observe({ cohortId: 'A', records: novel(100, 25) });
  tw.observe({ cohortId: 'A', records: novel(0, 25) });
  tw.observe({ cohortId: 'A', records: novel(200, 50) });
  // Cohort B: two empty steps. lambda = 0.625 both times (mu_hat at
  // or below mu0), e = 0.875 each, K_B = 0.765625, n_B = 2.
  tw.observe({ cohortId: 'B', records: [] });
  tw.observe({ cohortId: 'B', records: [] });
  const snapA = tw.getSnapshot('A');
  const snapB = tw.getSnapshot('B');
  assert.ok(approx(snapA.capital, 1.8884377633024245));
  assert.ok(approx(snapB.capital, 0.765625));
  // Weighted average from the header formula:
  // (4 * 1.8884377633024245 + 2 * 0.765625) / 6 = 1.5141668422016163.
  const merged = tw.mergeCohorts('A', 'B');
  assert.ok(approx(merged.capital, 1.5141668422016163));
  assert.equal(merged.steps, 6);
  assert.equal(tw.getSnapshot('B'), null);
  // Post-merge e-values multiply the AVERAGED capital: score sum is
  // now 2.0 over 6 steps, so the next stake is, from the formula,
  // mu_hat = 6/26 = 0.2307692, raw = 0.1923077, lambda = 0.7211538,
  // and for x = 0.5: e = 1.2163462, K = 1.5141668 * e.
  const d = tw.observe({ cohortId: 'A', records: novel(500, 25) });
  assert.ok(approx(d.lambda, 0.7211538461538461));
  assert.ok(approx(d.eValue, 1.2163461538461537));
  assert.ok(approx(d.capital, merged.capital * d.eValue, 1e-9));
});

test('evalue: merge latches a constituent crossing and rejects bad merges', () => {
  const tw = sdk.createEvalueTripwire();
  for (let step = 1; step <= 30 && !tw.getSnapshot('hot')?.crossed; step++) {
    tw.observe({ cohortId: 'hot', records: novel(step * 1000, 50) });
  }
  assert.equal(tw.getSnapshot('hot').crossed, true);
  tw.observe({ cohortId: 'cold', records: [] });
  const merged = tw.mergeCohorts('cold', 'hot');
  assert.equal(merged.crossed, true);
  assert.equal(merged.crossedAtStep, tw.getSnapshot('cold').crossedAtStep);
  assert.throws(() => tw.mergeCohorts('cold', 'cold'), /distinct/);
  assert.throws(() => tw.mergeCohorts('cold', 'nope'), /unknown source/);
  assert.throws(() => tw.mergeCohorts('nope', 'cold'), /unknown target/);
});

test('evalue: union accounting de-duplicates within and across steps; recordIds alias works', () => {
  const tw = sdk.createEvalueTripwire();
  const d1 = tw.observe({ cohortId: 'u', recordIds: [1, 1, 2, 3] });
  assert.equal(d1.servedRecords, 3);
  assert.equal(d1.novelRecords, 3);
  const d2 = tw.observe({ cohortId: 'u', records: [3, 4] });
  assert.equal(d2.novelRecords, 1);
  assert.equal(tw.getSnapshot('u').unionRecords, 4);
});

test('evalue: option validation', () => {
  assert.throws(() => sdk.createEvalueTripwire({ mu0: 0 }), /mu0/);
  assert.throws(() => sdk.createEvalueTripwire({ mu0: 1 }), /mu0/);
  assert.throws(() => sdk.createEvalueTripwire({ alpha: 0 }), /alpha/);
  assert.throws(() => sdk.createEvalueTripwire({ alpha: 1 }), /alpha/);
  assert.throws(() => sdk.createEvalueTripwire({ mu0: 0.2, designAlternative: 0.2 }), /designAlternative/);
  assert.throws(() => sdk.createEvalueTripwire({ mu0: 0.2, designAlternative: 1.5 }), /designAlternative/);
  const tw = sdk.createEvalueTripwire();
  assert.throws(() => tw.observe({ records: [1] }), /cohortId/);
});

/* ---- S1: Shiryaev-Roberts e-detector mode (PREREG-S1S3, D4) ----
 * SR recursion (module header): M_0 = 0, M_n = (1 + M_{n-1}) * e_n,
 * with the SAME e-values as product mode.
 */

test('evalue SR: hand-computed SR sequence from the recursion', () => {
  const tw = sdk.createEvalueTripwire({ detector: 'sr', srThreshold: 1000 });
  // Same stream as the product hand-computed test, so the e-values
  // are the ones derived there: e = 1.1875, 1.2008928571428572,
  // 0.8579545454545454, 1.5434782608695652.
  // M_1 = (1 + 0) * 1.1875 = 1.1875.
  const d1 = tw.observe({ cohortId: 'c', records: novel(0, 25) });
  assert.ok(approx(d1.srStatistic, 1.1875));
  // M_2 = (1 + 1.1875) * 1.2008928571428572
  //     = 2.1875 * 1.2008928571428572 = 2.626953125.
  const d2 = tw.observe({ cohortId: 'c', records: novel(100, 25) });
  assert.ok(approx(d2.srStatistic, 2.626953125));
  // M_3 = (1 + 2.626953125) * 0.8579545454545454
  //     = 3.626953125 * 0.8579545454545454 = 3.111760919744319.
  const d3 = tw.observe({ cohortId: 'c', records: novel(0, 25) });
  assert.ok(approx(d3.srStatistic, 3.111760919744319));
  // M_4 = (1 + 3.111760919744319) * 1.5434782608695652
  //     = 4.111760919744319 * 1.5434782608695652 = 6.346413593518406.
  const d4 = tw.observe({ cohortId: 'c', records: novel(200, 50) });
  assert.ok(approx(d4.srStatistic, 6.346413593518406));
  // Product capital is untouched by SR tracking (same values as the
  // product-mode hand-computed test).
  assert.ok(approx(d4.capital, 1.8884377633024245));
  const snap = tw.getSnapshot('c');
  assert.equal(snap.detector, 'sr');
  assert.equal(snap.srThreshold, 1000);
  assert.ok(approx(snap.srStatistic, 6.346413593518406));
  assert.equal(snap.srCrossed, false);
  assert.equal(snap.srCrossedAtStep, null);
  assert.equal(snap.crossed, false);
});

test('evalue SR: recursion matches the brute-force restart-sum on randomized inputs', () => {
  const tw = sdk.createEvalueTripwire({ detector: 'sr' });
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const eValues = [];
  let base = 0;
  for (let step = 1; step <= 200; step++) {
    const count = Math.floor(rnd() * 60);
    const d = tw.observe({ cohortId: 'rnd', records: novel(base, count) });
    base += 60;
    eValues.push(d.eValue);
    // Brute force: M_n = sum_{k=1..n} prod_{s=k..n} e_s, computed
    // directly from the restart-sum definition, no recursion.
    let brute = 0;
    for (let k = 0; k < eValues.length; k++) {
      let prod = 1;
      for (let s = k; s < eValues.length; s++) prod *= eValues[s];
      brute += prod;
    }
    assert.ok(approx(d.srStatistic, brute, 1e-9),
      `step ${step}: recursion ${d.srStatistic} vs brute force ${brute}`);
    assert.ok(approx(d.srLogStatistic, Math.log(brute), 1e-9));
  }
});

test('evalue SR: SR crossing is separate from the product crossing and fires once', () => {
  const srCrosses = [];
  const tw = sdk.createEvalueTripwire({
    detector: 'sr', srThreshold: 2, onSrCross: snap => srCrosses.push(snap),
  });
  // M_1 = 1.1875 < 2 (no SR cross); product K_1 = 1.1875 < 20.
  const d1 = tw.observe({ cohortId: 'c', records: novel(0, 25) });
  assert.equal(d1.srCrossed, false);
  assert.equal(d1.srCrossedNow, false);
  // M_2 = 2.626953125 >= 2: SR crosses at step 2 while the product
  // capital (1.4260603) is far below its threshold of 20.
  const d2 = tw.observe({ cohortId: 'c', records: novel(100, 25) });
  assert.equal(d2.srCrossed, true);
  assert.equal(d2.srCrossedNow, true);
  assert.equal(d2.crossed, false);
  const snap = tw.getSnapshot('c');
  assert.equal(snap.srCrossed, true);
  assert.equal(snap.srCrossedAtStep, 2);
  assert.equal(snap.crossed, false);
  assert.equal(snap.crossedAtStep, null);
  assert.equal(srCrosses.length, 1);
  assert.equal(srCrosses[0].srCrossedAtStep, 2);
  tw.observe({ cohortId: 'c', records: novel(200, 25) });
  assert.equal(srCrosses.length, 1);
});

test('evalue SR: merge takes the step-weighted average of the SR statistics', () => {
  const tw = sdk.createEvalueTripwire({ detector: 'sr' });
  // Cohort A: the hand-computed sequence - 4 steps, M_A = 6.346413593518406.
  tw.observe({ cohortId: 'A', records: novel(0, 25) });
  tw.observe({ cohortId: 'A', records: novel(100, 25) });
  tw.observe({ cohortId: 'A', records: novel(0, 25) });
  tw.observe({ cohortId: 'A', records: novel(200, 50) });
  // Cohort B: two empty steps, e = 0.875 each:
  // M_1 = 0.875, M_2 = (1 + 0.875) * 0.875 = 1.640625, n_B = 2.
  tw.observe({ cohortId: 'B', records: [] });
  tw.observe({ cohortId: 'B', records: [] });
  assert.ok(approx(tw.getSnapshot('A').srStatistic, 6.346413593518406));
  assert.ok(approx(tw.getSnapshot('B').srStatistic, 1.640625));
  // Weighted average: (4 * 6.346413593518406 + 2 * 1.640625) / 6
  // = 4.777817395678937.
  const merged = tw.mergeCohorts('A', 'B');
  assert.ok(approx(merged.srStatistic, 4.777817395678937));
  assert.equal(merged.steps, 6);
  // The product merge is unchanged alongside it.
  assert.ok(approx(merged.capital, 1.5141668422016163));
});

test('evalue SR: defaults and option validation', () => {
  const tw = sdk.createEvalueTripwire();
  tw.observe({ cohortId: 'c', records: novel(0, 10) });
  const snap = tw.getSnapshot('c');
  assert.equal(snap.detector, 'product');
  assert.equal(snap.srThreshold, 1000);
  assert.throws(() => sdk.createEvalueTripwire({ detector: 'bogus' }), /detector/);
  assert.throws(() => sdk.createEvalueTripwire({ srThreshold: 1 }), /srThreshold/);
  assert.throws(() => sdk.createEvalueTripwire({ srThreshold: 0 }), /srThreshold/);
  assert.throws(() => sdk.createEvalueTripwire({ srThreshold: NaN }), /srThreshold/);
});

/* ---- S3: calibrateMu0 (PREREG-S1S3, C4) ----
 * Index rule: 1-indexed order ceil((n + 1) * (1 - delta)) clamped
 * to [1, n] over the sorted scores; mu0 = quantile + delta, capped
 * at 1 - 1/(n + 1) with `saturated: true` when the raw bound
 * reaches 1 (EV-3: mu0 = 1 is refused by the engine).
 */

test('calibrateMu0: hand-computed order statistics on small arrays', () => {
  // Scores sorted: [0.1, 0.2, 0.3, 0.4, 0.9], n = 5.
  const scores = [0.1, 0.4, 0.2, 0.9, 0.3];
  // delta = 0.5: index = ceil(6 * 0.5) = 3 -> quantile 0.3,
  // mu0 = 0.3 + 0.5 = 0.8.
  assert.deepEqual(sdk.calibrateMu0(scores, { delta: 0.5 }),
    { mu0: 0.8, quantile: 0.3, n: 5, delta: 0.5 });
  // delta = 0.2: index = ceil(6 * 0.8) = ceil(4.8) = 5 -> quantile
  // 0.9, raw bound 0.9 + 0.2 = 1.1 >= 1: SATURATED (EV-3 fix,
  // audit 2026-11-03). The pre-fix expectation { mu0: 1 } encoded
  // the defect itself - createEvalueTripwire refuses mu0 = 1 - so
  // calibrateMu0 now caps at 1 - 1/(n + 1) and flags saturation.
  assert.deepEqual(sdk.calibrateMu0(scores, { delta: 0.2 }),
    { mu0: 1 - 1 / 6, quantile: 0.9, n: 5, delta: 0.2, saturated: true });
  // delta = 0.05: index = ceil(6 * 0.95) = ceil(5.7) = 6, clamped
  // to 5 -> quantile 0.9, mu0 = 0.9 + 0.05 = 0.95.
  const r = sdk.calibrateMu0(scores, { delta: 0.05 });
  assert.equal(r.quantile, 0.9);
  assert.ok(approx(r.mu0, 0.95, 1e-12));
  assert.equal(r.n, 5);
  // The input array is not mutated by the sort.
  assert.deepEqual(scores, [0.1, 0.4, 0.2, 0.9, 0.3]);
  // n = 9, scores 0, 0.1, ..., 0.8; delta = 0.1:
  // index = ceil(10 * 0.9) = 9 -> quantile 0.8, mu0 = 0.9.
  assert.deepEqual(
    sdk.calibrateMu0([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], { delta: 0.1 }),
    { mu0: 0.9, quantile: 0.8, n: 9, delta: 0.1 });
  // n = 1: index = ceil(2 * 0.95) = 2, clamped to 1 -> quantile is
  // the single score, mu0 = 0.42 + 0.05 = 0.47.
  const single = sdk.calibrateMu0([0.42], { delta: 0.05 });
  assert.equal(single.quantile, 0.42);
  assert.ok(approx(single.mu0, 0.47, 1e-12));
});

test('calibrateMu0: invalid inputs throw named errors', () => {
  assert.throws(() => sdk.calibrateMu0([], { delta: 0.05 }),
    (err) => err.name === 'CalibrateMu0EmptyScoresError');
  assert.throws(() => sdk.calibrateMu0([0.5], { delta: 0 }),
    (err) => err.name === 'CalibrateMu0InvalidDeltaError');
  assert.throws(() => sdk.calibrateMu0([0.5], { delta: 1 }),
    (err) => err.name === 'CalibrateMu0InvalidDeltaError');
  assert.throws(() => sdk.calibrateMu0([0.5], { delta: -0.1 }),
    (err) => err.name === 'CalibrateMu0InvalidDeltaError');
  assert.throws(() => sdk.calibrateMu0([0.5, 1.2], { delta: 0.05 }),
    (err) => err.name === 'CalibrateMu0InvalidScoreError');
  assert.throws(() => sdk.calibrateMu0([-0.1], { delta: 0.05 }),
    (err) => err.name === 'CalibrateMu0InvalidScoreError');
  assert.throws(() => sdk.calibrateMu0([NaN], { delta: 0.05 }),
    (err) => err.name === 'CalibrateMu0InvalidScoreError');
});
