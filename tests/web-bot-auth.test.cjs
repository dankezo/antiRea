const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const wba = require('../dist/tier2-active/web-bot-auth.js');

const NOW = 1_800_000_000; // fixed clock (seconds) for deterministic timing checks
const nowMs = () => NOW * 1000;
const AUTHORITY = 'api.example.test';
const AGENT_URL = 'https://agent.example';

/** Independent RFC 7638 thumbprint (does not use the module under test). */
function thumbprint(jwk) {
  const json = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return crypto.createHash('sha256').update(json).digest('base64url');
}

function makeAgent() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return { publicKey, privateKey, jwk, keyid: thumbprint(jwk) };
}

function stdParams(agent, over = {}) {
  const merged = {
    created: NOW,
    keyid: `"${agent.keyid}"`,
    alg: '"ed25519"',
    expires: NOW + 300,
    tag: '"web-bot-auth"',
    ...over,
  };
  return Object.entries(merged)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
}

function stdValues({ authority = AUTHORITY, agentUrl = AGENT_URL, memberKey = 'sig', method = 'GET', path = '/data?q=1' } = {}) {
  return {
    '"@authority"': authority,
    '"@method"': method,
    '"@target-uri"': `https://${authority}${path}`,
    '"signature-agent"': `${memberKey}="${agentUrl}"`,
    [`"signature-agent";key="${memberKey}"`]: `"${agentUrl}"`,
  };
}

/**
 * Build one RFC 9421 signature by hand: the signature base is assembled from
 * literal lines here in the test, never via module internals.
 */
function buildSignature(agent, { label = 'sig1', components, params, values }) {
  const inputValue = `(${components.join(' ')});${params.join(';')}`;
  const lines = components.map(c => `${c}: ${values[c]}`);
  lines.push(`"@signature-params": ${inputValue}`);
  const base = lines.join('\n');
  const signature = crypto.sign(null, Buffer.from(base, 'utf8'), agent.privateKey).toString('base64');
  return { inputPair: `${label}=${inputValue}`, signaturePair: `${label}=:${signature}:` };
}

function mockReq({ authority = AUTHORITY, path = '/data?q=1', method = 'GET', headers = {} } = {}) {
  const lowered = {};
  for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = v;
  return {
    url: `https://${authority}${path}`,
    method,
    headers: { get: name => lowered[name.toLowerCase()] ?? null },
  };
}

function signedRequest(agent, over = {}) {
  const components = over.components ?? ['"@authority"', '"signature-agent";key="sig"'];
  const params = over.params ?? stdParams(agent, over.paramOver);
  const values = stdValues(over);
  const built = buildSignature(agent, { components, params, values, label: over.label ?? 'sig1' });
  const headers = {
    'signature-agent': `sig="${over.agentUrl ?? AGENT_URL}"`,
    'signature-input': built.inputPair,
    signature: built.signaturePair,
    ...(over.extraHeaders ?? {}),
  };
  if (over.omitAgentHeader) delete headers['signature-agent'];
  return mockReq({ ...over, headers });
}

function verifierFor(agent, over = {}) {
  return wba.createWebBotAuthVerifier({
    keys: { keys: [agent.jwk] },
    now: nowMs,
    ...over,
  });
}

test('thumbprint helper matches an independent RFC 7638 computation', () => {
  const agent = makeAgent();
  assert.equal(wba.computeEd25519JwkThumbprint(agent.jwk), agent.keyid);
});

test('verifies a well-formed Web Bot Auth signature from a key directory', async () => {
  const agent = makeAgent();
  const verdict = await verifierFor(agent).verify(signedRequest(agent));
  assert.equal(verdict.verified, true);
  assert.equal(verdict.agent, AGENT_URL);
  assert.equal(verdict.keyId, agent.keyid);
  assert.equal(verdict.label, 'sig1');
  assert.equal(verdict.expiresAt, NOW + 300);
  assert.equal(verdict.reason, undefined);
});

test('verifies with @target-uri and @method coverage and whole-field signature-agent', async () => {
  const agent = makeAgent();
  const req = signedRequest(agent, {
    components: ['"@method"', '"@target-uri"', '"signature-agent"'],
  });
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, true);
  assert.equal(verdict.agent, AGENT_URL);
});

test('verifies against a static key map (record of keyid -> JWK)', async () => {
  const agent = makeAgent();
  const verifier = wba.createWebBotAuthVerifier({ keys: { [agent.keyid]: agent.jwk }, now: nowMs });
  const verdict = await verifier.verify(signedRequest(agent));
  assert.equal(verdict.verified, true);
});

test('verifies against a PEM static key', async () => {
  const agent = makeAgent();
  const pem = agent.publicKey.export({ format: 'pem', type: 'spki' });
  const verifier = wba.createWebBotAuthVerifier({ keys: { [agent.keyid]: pem }, now: nowMs });
  const verdict = await verifier.verify(signedRequest(agent));
  assert.equal(verdict.verified, true);
});

test('verifies via an injected resolver returning the directory JSON', async () => {
  const agent = makeAgent();
  const seen = [];
  const verifier = wba.createWebBotAuthVerifier({
    now: nowMs,
    resolveKey: async ctx => {
      seen.push(ctx);
      return { keys: [agent.jwk], purpose: 'testing' };
    },
  });
  const verdict = await verifier.verify(signedRequest(agent));
  assert.equal(verdict.verified, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].keyId, agent.keyid);
  assert.equal(seen[0].agent, AGENT_URL);
});

test('tampered covered component (@authority) fails as invalid_signature', async () => {
  const agent = makeAgent();
  const req = signedRequest(agent);
  req.url = 'https://evil.example.test/data?q=1';
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'invalid_signature');
});

test('tampered signature-agent value fails as invalid_signature', async () => {
  const agent = makeAgent();
  const req = signedRequest(agent);
  const originalHeaders = req.headers;
  assert.ok(originalHeaders.get('signature-agent').includes(AGENT_URL));
  req.headers = {
    get: name => (name.toLowerCase() === 'signature-agent' ? 'sig="https://impostor.example"' : originalHeaders.get(name)),
  };
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'invalid_signature');
});

test('wrong key registered under the claimed keyid fails as invalid_signature', async () => {
  const agent = makeAgent();
  const attacker = makeAgent();
  const verifier = wba.createWebBotAuthVerifier({ keys: { [agent.keyid]: attacker.jwk }, now: nowMs });
  const verdict = await verifier.verify(signedRequest(agent));
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'invalid_signature');
});

test('unknown keyid fails as unknown_key', async () => {
  const agent = makeAgent();
  const verifier = wba.createWebBotAuthVerifier({ keys: { keys: [] }, now: nowMs });
  const verdict = await verifier.verify(signedRequest(agent));
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'unknown_key');
});

test('expired signature fails as expired', async () => {
  const agent = makeAgent();
  const req = signedRequest(agent, { paramOver: { created: NOW - 1000, expires: NOW - 500 } });
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'expired');
});

test('not-yet-valid signature fails as not_yet_valid', async () => {
  const agent = makeAgent();
  const req = signedRequest(agent, { paramOver: { created: NOW + 3600, expires: NOW + 3900 } });
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'not_yet_valid');
});

test('validity window beyond the cap fails as validity_window_too_long', async () => {
  const agent = makeAgent();
  const req = signedRequest(agent, { paramOver: { created: NOW, expires: NOW + 90_000 } });
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'validity_window_too_long');
});

test('replayed nonce fails as replay_detected on second use', async () => {
  const agent = makeAgent();
  const verifier = verifierFor(agent);
  const req = signedRequest(agent, { paramOver: { nonce: '"replay-me-once"' } });
  const first = await verifier.verify(req);
  assert.equal(first.verified, true);
  const second = await verifier.verify(req);
  assert.equal(second.verified, false);
  assert.equal(second.reason, 'replay_detected');
});

test('distinct nonces both verify', async () => {
  const agent = makeAgent();
  const verifier = verifierFor(agent);
  const a = await verifier.verify(signedRequest(agent, { paramOver: { nonce: '"nonce-a"' } }));
  const b = await verifier.verify(signedRequest(agent, { paramOver: { nonce: '"nonce-b"' } }));
  assert.equal(a.verified, true);
  assert.equal(b.verified, true);
});

test('requireNonce rejects a signature without a nonce', async () => {
  const agent = makeAgent();
  const verifier = verifierFor(agent, { requireNonce: true });
  const verdict = await verifier.verify(signedRequest(agent));
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'missing_parameter');
});

test('missing signature headers fail as no_signature_headers', async () => {
  const agent = makeAgent();
  const verdict = await verifierFor(agent).verify(mockReq({ headers: {} }));
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'no_signature_headers');
});

test('missing Signature-Agent header fails as no_signature_agent', async () => {
  const agent = makeAgent();
  const req = signedRequest(agent, { omitAgentHeader: true });
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'no_signature_agent');
});

test('malformed Signature-Input fails as malformed_headers', async () => {
  const agent = makeAgent();
  const req = mockReq({
    headers: {
      'signature-agent': `sig="${AGENT_URL}"`,
      'signature-input': 'sig1=%%%',
      signature: 'sig1=:AAAA:',
    },
  });
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'malformed_headers');
});

test('wrong tag fails as wrong_tag', async () => {
  const agent = makeAgent();
  const req = signedRequest(agent, { paramOver: { tag: '"some-other-profile"' } });
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'wrong_tag');
});

test('missing expires fails as missing_parameter', async () => {
  const agent = makeAgent();
  const req = signedRequest(agent, { paramOver: { expires: undefined } });
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'missing_parameter');
});

test('non-ed25519 alg fails as unsupported_algorithm', async () => {
  const agent = makeAgent();
  const req = signedRequest(agent, { paramOver: { alg: '"rsa-v1_5-sha256"' } });
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'unsupported_algorithm');
});

test('coverage without signature-agent fails as insufficient_coverage', async () => {
  const agent = makeAgent();
  const req = signedRequest(agent, { components: ['"@authority"', '"@method"'] });
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'insufficient_coverage');
});

test('coverage without @authority or @target-uri fails as insufficient_coverage', async () => {
  const agent = makeAgent();
  const req = signedRequest(agent, { components: ['"signature-agent";key="sig"', '"@method"'] });
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'insufficient_coverage');
});

test('a valid web-bot-auth label is found among other signature labels', async () => {
  const agent = makeAgent();
  const values = stdValues({});
  const bad = buildSignature(agent, {
    label: 'bad',
    components: ['"@authority"'],
    params: stdParams(agent, { tag: '"other-profile"' }),
    values,
  });
  const good = buildSignature(agent, {
    label: 'good',
    components: ['"@authority"', '"signature-agent";key="sig"'],
    params: stdParams(agent),
    values,
  });
  const req = mockReq({
    headers: {
      'signature-agent': `sig="${AGENT_URL}"`,
      'signature-input': `${bad.inputPair}, ${good.inputPair}`,
      signature: `${bad.signaturePair}, ${good.signaturePair}`,
    },
  });
  const verdict = await verifierFor(agent).verify(req);
  assert.equal(verdict.verified, true);
  assert.equal(verdict.label, 'good');
});

test('resolver throwing fails as key_resolution_failed', async () => {
  const agent = makeAgent();
  const verifier = wba.createWebBotAuthVerifier({
    now: nowMs,
    resolveKey: async () => {
      throw new Error('directory fetch failed');
    },
  });
  const verdict = await verifier.verify(signedRequest(agent));
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'key_resolution_failed');
});

test('expired directory key fails as unknown_key', async () => {
  const agent = makeAgent();
  const directory = { keys: [{ ...agent.jwk, exp: NOW - 3600 }] };
  const verifier = wba.createWebBotAuthVerifier({ keys: directory, now: nowMs });
  const verdict = await verifier.verify(signedRequest(agent));
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'unknown_key');
});

test('onVerdict sink receives verdicts and its errors are swallowed', async () => {
  const agent = makeAgent();
  const seen = [];
  const verifier = verifierFor(agent, {
    onVerdict: v => {
      seen.push(v.verified);
      throw new Error('sink down');
    },
  });
  const verdict = await verifier.verify(signedRequest(agent));
  assert.equal(verdict.verified, true);
  assert.deepEqual(seen, [true]);
});

/* ------------------------- directory parsing ------------------------- */

test('parseWebBotAuthDirectory accepts a JWK Set object', () => {
  const agent = makeAgent();
  const parsed = wba.parseWebBotAuthDirectory({ keys: [agent.jwk], purpose: 'testing' });
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.purpose, 'testing');
  assert.ok(parsed.keys.has(agent.keyid));
});

test('parseWebBotAuthDirectory accepts a bare array and a single JWK', () => {
  const agent = makeAgent();
  assert.equal(wba.parseWebBotAuthDirectory([agent.jwk]).entries.length, 1);
  assert.equal(wba.parseWebBotAuthDirectory(agent.jwk).entries.length, 1);
  assert.equal(wba.parseWebBotAuthDirectory(JSON.stringify({ keys: [agent.jwk] })).entries.length, 1);
});

test('parseWebBotAuthDirectory indexes a differing kid as an alias', () => {
  const agent = makeAgent();
  const parsed = wba.parseWebBotAuthDirectory({ keys: [{ ...agent.jwk, kid: 'custom-id' }] });
  assert.ok(parsed.keys.has(agent.keyid));
  assert.ok(parsed.keys.has('custom-id'));
  assert.equal(parsed.keys.get('custom-id').keyId, agent.keyid);
});

test('parseWebBotAuthDirectory skips structurally invalid entries', () => {
  const agent = makeAgent();
  const parsed = wba.parseWebBotAuthDirectory({
    keys: [
      agent.jwk,
      { kty: 'RSA', crv: 'Ed25519', x: agent.jwk.x },
      { kty: 'OKP', crv: 'Ed448', x: agent.jwk.x },
      { kty: 'OKP', crv: 'Ed25519', x: 'AA==' },
      'garbage',
    ],
  });
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.skipped, 4);
});

test('parseWebBotAuthDirectory rejects unrecognized documents', () => {
  assert.throws(() => wba.parseWebBotAuthDirectory({ foo: 1 }), TypeError);
  assert.throws(() => wba.parseWebBotAuthDirectory('not json'), TypeError);
  assert.throws(() => wba.parseWebBotAuthDirectory(42), TypeError);
});
