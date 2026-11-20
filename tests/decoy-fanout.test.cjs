'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const { REGISTRY_331, req } = require('./fixtures/decoy-registry-331.cjs');

const surface = sdk.generateDecoySurface(REGISTRY_331);
const chain = REGISTRY_331.chains[0];

test('registry validation accepts the v4-shaped chain and rejects broken chains', () => {
  assert.deepEqual(sdk.validateDecoyRegistry(REGISTRY_331), []);
  const oneLevel = JSON.parse(JSON.stringify(REGISTRY_331));
  oneLevel.chains = [{ levels: [chain.levels[0]] }];
  assert.ok(sdk.validateDecoyRegistry(oneLevel).some((e) => e.includes('at least 2 levels')));
  const noNext = JSON.parse(JSON.stringify(REGISTRY_331));
  delete noNext.chains[0].levels[0].nextField;
  assert.ok(sdk.validateDecoyRegistry(noNext).some((e) => e.includes('nextField is required')));
  const collision = JSON.parse(JSON.stringify(REGISTRY_331));
  collision.endpoints.push({ path: '/api/suppliers/SUP-F-01', kind: 'live', payload: {} });
  assert.ok(sdk.validateDecoyRegistry(collision).some((e) => e.includes('collides')));
});

test('route map: every record at its individual route; next-hop resolution walks 2 hops to the leaf', () => {
  const map = sdk.buildChainRouteMap(chain);
  assert.equal(map.size, 7);
  const start = map.get('/api/suppliers/SUP-F-01');
  assert.ok(start);
  const hop1 = sdk.chainNextRoute(chain, start);
  assert.equal(hop1, '/api/contracts/CT-F-01');
  const hop2 = sdk.chainNextRoute(chain, map.get(hop1));
  assert.equal(hop2, '/api/rebate-plans/RB-F-01');
  assert.equal(sdk.chainNextRoute(chain, map.get(hop2)), null);
  assert.deepEqual(sdk.chainRoutes(chain), [...map.keys()]);
});

test('surface serves chain records wrapped as declared, and the spec declares every concrete route', async () => {
  const h = sdk.createDecoySurface({ enabled: true, surface, variantSecret: 'fanout-test' });
  const supplier = JSON.parse((await h.handle(req('/api/suppliers/SUP-F-02'))).body);
  assert.equal(supplier.supplier.name, 'Saigon Agro Export');
  assert.equal(supplier.supplier.contractId, 'CT-F-02');
  const contract = JSON.parse((await h.handle(req('/api/contracts/CT-F-02'))).body);
  assert.equal(contract.contract.rebatePlanId, 'RB-F-02');
  const plan = JSON.parse((await h.handle(req('/api/rebate-plans/RB-F-02'))).body);
  assert.equal(plan.rebatePlan.tier, 'Silver');
  const spec = JSON.parse((await h.handle(req('/openapi.json'))).body);
  for (const r of sdk.chainRoutes(chain)) assert.ok(spec.paths[r], `spec declares ${r}`);
  assert.equal(spec.paths['/api/suppliers/SUP-F-01'].get.summary, 'Provenance record');
});

test('chain billing: serves bill through the callback; a denial answers the 429 record-budget shape', async () => {
  const billed = [];
  const h = sdk.createDecoySurface({
    enabled: true, surface, variantSecret: 'fanout-test',
    billChainRecord: (identity, recordId) => { billed.push(recordId); return billed.length <= 2; },
  });
  const r1 = await h.handle(req('/api/suppliers/SUP-F-01', { 'x-identity': 'walker' }));
  assert.equal(r1.status, 200);
  assert.equal(r1.billed, true);
  assert.equal(r1.chainRecordId, 'SUP-F-01');
  await h.handle(req('/api/contracts/CT-F-01', { 'x-identity': 'walker' }));
  const denied = await h.handle(req('/api/rebate-plans/RB-F-01', { 'x-identity': 'walker' }));
  assert.equal(denied.status, 429);
  assert.equal(denied.billed, false);
  assert.deepEqual(JSON.parse(denied.body), { error: 'record_budget_exceeded' });
  assert.deepEqual(billed, ['SUP-F-01', 'CT-F-01', 'RB-F-01']);
});

test('without a billing callback chain serves still answer, reporting billed: false (visible degradation)', async () => {
  const h = sdk.createDecoySurface({ enabled: true, surface, variantSecret: 'fanout-test' });
  const r = await h.handle(req('/api/suppliers/SUP-F-01'));
  assert.equal(r.status, 200);
  assert.equal(r.billed, false);
});

test('disabled by default: chain routes are not handled', async () => {
  const off = sdk.createDecoySurface({ surface, variantSecret: 'fanout-test' });
  assert.equal((await off.handle(req('/api/suppliers/SUP-F-01'))).handled, false);
});
