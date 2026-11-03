const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const mockReq = (path, headers = {}, method = 'GET') => ({
  url: path.startsWith('http') ? path : `https://example.test${path}`,
  method,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
});

const mockRes = () => ({
  headers: {},
  statusCode: undefined,
  body: undefined,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  end(body) { if (body !== undefined) this.body = body; },
});

test('a registered decoy route answers 200 with a plausible synthetic document, not 404', async () => {
  const mirage = sdk.createDecoyMirage();
  const result = await mirage.handle(mockReq('/api/v1/internal/schema-export'));
  assert.equal(result.isDecoy, true);
  assert.equal(result.status, 200);
  assert.ok(['service-config', 'schema-registry', 'scoring-profile'].includes(result.body.document));
  assert.equal(typeof result.body.service, 'string');
  assert.match(result.body.version, /^\d+\.\d+\.\d+$/);
});

test('decoy documents are deterministic: same path, same document, across calls and instances', async () => {
  const a = sdk.createDecoyMirage();
  const b = sdk.createDecoyMirage();
  const first = await a.handle(mockReq('/api/v1/internal/prompt-registry'));
  const again = await a.handle(mockReq('/api/v1/internal/prompt-registry'));
  const otherInstance = await b.handle(mockReq('/api/v1/internal/prompt-registry'));
  assert.deepEqual(again.body, first.body);
  assert.deepEqual(otherInstance.body, first.body);
});

test('different decoy paths serve different documents', async () => {
  const mirage = sdk.createDecoyMirage();
  const a = await mirage.handle(mockReq('/api/v1/internal/schema-export'));
  const b = await mirage.handle(mockReq('/api/v2/admin/feature-flags-dump'));
  assert.notDeepEqual(a.body, b.body);
});

test('unregistered paths are not decoys', async () => {
  const mirage = sdk.createDecoyMirage();
  const result = await mirage.handle(mockReq('/api/accounts'));
  assert.equal(result.isDecoy, false);
});

test('hits fire onHit with decoy:true and the normalized path, and survive a throwing sink', async () => {
  const hits = [];
  const mirage = sdk.createDecoyMirage({ onHit: h => hits.push(h) });
  await mirage.handle(mockReq('/API/V1/Internal/Schema-Export/?x=1'));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].decoy, true);
  assert.equal(hits[0].path, '/api/v1/internal/schema-export');

  const throwing = sdk.createDecoyMirage({ onHit: () => { throw new Error('sink down'); } });
  const result = await throwing.handle(mockReq('/api/v1/internal/schema-export'));
  assert.equal(result.isDecoy, true);
  assert.equal(result.status, 200);
});

test('cross-site requests hit by default; ignoreCrossSite is an explicit opt-in (mirrors the canary handler)', async () => {
  const hits = [];
  const mirage = sdk.createDecoyMirage({ onHit: h => hits.push(h) });
  const trapped = await mirage.handle(mockReq('/api/v1/internal/schema-export', { 'sec-fetch-site': 'cross-site' }));
  assert.equal(trapped.isDecoy, true);
  assert.equal(hits.length, 1);

  const optInHits = [];
  const optIn = sdk.createDecoyMirage({ ignoreCrossSite: true, onHit: h => optInHits.push(h) });
  const ignored = await optIn.handle(mockReq('/api/v1/internal/schema-export', { 'sec-fetch-site': 'cross-site' }));
  assert.equal(ignored.isDecoy, false);
  assert.equal(ignored.ignored, true);
  assert.equal(optInHits.length, 0);
});

test('per-path document overrides are served verbatim and custom paths are honored', async () => {
  const custom = { document: 'service-config', service: 'hand-written', version: '9.9.9' };
  const mirage = sdk.createDecoyMirage({
    paths: ['/internal/export-config'],
    documents: { '/internal/export-config': custom },
  });
  const served = await mirage.handle(mockReq('/internal/export-config'));
  assert.equal(served.isDecoy, true);
  assert.deepEqual(served.body, custom);
  const notRegistered = await mirage.handle(mockReq('/api/v1/internal/schema-export'));
  assert.equal(notRegistered.isDecoy, false);
});

test('hits are classified by Fetch Metadata: browser loads are ambient, client fetches are programmatic', async () => {
  const hits = [];
  const mirage = sdk.createDecoyMirage({ onHit: h => hits.push(h) });
  await mirage.handle(mockReq('/api/v1/internal/schema-export', {
    'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'same-origin',
  }));
  assert.equal(hits[0].hitKind, 'ambient');
  await mirage.handle(mockReq('/api/v1/internal/schema-export', {
    'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin',
  }));
  assert.equal(hits[1].hitKind, 'ambient');
  await mirage.handle(mockReq('/api/v1/internal/schema-export', {
    'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
  }));
  assert.equal(hits[2].hitKind, 'programmatic');
  await mirage.handle(mockReq('/api/v1/internal/schema-export'));
  assert.equal(hits[3].hitKind, 'programmatic'); // no Fetch Metadata at all: a non-browser client
});

test('authorize=false answers a plain 404 not_found and fires NO hit', async () => {
  const hits = [];
  const mirage = sdk.createDecoyMirage({
    onHit: h => hits.push(h),
    authorize: req => req.headers.get('authorization') === 'Bearer test',
  });
  const denied = await mirage.handle(mockReq('/api/v1/internal/schema-export'));
  assert.equal(denied.isDecoy, false);
  assert.equal(denied.status, 404);
  assert.deepEqual(denied.body, { error: 'not_found' });
  assert.equal(hits.length, 0);

  const res = mockRes();
  let nextCalled = false;
  await mirage.middleware(mockReq('/api/v1/internal/schema-export'), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false); // the middleware writes the 404 itself
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'not_found' });

  const allowed = await mirage.handle(mockReq('/api/v1/internal/schema-export', { authorization: 'Bearer test' }));
  assert.equal(allowed.isDecoy, true);
  assert.equal(allowed.status, 200);
  assert.equal(hits.length, 1);
});

test('validateRequest=false answers 400 bad_request and fires NO hit', async () => {
  const hits = [];
  const mirage = sdk.createDecoyMirage({
    onHit: h => hits.push(h),
    validateRequest: req => req.headers.get('x-api-version') === '2',
  });
  const bad = await mirage.handle(mockReq('/api/v1/internal/schema-export'));
  assert.equal(bad.isDecoy, false);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: 'bad_request' });
  assert.equal(hits.length, 0);
  const good = await mirage.handle(mockReq('/api/v1/internal/schema-export', { 'x-api-version': '2' }));
  assert.equal(good.isDecoy, true);
  assert.equal(hits.length, 1);
});

test('seedScope mixes into generation: different scopes see different documents, one scope stays stable', async () => {
  const mirage = sdk.createDecoyMirage({
    seedScope: req => req.headers.get('x-account') ?? undefined,
  });
  const a1 = await mirage.handle(mockReq('/api/v1/internal/schema-export', { 'x-account': 'acc-a' }));
  const a2 = await mirage.handle(mockReq('/api/v1/internal/schema-export', { 'x-account': 'acc-a' }));
  const b1 = await mirage.handle(mockReq('/api/v1/internal/schema-export', { 'x-account': 'acc-b' }));
  assert.deepEqual(a2.body, a1.body);
  assert.notDeepEqual(b1.body, a1.body);
  // Unscoped requests keep the original shared document.
  const plain = await mirage.handle(mockReq('/api/v1/internal/schema-export'));
  const vanilla = await sdk.createDecoyMirage().handle(mockReq('/api/v1/internal/schema-export'));
  assert.deepEqual(plain.body, vanilla.body);
});

test('middleware survives a host res that throws at setHeader (NV-4)', async () => {
  const mirage = sdk.createDecoyMirage();
  const res = {
    setHeader() { throw new Error('headers already sent'); },
    status(code) { return { json() {} }; },
    json() {},
    end() {},
  };
  let nextArg = 'not-called';
  // Pre-fix this rejected out of the async middleware (unhandled on Express 4).
  await mirage.middleware(mockReq('/api/v1/internal/schema-export'), res, err => { nextArg = err ?? 'called-no-err'; });
  assert.equal(nextArg, 'not-called');
});

test('middleware survives a host res that throws at status().json (NV-4)', async () => {
  const mirage = sdk.createDecoyMirage();
  const res = {
    setHeader() {},
    status(code) { return { json() { throw new Error('socket closed'); } }; },
    json() { throw new Error('must not fall through to res.json after a chained json throw'); },
    end() { throw new Error('must not fall through to res.end'); },
  };
  let nextCalled = false;
  await mirage.middleware(mockReq('/api/v1/internal/schema-export'), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
});

test('middleware survives a host res that throws at res.json (NV-4)', async () => {
  const mirage = sdk.createDecoyMirage();
  const res = {
    setHeader() {},
    json() { throw new Error('json boom'); },
    end() { throw new Error('must not fall through to res.end'); },
  };
  let nextCalled = false;
  await mirage.middleware(mockReq('/api/v1/internal/schema-export'), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
});

test('middleware survives a host res that throws at res.end (NV-4)', async () => {
  const mirage = sdk.createDecoyMirage();
  const res = {
    setHeader() {},
    end() { throw new Error('end boom'); },
  };
  let nextCalled = false;
  await mirage.middleware(mockReq('/api/v1/internal/schema-export'), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
});

test('middleware absorbs async rejections from res writes instead of leaking unhandled rejections (NV-4)', async () => {
  const unhandled = [];
  const onUnhandled = err => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const mirage = sdk.createDecoyMirage();
    const res = {
      setHeader() {},
      status(code) { return { json() { return Promise.reject(new Error('async json boom')); } }; },
      end() {},
    };
    let nextCalled = false;
    await mirage.middleware(mockReq('/api/v1/internal/schema-export'), res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    // Give any floating rejection a chance to surface before asserting none did.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('middleware still writes the authorize 404 when res is healthy and survives it throwing (NV-4)', async () => {
  const mirage = sdk.createDecoyMirage({ authorize: () => false });
  const healthy = mockRes();
  let nextCalled = false;
  await mirage.middleware(mockReq('/api/v1/internal/schema-export'), healthy, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(healthy.statusCode, 404);
  assert.deepEqual(healthy.body, { error: 'not_found' });

  const throwing = {
    setHeader() { throw new Error('headers already sent'); },
    status(code) { return { json() {} }; },
    end() {},
  };
  await mirage.middleware(mockReq('/api/v1/internal/schema-export'), throwing, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
});

test('middleware serves the decoy on a match and passes everything else through', async () => {
  const mirage = sdk.createDecoyMirage();
  const hitRes = mockRes();
  let hitNext = false;
  await mirage.middleware(mockReq('/api/v1/billing/enterprise-override'), hitRes, () => { hitNext = true; });
  assert.equal(hitNext, false);
  assert.equal(hitRes.statusCode, 200);
  assert.equal(typeof hitRes.body.document, 'string');

  const missRes = mockRes();
  let missNext = false;
  await mirage.middleware(mockReq('/api/accounts'), missRes, () => { missNext = true; });
  assert.equal(missNext, true);
  assert.equal(missRes.body, undefined);
});
