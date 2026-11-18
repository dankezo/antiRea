const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const sdk = require('../dist/index.js');

// ABS-01: a signing secret must never default to a public constant;
// a missing secret fails closed. Neighbour measurement (abs-lab
// RESULTS-ABS-STEP0): ShieldSettings() with no env secret fell back
// to the public literal "change-me-abs-secret", and a token minted
// under it verified (gates 4/4); the same token did NOT verify under
// a random 32-byte secret. antiRea ships no default secret anywhere:
// every secret-bearing surface takes the secret as a mandatory
// argument. These tests pin that, plus the new guard that rejects
// the measured public literal itself when a host pastes it in.

const PUBLIC_LITERAL = 'change-me-abs-secret';
const REAL_SECRET = 'abs01-host-secret-9f27c1d4e8b4a6f0c2d5e7a9b1c3d5e7';

test('ABS-01: the public-default guard rejects missing, empty and public-literal secrets', () => {
  for (const bad of [undefined, null, '', PUBLIC_LITERAL, 'change-me']) {
    assert.throws(() => sdk.assertSigningSecretConfigured(bad), sdk.StepUpProofError, String(bad));
  }
});

test('ABS-01: the public-default guard accepts a host-chosen secret', () => {
  assert.equal(sdk.assertSigningSecretConfigured(REAL_SECRET), REAL_SECRET);
  assert.ok(sdk.PUBLIC_DEFAULT_SIGNING_SECRETS.includes(PUBLIC_LITERAL));
});

test('ABS-01: bulk access key authority fails closed on a missing secret (existing law, pinned)', () => {
  assert.throws(() => sdk.createBulkAccessKeyAuthority({}), sdk.BulkAccessKeyError);
  assert.throws(() => sdk.createBulkAccessKeyAuthority({ secret: '' }), sdk.BulkAccessKeyError);
});

test('ABS-01: bulk access key authority rejects the measured public default literal', () => {
  assert.throws(() => sdk.createBulkAccessKeyAuthority({ secret: PUBLIC_LITERAL }), /public default/);
});

test('ABS-01: bulk access key authority works under a host-chosen secret (both directions)', () => {
  const authority = sdk.createBulkAccessKeyAuthority({ secret: REAL_SECRET, now: () => 1_700_000_000_000 });
  const issued = authority.requestKey('abs01-user', 'account', { declared: true });
  assert.equal(issued.status, 'issued');
  assert.equal(authority.presentKey('abs01-user', issued.token).accepted, true);
  // A token minted under the public literal by a DIFFERENT authority
  // instance does not verify here: the binding is the key, not a
  // vacuous verifier (the neighbour control, transposed).
  const foreign = sdk.createBulkAccessKeyAuthority({ secret: 'abs01-other-secret-0123456789abcdef', now: () => 1_700_000_000_000 });
  const foreignKey = foreign.requestKey('abs01-user', 'account', { declared: true });
  assert.equal(authority.presentKey('abs01-user', foreignKey.token).accepted, false);
});

test('ABS-01: step-up proof issuance and verification have no default key material', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const cfg = 'b'.repeat(64);
  const challenge = { type: 'captcha' };
  const ch = sdk.stepUpChallengeHash(challenge);
  const token = sdk.issueStepUpProof({
    privateKey, kid: 'main', identity: 'abs01-user', configHash: cfg, challengeConfig: challenge,
    nonce: 'abs01-nonce', issuedAtSec: 1_700_000_000, expiresAtSec: 1_700_000_600,
  });
  const ctx = { identity: 'abs01-user', expectedConfigHash: cfg, expectedChallengeHash: ch, nowSec: 1_700_000_060 };
  // No keys configured at all: fail closed as UNKNOWN_KEY, never accept.
  const noKeys = sdk.createStepUpProofVerifier({ keys: {}, consumeNonce: () => true });
  assert.deepEqual(noKeys.verifyProof(token, ctx), { outcome: 'REJECT', reason: 'UNKNOWN_KEY' });
  // Wrong key: BAD_SIGNATURE. Right key: ACCEPT. No default anywhere.
  const { publicKey: otherPublic } = generateKeyPairSync('ed25519');
  const wrong = sdk.createStepUpProofVerifier({ keys: { main: otherPublic }, consumeNonce: () => true });
  assert.deepEqual(wrong.verifyProof(token, ctx), { outcome: 'REJECT', reason: 'BAD_SIGNATURE' });
  const right = sdk.createStepUpProofVerifier({ keys: { main: publicKey }, consumeNonce: () => true });
  assert.deepEqual(right.verifyProof(token, ctx), { outcome: 'ACCEPT' });
  // Issuance without key material throws instead of falling back.
  assert.throws(() => sdk.issueStepUpProof({
    privateKey: undefined, kid: 'main', identity: 'abs01-user', configHash: cfg,
    challengeConfig: challenge, nonce: 'n', issuedAtSec: 1_700_000_000, expiresAtSec: 1_700_000_600,
  }));
});
