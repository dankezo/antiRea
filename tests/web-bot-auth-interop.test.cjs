/**
 * Interoperability tests for the Web Bot Auth verifier
 * (`src/tier2-active/web-bot-auth.ts`) against material produced by the
 * REFERENCE implementation — not by this repo's own test signer:
 *
 *  1. The official test vectors of cloudflare/web-bot-auth, vendored
 *     unmodified at `tests/fixtures/web_bot_auth_architecture_v1.json`
 *     (provenance: `tests/fixtures/README.md`).
 *  2. The Ed25519 test vector printed in Appendix E.2.1 of
 *     draft-ietf-webbotauth-httpsig-protocol-00 — the exact profile this
 *     verifier implements.
 *
 * Runtime cross-signing against the reference implementation's signer and
 * verifier (npm package `web-bot-auth`, installed OUTSIDE this repo) lives
 * in `scripts/interop-web-bot-auth.cjs` and runs in the `interop` CI
 * workflow; this file is the offline, deterministic half.
 *
 * ------------------------------------------------------------------------
 * DIVERGENCE LEDGER — read before "fixing" anything here.
 *
 * The vendored vectors were generated for the earlier
 * draft-meunier-web-bot-auth-architecture profile. This verifier implements
 * draft-ietf-webbotauth-httpsig-protocol-00. Both Ed25519 vectors carry
 * RFC 9421 signatures that are cryptographically VALID (asserted below
 * with node:crypto over hand-built signature bases, independently of the
 * verifier), and they land on opposite sides of this verifier's
 * Signature-Agent policy:
 *
 *  - sig1 covers "@authority" only and the request carries NO
 *    Signature-Agent header. -00 §5.2.1: "A signed request MUST carry the
 *    Signature-Agent header" and its member for the signature's label MUST
 *    be a covered component. Verdict here: `no_signature_agent`.
 *    This is a deliberate profile requirement of this module (its unit
 *    tests pin it); the vector simply predates it.
 *
 *  - sig2 uses the LEGACY bare-sf-string Signature-Agent form
 *    (`Signature-Agent: "https://signature-agent.test"`) with whole-field
 *    coverage. -00 §5.2.1 makes the Dictionary form mandatory for signers
 *    and says a verifier MAY accept the legacy form. Decision (Danny,
 *    2026-11-01): accept BOTH forms — the draft mandates the dictionary
 *    form, but Cloudflare's production verifier still requires the bare
 *    string and production signers send it deliberately, so a
 *    dictionary-only verifier would reject the deployed ecosystem. The
 *    legacy form is accepted as deprecated compatibility under a
 *    fail-closed guardrail (exactly one signature may cover the field;
 *    whole-field component only, no `;key` binding) and the verdict
 *    reports `agentForm: "legacy"`. The tests below pin the acceptance —
 *    and its tamper / ambiguity / `;key` edges — so the behavior cannot
 *    drift silently. Revisit when the draft becomes an RFC or Cloudflare
 *    flips its production verifier to the dictionary form.
 *
 * The draft's own Appendix E.2.1 vector (dictionary form, member coverage)
 * verifies cleanly — see the last test.
 * ------------------------------------------------------------------------
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const wba = require('../dist/tier2-active/web-bot-auth.js');

const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'web_bot_auth_architecture_v1.json'), 'utf8'),
);

/** Public half of a vector key (the vendored JWKs include the private part). */
function publicJwk(key) {
  return { kty: key.kty, crv: key.crv, x: key.x };
}

function mockReq({ url, headers = {} }) {
  const lowered = {};
  for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = v;
  return {
    url,
    method: 'GET',
    headers: { get: name => lowered[name.toLowerCase()] ?? null },
  };
}

/** Reconstruct the request exactly the way the reference test suite does. */
function requestFromVector(vector) {
  const headers = {
    'signature-input': vector.signature_input,
    signature: vector.signature,
  };
  if (vector.signature_agent !== undefined) headers['signature-agent'] = vector.signature_agent;
  return mockReq({ url: vector.target_url, headers });
}

function verifierForVector(vector) {
  // Clock pinned at the vector's `created`, mirroring the reference suite's
  // `now: new Date(vector.created_ms)`.
  return wba.createWebBotAuthVerifier({
    keys: { keys: [publicJwk(vector.key)] },
    now: () => vector.created_ms,
  });
}

/**
 * Independent RFC 9421 check: rebuild the signature base from literal lines
 * and verify with node:crypto. This separates "the reference signature is
 * cryptographically sound" from "this verifier's profile accepts it".
 */
function rawRfc9421Verify(vector, componentLines) {
  const params = vector.signature_input.slice(vector.label.length + 1); // strip "sigN="
  const base = [...componentLines, `"@signature-params": ${params}`].join('\n');
  const publicKey = crypto.createPublicKey({ key: publicJwk(vector.key), format: 'jwk' });
  const signatureBytes = Buffer.from(
    vector.signature.slice(vector.label.length + 2, -1), // strip "sigN=:" and ":"
    'base64',
  );
  return crypto.verify(null, Buffer.from(base, 'utf8'), publicKey, signatureBytes);
}

test('fixture integrity: vendored architecture-v1 file has the expected inventory', () => {
  assert.equal(vectors.length, 4);
  assert.deepEqual(
    vectors.map(v => `${v.key.kty}:${v.label}`),
    ['RSA:sig1', 'RSA:sig2', 'OKP:sig1', 'OKP:sig2'],
  );
  for (const vector of vectors) {
    assert.equal(vector.target_url, 'https://example.com/path/to/resource');
  }
});

for (const vector of vectors.filter(v => v.key.kty === 'RSA')) {
  test(
    `architecture-v1 ${vector.label} (RSA-PSS) is out of scope for this verifier`,
    { skip: 'RSA-PSS vector: src/tier2-active/web-bot-auth.ts is Ed25519-only by design (draft profile decision, see module header)' },
    () => {},
  );
}

const ed25519Sig1 = vectors.find(v => v.key.kty === 'OKP' && v.label === 'sig1');
const ed25519Sig2 = vectors.find(v => v.key.kty === 'OKP' && v.label === 'sig2');

test('DIVERGENCE (profile): architecture-v1 Ed25519 sig1 — valid RFC 9421 signature, rejected for missing Signature-Agent', async () => {
  // The reference signature itself is sound: "@authority" is the only
  // covered component, and the base below is all there is to check.
  assert.equal(rawRfc9421Verify(ed25519Sig1, ['"@authority": example.com']), true);

  // draft-ietf-webbotauth-httpsig-protocol-00 §5.2.1 requires the request to
  // carry Signature-Agent and the signature to cover its member; this
  // pre-draft vector does neither, so the profile gate fires before crypto.
  const verdict = await verifierForVector(ed25519Sig1).verify(requestFromVector(ed25519Sig1));
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'no_signature_agent');
});

test('COMPAT (legacy form): architecture-v1 Ed25519 sig2 — valid RFC 9421 signature, verified via legacy bare-string Signature-Agent acceptance', async () => {
  // Legacy whole-field form: the covered component value is the raw field
  // value (a bare sf-string), and over that base the signature is sound.
  assert.equal(
    rawRfc9421Verify(ed25519Sig2, [
      '"@authority": example.com',
      `"signature-agent": ${ed25519Sig2.signature_agent}`,
    ]),
    true,
  );

  // Dual-form acceptance (decision: Danny, 2026-11-01): the draft
  // mandates the dictionary form for signers, but Cloudflare's production
  // verifier requires this bare-string form and production signers send
  // it deliberately, so the verifier accepts it under the §5.2.1 MAY —
  // bound to the single covering signature via the whole-field component,
  // and reported on the verdict as agentForm "legacy" so operators can
  // watch remaining legacy usage.
  const verdict = await verifierForVector(ed25519Sig2).verify(requestFromVector(ed25519Sig2));
  assert.equal(verdict.verified, true);
  assert.equal(verdict.agent, 'https://signature-agent.test');
  assert.equal(verdict.agentForm, 'legacy');
  assert.equal(verdict.label, 'sig2');
  assert.equal(verdict.keyId, 'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U');
});

test('COMPAT (legacy form): tampered legacy agent URL fails as invalid_signature', async () => {
  // The agent URL is inside the signature base, so swapping the header
  // value for an attacker's URL must break Ed25519 verification — the
  // legacy acceptance never detaches identity from the signature.
  const req = mockReq({
    url: ed25519Sig2.target_url,
    headers: {
      'signature-input': ed25519Sig2.signature_input,
      signature: ed25519Sig2.signature,
      'signature-agent': '"https://attacker.example"',
    },
  });
  const verdict = await verifierForVector(ed25519Sig2).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'invalid_signature');
  assert.equal(verdict.agentForm, 'legacy');
});

test('COMPAT (legacy form): ambiguous multi-signature coverage is rejected as malformed_headers', async () => {
  // The same covering signature presented under two labels: the implicit
  // binding of a bare-string agent is ambiguous, so the guardrail keeps
  // rejecting instead of guessing which signature the agent belongs to.
  const params = ed25519Sig2.signature_input.slice(ed25519Sig2.label.length + 1); // strip "sig2="
  const sigMember = ed25519Sig2.signature.slice(ed25519Sig2.label.length + 1); // strip "sig2=", keeps ":...:"
  const req = mockReq({
    url: ed25519Sig2.target_url,
    headers: {
      'signature-agent': ed25519Sig2.signature_agent,
      'signature-input': `siga=${params}, sigb=${params}`,
      signature: `siga=${sigMember}, sigb=${sigMember}`,
    },
  });
  const verdict = await verifierForVector(ed25519Sig2).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'malformed_headers');
  assert.equal(verdict.agentForm, 'legacy');
});

test('COMPAT (legacy form): dictionary-member coverage (`;key`) over a legacy header is rejected as malformed_headers', async () => {
  // A `;key` component selects a dictionary member; a bare-string header
  // has no members, so there is nothing to bind — fail closed.
  const params = ed25519Sig2.signature_input.slice(ed25519Sig2.label.length + 1); // strip "sig2="
  const keyedParams = params.replace('"signature-agent"', '"signature-agent";key="agent"');
  assert.notEqual(keyedParams, params); // the rewrite actually happened
  const req = mockReq({
    url: ed25519Sig2.target_url,
    headers: {
      'signature-agent': ed25519Sig2.signature_agent,
      'signature-input': `sig2=${keyedParams}`,
      signature: ed25519Sig2.signature,
    },
  });
  const verdict = await verifierForVector(ed25519Sig2).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'malformed_headers');
  assert.equal(verdict.agentForm, 'legacy');
});

test('draft-ietf-webbotauth-httpsig-protocol-00 Appendix E.2.1 Ed25519 vector verifies', async () => {
  // The vector as printed in the draft. NOTE on the request authority: the
  // draft's published signature base (Appendix E.2.1) is over
  // `"@authority": example.com`; "https://signature-agent.test" is the
  // agent URL inside Signature-Agent, not the request authority. The
  // signature does not verify over any other authority (checked during
  // development: authority signature-agent.test yields invalid_signature).
  const req = mockReq({
    url: 'https://example.com/path/to/resource',
    headers: {
      'signature-agent': 'agent2="https://signature-agent.test"',
      'signature-input':
        'sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"',
      signature:
        'sig2=:RdNFx5Bj6au3YgAMQL/RzmUlZE8QZLIaXGRpw985hWnwPfMxT228NMk6ehRS1PSl4e8PhbNZACSanGdhEwYCCg==:',
    },
  });
  const verifier = wba.createWebBotAuthVerifier({
    // RFC 9421 Appendix B.1.4 Ed25519 test key (public half).
    keys: { keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' }] },
    now: () => 1735689600 * 1000,
    // The draft vector's validity window is ~100 years (expires 2125) so
    // the example never ages out of the spec. That is a spec artifact, not
    // a production setting: the raised cap applies to this instance only.
    maxValiditySeconds: 4_000_000_000,
  });
  const verdict = await verifier.verify(req);
  assert.equal(verdict.verified, true);
  assert.equal(verdict.agent, 'https://signature-agent.test');
  assert.equal(verdict.agentForm, 'dictionary');
  assert.equal(verdict.keyId, 'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U');
  assert.equal(verdict.label, 'sig2');
  assert.equal(verdict.expiresAt, 4889289600);
});
