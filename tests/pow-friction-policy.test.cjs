const { test } = require('node:test');
const assert = require('node:assert/strict');
// C38 POW-LADDER, identity-creation leg only. These tests encode
// the lab run's measured numbers (c38-lab/C38-RESULTS.md: hash
// rates and median solve times measured in that run on the lab
// VM) and the frozen gate from C38-DESIGN.md section 2. The
// step-up leg is KILL and is pinned as such. Browser d22/d24 were
// NOT measured (no samples completed in the shared 120 s budget);
// the tests pin them as unmeasured, with only the lab's
// rate-arithmetic extrapolations (~66 s / ~266 s) reproduced
// through the rate model.
const pow = require('../dist/tier2-active/pow-friction-policy.js');

test('measured hash rates of the lab run are the pinned constants', () => {
  assert.equal(pow.POW_NATIVE_HASH_RATE_PER_SEC, 457029);
  assert.equal(pow.POW_BROWSER_JS_HASH_RATE_PER_SEC, 63148);
  assert.equal(pow.POW_SUBTLE_CRYPTO_HASH_RATE_PER_SEC, 107143);
});

test('measured median table: native d18/d20/d22/d24 and browser d18/d20 exact; browser d22/d24 unmeasured', () => {
  assert.deepEqual(pow.POW_MEASURED_MEDIAN_SEC[18], { nativeMedianSec: 0.69, browserMedianSec: 3.66 });
  assert.deepEqual(pow.POW_MEASURED_MEDIAN_SEC[20], { nativeMedianSec: 2.45, browserMedianSec: 6.62 });
  assert.deepEqual(pow.POW_MEASURED_MEDIAN_SEC[22], { nativeMedianSec: 12.39, browserMedianSec: null });
  assert.deepEqual(pow.POW_MEASURED_MEDIAN_SEC[24], { nativeMedianSec: 27.47, browserMedianSec: null });
});

test('frozen gate: d20 passes both legs on measured numbers', () => {
  const ev = pow.evaluatePowIdentityFriction(20);
  assert.equal(ev.browserMedianSec, 6.62);
  assert.equal(ev.nativeMedianSec, 2.45);
  assert.equal(ev.browserMeasured, true);
  assert.equal(ev.browserGatePass, true); // 6.62 in [2, 20]
  assert.equal(ev.nativeGatePass, true); // 2.45 >= 1
  assert.equal(ev.passLeg, true);
  assert.equal(ev.mobile, 'unmeasured');
});

test('frozen gate: d18 fails the native leg (0.69 s < 1 s) even though its browser median is in range', () => {
  const ev = pow.evaluatePowIdentityFriction(18);
  assert.equal(ev.browserGatePass, true); // 3.66 in [2, 20]
  assert.equal(ev.nativeGatePass, false);
  assert.equal(ev.passLeg, false);
});

test('unmeasured difficulties can never pass: d22/d24 browser medians are null, not extrapolated into the gate', () => {
  for (const d of [22, 24]) {
    const ev = pow.evaluatePowIdentityFriction(d);
    assert.equal(ev.browserMedianSec, null);
    assert.equal(ev.browserMeasured, false);
    assert.equal(ev.browserGatePass, false);
    assert.equal(ev.passLeg, false);
  }
  const ev19 = pow.evaluatePowIdentityFriction(19); // never in the measured table at all
  assert.equal(ev19.nativeMedianSec, null);
  assert.equal(ev19.passLeg, false);
});

test('reversed asymmetry at d20: the browser user pays ~2.70x the native attacker', () => {
  const ev = pow.evaluatePowIdentityFriction(20);
  assert.equal(ev.asymmetryDirection, 'reversed');
  assert.ok(Math.abs(ev.asymmetryRatio - 6.62 / 2.45) < 1e-12);
  assert.ok(Math.abs(ev.asymmetryRatio - 2.702) < 0.001);
  assert.ok(ev.notice.includes('GPU'));
  assert.ok(ev.notice.includes('mobile is unmeasured'));
});

test('sybil arithmetic at d20: 2.45 native core-seconds per identity, ~6.8 core-hours per 10,000', () => {
  const ev = pow.evaluatePowIdentityFriction(20);
  assert.equal(ev.nativeCoreSecPerIdentity, 2.45);
  assert.ok(Math.abs(ev.coreHoursPer10000Identities - (2.45 * 10000) / 3600) < 1e-12);
  assert.ok(Math.abs(ev.coreHoursPer10000Identities - 6.8) < 0.01);
});

test('rate model reproduces the lab extrapolations for browser d22/d24 (~66 s / ~266 s, flagged as model)', () => {
  assert.ok(Math.abs(pow.expectedPowSolveSec(22, pow.POW_BROWSER_JS_HASH_RATE_PER_SEC) - 66.4) < 0.1);
  assert.ok(Math.abs(pow.expectedPowSolveSec(24, pow.POW_BROWSER_JS_HASH_RATE_PER_SEC) - 265.7) < 0.5);
  // The model is an expectation (2^d / rate), distinct from the measured medians.
  assert.equal(pow.expectedPowSolveSec(20, pow.POW_NATIVE_HASH_RATE_PER_SEC), Math.pow(2, 20) / 457029);
  const ev = pow.evaluatePowIdentityFriction(20);
  assert.notEqual(ev.nativeExpectedSec, ev.nativeMedianSec);
});

test('the recommended policy is exactly the d20 evaluation', () => {
  assert.equal(pow.POW_IDENTITY_FRICTION_DIFFICULTY, 20);
  assert.deepEqual(pow.powIdentityFrictionPolicy(), pow.evaluatePowIdentityFriction(20));
});

test('step-up leg is KILL: no step-up difficulty exists', () => {
  const v = pow.evaluatePowStepUp();
  assert.equal(v.verdict, 'KILL');
  assert.equal(v.allowed, false);
  assert.ok(v.reason.includes('99.9%'));
  assert.ok(!('difficulty' in v));
});

test('policy surface bundles no challenge: only policy computation is exported', () => {
  const names = Object.keys(pow).sort();
  for (const banned of ['issueChallenge', 'verifySolution', 'createPowChallenge', 'solvePow']) {
    assert.ok(!names.includes(banned), banned);
  }
});

test('invalid inputs throw PowFrictionPolicyError', () => {
  assert.throws(() => pow.evaluatePowIdentityFriction(-1), pow.PowFrictionPolicyError);
  assert.throws(() => pow.evaluatePowIdentityFriction(20.5), pow.PowFrictionPolicyError);
  assert.throws(() => pow.evaluatePowIdentityFriction(65), pow.PowFrictionPolicyError);
  assert.throws(() => pow.expectedPowSolveSec(20, 0), pow.PowFrictionPolicyError);
  assert.throws(() => pow.expectedPowSolveSec(20, Number.NaN), pow.PowFrictionPolicyError);
});
