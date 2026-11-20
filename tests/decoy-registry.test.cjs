'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const { REGISTRY } = require('./fixtures/decoy-registry.cjs');

const clone = (v) => JSON.parse(JSON.stringify(v));

test('the trial-shaped fixture registry validates clean', () => {
  assert.deepEqual(sdk.validateDecoyRegistry(REGISTRY), []);
});

test('validation reports each broken rule without throwing', () => {
  const bad = clone(REGISTRY);
  bad.formatVersion = 2;
  bad.endpoints.push({ path: '/api/v2/products', kind: 'live', payload: {} }); // duplicate
  bad.endpoints.push({ path: '/api/ghost', kind: 'phantom', payload: {} }); // phantom with payload
  bad.discovery.disallowPaths = ['/not-declared'];
  bad.contradictions = [{ feedPath: '/api/items', priceFactor: 1, endorsement: '' }];
  bad.workedExamples = [{ path: '/api/v2/products', subtotal: 100, stepsPct: [], servedTotal: 100 }];
  bad.expandables = [{ path: '/api/v2/products', param: 'expand', value: 'x', attachAs: 'x', kind: 'x' }]; // neither count
  const errors = sdk.validateDecoyRegistry(bad);
  assert.ok(errors.length >= 7, errors.join(' | '));
  assert.ok(errors.some((e) => e.includes('formatVersion')));
  assert.ok(errors.some((e) => e.includes('duplicate endpoint path')));
  assert.ok(errors.some((e) => e.includes('carries a payload')));
  assert.ok(errors.some((e) => e.includes('not a declared decoy path')));
  assert.ok(errors.some((e) => e.includes('priceFactor')));
  assert.ok(errors.some((e) => e.includes('collides with a declared endpoint')));
  assert.ok(errors.some((e) => e.includes('needs subsPerRecord or fixedSubs')));
});

test('generateDecoySurface throws DecoyRegistryError on an invalid registry', () => {
  assert.throws(() => sdk.generateDecoySurface({ formatVersion: 9 }), sdk.DecoyRegistryError);
});

test('surface paths cover discovery docs, spec, docs, endpoints, examples and join paths', () => {
  const surface = sdk.generateDecoySurface(REGISTRY);
  const paths = sdk.decoySurfacePaths(surface);
  for (const p of ['/robots.txt', '/sitemap.xml', '/openapi.json', '/api-docs', '/api/v2/products',
    '/api/v3/items', '/partner-terms', '/api/discounts/calculate', '/api/suppliers', '/api/contracts']) {
    assert.ok(paths.includes(p), p);
  }
});

test('robots render lists disallow lines and the sitemap pointer (A1)', () => {
  const surface = sdk.generateDecoySurface(REGISTRY);
  const robots = sdk.renderDecoyRobots(surface);
  assert.ok(robots.startsWith('User-agent: *\nAllow: /\n'));
  assert.ok(robots.includes('Disallow: /api/admin-export\n'));
  assert.ok(robots.includes('Disallow: /api/hidden-pricing\n'));
  assert.ok(robots.endsWith('Sitemap: /sitemap.xml\n'));
});

test('sitemap render carries real paths and sitemap-only decoy paths (A1)', () => {
  const surface = sdk.generateDecoySurface(REGISTRY);
  const xml = sdk.renderDecoySitemap(surface);
  for (const p of ['/', '/api/items', '/api/supplier/feed', '/api/clearance/list']) {
    assert.ok(xml.includes(`<loc>${p}</loc>`), p);
  }
});

test('spec render mirrors real paths and declares the whole decoy surface (A2/A3/A5/A8)', () => {
  const surface = sdk.generateDecoySurface(REGISTRY);
  const spec = sdk.buildDecoyOpenApiSpec(surface);
  assert.equal(spec.info.title, 'Catalog API');
  assert.ok(spec.paths['/api/items'], 'real path mirrored');
  assert.equal(spec.paths['/api/v3/items'].get.summary, 'Preview endpoint');
  assert.ok(spec.paths['/api/partners/feed'].get.description.includes('canonical pricing source'));
  assert.ok(spec.paths['/api/discounts/calculate'].get.description.includes('sequentially'));
  assert.ok(spec.paths['/api/v2/products?expand=supplier'], 'expandable declared with its query (twin shape)');
  assert.ok(spec.paths['/api/discounts/calculate?expand=breakdown']);
});

test('contradiction feed applies the factor to real prices and keeps keys aligned (A3)', () => {
  const real = [
    { sku: 'SKU-20001', name: 'Artisan Coffee Beans 1kg', priceVnd: 250000 },
    { sku: 'SKU-20002', name: 'Ceramic Pour-Over Set', priceVnd: 480000 },
  ];
  const feed = sdk.buildContradictionFeed(real, {
    keyOf: (r) => r.sku, nameOf: (r) => r.name, priceOf: (r) => r.priceVnd, priceFactor: 0.82,
  });
  // Trial factor pin: partner price = round(real x 0.82).
  assert.equal(feed[0].partnerPrice, 205000);
  assert.equal(feed[1].partnerPrice, 393600);
  assert.equal(feed[0].key, 'SKU-20001');
  assert.equal(feed[1].name, 'Ceramic Pour-Over Set');
  assert.equal(real[0].partnerPrice, undefined, 'input not mutated');
});

test('worked example: documented sequential total differs from the served flat total (A5 trial pin)', () => {
  // Trial pin: 1,000,000 x 0.85 x 0.95 = 807,500 documented; the endpoint serves 800,000.
  assert.equal(sdk.sequentialStepsTotal(1000000, [15, 5]), 807500);
  const surface = sdk.generateDecoySurface(REGISTRY);
  const payload = sdk.workedExamplePayload(surface.workedExamples[0]);
  assert.equal(payload.example.total, 800000);
  assert.equal(payload.example.subtotal, 1000000);
  assert.deepEqual(payload.example.stepsPct, [15, 5]);
});
