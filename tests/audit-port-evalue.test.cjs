'use strict';
/*
 * Audit-port regression tests for the e-value tripwire findings
 * EV-1 / EV-2 / EV-3 (audit
 * antirea-270-pre-release-2026-11-03, REPORT.md). These tests are
 * ADDITIVE: the pre-existing tests/evalue-tripwire.test.cjs is
 * untouched and none of its assertions are restated weaker here.
 *
 * EV-1: an async onCross / onSrCross callback that rejects must
 *       be swallowed like a sync throw - 0 unhandled rejections,
 *       and the crossing decision is still returned.
 * EV-2: non-finite constructor parameters (above all
 *       scaleRecords = Infinity, which used to blind the engine
 *       silently) must be rejected at construction.
 * EV-3: calibrateMu0 must never return a mu0 that
 *       createEvalueTripwire refuses (mu0 = 1); the saturated
 *       case is capped and flagged, the ordinary case is
 *       byte-for-byte the pre-fix result.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const novel = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

// Run `fn` while counting unhandled rejections, then assert the
// count is zero. The listener is always removed afterwards so it
// cannot mask (or be blamed for) rejections from other tests.
async function assertNoUnhandledRejection(fn) {
  const rejections = [];
  const onRejection = (err) => rejections.push(String((err && err.message) || err));
  process.on('unhandledRejection', onRejection);
  try {
    const out = fn();
    await settle();
    assert.deepEqual(rejections, []);
    return out;
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }
}

/* ---- EV-1: async callback rejections are swallowed ---- */

test('audit EV-1: async onCross throw -> 0 unhandledRejection, crossing decision returned', async () => {
  const decision = await assertNoUnhandledRejection(() => {
    const tw = sdk.createEvalueTripwire({
      mu0: 0.2,
      alpha: 0.9, // threshold 1/0.9 ~ 1.11: the first hot step crosses
      onCross: async () => { throw new Error('host db down (async)'); },
    });
    return tw.observe({
      cohortId: 'ev1-cross',
      identityId: 'account:a',
      records: novel(0, 50),
    });
  });
  assert.equal(decision.crossed, true);
  assert.equal(decision.crossedNow, true);
});

test('audit EV-1: async onSrCross throw -> 0 unhandledRejection, SR crossing decision returned', async () => {
  const decisions = await assertNoUnhandledRejection(() => {
    const tw = sdk.createEvalueTripwire({
      detector: 'sr',
      srThreshold: 2,
      onSrCross: async () => { throw new Error('host db down (async, SR)'); },
    });
    // Same stream as the shipped SR test: M_1 = 1.1875 < 2,
    // M_2 = 2.626953125 >= 2, so the SR crossing is step 2.
    const d1 = tw.observe({ cohortId: 'ev1-srcross', records: novel(0, 25) });
    const d2 = tw.observe({ cohortId: 'ev1-srcross', records: novel(100, 25) });
    return [d1, d2];
  });
  assert.equal(decisions[0].srCrossed, false);
  assert.equal(decisions[1].srCrossed, true);
  assert.equal(decisions[1].srCrossedNow, true);
});

test('audit EV-1: bare thenable callback rejection (no .catch method) is swallowed', async () => {
  const decision = await assertNoUnhandledRejection(() => {
    const tw = sdk.createEvalueTripwire({
      mu0: 0.2,
      alpha: 0.9,
      // A non-Promise thenable: has .then, has no .catch.
      onCross: () => ({
        then: (_onFulfilled, onRejected) => onRejected(new Error('thenable db down')),
      }),
    });
    return tw.observe({ cohortId: 'ev1-thenable', records: novel(0, 50) });
  });
  assert.equal(decision.crossed, true);
  assert.equal(decision.crossedNow, true);
});

test('audit EV-1: sync onCross throw is still swallowed (pre-existing discipline kept)', () => {
  const tw = sdk.createEvalueTripwire({
    mu0: 0.2,
    alpha: 0.9,
    onCross: () => { throw new Error('host db down (sync)'); },
  });
  const d = tw.observe({ cohortId: 'ev1-sync', records: novel(0, 50) });
  assert.equal(d.crossed, true);
  assert.equal(d.crossedNow, true);
});

/* ---- EV-2: constructor rejects non-finite numeric options ---- */

test('audit EV-2: constructor throws for scaleRecords = Infinity and NaN', () => {
  assert.throws(() => sdk.createEvalueTripwire({ scaleRecords: Infinity }), /scaleRecords/);
  assert.throws(() => sdk.createEvalueTripwire({ scaleRecords: NaN }), /scaleRecords/);
  assert.throws(() => sdk.createEvalueTripwire({ scaleRecords: -Infinity }), /scaleRecords/);
});

test('audit EV-2: constructor throws for every other non-finite numeric option', () => {
  // shrinkKappa = Infinity is the verifier-noted variant of the
  // EV-2 root (`Infinity > 0` passed the old check). mu0, alpha
  // and designAlternative gained explicit finite checks alongside
  // it; srThreshold already had one and is locked here too.
  const badOptions = [
    [{ shrinkKappa: Infinity }, /shrinkKappa/],
    [{ shrinkKappa: NaN }, /shrinkKappa/],
    [{ mu0: Infinity }, /mu0/],
    [{ mu0: NaN }, /mu0/],
    [{ alpha: Infinity }, /alpha/],
    [{ alpha: NaN }, /alpha/],
    [{ designAlternative: Infinity }, /designAlternative/],
    [{ designAlternative: NaN }, /designAlternative/],
    [{ srThreshold: Infinity }, /srThreshold/],
    [{ srThreshold: NaN }, /srThreshold/],
  ];
  for (const [opts, pattern] of badOptions) {
    assert.throws(() => sdk.createEvalueTripwire(opts), pattern, JSON.stringify(opts));
  }
});

test('audit EV-2: finite boundary values are still accepted', () => {
  assert.doesNotThrow(() => sdk.createEvalueTripwire({ scaleRecords: 1 }));
  assert.doesNotThrow(() => sdk.createEvalueTripwire({ shrinkKappa: 0.5 }));
  const tw = sdk.createEvalueTripwire({ scaleRecords: 50, shrinkKappa: 20 });
  const d = tw.observe({ cohortId: 'ev2-ok', records: novel(0, 50) });
  assert.equal(d.score, 1); // a finite scale still scores a maximal step at 1
});

/* ---- EV-3: calibrateMu0 output is always engine-consumable ---- */

test('audit EV-3: calibrateMu0([1,1,1,1], delta 0.05) saturates, caps and feeds the engine', () => {
  const cal = sdk.calibrateMu0([1, 1, 1, 1], { delta: 0.05 });
  assert.equal(cal.quantile, 1);
  assert.equal(cal.n, 4);
  assert.equal(cal.delta, 0.05);
  // Saturation is signalled, and the capped mu0 is the conformal
  // resolution limit 1 - 1/(n + 1) = 1 - 1/5 = 0.8 for n = 4.
  assert.equal(cal.saturated, true);
  assert.ok(cal.mu0 > 0 && cal.mu0 < 1, `capped mu0 ${cal.mu0} must be in (0, 1)`);
  assert.ok(approx(cal.mu0, 1 - 1 / (4 + 1), 1e-12), `capped mu0 ${cal.mu0} != 0.8`);
  // The whole point of the fix: the result goes straight in.
  assert.doesNotThrow(() => sdk.createEvalueTripwire({ mu0: cal.mu0 }));
  const tw = sdk.createEvalueTripwire({ mu0: cal.mu0 });
  tw.observe({ cohortId: 'ev3-fed', records: novel(0, 10) });
  assert.equal(tw.getSnapshot('ev3-fed').mu0, cal.mu0);
});

test('audit EV-3: non-saturated calibration is exactly the pre-fix result', () => {
  // Hand-computed pre-fix values (same arrays as the shipped
  // test): sorted [0.1, 0.2, 0.3, 0.4, 0.9], delta 0.5 -> index 3
  // -> quantile 0.3, mu0 = 0.3 + 0.5 = 0.8, and NO extra field.
  const plain = sdk.calibrateMu0([0.1, 0.4, 0.2, 0.9, 0.3], { delta: 0.5 });
  assert.deepEqual(plain, { mu0: 0.8, quantile: 0.3, n: 5, delta: 0.5 });
  assert.equal('saturated' in plain, false);
  // delta 0.05 on the same scores: quantile 0.9, mu0 = 0.95.
  const plain2 = sdk.calibrateMu0([0.1, 0.4, 0.2, 0.9, 0.3], { delta: 0.05 });
  assert.equal(plain2.quantile, 0.9);
  assert.ok(approx(plain2.mu0, 0.95, 1e-12));
  assert.equal('saturated' in plain2, false);
  assert.doesNotThrow(() => sdk.createEvalueTripwire({ mu0: plain.mu0 }));
  assert.doesNotThrow(() => sdk.createEvalueTripwire({ mu0: plain2.mu0 }));
});
