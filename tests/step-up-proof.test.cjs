const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
// CAP-01 StepUpProofShape: the lab's 19-case conformance as unit
// tests - frozen check order, binding (sub/cfg/ch), TTL law, and
// the side-effect law: consumeNonce fires exactly once per token
// that reaches the replay step, never earlier.
const sdk = require('../dist/tier2-active/step-up-proof.js');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const { publicKey: otherPublic } = generateKeyPairSync('ed25519');
const CFG = 'b'.repeat(64);
const CHALLENGE = { type: 'captcha', difficulty: 3 };
const CH = sdk.stepUpChallengeHash(CHALLENGE);
const NOW = 1_700_000_000;

function makeVerifier(consumed = new Set()) {
  let calls = 0;
  const verifier = sdk.createStepUpProofVerifier({
    keys: { main: publicKey },
    consumeNonce: (nonce) => {
      calls++;
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  });
  return { verifier, calls: () => calls };
}
function issue(overrides = {}) {
  return sdk.issueStepUpProof({
    privateKey, kid: 'main', identity: 'user-1', configHash: CFG,
    challengeConfig: CHALLENGE, nonce: 'nonce-1', issuedAtSec: NOW, expiresAtSec: NOW + 600,
    ...overrides,
  });
}
function ctx(overrides = {}) {
  return { identity: 'user-1', expectedConfigHash: CFG, expectedChallengeHash: CH, nowSec: NOW + 60, ...overrides };
}

test('a valid proof accepts and consumes its nonce exactly once', () => {
  const { verifier, calls } = makeVerifier();
  assert.deepEqual(verifier.verifyProof(issue(), ctx()), { outcome: 'ACCEPT' });
  assert.equal(calls(), 1);
});

test('replay of the same token rejects REPLAY', () => {
  const { verifier } = makeVerifier();
  const token = issue();
  assert.equal(verifier.verifyProof(token, ctx()).outcome, 'ACCEPT');
  assert.deepEqual(verifier.verifyProof(token, ctx()), { outcome: 'REJECT', reason: 'REPLAY' });
});

test('construction without a consume hook throws (single-use is part of the shape)', () => {
  assert.throws(() => sdk.createStepUpProofVerifier({ keys: { main: publicKey } }), sdk.StepUpProofError);
});

test('structure and key failures reject before any nonce is burned', () => {
  const { verifier, calls } = makeVerifier();
  assert.deepEqual(verifier.verifyProof('not-a-token', ctx()), { outcome: 'REJECT', reason: 'MALFORMED' });
  assert.deepEqual(verifier.verifyProof(42, ctx()), { outcome: 'REJECT', reason: 'MALFORMED' });
  assert.deepEqual(verifier.verifyProof(issue({ kid: 'ghost' }), ctx()), { outcome: 'REJECT', reason: 'UNKNOWN_KEY' });
  assert.equal(calls(), 0);
});

test('unknown kid with a well-formed header rejects UNKNOWN_KEY', () => {
  const { verifier, calls } = makeVerifier();
  // Re-key the header of a real token to an unknown kid.
  const token = issue();
  const [h, p, s] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  header.kid = 'unknown';
  const reheaded = Buffer.from(JSON.stringify(header)).toString('base64url') + '.' + p + '.' + s;
  assert.deepEqual(verifier.verifyProof(reheaded, ctx()), { outcome: 'REJECT', reason: 'UNKNOWN_KEY' });
  assert.equal(calls(), 0);
});

test('tampered payload or wrong key rejects BAD_SIGNATURE, nonce untouched', () => {
  const { verifier, calls } = makeVerifier();
  const token = issue();
  const [h, p, s] = token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  payload.sub = 'mallory';
  const tampered = h + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + s;
  assert.deepEqual(verifier.verifyProof(tampered, ctx()), { outcome: 'REJECT', reason: 'BAD_SIGNATURE' });
  const wrongKey = sdk.createStepUpProofVerifier({
    keys: { main: otherPublic }, consumeNonce: () => true,
  });
  assert.deepEqual(wrongKey.verifyProof(token, ctx()), { outcome: 'REJECT', reason: 'BAD_SIGNATURE' });
  assert.equal(calls(), 0);
});

test('temporal law: EXPIRED and NOT_YET_VALID with 60 s skew', () => {
  const { verifier } = makeVerifier();
  const token = issue();
  assert.deepEqual(verifier.verifyProof(token, ctx({ nowSec: NOW + 600 + 61 })), { outcome: 'REJECT', reason: 'EXPIRED' });
  assert.equal(verifier.verifyProof(token, ctx({ nowSec: NOW + 600 + 59 })).outcome, 'ACCEPT');
  const { verifier: v2 } = makeVerifier();
  assert.deepEqual(v2.verifyProof(token, ctx({ nowSec: NOW - 61 })), { outcome: 'REJECT', reason: 'NOT_YET_VALID' });
});

test('binding mismatches reject in sub, cfg, ch order', () => {
  const { verifier, calls } = makeVerifier();
  const token = issue();
  assert.deepEqual(verifier.verifyProof(token, ctx({ identity: 'user-2' })), { outcome: 'REJECT', reason: 'SUBJECT_MISMATCH' });
  assert.deepEqual(verifier.verifyProof(token, ctx({ expectedConfigHash: 'c'.repeat(64) })), { outcome: 'REJECT', reason: 'CONFIG_MISMATCH' });
  assert.deepEqual(
    verifier.verifyProof(token, ctx({ expectedChallengeHash: sdk.stepUpChallengeHash({ type: 'other' }) })),
    { outcome: 'REJECT', reason: 'CHALLENGE_MISMATCH' },
  );
  assert.equal(calls(), 0); // binding failures never reach the replay step
});

test('issue-side law: lifetime must be in (0, 3600] and config hash must be a SHA-256 hex', () => {
  assert.throws(() => issue({ expiresAtSec: NOW + 3601 }), sdk.StepUpProofError);
  assert.throws(() => issue({ expiresAtSec: NOW }), sdk.StepUpProofError);
  assert.throws(() => issue({ configHash: 'xyz' }), sdk.StepUpProofError);
  assert.throws(() => issue({ nonce: '' }), sdk.StepUpProofError);
});
