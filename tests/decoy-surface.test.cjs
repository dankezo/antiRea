'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const { REGISTRY, req } = require('./fixtures/decoy-registry.cjs');

const surface = sdk.generateDecoySurface(REGISTRY);
const enabledHandler = () => sdk.createDecoySurface({ enabled: true, surface, joinSecret: 'surface-test-secret', surfaceSeed: 'surface-test' });

test('disabled by default: nothing is handled, so real routing is byte-identical to 3.2.0', async () => {
  const off = sdk.createDecoySurface({ surface, joinSecret: 'surface-test-secret' });
  assert.equal(off.enabled, false);
  for (const p of ['/robots.txt', '/sitemap.xml', '/openapi.json', '/api-docs', '/api/v2/products', '/api/v3/items', '/api/suppliers', '/api/discounts/calculate']) {
    const r = await off.handle(req(p));
    assert.equal(r.handled, false, p);
  }
  const bare = sdk.createDecoySurface();
  assert.equal((await bare.handle(req('/robots.txt'))).handled, false);
});

test('enabled without a surface, or join sets without a secret, fails fast', () => {
  assert.throws(() => sdk.createDecoySurface({ enabled: true }), sdk.DecoySurfaceError);
  assert.throws(() => sdk.createDecoySurface({ enabled: true, surface }), sdk.DecoySurfaceError);
});

test('serves the discovery documents, spec and docs page', async () => {
  const h = enabledHandler();
  const robots = await h.handle(req('/robots.txt'));
  assert.equal(robots.status, 200);
  assert.ok(robots.body.includes('Disallow: /api/admin-export'));
  const sitemap = await h.handle(req('/sitemap.xml'));
  assert.ok(sitemap.body.includes('<loc>/api/supplier/feed</loc>'));
  const spec = JSON.parse((await h.handle(req('/openapi.json'))).body);
  assert.equal(spec.info.title, 'Catalog API');
  const docs = await h.handle(req('/api-docs'));
  assert.equal(docs.status, 200);
  assert.ok(docs.body.includes('canonical pricing source'), 'docs endorse the contradiction');
  assert.ok(docs.body.includes('807500'), 'docs state the documented sequential total');
  assert.ok(docs.body.includes('/api/suppliers'), 'docs list the join directory');
});

test('serves live endpoints and pages; phantom endpoints are plain 404s', async () => {
  const h = enabledHandler();
  const products = JSON.parse((await h.handle(req('/api/v2/products'))).body);
  assert.equal(products.items.length, 2);
  const page = await h.handle(req('/partner-terms'));
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('Partner terms'));
  const phantom = await h.handle(req('/api/v3/items'));
  assert.equal(phantom.handled, true);
  assert.equal(phantom.status, 404);
  assert.equal(phantom.isDecoy, false);
});

test('worked example endpoint serves the flat total, not the documented one (A5)', async () => {
  const h = enabledHandler();
  const r = JSON.parse((await h.handle(req('/api/discounts/calculate'))).body);
  assert.equal(r.example.total, 800000);
});

test('unowned paths pass through; non-GET on owned paths is 405; HEAD has no body', async () => {
  const h = enabledHandler();
  assert.equal((await h.handle(req('/api/items'))).handled, false);
  const post = await h.handle(req('/api/v2/products', {}, 'POST'));
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
  const head = await h.handle(req('/api/v2/products', {}, 'HEAD'));
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('join sets are served gated per identity and resolve within one identity (A7)', async () => {
  const h = enabledHandler();
  const a = { 'x-identity': 'key-A' };
  const b = { 'x-identity': 'key-B' };
  const parentsA = JSON.parse((await h.handle(req('/api/suppliers', a))).body).records;
  const childrenA = JSON.parse((await h.handle(req('/api/contracts', a))).body).records;
  const childrenB = JSON.parse((await h.handle(req('/api/contracts', b))).body).records;
  assert.ok(parentsA[0].supplierId.startsWith('SUP-'));
  assert.ok(!parentsA[0].supplierId.includes('{tag}'), 'placeholder replaced');
  // Trial pin (v3 IDJ): same identity 0% orphans, mixed identity 100%.
  assert.equal(sdk.resolveJoins(parentsA, 'supplierId', childrenA, 'supplierId').orphanRate, 0);
  assert.equal(sdk.resolveJoins(parentsA, 'supplierId', childrenB, 'supplierId').orphanRate, 1);
});

test('every served decoy response is logged in the fixed shape; a throwing sink is swallowed', async () => {
  const entries = [];
  const h = sdk.createDecoySurface({
    enabled: true, surface, joinSecret: 'surface-test-secret',
    onLog: (e) => { entries.push(e); },
  });
  await h.handle(req('/robots.txt', { 'user-agent': 'test-agent' }));
  await h.handle(req('/api/v2/products'));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].source, 'decoy-surface');
  assert.equal(entries[0].kind, 'robots');
  assert.equal(entries[0].ua, 'test-agent');
  assert.equal(entries[1].kind, 'endpoint');

  const throwing = sdk.createDecoySurface({
    enabled: true, surface, joinSecret: 'surface-test-secret',
    onLog: () => { throw new Error('sink down'); },
  });
  const r = await throwing.handle(req('/robots.txt'));
  assert.equal(r.status, 200, 'host response unaffected by a broken sink');
});
