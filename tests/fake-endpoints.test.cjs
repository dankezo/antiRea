'use strict';
// UAS-03 fake-200 scanner decoys - suite version of uas-lab/uas03.cjs.
// Format checks, stage behaviour and attribution expectations are lifted
// from the frozen Step-0 probe (REGISTRATION-UAS-STEP0.md); the /.env
// credential is additionally bound to canary-echo (BUILD-SPEC-3.0 7c).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fe = require('../dist/tier2-active/fake-endpoints.js');
const echo = require('../dist/tier2-active/canary-echo.js');

const SECRET = 'fake-endpoints-test-secret-0123456789';
const T0 = 1_700_000_000_000;
const SCANNER_UA = 'LabScanner/1.0 (step-0 simulation)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PATHS = ['/wp-login.php', '/wp-admin/', '/xmlrpc.php', '/.env', '/.git/config', '/phpinfo.php', '/server-status', '/config.json'];

// Format-check battery, lifted verbatim from uas03.cjs.
const FORMAT_CHECKS = {
  '/wp-login.php': { type: 'text/html', markers: ['wp-login'] },
  '/wp-admin/': { type: 'text/html', markers: ['wordpress'], ci: true },
  '/xmlrpc.php': { type: 'text/xml', markers: ['methodResponse'] },
  '/.env': { type: 'text/plain', regex: 'APP_KEY=base64:[A-Za-z0-9+/=]+' },
  '/.git/config': { type: 'text/plain', markers: ['[core]', 'repositoryformatversion'] },
  '/phpinfo.php': { type: 'text/html', markers: ['phpinfo()', 'PHP Version'] },
  '/server-status': { type: 'text/html', markers: ['Apache Server Status'] },
  '/config.json': { type: 'application/json', jsonSecret: true },
};
function formatPass(p, status, contentType, body) {
  const c = FORMAT_CHECKS[p];
  if (!c || status !== 200) return false;
  if (!contentType || !contentType.startsWith(c.type)) return false;
  if (c.regex && !(new RegExp(c.regex)).test(body)) return false;
  if (c.jsonSecret) {
    try { const j = JSON.parse(body); if (!('secret' in j)) return false; } catch { return false; }
  }
  if (c.markers) {
    const hay = c.ci ? body.toLowerCase() : body;
    for (const m of c.markers) if (!hay.includes(c.ci ? m.toLowerCase() : m)) return false;
  }
  return true;
}

const mockReq = (path, ua = BROWSER_UA, method = 'GET') => ({
  url: path.startsWith('http') ? path : `https://example.test${path}`,
  method,
  headers: { get: (k) => (k.toLowerCase() === 'user-agent' ? ua : null) },
});

const makeOn = (logs, extra = {}) =>
  fe.createFakeEndpoints({ enabled: true, echoSecret: SECRET, echoMintedFor: 'decoy:test-env', now: T0, onLog: (e) => logs.push(e), ...extra });

test('registered paths are exactly the 8 frozen decoy paths', () => {
  assert.deepEqual([...fe.FAKE_ENDPOINT_PATHS], PATHS);
  const pack = makeOn([]);
  assert.deepEqual([...pack.paths], PATHS);
  assert.equal(pack.enabled, true);
});

test('format battery: all 8 paths pass their frozen scanner-format checks (ON arm)', async () => {
  const pack = makeOn([]);
  for (const p of PATHS) {
    const r = await pack.handle(mockReq(p));
    assert.equal(r.handled, true, p);
    assert.equal(r.isDecoy, true, p);
    assert.ok(formatPass(p, r.status, r.contentType, r.body), `format battery failed for ${p}: status=${r.status} type=${r.contentType}`);
  }
});

test('OFF arm: default-off and explicit-off packs answer 404 on all 8 paths and log nothing', async () => {
  for (const opts of [{}, { enabled: false }]) {
    const logs = [];
    const pack = fe.createFakeEndpoints({ ...opts, onLog: (e) => logs.push(e) });
    assert.equal(pack.enabled, false);
    assert.equal(pack.envEchoId, null);
    for (const p of PATHS) {
      const r = await pack.handle(mockReq(p, SCANNER_UA));
      assert.equal(r.status, 404, `OFF arm must 404: ${p}`);
      assert.equal(r.isDecoy, false, p);
    }
    assert.equal(logs.length, 0, 'OFF arm produces zero decoy log entries');
  }
});

test('method rejection: POST/PUT/DELETE on all 8 paths -> 405 (24/24) with zero decoy log entries', async () => {
  const logs = [];
  const pack = makeOn(logs);
  let ok = 0;
  let total = 0;
  for (const p of PATHS) {
    for (const m of ['POST', 'PUT', 'DELETE']) {
      total++;
      const r = await pack.handle(mockReq(p, BROWSER_UA, m));
      assert.equal(r.status, 405, `${m} ${p}`);
      assert.equal(r.headers.allow, 'GET, HEAD');
      assert.equal(r.isDecoy, false);
      if (r.status === 405) ok++;
    }
  }
  assert.equal(total, 24);
  assert.equal(ok, 24);
  assert.equal(logs.length, 0, 'rejected methods produce zero decoy log entries');
});

test('HEAD: all 8 paths answer 200 with an empty body and are logged as HEAD hits', async () => {
  const logs = [];
  const pack = makeOn(logs);
  for (const p of PATHS) {
    const r = await pack.handle(mockReq(p, BROWSER_UA, 'HEAD'));
    assert.equal(r.status, 200, p);
    assert.equal(r.isDecoy, true, p);
    assert.equal(r.body, '', 'HEAD serves no body');
  }
  assert.equal(logs.length, 8);
  assert.ok(logs.every((e) => e.method === 'HEAD' && e.source === 'decoy'));
});

test('attribution exactness: every ON-arm GET/HEAD hit logs exactly {source, path, ua, method} in order', async () => {
  const logs = [];
  const pack = makeOn(logs);
  const expected = [];
  const seq = [
    ['GET', '/wp-login.php', SCANNER_UA],
    ['GET', '/.env', SCANNER_UA],
    ['HEAD', '/wp-admin/', BROWSER_UA],
    ['GET', '/config.json', 'OtherProbe/2.0'],
    ['GET', '/.git/config', SCANNER_UA],
  ];
  for (const [method, p, ua] of seq) {
    await pack.handle(mockReq(p, ua, method));
    expected.push({ source: 'decoy', path: p, ua, method });
  }
  assert.deepEqual(logs, expected);
});

test('canary binding: the /.env credential is a canary-echo token that verifies and resolves', async () => {
  const pack = makeOn([], { echoMintedFor: 'decoy:env-surface-7' });
  const r = await pack.handle(mockReq('/.env'));
  assert.equal(r.status, 200);
  const line = r.body.split('\n').find((l) => l.startsWith('APP_KEY=base64:'));
  assert.ok(line, '/.env body must carry an APP_KEY=base64: line');
  const credential = line.slice('APP_KEY=base64:'.length).trim();
  assert.equal(credential, pack.envEchoId, 'the served credential is the handler\u2019s minted echo id');
  assert.ok(echo.isEchoId(credential), 'credential has the echo-id shape, not a dumb string');
  const v = echo.verifyEchoId(SECRET, credential, { now: T0 + 1000 });
  assert.equal(v.ok, true, `credential must verify through canary-echo: ${JSON.stringify(v)}`);
  assert.equal(v.mintedFor, 'decoy:env-surface-7');
  assert.equal(echo.resolveEchoFrom(SECRET, credential, { now: T0 + 1000 }), 'decoy:env-surface-7');
  // A tampered copy attributes to nothing.
  assert.equal(echo.resolveEchoFrom(SECRET, credential + 'x', { now: T0 + 1000 }), undefined);
  // The body is stable across hits of one instance (a real file does not rotate per request).
  const r2 = await pack.handle(mockReq('/.env'));
  assert.equal(r2.body, r.body);
});

test('enabling without a canary-echo secret throws instead of shipping a dumb credential', () => {
  assert.throws(() => fe.createFakeEndpoints({ enabled: true }), fe.FakeEndpointsError);
  assert.throws(() => fe.createFakeEndpoints({ enabled: true }), /echoSecret is required/);
  // Disabled packs need no secret (they serve nothing).
  assert.doesNotThrow(() => fe.createFakeEndpoints({}));
});

test('never mounted on a real route: non-decoy paths are not handled, exact-match only', async () => {
  const pack = makeOn([]);
  for (const p of ['/api/orders', '/wp-admin', '/wp-login.php/extra', '/WP-LOGIN.PHP', '/', '/config.json.bak']) {
    const r = await pack.handle(mockReq(p));
    assert.equal(r.handled, false, `must not handle: ${p}`);
    assert.equal(r.isDecoy, false, p);
  }
  // Query strings do not break decoy identity.
  const r = await pack.handle(mockReq('/.env?x=1'));
  assert.equal(r.isDecoy, true);
  assert.equal(r.status, 200);
});
