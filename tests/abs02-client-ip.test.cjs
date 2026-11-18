const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ABS-02 (conformance audit): client IP must come from the
// connection unless a configured trusted proxy says otherwise.
// Neighbour failure (abs-lab RESULTS-ABS-STEP0) was total: a spoofed
// X-Forwarded-For banned the SPOOFED ip, and a spoofed trusted_ips
// entry bypassed every check; the source's trusted_proxies setting
// was declaration-only (1 grep hit, never read). Audit of antiRea's
// shipped IP-resolution surfaces (quota-guard resolveIp,
// record-budget identity resolution, honeypot middleware, canary
// maze, decoy mirage): every surface reads a forwarding header ONLY
// when the host explicitly configured `trustedIpHeader` for it -
// there is no default trusted header and no trusted_ips list a
// request can influence. These tests pin that behavior.

const SPOOFED = '203.0.113.7'; // the victim address an attacker puts in XFF
const CONNECTION = '198.51.100.9'; // the actual connection peer

const headerReq = (fields = {}) => ({
  url: 'https://example.test/api/data',
  method: 'GET',
  headers: { 'x-forwarded-for': SPOOFED },
  remoteAddress: CONNECTION,
  ...fields,
});

test('ABS-02: record-budget identity ignores a spoofed XFF when no trusted header is configured', async () => {
  const key = await sdk.resolveRecordBudgetIdentityKey(headerReq(), {});
  assert.equal(key, `ip:${CONNECTION}`);
});

test('ABS-02: a configured trustedIpHeader is the ONLY way a forwarding header is believed', async () => {
  const key = await sdk.resolveRecordBudgetIdentityKey(headerReq(), { trustedIpHeader: 'x-forwarded-for' });
  assert.equal(key, `ip:${SPOOFED}`);
});

test('ABS-02: a differently-named spoofed header is not believed even when another header is trusted', async () => {
  const key = await sdk.resolveRecordBudgetIdentityKey(headerReq(), { trustedIpHeader: 'cf-connecting-ip' });
  assert.equal(key, `ip:${CONNECTION}`);
});

test('ABS-02: server-resolved identity IP beats any header, configured or not', async () => {
  const key = await sdk.resolveRecordBudgetIdentityKey(headerReq(), {
    trustedIpHeader: 'x-forwarded-for',
    resolveIdentity: () => ({ ip: '192.0.2.55' }),
  });
  assert.equal(key, 'ip:192.0.2.55');
});

test('ABS-02: canary trap alerts carry no IP from a spoofed XFF without configured trust', async () => {
  const alerts = [];
  const req = {
    url: 'https://example.test/api/v1/internal/schema-export',
    method: 'GET',
    headers: { get: (name) => (name === 'x-forwarded-for' ? SPOOFED : null) },
  };
  await sdk.handleCanaryTrapRequest(req, { onAlert: (a) => alerts.push(a) });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].ip, undefined);
  const trustedAlerts = [];
  await sdk.handleCanaryTrapRequest(req, {
    trustedIpHeader: 'x-forwarded-for',
    onAlert: (a) => trustedAlerts.push(a),
  });
  assert.equal(trustedAlerts[0].ip, SPOOFED);
});

test('ABS-02: canary maze keys its per-IP budget on the connection address, not a spoofed XFF', async () => {
  const alerts = [];
  const maze = sdk.createCanaryMaze({ enabled: true, onAlert: (a) => alerts.push(a) });
  const req = {
    url: '/_canary/amber',
    method: 'GET',
    headers: { get: (name) => (name === 'x-forwarded-for' ? SPOOFED : null) },
    remoteAddress: CONNECTION,
  };
  const res = await maze.handle(req);
  assert.equal(res.isTrapped, true);
  assert.equal(alerts[0].ip, CONNECTION);
});
