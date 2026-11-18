const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const sdk = require('../dist/index.js');

// ABS-12 (conformance pin): PoW difficulty must scale with assessed
// score. Neighbour measurement (abs-lab RESULTS-ABS-STEP0): the
// challenge difficulty was 4 for a score-0 client and 4 for a
// score-75 client alike; "difficulty" occurred exactly 5 times in
// the source, none of them a score-dependent computation.
// Audit result for antiRea: NO shipped STEP-UP surface issues a PoW
// difficulty. Step-up proofs (CAP-01) verify a host-run
// challenge; the step-up 402 responder shapes a consequence; the
// bulk-access authority rations key issuance; the ABS-06 clock
// measures elapsed time and has no difficulty parameter. Difficulty
// assignment is host challenge-issuance policy (the scaling helper
// itself is registered separately as WDN-07), so the shippable
// deliverable here is the design-rule pin: these tests fail the day
// any shipped step-up surface grows a fixed, score-independent
// difficulty.
// Integration note (coordinator, 3.1.0 merge): two OTHER registered
// opt-in PoW surfaces legitimately carry difficulty exports - the
// NHS-09 hashcash (POW_DEFAULT_DIFFICULTY, a host-overridable
// default: options.difficulty ?? POW_DEFAULT_DIFFICULTY) and the
// C38 identity-friction policy (POW_IDENTITY_FRICTION_DIFFICULTY,
// the registered gate value; its evaluator accepts any difficulty).
// A third export, scalePowDifficulty, is the WDN-07 score-scaling
// helper this pin's own header points at. None of the three is a
// step-up surface and none fixes a difficulty on a host. The export
// pin below therefore names exactly those three; any NEW
// difficulty export fails the suite.

const STEP_UP_SOURCES = ['step-up-proof.ts', 'step-up-402.ts', 'bulk-access-key.ts'];

test('ABS-12: no shipped step-up source mentions a difficulty it could issue', () => {
  for (const file of STEP_UP_SOURCES) {
    const source = readFileSync(join(__dirname, '..', 'src', 'tier2-active', file), 'utf8');
    assert.equal(/difficulty/i.test(source), false, `${file} must not carry a difficulty`);
  }
});

test('ABS-12: the public SDK exports no difficulty constant or field beyond the registered PoW surfaces', () => {
  const names = Object.keys(sdk);
  assert.deepEqual(names.filter((n) => /difficulty/i.test(n)).sort(), [
    'POW_DEFAULT_DIFFICULTY',
    'POW_IDENTITY_FRICTION_DIFFICULTY',
    'scalePowDifficulty',
  ]);
});

test('ABS-12: the ABS-06 PoW clock surface is elapsed-only (issue + check, no difficulty knob)', () => {
  const clock = sdk.createServerMeasuredPowClock({ minElapsedMs: 0, maxElapsedMs: 1_000, monoNow: () => 0 });
  assert.deepEqual(Object.keys(clock).sort(), ['checkElapsed', 'issueChallenge']);
});

test('ABS-12: the step-up 402 response shape carries no difficulty field', () => {
  const responder = sdk.createStepUp402Responder({
    priceUsd: 0.001,
    manifestUrl: 'https://example.test/x402.json',
    facilitator: 'abs12-test',
    payUrl: 'https://example.test/pay',
    appealUrl: 'https://example.test/appeal',
    continueFreeUrl: 'https://example.test/free',
  });
  const res = responder.respond('session-1', 'abs12');
  assert.equal(/difficulty/i.test(res.body), false);
  assert.deepEqual(sdk.findVerdictLeaks(JSON.parse(res.body)), []);
});
