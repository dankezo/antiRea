const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const sdk = require('../dist/index.js');

// ABS-04: verify-endpoint limits must key on proven identity, not
// attacker-chosen values. Neighbour measurement (abs-lab
// RESULTS-ABS-STEP0): 50 successful verifies each with a FRESH
// fp_hash and FRESH request_id all returned 200 (the 40/min fp limit
// never fired); with the SAME fp_hash the limit fired at exactly 41
// (counter reads 41); with the SAME request_id at exactly 81. The
// limiter below accepts exactly one key - a proven identity (the
// server-side connection/session identity, or an issued nonce) -
// and has no parameter through which a client-chosen fingerprint
// or request id could become the bucket key.

const CONN = 'conn:198.51.100.9';

test('ABS-04: the limit fires at exactly attempt 41 for one proven key (neighbour number)', () => {
  const limiter = sdk.createStepUpVerifyAttemptLimiter({ maxAttemptsPerWindow: 40, windowMs: 60_000, now: () => 1_000_000 });
  for (let i = 1; i <= 40; i++) {
    assert.equal(limiter.attempt(CONN).allowed, true, `attempt ${i}`);
  }
  const fortyFirst = limiter.attempt(CONN);
  assert.equal(fortyFirst.allowed, false);
  assert.equal(fortyFirst.count, 41);
});

test('ABS-04: rotating attacker-chosen fp_hash / request_id values do not evade the limit', () => {
  const limiter = sdk.createStepUpVerifyAttemptLimiter({ maxAttemptsPerWindow: 40, windowMs: 60_000, now: () => 2_000_000 });
  let allowed = 0;
  // Transposes neighbour arm A: 50 verifies, each carrying a fresh
  // fp_hash and a fresh request_id. Those values are never passed to
  // the limiter - the bucket is the fixed connection identity - so
  // the rotation buys nothing: exactly 40 pass, 10 are refused.
  for (let i = 0; i < 50; i++) {
    const fpHash = `fp-${i}`; // attacker-chosen, deliberately unused as a key
    const requestId = `req-${i}`; // attacker-chosen, deliberately unused as a key
    void fpHash; void requestId;
    if (limiter.attempt(CONN).allowed) allowed++;
  }
  assert.equal(allowed, 40);
});

test('ABS-04: distinct proven identities have independent buckets', () => {
  const limiter = sdk.createStepUpVerifyAttemptLimiter({ maxAttemptsPerWindow: 2, windowMs: 60_000, now: () => 3_000_000 });
  assert.equal(limiter.attempt('conn:198.51.100.9').allowed, true);
  assert.equal(limiter.attempt('conn:198.51.100.9').allowed, true);
  assert.equal(limiter.attempt('conn:198.51.100.9').allowed, false);
  assert.equal(limiter.attempt('conn:198.51.100.10').allowed, true);
  assert.equal(limiter.attempt('nonce:issued-nonce-1').allowed, true);
});

test('ABS-04: the window slides - attempts age out on the server clock', () => {
  let now = 4_000_000;
  const limiter = sdk.createStepUpVerifyAttemptLimiter({ maxAttemptsPerWindow: 1, windowMs: 60_000, now: () => now });
  assert.equal(limiter.attempt(CONN).allowed, true);
  assert.equal(limiter.attempt(CONN).allowed, false);
  now += 60_001;
  assert.equal(limiter.attempt(CONN).allowed, true);
});

test('ABS-04: an empty or non-string proven key fails closed', () => {
  const limiter = sdk.createStepUpVerifyAttemptLimiter({ now: () => 5_000_000 });
  assert.throws(() => limiter.attempt(''), sdk.StepUpProofError);
  assert.throws(() => limiter.attempt(undefined), sdk.StepUpProofError);
});

test('ABS-04: verifier integration - RATE_LIMITED rejects before the nonce is consumed, missing key fails closed', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const cfg = 'b'.repeat(64);
  const challenge = { type: 'captcha' };
  const ch = sdk.stepUpChallengeHash(challenge);
  const limiter = sdk.createStepUpVerifyAttemptLimiter({ maxAttemptsPerWindow: 2, windowMs: 60_000, now: () => 6_000_000 });
  const consumed = [];
  const verifier = sdk.createStepUpProofVerifier({
    keys: { main: publicKey },
    consumeNonce: (nonce) => { consumed.push(nonce); return true; },
    attemptLimiter: limiter,
  });
  const issue = (nonce) => sdk.issueStepUpProof({
    privateKey, kid: 'main', identity: 'abs04-user', configHash: cfg, challengeConfig: challenge,
    nonce, issuedAtSec: 1_700_000_000, expiresAtSec: 1_700_000_600,
  });
  const ctx = (overrides = {}) => ({
    identity: 'abs04-user', expectedConfigHash: cfg, expectedChallengeHash: ch,
    nowSec: 1_700_000_060, rateLimitKey: CONN, ...overrides,
  });
  assert.equal(verifier.verifyProof(issue('n1'), ctx()).outcome, 'ACCEPT');
  assert.equal(verifier.verifyProof(issue('n2'), ctx()).outcome, 'ACCEPT');
  // Third attempt under the same proven key: limited, and its nonce
  // is NOT burned (the limiter runs before the replay step).
  assert.deepEqual(verifier.verifyProof(issue('n3'), ctx()), { outcome: 'REJECT', reason: 'RATE_LIMITED' });
  assert.deepEqual(consumed, ['n1', 'n2']);
  // No proven key presented to a limiter-configured verifier: fail closed.
  const noKeyCtx = ctx();
  delete noKeyCtx.rateLimitKey;
  assert.deepEqual(verifier.verifyProof(issue('n4'), noKeyCtx), { outcome: 'REJECT', reason: 'RATE_LIMITED' });
  assert.deepEqual(consumed, ['n1', 'n2']);
});
