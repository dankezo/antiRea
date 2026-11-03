/**
 * L9 — Web Bot Auth CONFORMANCE pack (PREREG-V261 amendment, landscape D1).
 *
 * Purpose: prove the shipped verifier (`createWebBotAuthVerifier`)
 * conforms to RFC 9421 as profiled by draft-ietf-webbotauth-httpsig-
 * protocol-00, using vectors constructed INDEPENDENTLY in this file:
 *
 *  - Key material is the RFC 9421 Appendix B.1.4 Ed25519 test key
 *    (public AND private halves are published specification test keys;
 *    `x`/`d` below are copied from the RFC / the vendored Cloudflare
 *    fixture which carries the same key — never a production key).
 *  - Every signature base is assembled HERE from literal component
 *    lines following RFC 9421 §2.5 serialization (component identifier
 *    in double quotes, `: ` separator, lines joined by `\n`, final
 *    `"@signature-params"` line carrying the raw inner-list + params).
 *    No vendor example signature blob is copied, and no module
 *    internals are used to build or check a base. Each valid vector is
 *    ALSO asserted cryptographically sound with raw `node:crypto`
 *    over the hand-built base, so "vector is wrong" and "verifier is
 *    wrong" are always distinguishable.
 *  - Motivation (landscape D1): an independent 2026-10-26 analysis
 *    rebuilt the signature bases from Visa TAP's and Mastercard Agent
 *    Pay's published examples and found none of them verify — both
 *    reuse a test vector signing a DIFFERENT message than the one
 *    presented, and both ship 60-minute validity windows against their
 *    own 8-minute rule. Those two failure shapes are therefore
 *    REQUIRED vector classes here (I1 and I5).
 *
 * Registered bar: every VALID vector verifies; every INVALID vector is
 * rejected with its named reason; false-accept budget is EXACTLY 0.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const wba = require('../dist/tier2-active/web-bot-auth.js');

/* ------------------------------------------------------------------ */
/* RFC 9421 Appendix B.1.4 Ed25519 test key (published spec material)  */
/* ------------------------------------------------------------------ */
const RFC_PUBLIC_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',
};
const RFC_PRIVATE_JWK = {
  ...RFC_PUBLIC_JWK,
  d: 'n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU',
};
// The draft's keyid for this key: its RFC 7638 JWK SHA-256 thumbprint.
// Provenance: printed in draft-ietf-webbotauth-httpsig-protocol-00
// Appendix E.2.1 and recomputed independently in the first test below.
const RFC_KEYID = 'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U';

const privateKey = crypto.createPrivateKey({ key: RFC_PRIVATE_JWK, format: 'jwk' });
const publicKey = crypto.createPublicKey({ key: RFC_PUBLIC_JWK, format: 'jwk' });

/* ------------------------------------------------------------------ */
/* Fixed scenario (deterministic clock, draft-shaped request)          */
/* ------------------------------------------------------------------ */
const NOW = 1735689600; // 2025-01-01T00:00:00Z, the RFC/draft example epoch
const nowMs = () => NOW * 1000;
const AUTHORITY = 'example.com';
const TARGET_URI = 'https://example.com/path/to/resource';
const AGENT_URL = 'https://signature-agent.test';
const AGENT_HEADER = `agent="${AGENT_URL}"`; // dictionary form, member key "agent"

/** Independent RFC 7638 thumbprint (does not use the module under test). */
function thumbprint(jwk) {
  const json = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return crypto.createHash('sha256').update(json).digest('base64url');
}

/**
 * Independent RFC 9421 signer. `components` are component-identifier
 * strings exactly as they will appear in Signature-Input; `values` maps
 * each identifier to the component value per RFC 9421 §2.1 derivation
 * for THIS test's fixed scenario; `params` are [name, rawSfValue] pairs
 * serialized in the given order into the @signature-params line.
 */
function signIndependently({ components, values, params }) {
  const paramsRaw = `(${components.join(' ')});${params.map(([k, v]) => `${k}=${v}`).join(';')}`;
  const lines = components.map(c => `${c}: ${values[c]}`);
  lines.push(`"@signature-params": ${paramsRaw}`);
  const base = lines.join('\n');
  const signature = crypto.sign(null, Buffer.from(base, 'utf8'), privateKey);
  return { paramsRaw, base, signature };
}

/** Raw node:crypto check of a hand-built base — vector soundness proof. */
function rawVerify(base, signature) {
  return crypto.verify(null, Buffer.from(base, 'utf8'), publicKey, signature);
}

let nonceCounter = 0;
function stdParams(over = {}) {
  const merged = {
    created: String(NOW),
    keyid: `"${RFC_KEYID}"`,
    alg: '"ed25519"',
    expires: String(NOW + 300),
    nonce: `"l9-nonce-${++nonceCounter}"`,
    tag: '"web-bot-auth"',
    ...over,
  };
  return Object.entries(merged)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, v]);
}

function stdValues(over = {}) {
  return {
    '"@authority"': AUTHORITY,
    '"@method"': 'GET',
    '"@target-uri"': TARGET_URI,
    '"signature-agent"': AGENT_HEADER,
    '"signature-agent";key="agent"': `"${AGENT_URL}"`,
    ...over,
  };
}

function mockReq({ url = TARGET_URI, headers = {} } = {}) {
  const lowered = {};
  for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = v;
  return {
    url,
    method: 'GET',
    headers: { get: name => lowered[name.toLowerCase()] ?? null },
  };
}

/**
 * Build a signed request from explicit parts. Returns the request plus
 * the hand-built base/signature so tests can assert raw soundness.
 */
function buildRequest({
  components = ['"@authority"', '"signature-agent";key="agent"'],
  values = stdValues(),
  params = stdParams(),
  label = 'sig1',
  url = TARGET_URI,
  agentHeader = AGENT_HEADER,
} = {}) {
  const { paramsRaw, base, signature } = signIndependently({ components, values, params });
  const req = mockReq({
    url,
    headers: {
      'signature-agent': agentHeader,
      'signature-input': `${label}=${paramsRaw}`,
      signature: `${label}=:${signature.toString('base64')}:`,
    },
  });
  return { req, base, signature };
}

function verifier(over = {}) {
  return wba.createWebBotAuthVerifier({
    keys: { keys: [RFC_PUBLIC_JWK] },
    now: nowMs,
    ...over,
  });
}

/* ------------------------------------------------------------------ */
/* Provenance pin: the key material really is the RFC 9421 test key    */
/* ------------------------------------------------------------------ */
test('provenance: RFC 9421 B.1.4 key material — thumbprint matches the draft keyid and private half matches public half', () => {
  // Proves: the x/d pair above is the published RFC test key, and the
  // keyid used in every vector is its genuine RFC 7638 thumbprint.
  assert.equal(thumbprint(RFC_PUBLIC_JWK), RFC_KEYID);
  const derivedPublic = crypto
    .createPublicKey(privateKey)
    .export({ format: 'jwk' });
  assert.equal(derivedPublic.x, RFC_PUBLIC_JWK.x);
});

/* ------------------------------------------------------------------ */
/* VALID set — each must verify ok:true                                */
/* ------------------------------------------------------------------ */
test('V1 VALID: @authority + signature-agent;key (dictionary form), fresh nonce, 300s window — verifies', async () => {
  // Proves: the core draft profile shape, independently signed over a
  // hand-built RFC 9421 base, is accepted and binds the agent identity.
  const { req, base, signature } = buildRequest();
  assert.equal(rawVerify(base, signature), true); // vector itself is sound
  const verdict = await verifier().verify(req);
  assert.equal(verdict.verified, true, JSON.stringify(verdict));
  assert.equal(verdict.agent, AGENT_URL);
  assert.equal(verdict.agentForm, 'dictionary');
  assert.equal(verdict.keyId, RFC_KEYID);
  assert.equal(verdict.expiresAt, NOW + 300);
});

test('V2 VALID: @target-uri + whole-field signature-agent (dictionary form) — verifies', async () => {
  // Proves: the @target-uri alternative to @authority satisfies the
  // draft coverage rule, and whole-field coverage of a dictionary
  // Signature-Agent header resolves the single member as the agent.
  const { req, base, signature } = buildRequest({
    components: ['"@target-uri"', '"signature-agent"'],
  });
  assert.equal(rawVerify(base, signature), true);
  const verdict = await verifier().verify(req);
  assert.equal(verdict.verified, true, JSON.stringify(verdict));
  assert.equal(verdict.agent, AGENT_URL);
});

test('V3 VALID: @method + @authority + signature-agent;key — verifies', async () => {
  // Proves: a wider covered-component set (method bound as well)
  // reconstructs byte-for-byte and verifies.
  const { req, base, signature } = buildRequest({
    components: ['"@method"', '"@authority"', '"signature-agent";key="agent"'],
  });
  assert.equal(rawVerify(base, signature), true);
  const verdict = await verifier().verify(req);
  assert.equal(verdict.verified, true, JSON.stringify(verdict));
  assert.equal(verdict.agent, AGENT_URL);
});

/* ------------------------------------------------------------------ */
/* INVALID set — false-accept budget EXACTLY 0                         */
/* ------------------------------------------------------------------ */
test('I1a INVALID (TAP/Mastercard failure mode): signature over a DIFFERENT message — signed for example.com, presented for other.example — invalid_signature', async () => {
  // Provenance: the Visa TAP / Mastercard published-example failure —
  // the signature is genuine, but over request A's message, while
  // request B is presented. The raw asserts prove the signature IS
  // valid over A and is NOT valid over B, so rejection can only be
  // correct message binding, never a broken vector.
  const signedForA = buildRequest({
    components: ['"@authority"', '"@target-uri"', '"signature-agent";key="agent"'],
  });
  assert.equal(rawVerify(signedForA.base, signedForA.signature), true);
  const bBase = signedForA.base
    .replace('"@authority": example.com', '"@authority": other.example')
    .replace(`"@target-uri": ${TARGET_URI}`, '"@target-uri": https://other.example/path/to/resource');
  assert.equal(rawVerify(bBase, signedForA.signature), false);

  const presentedB = mockReq({
    url: 'https://other.example/path/to/resource',
    headers: {
      'signature-agent': AGENT_HEADER,
      'signature-input': signedForA.req.headers.get('signature-input'),
      signature: signedForA.req.headers.get('signature'),
    },
  });
  const verdict = await verifier().verify(presentedB);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'invalid_signature');
});

test('I1b INVALID (TAP/Mastercard failure mode): signature over a DIFFERENT message — same authority, different target path — invalid_signature', async () => {
  // Same failure class as I1a, subtler shape: authority matches, only
  // the @target-uri inside the signed message differs from the
  // presented request's path.
  const signedForA = buildRequest({
    components: ['"@authority"', '"@target-uri"', '"signature-agent";key="agent"'],
  });
  assert.equal(rawVerify(signedForA.base, signedForA.signature), true);
  const presentedB = mockReq({
    url: 'https://example.com/path/to/other-resource',
    headers: {
      'signature-agent': AGENT_HEADER,
      'signature-input': signedForA.req.headers.get('signature-input'),
      signature: signedForA.req.headers.get('signature'),
    },
  });
  const verdict = await verifier().verify(presentedB);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'invalid_signature');
});

test('I2 INVALID: tampered covered component value (signature-agent member swapped post-signing) — invalid_signature', async () => {
  // Proves: the agent identity is inside the signature base — swapping
  // the Signature-Agent member for an attacker's URL after signing
  // breaks verification instead of rebinding the identity.
  const { req } = buildRequest();
  const tampered = mockReq({
    headers: {
      'signature-agent': 'agent="https://attacker.example"',
      'signature-input': req.headers.get('signature-input'),
      signature: req.headers.get('signature'),
    },
  });
  const verdict = await verifier().verify(tampered);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'invalid_signature');
});

test('I3 INVALID: expired signature (window entirely in the past, beyond clock skew) — expired', async () => {
  // Proves: a cryptographically sound signature whose expires is past
  // is rejected on timing, not crypto.
  const { req, base, signature } = buildRequest({
    params: stdParams({ created: String(NOW - 7200), expires: String(NOW - 3600) }),
  });
  assert.equal(rawVerify(base, signature), true);
  const verdict = await verifier().verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'expired');
});

test('I4a INVALID: expires == created (empty validity window) — invalid_validity_window', async () => {
  const { req, base, signature } = buildRequest({
    params: stdParams({ created: String(NOW), expires: String(NOW) }),
  });
  assert.equal(rawVerify(base, signature), true);
  const verdict = await verifier().verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'invalid_validity_window');
});

test('I4b INVALID: expires < created (negative validity window) — invalid_validity_window', async () => {
  const { req, base, signature } = buildRequest({
    params: stdParams({ created: String(NOW + 600), expires: String(NOW + 300) }),
  });
  assert.equal(rawVerify(base, signature), true);
  const verdict = await verifier().verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'invalid_validity_window');
});

test('I5 INVALID (exact TAP shape): 60-minute validity window against a tightly configured 300s maximum — validity_window_too_long', async () => {
  // Provenance: Visa TAP / Mastercard ship 60-minute windows against
  // their own 8-minute rule. Here the host configures maxValiditySeconds
  // = 300; an otherwise valid, unexpired, correctly signed request with
  // a 3600s window must be rejected on the window alone.
  const { req, base, signature } = buildRequest({
    params: stdParams({ created: String(NOW), expires: String(NOW + 3600) }),
  });
  assert.equal(rawVerify(base, signature), true);
  const verdict = await verifier({ maxValiditySeconds: 300 }).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'validity_window_too_long');
});

test('I6 INVALID: duplicate covered components (signature itself valid over the duplicated base) — duplicate_covered_components', async () => {
  // Proves: RFC 9421 §2.5's duplicate ban is enforced as a conformance
  // gate, not waived when the crypto happens to verify.
  const { req, base, signature } = buildRequest({
    components: ['"@authority"', '"@authority"', '"signature-agent";key="agent"'],
  });
  assert.equal(rawVerify(base, signature), true);
  const verdict = await verifier().verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'duplicate_covered_components');
});

test('I7 INVALID: nonce replay — same valid request presented twice, second presentation — replay_detected', async () => {
  // Proves: the nonce store records on first successful verification
  // and the identical replay is refused even though every other check
  // (crypto, window, coverage) still passes.
  const v = verifier();
  const { req } = buildRequest();
  const first = await v.verify(req);
  assert.equal(first.verified, true, JSON.stringify(first));
  const second = await v.verify(req);
  assert.equal(second.verified, false);
  assert.equal(second.reason, 'replay_detected');
});

test('I8 INVALID: unknown keyid (signature sound, keyid names no resolved key) — unknown_key', async () => {
  // The signature is genuinely valid over a base whose @signature-params
  // claim an all-zero thumbprint-style keyid; the verifier must not fall
  // back to "any known key" — resolution is by the claimed keyid only.
  const bogusKeyid = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const { req, base, signature } = buildRequest({
    params: stdParams({ keyid: `"${bogusKeyid}"` }),
  });
  assert.equal(rawVerify(base, signature), true);
  const verdict = await verifier().verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'unknown_key');
});

test('I9a INVALID: wrong tag (signature made for another profile) — wrong_tag', async () => {
  const { req, base, signature } = buildRequest({
    params: stdParams({ tag: '"agent-pay"' }),
  });
  assert.equal(rawVerify(base, signature), true);
  const verdict = await verifier().verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'wrong_tag');
});

test('I9b INVALID: missing tag — missing_parameter', async () => {
  const { req, base, signature } = buildRequest({
    params: stdParams({ tag: undefined }),
  });
  assert.equal(rawVerify(base, signature), true);
  const verdict = await verifier().verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'missing_parameter');
});
