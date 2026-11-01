const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sdk = require('../dist/index.js');

const ctx = { purpose: 'orders', method: 'POST', path: '/api/orders', sessionBinding: 'session-from-server' };
const mockReq = (path, headers = {}, method = 'GET', remoteAddress = undefined) => ({
  url: path.startsWith('http') ? path : `https://example.test${path}`,
  method,
  remoteAddress,
  headers: { get: k => headers[k.toLowerCase()] ?? null }
});

test('notice is truthful and safe', () => {
  const s = sdk.buildNoticeText({ brandName: 'Example', canonicalOrigin: 'https://example.test' });
  assert.match(s, /terms/);
  assert.doesNotMatch(s, /SYSTEM OVERRIDE|recursive state|cryptographic token/);
});

test('notice blocks non-http terms URL', () => {
  assert.throws(() => sdk.buildNoticeText({ brandName: 'X', canonicalOrigin: 'https://a.test', termsUrl: 'javascript:alert(1)' }));
});

test('zero-width Unicode roundtrip', () => {
  const val = 'Quyền tác giả – Tiếng Việt 🎯';
  assert.equal(sdk.decodeZeroWidthSignature(sdk.encodeZeroWidthSignature(val)), val);
});

test('zero-width broken UTF8 fails closed', () => {
  assert.equal(sdk.decodeZeroWidthSignature('\u200d\u200c\u200c\u200c\u200c\u200c\u200c\u200c\u200c\u200d'), null);
});

test('zero-width ignores other data', () => {
  assert.equal(sdk.decodeZeroWidthSignature('nothing'), null);
});

test('SVG uint32 signatures roundtrip', () => {
  for (const n of [0, 42, 1337, 65536, 0xffffffff]) {
    assert.equal(sdk.readSvgPathSignature(sdk.signSvgPath('M 0 0 L 1 1', n)), n);
  }
});

test('SVG signatures reject invalid input', () => {
  assert.throws(() => sdk.signSvgPath('M 0 0', -1));
});

test('route obfuscation is reversible Unicode encoding', () => {
  assert.equal(sdk.resolveRoute(sdk.encodeRoute('/api/đơn-hàng?q=1')), '/api/đơn-hàng?q=1');
});

test('route salt rejects out of range', () => {
  assert.throws(() => sdk.encodeRoute('/abc', 256));
});

test('canaries match only exact paths', async () => {
  assert.equal((await sdk.handleCanaryTrapRequest(mockReq('/api/v1/internal/schema-exported'))).isTrapped, false);
  assert.equal((await sdk.handleCanaryTrapRequest(mockReq('/api/v1/internal/schema-export'))).isTrapped, true);
});

test('normalizeCanaryPath and handleCanaryTrapRequest catch trailing slash, uppercase, and percent-encoded variants', async () => {
  const variants = [
    '/api/v1/internal/schema-export/',
    '/API/V1/INTERNAL/SCHEMA-EXPORT',
    '/api/v1/internal/schema%2Dexport',
    '//api//v1/internal/schema%2dexport/?format=json#top'
  ];
  for (const v of variants) {
    assert.equal(sdk.normalizeCanaryPath(v), '/api/v1/internal/schema-export');
    let alertedPath = null;
    const res = await sdk.handleCanaryTrapRequest(mockReq(v), {
      onAlert: a => { alertedPath = a.path; }
    });
    assert.equal(res.isTrapped, true, `Expected variant ${v} to be trapped`);
    assert.equal(alertedPath, '/api/v1/internal/schema-export');
  }
});

test('canaries never automatically attribute spoofed header identity', async () => {
  let alert;
  await sdk.handleCanaryTrapRequest(
    mockReq('/api/v1/internal/schema-export', { 'x-forwarded-for': '1.2.3.4', 'x-user-id': 'victim' }),
    { onAlert: a => { alert = a; } }
  );
  assert.equal(alert.ip, undefined);
  assert.equal(alert.userId, undefined);
});

test('canaries attribute only explicitly trusted proxy headers and server session', async () => {
  let alert;
  await sdk.handleCanaryTrapRequest(
    mockReq('/api/v1/internal/schema-export', { 'cf-connecting-ip': '203.0.113.10', 'user-agent': 'audit' }),
    { trustedIpHeader: 'cf-connecting-ip', resolveUserId: () => 'verified-user', onAlert: a => { alert = a; } }
  );
  assert.equal(alert.ip, '203.0.113.10');
  assert.equal(alert.userId, 'verified-user');
});

test('canaries trap cross-site requests by default; ignoreCrossSite is an explicit opt-in', async () => {
  // sec-fetch-site is client-supplied, so by default a cross-site claim does
  // NOT exempt the request: a non-browser client could send it to opt out.
  let called = false;
  const trapped = await sdk.handleCanaryTrapRequest(
    mockReq('/api/v1/internal/schema-export', { 'sec-fetch-site': 'cross-site' }),
    { onAlert: () => { called = true; } }
  );
  assert.equal(trapped.isTrapped, true);
  assert.equal(called, true);

  let calledOptIn = false;
  const ignored = await sdk.handleCanaryTrapRequest(
    mockReq('/api/v1/internal/schema-export', { 'sec-fetch-site': 'cross-site' }),
    { ignoreCrossSite: true, onAlert: () => { calledOptIn = true; } }
  );
  assert.equal(ignored.isTrapped, false);
  assert.equal(ignored.ignored, true);
  assert.equal(calledOptIn, false);
});

test('canary logging errors do not break app', async () => {
  const r = await sdk.handleCanaryTrapRequest(
    mockReq('/api/v1/internal/schema-export'),
    { onAlert: () => { throw Error('db down'); } }
  );
  assert.equal(r.status, 404);
});

test('canary robots snippet and client decoy route helpers', () => {
  for (const p of sdk.CANARY_ENDPOINTS) {
    assert.ok(sdk.robotsTxtSnippet().includes('Disallow: ' + p));
  }
  assert.deepEqual(sdk.getClientDecoyRoutes(), sdk.CANARY_ENDPOINTS);
  assert.equal(sdk.registerClientBundleCanaries, sdk.getClientDecoyRoutes);
});

test('SSR functions do not require window or document', () => {
  assert.equal(typeof sdk.detectAutomationSignals({ onDetected: () => {}, enabled: true }), 'function');
  assert.equal(sdk.initCdpGuard, sdk.detectAutomationSignals);
  assert.equal(typeof sdk.mountForensicWatermark({ token: 'abcd', enabled: true }), 'function');
});

test('DOM mock verifies injectAgentNotice and mountForensicWatermark create and clean up elements', () => {
  const headChildren = [];
  const bodyChildren = [];
  const makeNode = tag => {
    const attrs = {};
    const node = {
      tagName: tag.toUpperCase(),
      style: {},
      textContent: '',
      children: [],
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return attrs[k] ?? null; },
      appendChild(child) { this.children.push(child); return child; },
      remove() {
        const hIdx = headChildren.indexOf(node);
        if (hIdx >= 0) headChildren.splice(hIdx, 1);
        const bIdx = bodyChildren.indexOf(node);
        if (bIdx >= 0) bodyChildren.splice(bIdx, 1);
      }
    };
    return node;
  };

  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: makeNode,
    head: { appendChild(el) { headChildren.push(el); return el; } },
    body: { appendChild(el) { bodyChildren.push(el); return el; } }
  };
  try {
    const cleanNotice = sdk.injectAgentNotice({
      brandName: 'Northstar',
      canonicalOrigin: 'https://northstar.example',
      termsUrl: '/terms'
    });
    assert.equal(headChildren.length, 1);
    assert.equal(headChildren[0].tagName, 'META');
    assert.equal(headChildren[0].getAttribute('name'), 'ai-use-notice');
    assert.match(headChildren[0].getAttribute('content'), /Northstar/);
    cleanNotice();
    assert.equal(headChildren.length, 0);

    const cleanWatermark = sdk.mountForensicWatermark({
      token: 'Tok_2026_Abcd',
      opacity: 0.15,
      enabled: true
    });
    assert.equal(bodyChildren.length, 1);
    assert.equal(bodyChildren[0].getAttribute('data-antirea-watermark'), 'true');
    assert.equal(bodyChildren[0].getAttribute('aria-hidden'), 'true');
    assert.equal(bodyChildren[0].style.opacity, '0.15');
    assert.equal(bodyChildren[0].children[0].textContent, 'Licensed preview · Tok_2026_Abcd');
    cleanWatermark();
    assert.equal(bodyChildren.length, 0);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('behavior shield SSR is a no-op and never registers keyboard listeners', () => {
  const shield = new sdk.BehaviorShield({ onAnomaly: () => {}, enabled: true });
  assert.doesNotThrow(() => { shield.start(); shield.stop(); });

  const registeredEvents = [];
  const prevWin = globalThis.window;
  globalThis.window = {
    location: { pathname: '/dashboard' },
    addEventListener(evt) { registeredEvents.push(evt); },
    removeEventListener() {},
    setInterval() { return 1; },
    clearInterval() {}
  };
  try {
    const activeShield = new sdk.BehaviorShield({ onAnomaly: () => {}, enabled: true });
    activeShield.start();
    activeShield.stop();
    for (const forbidden of ['keydown', 'keyup', 'keypress', 'beforeinput']) {
      assert.equal(registeredEvents.includes(forbidden), false, `Must not listen to ${forbidden}`);
    }
    assert.deepEqual(registeredEvents, ['click']);
  } finally {
    globalThis.window = prevWin;
  }
});

test('AES-GCM envelope roundtrip with required shared replay callback', async () => {
  const key = await sdk.createEnvelopeKey();
  const guard = sdk.createInMemoryReplayGuard({ ttlMs: 300_000, maxEntries: 100 });
  const e = await sdk.encryptPayload({ secret: 'hello', n: 3 }, key, ctx);
  assert.deepEqual(await sdk.decryptPayload(e, key, ctx, { markNonceOnce: guard }), { secret: 'hello', n: 3 });
  await assert.rejects(() => sdk.decryptPayload(e, key, ctx, { markNonceOnce: guard }), /Replay detected/);
});

test('createInMemoryReplayGuard fails closed at maxEntries instead of evicting live nonces', async () => {
  const guard = sdk.createInMemoryReplayGuard({ ttlMs: 60_000, maxEntries: 100 });
  for (let i = 0; i < 100; i++) {
    assert.equal(guard(`nonce-${i}`, 60_000), true);
  }
  // The cache is full of unexpired nonces: a new envelope is rejected rather
  // than the guard forgetting a live nonce to make room.
  assert.equal(guard('nonce-overflow', 60_000), false);
  // Existing entries are untouched: both the oldest and the newest still
  // count as seen (replay), proving nothing was evicted.
  assert.equal(guard('nonce-0', 60_000), false);
  assert.equal(guard('nonce-99', 60_000), false);

  // Once entries expire, they are evicted and capacity frees up again.
  const shortLived = sdk.createInMemoryReplayGuard({ ttlMs: 40, maxEntries: 100 });
  for (let i = 0; i < 100; i++) {
    assert.equal(shortLived(`exp-${i}`, 40), true);
  }
  assert.equal(shortLived('exp-overflow', 40), false);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(shortLived('exp-overflow', 40), true);
  // An expired key can also be recorded again as fresh.
  assert.equal(shortLived('exp-0', 40), true);
});

test('AES-GCM envelope cannot decrypt under a different request path', async () => {
  const key = await sdk.createEnvelopeKey(), e = await sdk.encryptPayload({ id: 2 }, key, ctx);
  await assert.rejects(() => sdk.decryptPayload(e, key, { ...ctx, path: '/api/admin' }, { markNonceOnce: sdk.createInMemoryReplayGuard() }));
});

test('AES-GCM envelope cannot decrypt after ciphertext modification', async () => {
  const key = await sdk.createEnvelopeKey(), e = await sdk.encryptPayload({ id: 2 }, key, ctx);
  const tampered = { ...e, payload: e.payload.slice(0, -1) + (e.payload.endsWith('A') ? 'B' : 'A') };
  await assert.rejects(() => sdk.decryptPayload(tampered, key, ctx, { markNonceOnce: sdk.createInMemoryReplayGuard() }));
});

test('AES-GCM expiry is enforced', async () => {
  const key = await sdk.createEnvelopeKey(), e = await sdk.encryptPayload({ id: 2 }, key, ctx);
  await assert.rejects(() => sdk.decryptPayload(e, key, ctx, { markNonceOnce: sdk.createInMemoryReplayGuard(), now: e.ts + 20000 }), /expired/);
});

test('AES-GCM replay guard must be present', async () => {
  const key = await sdk.createEnvelopeKey(), e = await sdk.encryptPayload({ id: 2 }, key, ctx);
  await assert.rejects(() => sdk.decryptPayload(e, key, ctx, {}), /replay guard/);
});

test('AES-GCM keys are nonextractable', async () => {
  const key = await sdk.createEnvelopeKey();
  assert.equal(key.extractable, false);
  const webcrypto = globalThis.crypto ?? require('node:crypto').webcrypto;
  await assert.rejects(() => webcrypto.subtle.exportKey('raw', key));
});

test('AES-GCM purpose required', async () => {
  const key = await sdk.createEnvelopeKey();
  await assert.rejects(() => sdk.encryptPayload({ ok: true }, key, { ...ctx, purpose: '' }), /Provide purpose/);
});

test('no hidden local screenshot or keyboard tracking in shield code', () => {
  const shield = fs.readFileSync('src/tier4-forensic/behavior-shield.ts', 'utf8');
  assert.doesNotMatch(shield, /keydown|keyup|keypress|beforeinput|PrintScreen|screenshot_shortcut/);
});

test('server quota guard enforces per-account, per-API-key, and per-IP tier quotas with 429 Retry-After and logs events', async () => {
  const events = [];
  let currentTime = 1_700_000_000_000;
  const guard = sdk.createQuotaGuard({
    now: () => currentTime,
    trustedIpHeader: 'x-real-ip',
    tiers: {
      free: { maxRequests: 2, windowMs: 60_000, maxPageSize: 20, maxPage: 5 },
      pro: { maxRequests: 5, windowMs: 60_000, maxPageSize: 100, maxPage: 50 }
    },
    resolveIdentity: req => ({
      accountId: req.headers.get('x-test-account') ?? undefined,
      apiKeyId: req.headers.get('x-test-apikey') ?? undefined,
      tier: req.headers.get('x-test-tier') ?? 'free'
    }),
    onQuotaExceeded: evt => { events.push(evt); }
  });

  // 1. Account on 'free' tier allowed 2 requests, 3rd returns 429 with Retry-After
  const r1 = await guard.checkRequest(mockReq('/api/items?page=1&limit=10', { 'x-test-account': 'acc-1', 'x-real-ip': '203.0.113.5' }));
  const r2 = await guard.checkRequest(mockReq('/api/items?page=2&limit=10', { 'x-test-account': 'acc-1', 'x-real-ip': '203.0.113.5' }));
  const r3 = await guard.checkRequest(mockReq('/api/items?page=3&limit=10', { 'x-test-account': 'acc-1', 'x-real-ip': '203.0.113.5' }));
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, false);
  assert.equal(r3.status, 429);
  assert.equal(r3.headers['Retry-After'], '60');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'rate_limit_exceeded');
  assert.equal(events[0].dimension, 'account');
  assert.equal(events[0].accountId, 'acc-1');

  // 2. Pro tier API key gets higher quota and page size
  const proReq = await guard.checkRequest(mockReq('/api/items?page=10&limit=80', { 'x-test-apikey': 'key-pro-9', 'x-test-tier': 'pro' }));
  assert.equal(proReq.allowed, true);
  assert.equal(proReq.pagination.pageSize, 80);
  assert.equal(proReq.pagination.page, 10);

  // 3. Exceeding maxPageSize or maxPage triggers 429 + Retry-After + operator log
  const overSize = await guard.checkRequest(mockReq('/api/items?limit=500', { 'x-test-account': 'acc-2', 'x-test-tier': 'free' }));
  assert.equal(overSize.allowed, false);
  assert.equal(overSize.status, 429);
  assert.equal(overSize.body.error, 'page_size_exceeded');
  assert.equal(overSize.headers['Retry-After'], '60');

  const overPage = await guard.checkRequest(mockReq('/api/items?page=99&limit=10', { 'x-test-account': 'acc-2', 'x-test-tier': 'free' }));
  assert.equal(overPage.allowed, false);
  assert.equal(overPage.status, 429);
  assert.equal(overPage.body.error, 'max_page_exceeded');
  assert.equal(events.length, 3);
  assert.equal(events[1].kind, 'page_size_exceeded');
  assert.equal(events[2].kind, 'max_page_exceeded');
});

test('Express quota middleware attaches sanitized pagination and blocks when quota exceeded', async () => {
  const mw = sdk.createExpressQuotaMiddleware({
    tiers: { free: { maxRequests: 1, windowMs: 30_000, maxPageSize: 15, maxPage: 3 } },
    paginationMode: 'clamp'
  });

  const makeRes = () => ({
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return { json: b => { this.payload = b; } }; },
    end(b) { this.payload = b ? JSON.parse(b) : null; }
  });

  let nextCalled = 0;
  const req1 = { url: '/api/records?limit=999&page=10', method: 'GET', headers: {}, socket: { remoteAddress: '198.51.100.7' } };
  const res1 = makeRes();
  await mw(req1, res1, () => { nextCalled += 1; });
  assert.equal(nextCalled, 1);
  assert.deepEqual(req1.quotaPagination, { page: 3, pageSize: 15, offset: 30, clamped: true });

  const req2 = { url: '/api/records?limit=5&page=1', method: 'GET', headers: {}, socket: { remoteAddress: '198.51.100.7' } };
  const res2 = makeRes();
  await mw(req2, res2, () => { nextCalled += 1; });
  assert.equal(nextCalled, 1);
  assert.equal(res2.statusCode, 429);
  assert.equal(res2.headers['Retry-After'], '30');
  assert.equal(res2.payload.error, 'rate_limit_exceeded');
});

test('quota store fails closed at capacity: new windows are refused, live windows are never evicted', async () => {
  const store = sdk.createInMemoryQuotaStore(100);
  const now = 1_700_000_000_000;
  for (let i = 0; i < 100; i++) {
    assert.equal(store.record(`ip:10.0.0.${i}`, now, 60_000), true);
  }
  // Full of unexpired windows: a NEW window is refused, not made room for.
  assert.equal(store.record('ip:10.9.9.9', now, 60_000), false);
  // Existing windows are untouched and keep counting.
  assert.equal(store.peek('ip:10.0.0.0', now, 60_000).count, 1);
  assert.equal(store.record('ip:10.0.0.0', now, 60_000), true);
  assert.equal(store.peek('ip:10.0.0.0', now, 60_000).count, 2);
  // After the window slides past, expired windows free capacity again.
  assert.equal(store.record('ip:10.9.9.9', now + 61_000, 60_000), true);
});

test('quota guard rejects 429 store_capacity_exceeded when the store refuses a new window', async () => {
  const events = [];
  let currentTime = 1_700_000_000_000;
  const guard = sdk.createQuotaGuard({
    now: () => currentTime,
    maxEntries: 100,
    tiers: { free: { maxRequests: 1_000, windowMs: 60_000, maxPageSize: 50, maxPage: 20 } },
    defaultTier: 'free',
    onQuotaExceeded: evt => { events.push(evt); }
  });
  for (let i = 0; i < 100; i++) {
    const r = await guard.checkRequest(mockReq('/api/items', {}, 'GET', `10.0.1.${i}`));
    assert.equal(r.allowed, true, `request ${i} should be admitted`);
  }
  const refused = await guard.checkRequest(mockReq('/api/items', {}, 'GET', '10.9.9.9'));
  assert.equal(refused.allowed, false);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, 'store_capacity_exceeded');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'store_capacity_exceeded');
  assert.equal(events[0].dimension, 'ip');
  // A client whose window already exists is unaffected by the full store.
  const existing = await guard.checkRequest(mockReq('/api/items', {}, 'GET', '10.0.1.0'));
  assert.equal(existing.allowed, true);
  // Once windows expire, new clients are admitted again.
  currentTime += 61_000;
  const afterExpiry = await guard.checkRequest(mockReq('/api/items', {}, 'GET', '10.9.9.9'));
  assert.equal(afterExpiry.allowed, true);
});

test('quota guard counts unresolvable identities against a shared unknown bucket by default', async () => {
  const events = [];
  const guard = sdk.createQuotaGuard({
    tiers: { free: { maxRequests: 2, windowMs: 60_000, maxPageSize: 50, maxPage: 20 } },
    defaultTier: 'free',
    resolveIdentity: () => undefined,
    onQuotaExceeded: evt => { events.push(evt); }
  });
  // mockReq without remoteAddress and no trusted IP header: nothing resolves.
  const r1 = await guard.checkRequest(mockReq('/api/items'));
  const r2 = await guard.checkRequest(mockReq('/api/items'));
  const r3 = await guard.checkRequest(mockReq('/api/items'));
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, false);
  assert.equal(r3.status, 429);
  assert.equal(r3.body.error, 'rate_limit_exceeded');
  assert.equal(events.length, 1);
  assert.equal(events[0].dimension, 'unknown');

  // The legacy skip behavior is available only as an explicit opt-in.
  const legacy = sdk.createQuotaGuard({
    tiers: { free: { maxRequests: 2, windowMs: 60_000, maxPageSize: 50, maxPage: 20 } },
    defaultTier: 'free',
    resolveIdentity: () => undefined,
    allowUnresolvedIdentity: true
  });
  for (let i = 0; i < 4; i++) {
    assert.equal((await legacy.checkRequest(mockReq('/api/items'))).allowed, true);
  }
});
