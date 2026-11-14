/**
 * Cross-implementation Web Bot Auth check: this repo's verifier
 * (`dist/tier2-active/web-bot-auth.js`) against the REFERENCE
 * implementation - Cloudflare's `web-bot-auth` npm package.
 *
 * Directions exercised:
 *   A. Reference signer (`signerFromJWK` + `sign`) signs a request;
 *      OUR verifier must accept it.
 *   B. A signer built the way this repo's test suite signs (literal
 *      RFC 9421 signature-base lines + node:crypto) signs a request;
 *      THEIR verifier (`verifierFromJWK` + `verify`) must accept it.
 *
 * Both directions use the RFC 9421 Appendix B.1.4 Ed25519 test key and a
 * request carrying `Signature-Agent: sig1="https://signature-agent.test"`,
 * i.e. the draft-ietf-webbotauth-httpsig-protocol-00 profile.
 *
 * The reference package is a TEST-ONLY tool. It is installed into a
 * scratch directory OUTSIDE this repo and must never appear in this
 * repo's package.json:
 *
 *   mkdir -p /tmp/wba-interop && cd /tmp/wba-interop
 *   npm init -y && npm install web-bot-auth
 *   npm run build   # in this repo, so dist/ exists
 *   INTEROP_PKG_DIR=/tmp/wba-interop node scripts/interop-web-bot-auth.cjs
 *
 * Exit codes: 0 = every direction PASS; 1 = a direction FAILed;
 * 2 = setup problem (missing env, missing package, missing dist build).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');

const pkgDir = process.env.INTEROP_PKG_DIR;
if (!pkgDir) {
  console.error('INTEROP_PKG_DIR is not set. Point it at the scratch dir where the `web-bot-auth` package is installed (see header).');
  process.exit(2);
}
const distModule = path.join(__dirname, '..', 'dist', 'tier2-active', 'web-bot-auth.js');
if (!fs.existsSync(distModule)) {
  console.error(`Missing build output at ${distModule}. Run \`npm run build\` first.`);
  process.exit(2);
}

let reference;
let referenceCrypto;
let referenceVersion = 'unknown';
try {
  const scratchRequire = createRequire(path.join(pkgDir, 'package.json'));
  reference = scratchRequire('web-bot-auth');
  referenceCrypto = scratchRequire('web-bot-auth/crypto');
  // The package's exports map does not expose ./package.json; read it directly.
  referenceVersion = JSON.parse(
    fs.readFileSync(path.join(pkgDir, 'node_modules', 'web-bot-auth', 'package.json'), 'utf8'),
  ).version;
} catch (err) {
  console.error(`Could not load the reference \`web-bot-auth\` package from ${pkgDir}: ${err.message}`);
  process.exit(2);
}
const ours = require(distModule);

// RFC 9421 Appendix B.1.4 Ed25519 test key (published, test-only).
const TEST_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  kid: 'test-key-ed25519',
  d: 'n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU',
  x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',
};
const PUBLIC_JWK = { kty: 'OKP', crv: 'Ed25519', x: TEST_JWK.x };
const EXPECTED_KEYID = 'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U'; // RFC 7638 thumbprint of the test key
const TARGET_URL = 'https://example.com/path/to/resource';
const AGENT_HEADER = 'sig1="https://signature-agent.test"';

let failures = 0;
function report(direction, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${direction}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Direction A: reference signer -> antiRea verifier. */
async function directionA() {
  const signer = await referenceCrypto.signerFromJWK(TEST_JWK);
  // keyid evidence: the draft requires keyid = JWK thumbprint. The example
  // JWK carries kid "test-key-ed25519"; print what the signer actually uses.
  console.log(`reference signer.keyid = ${signer.keyid} (JWK kid is "${TEST_JWK.kid}")`);
  console.log(`keyid is the RFC 7638 thumbprint: ${signer.keyid === EXPECTED_KEYID}`);

  const now = new Date();
  const request = new Request(TARGET_URL, { headers: { 'signature-agent': AGENT_HEADER } });
  const fields = await reference.sign(request, {
    signer,
    created: now,
    expires: new Date(now.getTime() + 300_000),
  });
  console.log(`reference Signature-Input: ${fields.signatureInput}`);

  const headers = new Headers(request.headers);
  headers.set('signature', fields.signature);
  headers.set('signature-input', fields.signatureInput);
  const signedRequest = new Request(request, { headers });

  const verdict = await ours.createWebBotAuthVerifier({ keys: { keys: [PUBLIC_JWK] } }).verify({
    url: signedRequest.url,
    method: signedRequest.method,
    headers: { get: name => signedRequest.headers.get(name) },
  });
  report(
    'A. reference signer -> antiRea verifier',
    verdict.verified === true,
    verdict.verified
      ? `agent=${verdict.agent} keyId=${verdict.keyId}`
      : `verdict reason=${verdict.reason} detail=${verdict.detail}`,
  );
}

/** Direction B: antiRea test-style signer -> reference verifier. */
async function directionB() {
  // Same hand-rolled signer pattern as tests/web-bot-auth.test.cjs: the
  // signature base is assembled from literal lines, never via either
  // implementation's internals.
  const created = Math.floor(Date.now() / 1000);
  const expires = created + 300;
  const components = ['"@authority"', '"signature-agent";key="sig1"'];
  const params = [
    `created=${created}`,
    `keyid="${EXPECTED_KEYID}"`,
    'alg="ed25519"',
    `expires=${expires}`,
    'tag="web-bot-auth"',
  ];
  const inputValue = `(${components.join(' ')});${params.join(';')}`;
  const base = [
    '"@authority": example.com',
    '"signature-agent";key="sig1": "https://signature-agent.test"',
    `"@signature-params": ${inputValue}`,
  ].join('\n');
  const privateKey = crypto.createPrivateKey({ key: TEST_JWK, format: 'jwk' });
  const signature = crypto.sign(null, Buffer.from(base, 'utf8'), privateKey).toString('base64');

  const request = new Request(TARGET_URL, {
    headers: {
      'signature-agent': AGENT_HEADER,
      'signature-input': `sig1=${inputValue}`,
      signature: `sig1=:${signature}:`,
    },
  });
  const verifier = await referenceCrypto.verifierFromJWK(PUBLIC_JWK);
  try {
    const result = await reference.verify(request, { resolver: () => verifier, now: new Date() });
    report(
      'B. antiRea test-style signer -> reference verifier',
      result.keyid === EXPECTED_KEYID,
      `keyid=${result.keyid} agent=${result.signatureAgent?.uri}`,
    );
  } catch (err) {
    report('B. antiRea test-style signer -> reference verifier', false, `rejected: ${err.message}${err.cause ? ` (cause: ${err.cause.message})` : ''}`);
  }
}

(async () => {
  console.log(`Cross-implementation Web Bot Auth check against web-bot-auth@${referenceVersion} (scratch dir: ${pkgDir})`);
  for (const direction of [directionA, directionB]) {
    try {
      await direction();
    } catch (err) {
      report(direction.name, false, `threw: ${err.message}`);
    }
  }
  console.log(failures === 0 ? 'RESULT: PASS (all directions)' : `RESULT: FAIL (${failures} direction(s))`);
  process.exit(failures === 0 ? 0 : 1);
})();
