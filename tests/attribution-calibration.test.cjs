const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/* ------------------------- evidence attribution ------------------------ */

test('attribution: evidence is credited in full to the acting subject', () => {
  const attributor = sdk.createEvidenceAttributor();
  const result = attributor.attribute({ actor: 'account:a', amount: 2.5, ts: 1000 });
  assert.equal(result.disposition, 'credited');
  assert.equal(result.creditedToActor, 2.5);
  assert.equal(result.creditedCross, 0);
});

test('attribution: declared cross-contribution is capped per pair', () => {
  const attributor = sdk.createEvidenceAttributor({ maxCrossPerPair: 1.0, now: () => 10_000 });
  const first = attributor.attribute({ actor: 'account:a', about: 'account:b', relation: 'declared', amount: 0.7 });
  assert.equal(first.creditedCross, 0.7);
  const second = attributor.attribute({ actor: 'account:b', about: 'account:a', relation: 'declared', amount: 0.7 });
  assert.ok(Math.abs(second.creditedCross - 0.3) < 1e-9, 'the pair cap binds across both directions');
  assert.match(second.reason, /capped/);
  assert.ok(Math.abs(attributor.crossCredit('account:a', 'account:b') - 1.0) < 1e-9);
});

test('attribution: cross-credit decays with the configured half-life', () => {
  let clock = 100_000;
  const attributor = sdk.createEvidenceAttributor({
    maxCrossPerPair: 1.0, crossHalfLifeMs: 10_000, now: () => clock,
  });
  attributor.attribute({ actor: 'account:a', about: 'account:b', relation: 'declared', amount: 0.8 });
  clock += 10_000; // one half-life
  const decayed = attributor.crossCredit('account:a', 'account:b');
  assert.ok(Math.abs(decayed - 0.4) < 1e-9, `expected ~0.4 after one half-life, got ${decayed}`);
  // Decayed room frees up: a fresh 0.6 fits under the cap again.
  const fresh = attributor.attribute({ actor: 'account:a', about: 'account:b', relation: 'declared', amount: 0.6 });
  assert.equal(fresh.creditedCross, 0.6);
});

test('attribution: inferred cross-contribution is observation-only (zero enforcement credit)', () => {
  const attributor = sdk.createEvidenceAttributor();
  const result = attributor.attribute({ actor: 'account:a', about: 'account:b', relation: 'inferred', amount: 3 });
  assert.equal(result.disposition, 'observed_only');
  assert.equal(result.creditedCross, 0);
  assert.equal(result.creditedToActor, 3);
  assert.equal(attributor.crossCredit('account:a', 'account:b'), 0);
});

test('attribution: unknown relationships are quarantined to the audit log with zero credit', () => {
  const attributor = sdk.createEvidenceAttributor();
  const result = attributor.attribute({ actor: 'account:a', about: 'account:z', amount: 1.5, ts: 42 });
  assert.equal(result.disposition, 'quarantined');
  assert.equal(result.creditedCross, 0);
  const log = attributor.auditLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].disposition, 'quarantined');
  assert.equal(log[0].about, 'account:z');
});

/* ------------------------- calibration manifest ------------------------ */

const VALID_MANIFEST = {
  modelVersion: 'cusum-1',
  calibrationVersion: 'host-fit-1',
  sampleSizes: { legit: 500, attack: 120 },
  holdout: { falsePositiveRate: 0.001, falseNegativeRate: 0.2 },
  method: 'trace-fitted LLR tables, LOAFO',
  attestedBy: 'host security team',
  issuedAtMs: 1_000,
  expiresAtMs: 10_000_000,
};

test('calibration: no manifest means audit_only', () => {
  const evaluation = sdk.evaluateCalibrationManifest(null, { now: 5_000 });
  assert.equal(evaluation.tier, 'audit_only');
  assert.equal(evaluation.calibrated, false);
});

test('calibration: a complete in-date manifest meeting the floors reaches the ceiling tier', () => {
  const evaluation = sdk.evaluateCalibrationManifest(VALID_MANIFEST, { now: 5_000 });
  assert.equal(evaluation.tier, 'ceiling');
  assert.equal(evaluation.calibrated, true);
});

test('calibration: a valid manifest above the FP floor is capped at step_down', () => {
  const evaluation = sdk.evaluateCalibrationManifest(
    { ...VALID_MANIFEST, holdout: { falsePositiveRate: 0.05, falseNegativeRate: 0.2 } },
    { now: 5_000 },
  );
  assert.equal(evaluation.tier, 'step_down');
  assert.match(evaluation.reasons.join(' '), /FP rate/);
});

test('calibration: expired, inverted or unattested manifests fall back to audit_only with named defects', () => {
  const expired = sdk.evaluateCalibrationManifest(VALID_MANIFEST, { now: 20_000_000 });
  assert.equal(expired.tier, 'audit_only');
  assert.match(expired.reasons.join(' '), /expired/);
  const inverted = sdk.evaluateCalibrationManifest(
    { ...VALID_MANIFEST, issuedAtMs: 9_000, expiresAtMs: 8_000 },
    { now: 5_000 },
  );
  assert.equal(inverted.tier, 'audit_only');
  const unattested = sdk.evaluateCalibrationManifest({ ...VALID_MANIFEST, attestedBy: '' }, { now: 5_000 });
  assert.equal(unattested.tier, 'audit_only');
  assert.match(unattested.reasons.join(' '), /attester/);
});

test('calibration: the shipped default notice is the uncalibrated audit-only label', () => {
  assert.equal(sdk.UNCALIBRATED_AUDIT_ONLY_NOTICE, 'uncalibrated - audit only');
});
