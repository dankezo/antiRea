const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// AC-26 (PASS-LAB, ac-batch1-lab): rotation 1 clone breakage
// 0.380, suite failure 0.833; rotation 4 dips to 0.185 (a 4-name
// cycle re-synchronizes - documented in the module).

test('AC-26: the measured curve matches the lab record', () => {
  assert.deepEqual(
    sdk.AC26_ROTATION_CURVE.map(c => [c.rotation, c.cloneBreakage, c.suiteFailure, c.mappingFailures]),
    [
      [0, 0, 0, 0],
      [1, 0.38, 0.833, 0],
      [2, 0.375, 0.833, 0],
      [3, 0.395, 0.833, 0],
      [4, 0.185, 0.417, 0],
      [5, 0.39, 0.833, 0],
      [6, 0.435, 0.833, 0],
    ],
  );
});

test('AC-26: rotation 1 clears the registered gates (breakage >= 0.30, suite failure >= 0.50)', () => {
  const cell = sdk.assessRotation(1).cell;
  assert.ok(cell.cloneBreakage >= 0.3);
  assert.ok(cell.suiteFailure >= 0.5);
});

test('AC-26: rotation 4 is the dip - a 4-name cycle re-synchronizes and is flagged', () => {
  const assessment = sdk.assessRotation(4, 4);
  assert.equal(assessment.cell.cloneBreakage, 0.185);
  assert.equal(assessment.resynchronizes, true);
  assert.equal(assessment.recommendation, 'avoid-cycle-completion');
  assert.equal(sdk.assessRotation(8, 4).resynchronizes, true);
  assert.equal(sdk.assessRotation(5, 4).resynchronizes, false);
});

test('AC-26: unmeasured rotations claim nothing', () => {
  const assessment = sdk.assessRotation(12);
  assert.equal(assessment.measured, false);
  assert.equal(assessment.cell, null);
  assert.equal(assessment.recommendation, 'unmeasured');
});
