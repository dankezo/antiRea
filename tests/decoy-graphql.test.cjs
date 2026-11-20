'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const { REGISTRY_331, GRAPHQL, req } = require('./fixtures/decoy-registry-331.cjs');

const surface = sdk.generateDecoySurface(REGISTRY_331);

test('identifier inventory is the v4 trial shape: 3 phantom types + 3 phantom queries + 4 decoy fields = 10', () => {
  const ids = sdk.decoyGraphqlIdentifiers(GRAPHQL);
  assert.deepEqual(ids.phantomTypes, ['SupplierAnalytics', 'RebateForecast', 'WarehouseHeatmap']);
  assert.deepEqual(ids.phantomQueries, ['supplierAnalytics', 'rebateForecast', 'warehouseHeatmap']);
  assert.deepEqual(ids.decoyFields, ['Product.supplierMarginTier', 'Product.provenanceScore', 'Store.regionRiskIndex', 'Order.partnerRebateTier']);
  assert.equal(ids.all.length, 10);
});

test('schema composition: Query carries real fields then phantom queries; decoy fields merge onto real types', () => {
  const types = sdk.graphqlSchemaTypes(GRAPHQL);
  assert.equal(types[0].name, 'Query');
  assert.deepEqual(types[0].fields.map((f) => f.name), ['items', 'item', 'supplierAnalytics', 'rebateForecast', 'warehouseHeatmap']);
  const product = types.find((t) => t.name === 'Product');
  assert.deepEqual(product.fields.map((f) => f.name), ['sku', 'name', 'priceVnd', 'category', 'stock', 'supplierMarginTier', 'provenanceScore']);
  assert.deepEqual(types.map((t) => t.name), ['Query', 'Product', 'Store', 'Order', 'SupplierAnalytics', 'RebateForecast', 'WarehouseHeatmap']);
});

test('SDL renders the composed schema (the spec extension text)', () => {
  const sdl = sdk.renderGraphqlSdl(GRAPHQL);
  assert.ok(sdl.includes('type SupplierAnalytics {'));
  assert.ok(sdl.includes('  supplierAnalytics: SupplierAnalytics'));
  assert.ok(sdl.includes('  provenanceScore: String'));
});

test('introspection document carries every planted identifier (the measured carrier)', () => {
  const doc = sdk.buildGraphqlIntrospection(GRAPHQL);
  const schema = doc.data.__schema;
  assert.equal(schema.queryType.name, 'Query');
  assert.equal(schema.mutationType, null);
  const typeNames = schema.types.map((t) => t.name);
  for (const name of ['SupplierAnalytics', 'RebateForecast', 'WarehouseHeatmap']) assert.ok(typeNames.includes(name), name);
  const allFields = schema.types.flatMap((t) => t.fields.map((f) => f.name));
  for (const name of ['supplierAnalytics', 'rebateForecast', 'warehouseHeatmap', 'supplierMarginTier', 'provenanceScore', 'regionRiskIndex', 'partnerRebateTier']) {
    assert.ok(allFields.includes(name), name);
  }
});

test('surface serves the introspection document at the GraphQL path; the spec declares the path and carries the SDL extension', async () => {
  const h = sdk.createDecoySurface({ enabled: true, surface, variantSecret: 'gql-test' });
  const r = await h.handle(req('/graphql'));
  assert.equal(r.status, 200);
  const doc = JSON.parse(r.body);
  assert.equal(doc.data.__schema.types.length, 7);
  const spec = JSON.parse((await h.handle(req('/openapi.json'))).body);
  assert.ok(spec.paths['/graphql']);
  assert.equal(spec['x-graphql-schema'], sdk.renderGraphqlSdl(GRAPHQL));
});

test('validation rejects a phantom colliding with a real type and a decoy field on an undeclared type', () => {
  const bad1 = JSON.parse(JSON.stringify(REGISTRY_331));
  bad1.graphql.phantomTypes.push({ name: 'Product', fields: [{ name: 'x' }] });
  assert.ok(sdk.validateDecoyRegistry(bad1).some((e) => e.includes('collides with a real type')));
  const bad2 = JSON.parse(JSON.stringify(REGISTRY_331));
  bad2.graphql.decoyFields.push({ onType: 'Nope', field: { name: 'x' } });
  assert.ok(sdk.validateDecoyRegistry(bad2).some((e) => e.includes('not a declared real type')));
});

test('disabled by default: the GraphQL path is not handled', async () => {
  const off = sdk.createDecoySurface({ surface, variantSecret: 'gql-test' });
  assert.equal((await off.handle(req('/graphql'))).handled, false);
});
