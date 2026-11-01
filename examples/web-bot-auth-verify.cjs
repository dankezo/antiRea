/**
 * Web Bot Auth verification demo (antiRea v2.2).
 *
 * End-to-end, self-contained: generates an Ed25519 agent key, signs an HTTP
 * request the way the Web Bot Auth profile (RFC 9421) requires, verifies it
 * with createWebBotAuthVerifier, then tampers with a signed component and
 * shows the same request being rejected.
 *
 * Run:
 *   npm run build
 *   node examples/web-bot-auth-verify.cjs
 *
 * Exit code 0 means the positive case verified and the tampered case was
 * rejected. This is a local demonstration only: no network calls are made,
 * and the "agent" key is generated fresh on every run.
 */
'use strict';

const crypto = require('node:crypto');
const { createWebBotAuthVerifier } = require('../dist/tier2-active/web-bot-auth.js');

const AUTHORITY = 'api.example.test';
const AGENT_URL = 'https://agent.example';

/** RFC 7638 JWK thumbprint, computed independently of the module. */
function thumbprint(jwk) {
  const json = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return crypto.createHash('sha256').update(json).digest('base64url');
}

/** Sign a request by hand: the signature base is literal lines, per RFC 9421. */
function signRequest(privateKey, keyid, { authority = AUTHORITY, path = '/data?q=1' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const components = ['"@authority"', '"signature-agent";key="sig"'];
  const params = [
    `created=${now}`,
    `keyid="${keyid}"`,
    'alg="ed25519"',
    `expires=${now + 300}`,
    'tag="web-bot-auth"',
  ];
  const inputValue = `(${components.join(' ')});${params.join(';')}`;
  const values = {
    '"@authority"': authority,
    '"signature-agent";key="sig"': `"${AGENT_URL}"`,
  };
  const lines = components.map((c) => `${c}: ${values[c]}`);
  lines.push(`"@signature-params": ${inputValue}`);
  const signature = crypto.sign(null, Buffer.from(lines.join('\n'), 'utf8'), privateKey).toString('base64');
  const headers = {
    'signature-agent': `sig="${AGENT_URL}"`,
    'signature-input': `sig1=${inputValue}`,
    signature: `sig1=:${signature}:`,
  };
  return {
    url: `https://${authority}${path}`,
    method: 'GET',
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

async function main() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const keyid = thumbprint(jwk);

  // The verifier is given the agent's key directory as a JWK Set document -
  // in production you would fetch this from the agent's
  // /.well-known/http-message-signatures-directory via your own resolver.
  const verifier = createWebBotAuthVerifier({ keys: { keys: [jwk] }, maxValiditySeconds: 600 });

  const signed = signRequest(privateKey, keyid);
  const ok = await verifier.verify(signed);
  console.log('signed request   ->', ok.verified ? `VERIFIED (agent=${ok.agent}, keyId=${ok.keyId})` : `REJECTED (${ok.reason})`);

  // The attack: reuse the ORIGINAL signature on a request whose covered
  // @authority differs. The signature no longer matches the signature base.
  const forged = { ...signed, url: 'https://evil.example.test/data?q=1' };
  const bad = await verifier.verify(forged);
  console.log('tampered request ->', bad.verified ? 'VERIFIED (unexpected!)' : `REJECTED (${bad.reason}: ${bad.detail})`);

  if (!ok.verified || bad.verified) {
    console.error('Demo FAILED: expectations not met.');
    process.exit(1);
  }
  console.log('Demo OK: a valid signature verifies; changing a covered component invalidates it.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
