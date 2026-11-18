const { test } = require('node:test');
const assert = require('node:assert/strict');
// ABP-05 A-PROOF-COOKIE-MUST-WORK-OVER-PLAIN-HTTP: in the neighbour,
// a Secure-only proof cookie bricked the challenge on HTTP
// deployments - hasProof stayed false across 5 HTTP cycles and the
// path degraded challenge-page -> permanent 404. antiRea form: a
// cookie-flag POLICY in the step-up surface (stepUpProofCookieHeader)
// with the tradeoff named in the result.
const sdk = require('../dist/index.js');

// Browser storage rule used by the lab: a Secure cookie is stored
// only over HTTPS.
const browserStores = (header, scheme) => !(header.includes('; Secure') && scheme === 'http');

test('HTTPS default policy: Secure is set, no warnings, cookie lands', () => {
  const res = sdk.stepUpProofCookieHeader('tok123', {});
  assert.equal(res.secure, true);
  assert.match(res.header, /; Secure$/);
  assert.match(res.header, /; HttpOnly;/);
  assert.deepEqual(res.warnings, []);
  assert.equal(browserStores(res.header, 'https'), true);
});

test('HTTP with https-only policy: cookie lands on the first cycle (no brick)', () => {
  const res = sdk.stepUpProofCookieHeader('tok123', { scheme: 'http' });
  assert.equal(res.secure, false);
  assert.ok(!res.header.includes('Secure'));
  assert.equal(browserStores(res.header, 'http'), true);
  // Across the lab's 5 HTTP cycles the header is stable and storable.
  for (let cycle = 0; cycle < 5; cycle++) {
    const again = sdk.stepUpProofCookieHeader('tok123', { scheme: 'http' });
    assert.equal(again.header, res.header);
    assert.equal(browserStores(again.header, 'http'), true);
  }
  // The tradeoff is documented in the result, not silent.
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /bearer token/);
});

test('HTTP with always policy reproduces the lab brick, and the result names it', () => {
  const res = sdk.stepUpProofCookieHeader('tok123', { scheme: 'http', securePolicy: 'always' });
  assert.equal(res.secure, true);
  assert.equal(browserStores(res.header, 'http'), false); // never lands: the brick
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /dead-ends \(ABP-05\)/);
});

test('never policy: no Secure on either scheme, warning on http', () => {
  const http = sdk.stepUpProofCookieHeader('tok123', { scheme: 'http', securePolicy: 'never' });
  assert.equal(http.secure, false);
  assert.equal(http.warnings.length, 1);
  const https = sdk.stepUpProofCookieHeader('tok123', { scheme: 'https', securePolicy: 'never' });
  assert.equal(https.secure, false);
  assert.equal(https.warnings.length, 1);
});

test('HttpOnly is not removable by any policy, and Max-Age is clamped to the proof TTL cap', () => {
  for (const securePolicy of ['https-only', 'always', 'never']) {
    const res = sdk.stepUpProofCookieHeader('tok123', { securePolicy, maxAgeSec: 999_999 });
    assert.match(res.header, /; HttpOnly;/);
    assert.match(res.header, new RegExp('Max-Age=' + sdk.STEP_UP_PROOF_MAX_TTL_SEC + ';'));
  }
});

test('SameSite=None without Secure is refused (browsers reject it)', () => {
  assert.throws(
    () => sdk.stepUpProofCookieHeader('tok123', { scheme: 'http', sameSite: 'None' }),
    sdk.StepUpProofError,
  );
  const ok = sdk.stepUpProofCookieHeader('tok123', { scheme: 'https', sameSite: 'None' });
  assert.match(ok.header, /SameSite=None; Secure$/);
});

test('malformed tokens and names are refused, not baked into a header', () => {
  assert.throws(() => sdk.stepUpProofCookieHeader('a; b', {}), sdk.StepUpProofError);
  assert.throws(() => sdk.stepUpProofCookieHeader('', {}), sdk.StepUpProofError);
  assert.throws(() => sdk.stepUpProofCookieHeader('tok', { name: 'bad name' }), sdk.StepUpProofError);
});

test('a real issued proof token round-trips through the cookie header', () => {
  const { generateKeyPairSync } = require('node:crypto');
  const { privateKey } = generateKeyPairSync('ed25519');
  const token = sdk.issueStepUpProof({
    privateKey, kid: 'main', identity: 'user-1', configHash: 'b'.repeat(64),
    challengeConfig: { type: 'captcha', difficulty: 3 }, nonce: 'n-abp05',
    issuedAtSec: 1_700_000_000, expiresAtSec: 1_700_000_600,
  });
  const res = sdk.stepUpProofCookieHeader(token, { scheme: 'http', maxAgeSec: 600 });
  assert.ok(res.header.startsWith('antirea_stepup_proof=' + token + ';'));
  assert.match(res.header, /Max-Age=600;/);
});
