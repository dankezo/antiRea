'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

test('no default dose exists in code: omitting dosePct throws (DEC-5)', () => {
  assert.throws(() => sdk.planCanaryInterleave(150), sdk.CanaryDoseError);
  assert.throws(() => sdk.planCanaryInterleave(150, undefined), sdk.CanaryDoseError);
});

test('dose bounds: 0 plants nothing, 25 is the cap, beyond the cap throws', () => {
  assert.equal(sdk.planCanaryInterleave(150, 0).canaryCount, 0);
  assert.equal(sdk.MAX_CANARY_DOSE_PCT, 25);
  assert.throws(() => sdk.planCanaryInterleave(150, 26), sdk.CanaryDoseError);
  assert.throws(() => sdk.planCanaryInterleave(150, -5), sdk.CanaryDoseError);
  assert.throws(() => sdk.planCanaryInterleave(150, NaN), sdk.CanaryDoseError);
  assert.throws(() => sdk.planCanaryInterleave(-1, 10), sdk.CanaryDoseError);
  assert.equal(sdk.planCanaryInterleave(160, 12.5).every, 8, 'fractional doses are legal: stride = round(100/dose)');
});

test('dose linearity pins from the trials: 10% of 150 = 15, 25% of 500 = 125', () => {
  const p10 = sdk.planCanaryInterleave(150, 10);
  assert.equal(p10.every, 10);
  assert.equal(p10.canaryCount, 15);
  assert.deepEqual(p10.positions.slice(0, 3), [9, 19, 29]);
  assert.equal(p10.positions[p10.positions.length - 1], 149);
  const p25 = sdk.planCanaryInterleave(500, 25);
  assert.equal(p25.every, 4);
  assert.equal(p25.canaryCount, 125);
  const p25small = sdk.planCanaryInterleave(150, 25);
  assert.equal(p25small.canaryCount, 37, 'floor(150/4): the trial run extracted 24.7% at a 25% dose');
});

test('interleave substitutes in place: total preserved, reals untouched elsewhere, input not mutated', () => {
  const reals = Array.from({ length: 20 }, (_, i) => ({ id: `R-${i}` }));
  const canaries = [{ id: 'C-0' }, { id: 'C-1' }];
  const out = sdk.interleaveCanaries(reals, canaries, 10);
  assert.equal(out.length, 20);
  assert.equal(out[9].id, 'C-0');
  assert.equal(out[19].id, 'C-1');
  assert.equal(out[0].id, 'R-0');
  assert.equal(out[10].id, 'R-10');
  assert.equal(reals[9].id, 'R-9', 'input untouched');
  assert.throws(() => sdk.interleaveCanaries(reals, [{ id: 'C-x' }], 10), sdk.CanaryDoseError);
});

test('per-identity tag: format, determinism, separation across identities and secrets (A4/L4)', () => {
  const tag = sdk.canaryTagForIdentity('dose-secret', 'key-A');
  assert.match(tag, /^B-[0-9a-f]{6}$/);
  assert.equal(tag, sdk.canaryTagForIdentity('dose-secret', 'key-A'), 'same identity, same tag');
  assert.notEqual(tag, sdk.canaryTagForIdentity('dose-secret', 'key-B'));
  assert.notEqual(tag, sdk.canaryTagForIdentity('other-secret', 'key-A'));
  assert.throws(() => sdk.canaryTagForIdentity('dose-secret', ''), sdk.CanaryDoseError);
});

test('tag application lands inside fields when present, else top level; verify and identify round-trip', () => {
  const withFields = sdk.applyCanaryTag({ id: 'C-1', fields: { price: 10 } }, 'dose-secret', 'key-A');
  assert.match(withFields.fields.batchCode, /^B-[0-9a-f]{6}$/);
  assert.equal(withFields.batchCode, undefined);
  const topLevel = sdk.applyCanaryTag({ id: 'C-2' }, 'dose-secret', 'key-A');
  assert.match(topLevel.batchCode, /^B-[0-9a-f]{6}$/);
  assert.equal(sdk.verifyCanaryTag(withFields, 'dose-secret', 'key-A'), true);
  assert.equal(sdk.verifyCanaryTag(withFields, 'dose-secret', 'key-B'), false);
  // identifyCanaryTag takes the observed tag string (a forensic lookup, not a detection).
  assert.equal(sdk.identifyCanaryTag(topLevel.batchCode, 'dose-secret', ['key-B', 'key-A']), 'key-A');
  assert.equal(sdk.identifyCanaryTag(topLevel.batchCode, 'dose-secret', ['key-B']), null);
  assert.equal(sdk.identifyCanaryTag('B-000000', 'dose-secret', ['key-A']), null);
});
