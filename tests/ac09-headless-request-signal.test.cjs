const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// AC-09 (PASS-LAB, component only, ac-batch1-lab): round-1 logs
// re-measured exactly (72/72 baseline + 102/102 protected browser
// requests carry HeadlessChrome); ordinary FP 0/200. Component
// only, never a standalone verdict.

const HEADLESS_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36';
const ordinaryUA = i =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.${i}.0 Safari/537.36`;

test('AC-09: the round-1 log shape re-measures exactly (72/72 and 102/102 headless)', () => {
  const baseline = Array.from({ length: 72 }, () => sdk.evaluateHeadlessRequest(HEADLESS_UA));
  const protectedLog = Array.from({ length: 102 }, () => sdk.evaluateHeadlessRequest(HEADLESS_UA));
  assert.equal(baseline.filter(r => r.present).length, 72);
  assert.equal(protectedLog.filter(r => r.present).length, 102);
});

test('AC-09: ordinary-browser false positives are 0/200', () => {
  const ordinary = Array.from({ length: 200 }, (_, i) => sdk.evaluateHeadlessRequest(ordinaryUA(i)));
  assert.equal(ordinary.filter(r => r.present).length, 0);
});

test('AC-09: the result is a component only - no verdict, no gate, standalone is false', () => {
  const result = sdk.evaluateHeadlessRequest(HEADLESS_UA);
  assert.equal(result.component, 'headless-request');
  assert.equal(result.present, true);
  assert.equal(result.standalone, false);
  assert.equal(result.enforcement, 'none');
  assert.equal('verdict' in result, false);
  assert.equal('blocked' in result, false);
  assert.equal('allowed' in result, false);
  // The only consumption shape is a composite contribution.
  assert.deepEqual(sdk.headlessComponentContribution(HEADLESS_UA), {
    name: 'headless-request',
    present: true,
  });
});

test('AC-09: request-like inputs read the user-agent header', () => {
  assert.equal(
    sdk.evaluateHeadlessRequest({ headers: { 'User-Agent': HEADLESS_UA } }).present,
    true,
  );
  assert.equal(sdk.evaluateHeadlessRequest({ headers: { get: () => null } }).present, false);
  assert.equal(sdk.evaluateHeadlessRequest('curl/8.5.0').present, false);
});
