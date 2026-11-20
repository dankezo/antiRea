'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const { REGISTRY_331, PARTNERS, S1_ENUM_UNIVERSE, S1_SKEW_FIELDS, req } = require('./fixtures/decoy-registry-331.cjs');

const SECRET = 's1-test-secret';
const DECL = REGISTRY_331.identityVariants[0];
const surface = sdk.generateDecoySurface(REGISTRY_331);

function identityOfClass(cls) {
  for (let i = 0; i < 1000; i++) {
    const id = `walker-${i}`;
    if (sdk.variantClassFor(SECRET, id, 2) === cls) return id;
  }
  throw new Error('no identity found for class ' + cls);
}
const ID_A = identityOfClass(0);
const ID_B = identityOfClass(1);

test('subset windows reproduce the v4 trial subsets exactly (universe 10, subset 6, 2 classes)', () => {
  assert.deepEqual(sdk.subsetIndicesFor(0, 2, 10, 6), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(sdk.subsetIndicesFor(1, 2, 10, 6), [4, 5, 6, 7, 8, 9]);
  assert.deepEqual(sdk.enumSubsetFor(DECL, 0), S1_ENUM_UNIVERSE.slice(0, 6));
  assert.deepEqual(sdk.enumSubsetFor(DECL, 1), S1_ENUM_UNIVERSE.slice(4, 10));
  assert.deepEqual(sdk.skewSubsetFor(DECL, 0), S1_SKEW_FIELDS.slice(0, 6));
  assert.deepEqual(sdk.skewSubsetFor(DECL, 1), S1_SKEW_FIELDS.slice(4, 10));
});

test('class assignment is deterministic per (secret, identity) and keyed by the secret', () => {
  assert.equal(sdk.variantClassFor(SECRET, ID_A, 2), 0);
  assert.equal(sdk.variantClassFor(SECRET, ID_A, 2), sdk.variantClassFor(SECRET, ID_A, 2));
  assert.notEqual(sdk.variantClassFor(SECRET, ID_A, 2), sdk.variantClassFor(SECRET, ID_B, 2));
});

test('served shape per class: enum values stay inside the class subset (60% universe coverage)', () => {
  for (const [id, cls] of [[ID_A, 0], [ID_B, 1]]) {
    const served = sdk.applyIdentityVariants(PARTNERS, DECL, SECRET, id);
    const subset = new Set(sdk.enumSubsetFor(DECL, cls));
    const seen = new Set(served.map((r) => r.serviceTier));
    for (const v of seen) assert.ok(subset.has(v), `${v} outside class ${cls} subset`);
    assert.equal(seen.size, 6);
    assert.equal(seen.size / S1_ENUM_UNIVERSE.length, 0.6);
  }
});

test('union capture: 8/10 skew fields appear under exactly one identity (the v4 measurement)', () => {
  const a = sdk.applyIdentityVariants(PARTNERS, DECL, SECRET, ID_A);
  const b = sdk.applyIdentityVariants(PARTNERS, DECL, SECRET, ID_B);
  const present = (records) => new Set(records.flatMap((r) => S1_SKEW_FIELDS.filter((f) => f in r)));
  const pa = present(a);
  const pb = present(b);
  const singleClass = S1_SKEW_FIELDS.filter((f) => pa.has(f) !== pb.has(f));
  assert.equal(singleClass.length, 8);
});

test('aliases rename per class; cross-identity field-name overlap is at most 50% (Jaccard)', () => {
  const a = sdk.applyIdentityVariants(PARTNERS, DECL, SECRET, ID_A);
  const b = sdk.applyIdentityVariants(PARTNERS, DECL, SECRET, ID_B);
  assert.ok('warehouseCode' in a[0] && !('depotRef' in a[0]));
  assert.ok('depotRef' in b[0] && !('warehouseCode' in b[0]));
  assert.equal(b[0].depotRef, PARTNERS[0].warehouseCode);
  const names = (records) => new Set(records.flatMap((r) => Object.keys(r)));
  const na = names(a);
  const nb = names(b);
  const inter = [...na].filter((n) => nb.has(n)).length;
  const union = new Set([...na, ...nb]).size;
  assert.ok(inter / union <= 0.5, `Jaccard ${inter}/${union}`);
});

test('same identity is served the same shape twice; inputs are never mutated', () => {
  const one = sdk.applyIdentityVariants(PARTNERS, DECL, SECRET, ID_A);
  const two = sdk.applyIdentityVariants(PARTNERS, DECL, SECRET, ID_A);
  assert.deepEqual(one, two);
  for (const f of S1_SKEW_FIELDS) assert.ok(f in PARTNERS[0], 'fixture record mutated');
  assert.ok('warehouseCode' in PARTNERS[0]);
});

test('surface integration: variants require a secret, serve per-identity shapes, and are off by default', async () => {
  assert.throws(() => sdk.createDecoySurface({ enabled: true, surface }), sdk.DecoySurfaceError);
  const h = sdk.createDecoySurface({ enabled: true, surface, variantSecret: SECRET });
  const ra = JSON.parse((await h.handle(req('/api/partners/directory', { 'x-identity': ID_A }))).body);
  const rb = JSON.parse((await h.handle(req('/api/partners/directory', { 'x-identity': ID_B }))).body);
  assert.ok('warehouseCode' in ra.records[0]);
  assert.ok('depotRef' in rb.records[0]);
  assert.notDeepEqual(ra.records, rb.records);
  const off = sdk.createDecoySurface({ surface, variantSecret: SECRET });
  assert.equal((await off.handle(req('/api/partners/directory', { 'x-identity': ID_A }))).handled, false);
});

test('validation rejects a full-size subset (varies nothing) and aliases that do not name every class', () => {
  const bad1 = JSON.parse(JSON.stringify(REGISTRY_331));
  bad1.identityVariants[0].enumSubsetSize = 10;
  assert.ok(sdk.validateDecoyRegistry(bad1).some((e) => e.includes('enumSubsetSize')));
  const bad2 = JSON.parse(JSON.stringify(REGISTRY_331));
  bad2.identityVariants[0].aliases[0].names = ['onlyOneName'];
  assert.ok(sdk.validateDecoyRegistry(bad2).some((e) => e.includes('names must name every variant class')));
  const bad3 = JSON.parse(JSON.stringify(REGISTRY_331));
  bad3.identityVariants[0].path = '/api/not-an-endpoint';
  assert.ok(sdk.validateDecoyRegistry(bad3).some((e) => e.includes('not a declared live endpoint')));
});
