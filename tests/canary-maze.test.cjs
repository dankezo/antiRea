const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const mockReq = (path, headers = {}, method = 'GET', remoteAddress = undefined) => ({
  url: path.startsWith('http') ? path : `https://example.test${path}`,
  method,
  remoteAddress,
  headers: { get: k => headers[k.toLowerCase()] ?? null }
});

const hrefsOf = html => [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);

test('canary maze is opt-in: disabled by default and when enabled is false', async () => {
  const byDefault = sdk.createCanaryMaze();
  assert.equal((await byDefault.handle(mockReq('/_canary/amber'))).isTrapped, false);
  const off = sdk.createCanaryMaze({ enabled: false });
  const r = await off.handle(mockReq('/_canary/amber'));
  assert.equal(r.isTrapped, false);
  assert.equal(r.html, undefined);
});

test('canary maze ignores paths outside its prefix', async () => {
  const maze = sdk.createCanaryMaze({ enabled: true });
  assert.equal((await maze.handle(mockReq('/api/orders'))).isTrapped, false);
  assert.equal((await maze.handle(mockReq('/_canaryx/amber'))).isTrapped, false);
  assert.equal((await maze.handle(mockReq('/_canary'))).isTrapped, true);
});

test('canary maze pages are deterministic: same path renders identical markup', async () => {
  const maze = sdk.createCanaryMaze({ enabled: true });
  const a = await maze.handle(mockReq('/_canary/meadow/harbor'));
  const b = await maze.handle(mockReq('/_canary/meadow/harbor'));
  assert.equal(a.status, 200);
  assert.equal(a.isTrapped, true);
  assert.equal(a.html, b.html);
  const other = await maze.handle(mockReq('/_canary/meadow/lantern'));
  assert.notEqual(a.html, other.html);
});

test('every generated link stays inside the prefix and pages carry noindex,nofollow', async () => {
  const maze = sdk.createCanaryMaze({ enabled: true });
  const root = await maze.handle(mockReq('/_canary'));
  assert.match(root.html, /<meta name="robots" content="noindex,nofollow">/);
  const rootLinks = hrefsOf(root.html);
  assert.equal(rootLinks.length, 8);
  for (const href of rootLinks) {
    assert.ok(href.startsWith('/_canary/'), `link escapes prefix: ${href}`);
    assert.ok(!/^https?:/i.test(href), `external link: ${href}`);
  }
  const deep = await maze.handle(mockReq(rootLinks[0]));
  for (const href of hrefsOf(deep.html)) {
    assert.ok(href.startsWith('/_canary/'), `deep link escapes prefix: ${href}`);
  }
});

test('canary maze alerts carry maze:true and the depth under the prefix', async () => {
  const alerts = [];
  const maze = sdk.createCanaryMaze({ enabled: true, onAlert: a => alerts.push(a) });
  await maze.handle(mockReq('/_canary'));
  await maze.handle(mockReq('/_canary/meadow'));
  await maze.handle(mockReq('/_canary/meadow/harbor/lantern'));
  assert.equal(alerts.length, 3);
  assert.deepEqual(alerts.map(a => a.depth), [0, 1, 3]);
  assert.ok(alerts.every(a => a.maze === true));
  assert.equal(alerts[2].path, '/_canary/meadow/harbor/lantern');
});

test('per-IP cap trips after the limit and other IPs are unaffected', async () => {
  const maze = sdk.createCanaryMaze({ enabled: true, maxRequestsPerIp: 3 });
  const ip = '203.0.113.7';
  for (let i = 0; i < 3; i++) {
    assert.equal((await maze.handle(mockReq('/_canary/amber', {}, 'GET', ip))).status, 200);
  }
  const capped = await maze.handle(mockReq('/_canary/amber', {}, 'GET', ip));
  assert.equal(capped.status, 404);
  assert.equal(capped.capped, true);
  assert.equal(capped.html, undefined);
  assert.equal((await maze.handle(mockReq('/_canary/amber', {}, 'GET', '198.51.100.9'))).status, 200);
});

test('global daily cap trips across IPs and honors a configured 429', async () => {
  const maze = sdk.createCanaryMaze({ enabled: true, dailyPageCap: 2, overCapStatus: 429 });
  assert.equal((await maze.handle(mockReq('/_canary/a', {}, 'GET', '203.0.113.1'))).status, 200);
  assert.equal((await maze.handle(mockReq('/_canary/b', {}, 'GET', '203.0.113.2'))).status, 200);
  const capped = await maze.handle(mockReq('/_canary/c', {}, 'GET', '203.0.113.3'));
  assert.equal(capped.status, 429);
  assert.equal(capped.capped, true);
});

test('canary maze ignores cross-site browser requests without alerting', async () => {
  const alerts = [];
  const maze = sdk.createCanaryMaze({ enabled: true, onAlert: a => alerts.push(a) });
  const r = await maze.handle(mockReq('/_canary/amber', { 'sec-fetch-site': 'cross-site' }));
  assert.equal(r.isTrapped, false);
  assert.equal(r.ignored, true);
  assert.equal(alerts.length, 0);
});

test('dripMs delays the response when configured', async () => {
  const maze = sdk.createCanaryMaze({ enabled: true, dripMs: 50 });
  const start = Date.now();
  const r = await maze.handle(mockReq('/_canary/amber'));
  assert.equal(r.status, 200);
  assert.ok(Date.now() - start >= 40, 'response should be delayed by roughly dripMs');
});

test('canaryTrapLink snippet follows the safety gates', () => {
  const snippet = sdk.canaryTrapLink('/_canary/');
  assert.match(snippet, /style="display:none"/);
  assert.match(snippet, /aria-hidden="true"/);
  assert.match(snippet, /tabindex="-1"/);
  assert.match(snippet, /rel="nofollow"/);
  assert.match(snippet, /href="\/_canary\/"/);
});

test('canaryRobotsTxt emits the Disallow line for the prefix', () => {
  assert.equal(sdk.canaryRobotsTxt('/_canary/'), 'Disallow: /_canary/\n');
  assert.equal(sdk.canaryRobotsTxt('_canary'), 'Disallow: /_canary/\n');
  assert.equal(sdk.canaryRobotsTxt('/trap-space/'), 'Disallow: /trap-space/\n');
});
