const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const sdk = require('../dist/index.js');

// ABS-08: tokens whose first field is an IP must not be parsed by
// naive colon-splitting. Neighbour measurement (abs-lab
// RESULTS-ABS-STEP0): an IPv6 "2001:db8::1" token never verifies
// under split(":", 3) - the first colon-field is just "2001" - while
// the IPv4 token round-trips and a wrong-UA control rejects.
// antiRea's shipped token modules carry binding values inside a
// signed JSON payload (base64url), never in a colon-delimited
// prefix, so an IP binding value survives verbatim. These tests pin
// that property on every shipped token surface that binds an
// identity/session/subject: cursor, cursor-v2 and step-up proof.

const IPV6 = '2001:db8::1';
const IPV6_OTHER = '2001:db8::2';
const IPV4 = '203.0.113.7';
const SECRET = 'abs08-test-secret';

test('ABS-08: cursor bound to an IPv6 session id round-trips', () => {
  const token = sdk.mintCursor(SECRET, { sessionId: IPV6, position: 5, now: 1_000_000 });
  const result = sdk.verifyCursor(SECRET, token, { sessionId: IPV6, expectedPosition: 5, now: 1_000_100 });
  assert.equal(result.ok, true);
  assert.equal(result.position, 5);
});

test('ABS-08: cursor bound to an IPv6 session id rejects under a different IPv6 id', () => {
  const token = sdk.mintCursor(SECRET, { sessionId: IPV6, position: 5, now: 1_000_000 });
  assert.deepEqual(
    sdk.verifyCursor(SECRET, token, { sessionId: IPV6_OTHER, now: 1_000_100 }),
    { ok: false, reason: 'session_mismatch' },
  );
});

test('ABS-08: cursor bound to an IPv4 session id still round-trips (control)', () => {
  const token = sdk.mintCursor(SECRET, { sessionId: IPV4, position: 7, now: 1_000_000 });
  assert.equal(sdk.verifyCursor(SECRET, token, { sessionId: IPV4, now: 1_000_100 }).ok, true);
});

test('ABS-08: cursor-v2 bound to an IPv6 subject round-trips and rejects a different IPv6 subject', () => {
  const authority = { ledgerVersion: 0, sequence: 0 };
  const token = sdk.mintCursorV2(SECRET, { subject: IPV6, scope: 's', position: 3, authority, now: 1_000_000 });
  assert.equal(
    sdk.verifyCursorV2(SECRET, token, { subject: IPV6, scope: 's', authority, now: 1_000_100 }).ok,
    true,
  );
  assert.deepEqual(
    sdk.verifyCursorV2(SECRET, token, { subject: IPV6_OTHER, scope: 's', authority, now: 1_000_100 }),
    { ok: false, reason: 'binding_mismatch' },
  );
});

test('ABS-08: step-up proof bound to an IPv6 identity accepts, and rejects under a different IPv6 identity', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const cfg = 'b'.repeat(64);
  const challenge = { type: 'captcha' };
  const ch = sdk.stepUpChallengeHash(challenge);
  const consumed = new Set();
  const verifier = sdk.createStepUpProofVerifier({
    keys: { main: publicKey },
    consumeNonce: (nonce) => {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  });
  const token = sdk.issueStepUpProof({
    privateKey, kid: 'main', identity: IPV6, configHash: cfg, challengeConfig: challenge,
    nonce: 'abs08-nonce-1', issuedAtSec: 1_700_000_000, expiresAtSec: 1_700_000_600,
  });
  assert.deepEqual(
    verifier.verifyProof(token, { identity: IPV6, expectedConfigHash: cfg, expectedChallengeHash: ch, nowSec: 1_700_000_060 }),
    { outcome: 'ACCEPT' },
  );
  const token2 = sdk.issueStepUpProof({
    privateKey, kid: 'main', identity: IPV6, configHash: cfg, challengeConfig: challenge,
    nonce: 'abs08-nonce-2', issuedAtSec: 1_700_000_000, expiresAtSec: 1_700_000_600,
  });
  assert.deepEqual(
    verifier.verifyProof(token2, { identity: IPV6_OTHER, expectedConfigHash: cfg, expectedChallengeHash: ch, nowSec: 1_700_000_060 }),
    { outcome: 'REJECT', reason: 'SUBJECT_MISMATCH' },
  );
});

test('ABS-08: the shipped token encodings contain no colon-delimited IP prefix to misparse', () => {
  // Structural pin: a cursor token is payload.signature with a
  // base64url payload; decoding it yields the full IPv6 string as
  // one JSON field value, not a colon-split fragment.
  const token = sdk.mintCursor(SECRET, { sessionId: IPV6, position: 1, now: 1_000_000 });
  const [payloadPart] = token.split('.');
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  assert.equal(payload.sid, IPV6);
});
