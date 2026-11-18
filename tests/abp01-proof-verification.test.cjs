const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
// ABP-01 JS-PROOF-COOKIE-MUST-BE-VERIFIED-NOT-JUST-PRESENT: in the
// neighbour, all 3 shipped examples accepted a proof cookie by
// PRESENCE alone, and the challenge token was the constant
// 2222728016 - a forged cookie with no JS execution passed, and an
// empty-value cookie passed under the cloudflare-worker host
// semantics. antiRea already verifies (CAP-01 step-up proof: value,
// identity/config/challenge binding, expiry, single-use replay);
// this file pins that verification so a future presence-only
// shortcut fails the suite, and pins the host-definition note:
// whether an empty-value cookie counts as "present" is decided by
// the host framework, never by this SDK (express/nextjs treat an
// empty-value cookie as absent, cloudflare-worker as present).
const sdk = require('../dist/index.js');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const CFG = 'b'.repeat(64);
const CHALLENGE = { type: 'captcha', difficulty: 3 };
const CH = sdk.stepUpChallengeHash(CHALLENGE);
const NOW = 1_700_000_000;

function makeVerifier() {
  const consumed = new Set();
  return sdk.createStepUpProofVerifier({
    keys: { main: publicKey },
    consumeNonce: (nonce) => {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  });
}
function issue(overrides = {}) {
  return sdk.issueStepUpProof({
    privateKey, kid: 'main', identity: 'user-1', configHash: CFG,
    challengeConfig: CHALLENGE, nonce: 'nonce-abp01', issuedAtSec: NOW, expiresAtSec: NOW + 600,
    ...overrides,
  });
}
const ctx = (overrides = {}) => ({
  identity: 'user-1', expectedConfigHash: CFG, expectedChallengeHash: CH, nowSec: NOW + 60,
  ...overrides,
});

test('presence alone never verifies: the neighbour constant token rejects', () => {
  const verifier = makeVerifier();
  // The lab constant challenge token, presented as a cookie value.
  assert.deepEqual(verifier.verifyProof('2222728016', ctx()), { outcome: 'REJECT', reason: 'MALFORMED' });
});

test('presence alone never verifies: arbitrary and empty cookie values reject', () => {
  const verifier = makeVerifier();
  assert.deepEqual(verifier.verifyProof('anything', ctx()), { outcome: 'REJECT', reason: 'MALFORMED' });
  assert.deepEqual(verifier.verifyProof('', ctx()), { outcome: 'REJECT', reason: 'MALFORMED' });
  assert.deepEqual(verifier.verifyProof(undefined, ctx()), { outcome: 'REJECT', reason: 'MALFORMED' });
  assert.deepEqual(verifier.verifyProof(null, ctx()), { outcome: 'REJECT', reason: 'MALFORMED' });
});

test('host presence semantics differ, verification does not (empty-value split)', () => {
  // Measured lab fixture (R-ABP-1b): the same empty-value cookie is
  // ABSENT under express/nextjs parsing and PRESENT under
  // cloudflare-worker parsing. Both host readings are recorded here;
  // the SDK verifier rejects the empty value either way, which is
  // exactly why hosts must feed the verifier the VALUE, not a
  // presence flag.
  const hostPresence = {
    express: (raw) => raw !== undefined && raw !== '',
    nextjs: (raw) => raw !== undefined && raw !== '',
    cloudflareWorker: (raw) => raw !== undefined,
  };
  assert.equal(hostPresence.express(''), false);
  assert.equal(hostPresence.nextjs(''), false);
  assert.equal(hostPresence.cloudflareWorker(''), true);
  const verifier = makeVerifier();
  assert.equal(verifier.verifyProof('', ctx()).outcome, 'REJECT');
});

test('a real proof verifies on value, binding and expiry - not on presence', () => {
  const verifier = makeVerifier();
  assert.deepEqual(verifier.verifyProof(issue(), ctx()), { outcome: 'ACCEPT' });
});

test('binding is enforced: a proof for another identity, config or challenge rejects', () => {
  const verifier = makeVerifier();
  assert.deepEqual(verifier.verifyProof(issue(), ctx({ identity: 'user-2' })), { outcome: 'REJECT', reason: 'SUBJECT_MISMATCH' });
  assert.deepEqual(verifier.verifyProof(issue(), ctx({ expectedConfigHash: 'c'.repeat(64) })), { outcome: 'REJECT', reason: 'CONFIG_MISMATCH' });
  assert.deepEqual(
    verifier.verifyProof(issue(), ctx({ expectedChallengeHash: sdk.stepUpChallengeHash({ type: 'captcha', difficulty: 9 }) })),
    { outcome: 'REJECT', reason: 'CHALLENGE_MISMATCH' },
  );
});

test('expiry is enforced: an expired proof rejects even though it is present and well-formed', () => {
  const verifier = makeVerifier();
  const stale = issue({ issuedAtSec: NOW - 7200, expiresAtSec: NOW - 6600, nonce: 'nonce-stale' });
  assert.deepEqual(verifier.verifyProof(stale, ctx()), { outcome: 'REJECT', reason: 'EXPIRED' });
});

test('single use is enforced: the same proof cannot be presented twice', () => {
  const verifier = makeVerifier();
  const token = issue({ nonce: 'nonce-once' });
  assert.deepEqual(verifier.verifyProof(token, ctx()), { outcome: 'ACCEPT' });
  assert.deepEqual(verifier.verifyProof(token, ctx()), { outcome: 'REJECT', reason: 'REPLAY' });
});

test('a tampered proof value rejects BAD_SIGNATURE (the value is checked, not the slot)', () => {
  const verifier = makeVerifier();
  const [h, p, s] = issue({ nonce: 'nonce-tamper' }).split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  payload.sub = 'user-2';
  const forged = h + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + s;
  assert.deepEqual(verifier.verifyProof(forged, ctx({ identity: 'user-2' })), { outcome: 'REJECT', reason: 'BAD_SIGNATURE' });
});
