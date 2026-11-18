const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ABS-09: a verdict oracle must not leak score/tags to the
// requester. Neighbour measurement (abs-lab RESULTS-ABS-STEP0): an
// allowed request leaked score 40 plus tags in response headers; a
// block body leaked 70 plus tags; a challenge JSON leaked 75 plus
// tags; even a clean client was told its score (0) - the oracle was
// unconditional. antiRea's rule: internal evaluate() results are
// host-side telemetry; a response built for the requester carries
// only the action, a status and optionally a retry hint.
// `toPublicVerdictResponse` builds that shape from scratch (it
// copies nothing else), and `findVerdictLeaks` scans a candidate
// response for the forbidden fields.

const TAGS = ['ua_marker:python-requests', 'accept_unusual'];

test('ABS-09: public responses for the neighbour scores 40 / 70 / 75 / 0 carry no score and no tags', () => {
  for (const [score, action] of [[40, 'allow'], [70, 'block'], [75, 'challenge'], [0, 'allow']]) {
    const pub = sdk.toPublicVerdictResponse({ action, score, tags: TAGS, reasons: ['internal-note'] });
    assert.deepEqual(sdk.findVerdictLeaks(pub), [], `score ${score}`);
    const serialized = JSON.stringify(pub);
    assert.equal(serialized.includes('score'), false);
    assert.equal(serialized.includes('ua_marker'), false);
    assert.equal(pub.action, action);
  }
});

test('ABS-09: the public shape is exactly status + action (+ retryAfterSec when given)', () => {
  assert.deepEqual(
    sdk.toPublicVerdictResponse({ action: 'allow', score: 40, tags: TAGS }),
    { status: 200, action: 'allow' },
  );
  assert.deepEqual(
    sdk.toPublicVerdictResponse({ action: 'block', score: 70, tags: TAGS }),
    { status: 403, action: 'block' },
  );
  assert.deepEqual(
    sdk.toPublicVerdictResponse({ action: 'challenge', score: 75, tags: TAGS, retryAfterSec: 30 }),
    { status: 429, action: 'challenge', retryAfterSec: 30 },
  );
});

test('ABS-09: findVerdictLeaks names the neighbour leak shapes', () => {
  // Allowed-response header shape, block body shape, challenge JSON shape.
  assert.deepEqual(sdk.findVerdictLeaks({ 'x-antibot-score': '40' }).sort(), ['x-antibot-score']);
  assert.deepEqual(sdk.findVerdictLeaks({ score: 70, tags: TAGS }).sort(), ['score', 'tags']);
  assert.deepEqual(sdk.findVerdictLeaks({ error: 'challenge_required', score: 75, tags: TAGS }).sort(), ['score', 'tags']);
  assert.deepEqual(sdk.findVerdictLeaks({ nested: [{ riskScore: 12 }] }), ['riskScore']);
  assert.deepEqual(sdk.findVerdictLeaks({ error: 'not_found' }), []);
});

test('ABS-09: an invalid action fails closed instead of echoing internal state', () => {
  assert.throws(() => sdk.toPublicVerdictResponse({ action: 'whatever', score: 1 }), sdk.VerdictResponseError);
  assert.throws(() => sdk.toPublicVerdictResponse({}), sdk.VerdictResponseError);
});

test('ABS-09: shipped requester-facing shapes pass the leak scan', () => {
  // Step-up 402 responder: body and headers carry the manifest, never a score.
  const responder = sdk.createStepUp402Responder({
    priceUsd: 0.001,
    manifestUrl: 'https://example.test/x402.json',
    facilitator: 'abs09-test',
    payUrl: 'https://example.test/pay',
    appealUrl: 'https://example.test/appeal',
    continueFreeUrl: 'https://example.test/free',
  });
  const res402 = responder.respond('session-1', 'abs09');
  assert.deepEqual(sdk.findVerdictLeaks(res402.headers), []);
  assert.deepEqual(sdk.findVerdictLeaks(JSON.parse(res402.body)), []);
  // Canary trap body: a plain not_found, nothing else.
  assert.deepEqual(sdk.findVerdictLeaks({ error: 'not_found' }), []);
});
