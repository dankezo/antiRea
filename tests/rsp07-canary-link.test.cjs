const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const SECRET = 'rsp07-test-secret';

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

test('RSP-07 tokens distinct per IP 64/64 and per label 12/12', () => {
  const c = sdk.createRspCanaryLinks({ secret: SECRET });
  const perIp = new Set();
  for (let i = 0; i < 64; i++) perIp.add(c.token(`203.0.113.${i + 1}`, 'Posts'));
  assert.equal(perIp.size, 64);
  const perLabel = new Set(sdk.RSP_CANARY_LABELS.map((l) => c.token('203.0.113.1', l)));
  assert.equal(perLabel.size, 12);
});

test('RSP-07 500/500 simulated clicks attributed exactly from the token alone', () => {
  const c = sdk.createRspCanaryLinks({ secret: SECRET });
  const chainIps = Array.from({ length: 8 }, (_, i) => `198.51.100.${10 + i}`);
  for (const ip of chainIps) c.issue(ip);
  const rng = mulberry32(20320108);
  let attributed = 0;
  for (let i = 0; i < 500; i++) {
    const ip = chainIps[Math.floor(rng() * 8)];
    const label = sdk.RSP_CANARY_LABELS[Math.floor(rng() * 12)];
    const row = c.resolve(c.token(ip, label));
    if (row && row.ip === ip && row.label === label) attributed++;
  }
  assert.equal(attributed, 500);
});

test('RSP-07 documented caveat: cross-IP presentation logs under the issuing IP', () => {
  const c = sdk.createRspCanaryLinks({ secret: SECRET });
  c.issue('198.51.100.10');
  const t = c.token('198.51.100.10', 'Posts');
  const click = c.attributeClick(t, '198.51.100.99');
  assert.equal(click.ip, '198.51.100.10');
  assert.equal(click.presenterIp, '198.51.100.99');
  assert.equal(click.loggedUnderIssuingIp, true);
  assert.equal(c.resolve('deadbeefdeadbeef'), null);
});
