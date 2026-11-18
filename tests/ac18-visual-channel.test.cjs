const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// AC-18 (PASS-LAB, ac-batch1-lab): a measured parameter, not a
// module. R at 0.7 JND = 2.886 against a 2.0 gate; D(L2) = 0.489,
// just below the modelled 0.5 convergence band - only the weaker
// statement is claimed.

test('AC-18: the JND level table matches the lab record', () => {
  assert.deepEqual(
    sdk.AC18_JND_LEVELS.map(l => [l.amplitudeJnd, l.meanDiff, l.taxRatio]),
    [
      [0, 0.169, 1],
      [0.4, 0.315, 1.859],
      [0.7, 0.489, 2.886],
      [1, 0.677, 4.001],
    ],
  );
});

test('AC-18: R at 0.7 JND clears the 2.0 gate', () => {
  const claim = sdk.visualChannelClaim();
  assert.equal(claim.amplitudeJnd, 0.7);
  assert.equal(claim.taxRatio, 2.886);
  assert.equal(claim.taxGate, 2.0);
  assert.equal(claim.taxGatePassed, true);
});

test('AC-18: only the weaker statement is claimed - D(L2) is below the convergence band', () => {
  const claim = sdk.visualChannelClaim();
  assert.equal(claim.meanDiff, 0.489);
  assert.equal(claim.convergenceBand, 0.5);
  assert.ok(claim.meanDiff < claim.convergenceBand);
  assert.equal(claim.convergenceClaimed, false);
  assert.equal(claim.statement, 'likeness ceiling lowered relative to the noise floor');
});
