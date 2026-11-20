'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const { REGISTRY, req } = require('./fixtures/decoy-registry.cjs');

const surface = sdk.generateDecoySurface(REGISTRY);

test('subresources: stable billed ids, deterministic content, parent linkage (A8)', () => {
  const subs = sdk.generateSubresources({ seed: 'sink-test', path: '/api/v2/products', kind: 'supplier', baseId: 'SKU-20001', count: 3 });
  assert.deepEqual(subs.map((s) => s.id), ['sub-supplier-SKU-20001-1', 'sub-supplier-SKU-20001-2', 'sub-supplier-SKU-20001-3']);
  assert.ok(subs.every((s) => s.parentId === 'SKU-20001' && s.kind === 'supplier'));
  const again = sdk.generateSubresources({ seed: 'sink-test', path: '/api/v2/products', kind: 'supplier', baseId: 'SKU-20001', count: 3 });
  assert.deepEqual(subs, again, 'same request, same subresources');
  const other = sdk.generateSubresources({ seed: 'sink-test', path: '/api/v2/products', kind: 'supplier', baseId: 'SKU-20002', count: 3 });
  assert.notDeepEqual(subs, other);
  assert.deepEqual(sdk.generateSubresources({ seed: 's', path: '/p', kind: 'k', baseId: 'b', count: 0 }), []);
  assert.throws(() => sdk.generateSubresources({ seed: 's', path: '/p', kind: 'k', baseId: 'b', count: -1 }), sdk.DecoyExpandablesError);
});

test('fixed subresources for record-less endpoints carry no parent', () => {
  const subs = sdk.generateFixedSubresources({ seed: 'sink-test', path: '/api/discounts/calculate', kind: 'component', count: 3 });
  assert.deepEqual(subs.map((s) => s.id), ['sub-component-1', 'sub-component-2', 'sub-component-3']);
  assert.ok(subs.every((s) => s.parentId === null));
});

test('handler bills expansion ids through the host callback before serving', async () => {
  const billedCalls = [];
  const h = sdk.createDecoySurface({
    enabled: true, surface, joinSecret: 'sink-secret', surfaceSeed: 'sink-test',
    billExpansion: (identity, ids) => { billedCalls.push({ identity, ids }); return true; },
  });
  const r = await h.handle(req('/api/v2/products?expand=supplier', { 'x-identity': 'key-A' }));
  assert.equal(r.status, 200);
  assert.equal(r.billed, true);
  // 2 catalog records x 1 sub each, ids keyed by sku.
  assert.deepEqual(r.expansionIds, ['sub-supplier-SKU-20001-1', 'sub-supplier-SKU-20002-1']);
  assert.deepEqual(billedCalls, [{ identity: 'key-A', ids: r.expansionIds }]);
  const body = JSON.parse(r.body);
  assert.equal(body.items[0].supplier[0].id, 'sub-supplier-SKU-20001-1');
});

test('a budget denial answers 429 with the record-budget error shape', async () => {
  const h = sdk.createDecoySurface({
    enabled: true, surface, joinSecret: 'sink-secret', surfaceSeed: 'sink-test',
    billExpansion: () => false,
  });
  const r = await h.handle(req('/api/v2/products?expand=supplier'));
  assert.equal(r.status, 429);
  assert.deepEqual(JSON.parse(r.body), { error: 'record_budget_exceeded' });
  assert.equal(r.billed, false);
});

test('without a billing callback the expansion serves but reports billed: false - never silent', async () => {
  const h = sdk.createDecoySurface({ enabled: true, surface, joinSecret: 'sink-secret', surfaceSeed: 'sink-test' });
  const r = await h.handle(req('/api/v2/products?expand=supplier'));
  assert.equal(r.status, 200);
  assert.equal(r.billed, false);
  const plain = await h.handle(req('/api/v2/products'));
  assert.equal(plain.billed, undefined, 'plain responses carry no billing claim');
});

test('fixed expansion on the worked-example path bills its fixed subs', async () => {
  const seen = [];
  const h = sdk.createDecoySurface({
    enabled: true, surface, joinSecret: 'sink-secret', surfaceSeed: 'sink-test',
    billExpansion: (identity, ids) => { seen.push(ids); return true; },
  });
  const r = await h.handle(req('/api/discounts/calculate?expand=breakdown'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.expansionIds, ['sub-component-1', 'sub-component-2', 'sub-component-3']);
  assert.deepEqual(seen, [r.expansionIds]);
  const body = JSON.parse(r.body);
  assert.equal(body.breakdown.length, 3);
  assert.equal(body.example.total, 800000, 'the worked example itself is unchanged');
});
