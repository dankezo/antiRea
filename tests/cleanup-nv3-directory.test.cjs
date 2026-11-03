/**
 * NV-3 regression tests (coordinator-applied fix, spec by cleanup cluster C2):
 * Web Bot Auth directory documents are bounded (MAX_DIRECTORY_KEYS /
 * MAX_DIRECTORY_DOCUMENT_LENGTH, fail-fast) and resolver-supplied raw
 * documents are parsed once per document version per verifier (parse
 * cache by string content / object identity), not once per request.
 *
 * Audit background: parsing a directory is real per-key cryptographic
 * work (createPublicKey + RFC 7638 thumbprint, ~24 us/key measured).
 * Before the fix a 10,000-key directory cost ~215 ms of synchronous CPU
 * on EVERY verify through the documented raw-document resolver wiring;
 * after the fix the same wiring pays that cost once (and directories
 * above the caps are rejected before any key is normalized).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const wba = require('../dist/tier2-active/web-bot-auth.js');

const NOW = 1_800_000_000;
const nowMs = () => NOW * 1000;
const AUTHORITY = 'api.example.test';
const AGENT_URL = 'https://agent.example';

function thumbprint(jwk) {
  const json = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return crypto.createHash('sha256').update(json).digest('base64url');
}

function makeAgent() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return { publicKey, privateKey, jwk, keyid: thumbprint(jwk) };
}

function fillerJwk() {
  return crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
}

function directoryOf(agent, totalKeys) {
  const keys = [agent.jwk];
  while (keys.length < totalKeys) keys.push(fillerJwk());
  return { keys };
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

function signedRequest(agent) {
  const components = ['"@authority"', '"signature-agent";key="sig"'];
  const params = stdParams(agent);
  const values = {
    '"@authority"': AUTHORITY,
    '"signature-agent";key="sig"': `"${AGENT_URL}"`,
  };
  const inputValue = `(${components.join(' ')});${params.join(';')}`;
  const lines = components.map(c => `${c}: ${values[c]}`);
  lines.push(`"@signature-params": ${inputValue}`);
  const signature = crypto.sign(null, Buffer.from(lines.join('\n'), 'utf8'), agent.privateKey).toString('base64');
  const lowered = {
    'signature-agent': `sig="${AGENT_URL}"`,
    'signature-input': `sig1=${inputValue}`,
    signature: `sig1=:${signature}:`,
  };
  return {
    url: `https://${AUTHORITY}/data?q=1`,
    method: 'GET',
    headers: { get: name => lowered[name.toLowerCase()] ?? null },
  };
}

test('NV-3: directory above MAX_DIRECTORY_KEYS is rejected before normalizing any key', () => {
  const agent = makeAgent();
  const tooBig = directoryOf(agent, wba.MAX_DIRECTORY_KEYS + 1);
  assert.throws(
    () => wba.parseWebBotAuthDirectory(tooBig),
    err => err instanceof TypeError && err.message.includes(String(wba.MAX_DIRECTORY_KEYS)),
  );
});

test('NV-3: directory at exactly MAX_DIRECTORY_KEYS parses normally', () => {
  const agent = makeAgent();
  const parsed = wba.parseWebBotAuthDirectory(directoryOf(agent, wba.MAX_DIRECTORY_KEYS));
  assert.equal(parsed.entries.length, wba.MAX_DIRECTORY_KEYS);
  assert.ok(parsed.keys.get(agent.keyid));
});

test('NV-3: oversized string document is rejected by length before JSON parsing', () => {
  // Content is not valid JSON at all: if the length check did not run
  // first, the error would be the JSON error instead.
  const doc = ' '.repeat(wba.MAX_DIRECTORY_DOCUMENT_LENGTH + 1);
  assert.throws(
    () => wba.parseWebBotAuthDirectory(doc),
    err => err instanceof TypeError && err.message.includes('maximum accepted length'),
  );
});

test('NV-3: verifier fails closed (key_resolution_failed) when the resolver directory exceeds the cap', async () => {
  const agent = makeAgent();
  const tooBig = directoryOf(agent, wba.MAX_DIRECTORY_KEYS + 1);
  const verifier = wba.createWebBotAuthVerifier({ now: nowMs, resolveKey: async () => tooBig });
  const verdict = await verifier.verify(signedRequest(agent));
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'key_resolution_failed');
});

test('NV-3: resolver raw document object is parsed once per verifier, not once per verify', async () => {
  const agent = makeAgent();
  // Count reads of each JWK's `x`: normalization (the expensive part of a
  // parse) reads it; a cached parse must not re-read on later verifies.
  let xReads = 0;
  const counted = jwk => new Proxy(jwk, {
    get(target, prop, receiver) {
      if (prop === 'x') xReads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const keys = [counted(agent.jwk)];
  while (keys.length < 200) keys.push(counted(fillerJwk()));
  const document = { keys };
  const verifier = wba.createWebBotAuthVerifier({ now: nowMs, resolveKey: async () => document });

  const first = await verifier.verify(signedRequest(agent));
  assert.equal(first.verified, true);
  const readsAfterFirst = xReads;
  assert.ok(readsAfterFirst > 0, 'sanity: the first verify really parsed the directory');

  for (let i = 0; i < 19; i++) {
    const verdict = await verifier.verify(signedRequest(agent));
    assert.equal(verdict.verified, true);
  }
  assert.ok(
    xReads <= readsAfterFirst * 2,
    `expected the parse cache to keep x reads near ${readsAfterFirst}, got ${xReads} after 20 verifies`,
  );
});

test('NV-3: resolver returning the same JSON string verifies repeatedly (string cache path)', async () => {
  const agent = makeAgent();
  const document = JSON.stringify(directoryOf(agent, 50));
  const verifier = wba.createWebBotAuthVerifier({ now: nowMs, resolveKey: async () => document });
  for (let i = 0; i < 5; i++) {
    const verdict = await verifier.verify(signedRequest(agent));
    assert.equal(verdict.verified, true);
  }
});

test('NV-3: static keys above the cap fail fast at verifier construction', () => {
  const agent = makeAgent();
  const tooBig = directoryOf(agent, wba.MAX_DIRECTORY_KEYS + 1);
  assert.throws(() => wba.createWebBotAuthVerifier({ keys: tooBig, now: nowMs }), TypeError);
});
