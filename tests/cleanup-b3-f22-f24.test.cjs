// Cleanup B3 (audit 2.6.0 retest) — F-22 + F-24 regression tests.
//
// F-22 (Web Bot Auth, RFC 8941): the Structured Fields parser used to
// accept duplicate dictionary keys (last-wins) and duplicate parameters
// (first-wins via find). RFC 8941 requires dictionary member names and
// parameter names to be unique; accepting repeats is a parser
// differential against any proxy/host reading the same header with the
// other convention. The parser now throws, which the verifier surfaces
// as `malformed_headers`.
// Pre-fix evidence (harness, 2026-11-03): parseSfDictionary('a=1, a=2')
// returned size 1 / value 2 with no throw; 'a=1;p=1;p=2' kept both
// params; a validly signed request with a duplicated Signature-Agent
// key (identical value) and one with a duplicated signature parameter
// both verified=true.
//
// F-24 (Canary Maze): the per-IP map eviction used to delete live
// entries when full (the delete condition had a `size >= MAX` clause
// that was true by construction), so under IP churn a live IP's budget
// reset. Now, like the Web Bot Auth nonce store in the same package:
// only expired entries are evicted, and a map full of live entries
// refuses the new IP (capped) instead.
// Pre-fix evidence (harness, 2026-11-03): after filling the map with
// 10,000 live IPs, a new IP got 200 and the evicted victim IP got a
// fresh budget (200 on its over-cap third request).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const wba = require('../dist/tier2-active/web-bot-auth.js');
const sdk = require('../dist/index.js');

/* ------------------------------ F-22 ---------------------------------- */

test('F-22: parseSfDictionary rejects a duplicate dictionary key (RFC 8941)', () => {
  assert.throws(() => wba.parseSfDictionary('a=1, a=2'), /duplicate dictionary key "a"/);
  assert.throws(() => wba.parseSfDictionary('sig="https://a.example", sig="https://b.example"'), /duplicate dictionary key "sig"/);
  // Bare (boolean) members count too.
  assert.throws(() => wba.parseSfDictionary('a, a'), /duplicate dictionary key "a"/);
});

test('F-22: parseSfDictionary rejects duplicate parameters (item and inner-list)', () => {
  assert.throws(() => wba.parseSfDictionary('a=1;p=1;p=2'), /duplicate parameter "p"/);
  assert.throws(
    () => wba.parseSfDictionary('sig1=("@authority");created=1;created=2'),
    /duplicate parameter "created"/
  );
  // Duplicate param on a covered-component identifier inside the inner list.
  assert.throws(
    () => wba.parseSfDictionary('sig1=("@authority";key="a";key="b");created=1'),
    /duplicate parameter "key"/
  );
});

test('F-22: non-duplicate dictionaries and parameters still parse', () => {
  const members = wba.parseSfDictionary('a=1;p=1;q=2, b="x"');
  assert.equal(members.size, 2);
  assert.equal(members.get('a').item.params.length, 2);
  const input = wba.parseSfDictionary('sig1=("@authority" "signature-agent";key="sig");created=1;tag="web-bot-auth"');
  assert.equal(input.get('sig1').list.params.length, 2);
});

const NOW = 1_800_000_000;
const nowMs = () => NOW * 1000;

function thumbprint(jwk) {
  const json = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return crypto.createHash('sha256').update(json).digest('base64url');
}

function makeAgent() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return { publicKey, privateKey, jwk, keyid: thumbprint(jwk) };
}

/** Sign a request whose covered components are @authority + signature-agent;key. */
function signRequest(agent, signatureParams) {
  const components = ['"@authority"', '"signature-agent";key="sig"'];
  const inputValue = `(${components.join(' ')});${signatureParams}`;
  const lines = [
    '"@authority": api.example.test',
    '"signature-agent";key="sig": "https://agent.example"',
    `"@signature-params": ${inputValue}`,
  ];
  const sig = crypto.sign(null, Buffer.from(lines.join('\n'), 'utf8'), agent.privateKey).toString('base64');
  return { inputValue, sig };
}

function mockReq(agentHeader, inputValue, sig) {
  const headers = {
    'signature-agent': agentHeader,
    'signature-input': `sig1=${inputValue}`,
    signature: `sig1=:${sig}:`,
  };
  return {
    url: 'https://api.example.test/data?q=1',
    method: 'GET',
    headers: { get: name => headers[name.toLowerCase()] ?? null },
  };
}

const stdParams = agent =>
  `created=${NOW};keyid="${agent.keyid}";alg="ed25519";expires=${NOW + 300};tag="web-bot-auth"`;

test('F-22: a normal signed request still verifies', async () => {
  const agent = makeAgent();
  const verifier = wba.createWebBotAuthVerifier({ keys: { keys: [agent.jwk] }, now: nowMs });
  const { inputValue, sig } = signRequest(agent, stdParams(agent));
  const verdict = await verifier.verify(mockReq('sig="https://agent.example"', inputValue, sig));
  assert.equal(verdict.verified, true);
  assert.equal(verdict.agent, 'https://agent.example');
});

test('F-22: duplicate Signature-Agent dictionary key fails as malformed_headers, even when validly signed', async () => {
  const agent = makeAgent();
  const verifier = wba.createWebBotAuthVerifier({ keys: { keys: [agent.jwk] }, now: nowMs });
  const { inputValue, sig } = signRequest(agent, stdParams(agent));
  // Same member twice with the identical value: the signature is valid
  // over either copy, so pre-fix this verified=true (last-wins).
  const verdict = await verifier.verify(
    mockReq('sig="https://agent.example", sig="https://agent.example"', inputValue, sig)
  );
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'malformed_headers');
});

test('F-22: duplicate signature parameter fails as malformed_headers, even when validly signed', async () => {
  const agent = makeAgent();
  const verifier = wba.createWebBotAuthVerifier({ keys: { keys: [agent.jwk] }, now: nowMs });
  // Signer signs over a raw @signature-params that repeats `created`
  // with the identical value: pre-fix this verified=true (first-wins).
  const dupParams = `created=${NOW};created=${NOW};keyid="${agent.keyid}";alg="ed25519";expires=${NOW + 300};tag="web-bot-auth"`;
  const { inputValue, sig } = signRequest(agent, dupParams);
  const verdict = await verifier.verify(mockReq('sig="https://agent.example"', inputValue, sig));
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'malformed_headers');
});

test('F-22: duplicate label in Signature-Input fails as malformed_headers', async () => {
  const agent = makeAgent();
  const verifier = wba.createWebBotAuthVerifier({ keys: { keys: [agent.jwk] }, now: nowMs });
  const { inputValue, sig } = signRequest(agent, stdParams(agent));
  const single = `sig1=${inputValue}`;
  const verdict = await verifier.verify({
    url: 'https://api.example.test/data?q=1',
    method: 'GET',
    headers: {
      get: name => {
        const n = name.toLowerCase();
        if (n === 'signature-input') return `${single}, ${single}`;
        if (n === 'signature-agent') return 'sig="https://agent.example"';
        if (n === 'signature') return `sig1=:${sig}:`;
        return null;
      },
    },
  });
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'malformed_headers');
});

/* ------------------------------ F-24 ---------------------------------- */

const mazeReq = (ip) => ({
  url: 'https://example.test/_canary/amber',
  method: 'GET',
  remoteAddress: ip,
  headers: { get: () => null },
});
const ipFor = i => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

test('F-24: a map full of live entries refuses a new IP instead of evicting a live entry', async () => {
  const mono = 1_000_000; // frozen monotonic clock: nothing expires
  const maze = sdk.createCanaryMaze({
    enabled: true,
    maxRequestsPerIp: 2,
    windowMs: 600_000,
    dailyPageCap: 1_000_000,
    monoNow: () => mono,
  });
  const victim = ipFor(0);
  assert.equal((await maze.handle(mazeReq(victim))).status, 200);
  assert.equal((await maze.handle(mazeReq(victim))).status, 200); // victim now at cap (2)
  for (let i = 1; i < 10_000; i++) {
    await maze.handle(mazeReq(ipFor(i)));
  }
  // Map holds 10,000 live entries. A brand-new IP must be refused
  // (capped), not admitted by forgetting the oldest live entry.
  const newcomer = await maze.handle(mazeReq(ipFor(10_000)));
  assert.equal(newcomer.status, 404);
  assert.equal(newcomer.capped, true);
  // The victim entry survived: its third request is still over its
  // original per-IP cap instead of enjoying a reset budget.
  const victimAgain = await maze.handle(mazeReq(victim));
  assert.equal(victimAgain.status, 404);
  assert.equal(victimAgain.capped, true);
});

test('F-24: expired entries are still evicted to make room for a new IP', async () => {
  let mono = 1_000_000;
  const windowMs = 600_000;
  const maze = sdk.createCanaryMaze({
    enabled: true,
    maxRequestsPerIp: 2,
    windowMs,
    dailyPageCap: 1_000_000,
    monoNow: () => mono,
  });
  for (let i = 0; i < 10_000; i++) {
    await maze.handle(mazeReq(ipFor(i)));
  }
  const newcomerIp = ipFor(10_000);
  assert.equal((await maze.handle(mazeReq(newcomerIp))).status, 404); // full of live entries
  mono += windowMs; // every stored window expires
  const afterExpiry = await maze.handle(mazeReq(newcomerIp));
  assert.equal(afterExpiry.status, 200);
  assert.equal(afterExpiry.capped, undefined);
});
