const { test } = require('node:test');
const assert = require('node:assert/strict');
const { orderBlocks, orderSpecSections } = require('../dist/tier2-active/decoy-first-order.js');
const { createContractRotation } = require('../dist/tier2-active/contract-rotation.js');

const BLOCKS = [
  { name: 'real-a', role: 'real', content: 'A' },
  { name: 'decoy-1', role: 'decoy', content: 'D1' },
  { name: 'real-b', role: 'real', content: 'B' },
  { name: 'decoy-2', role: 'decoy', content: 'D2' },
  { name: 'real-c', role: 'real', content: 'C' },
];

test('orderBlocks: clean or disabled returns the same array reference', () => {
  assert.strictEqual(orderBlocks(BLOCKS, { enabled: true, flagged: false }), BLOCKS);
  assert.strictEqual(orderBlocks(BLOCKS, { enabled: false, flagged: true }), BLOCKS);
  assert.strictEqual(orderBlocks(BLOCKS, { flagged: true }), BLOCKS);
});

test('orderBlocks: flagged returns decoys first, stable, without mutating the input', () => {
  const snapshot = BLOCKS.map((b) => b.name);
  const out = orderBlocks(BLOCKS, { enabled: true, flagged: true });
  assert.notStrictEqual(out, BLOCKS);
  assert.deepEqual(out.map((b) => b.name), ['decoy-1', 'decoy-2', 'real-a', 'real-b', 'real-c']);
  assert.deepEqual(BLOCKS.map((b) => b.name), snapshot);
});

test('orderSpecSections: clean returns the same object reference', () => {
  const spec = { catalog: 1, catalogV2: 2, shipping: 3 };
  assert.strictEqual(orderSpecSections(spec, ['catalogV2'], { enabled: true, flagged: false }), spec);
  assert.strictEqual(orderSpecSections(spec, ['catalogV2'], { enabled: false, flagged: true }), spec);
});

test('orderSpecSections: flagged serializes with decoy keys first', () => {
  const spec = { catalog: 1, shipping: 3, catalogV2: 2, export: 4 };
  const out = orderSpecSections(spec, ['catalogV2', 'export'], { enabled: true, flagged: true });
  assert.notStrictEqual(out, spec);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(out))), ['catalogV2', 'export', 'catalog', 'shipping']);
  assert.deepEqual(Object.keys(spec), ['catalog', 'shipping', 'catalogV2', 'export']);
});

// Trial descriptors (headline twin decoyContract): epoch A and epoch B.
// Note: the brief's field shorthand for epoch A omits "name"; the twin's
// contract carries it (routes list it in every record). Fields are host
// data for statusForPath, which keys only on prefix.
const EPOCH_A = {
  epoch: 'A', prefix: '/api/v2',
  routes: ['/api/v2/catalog', '/api/v2/catalog/:sku', '/api/v2/export/full'],
  fields: ['sku', 'name', 'priceTier', 'stockBand', 'warehouseZone'], keyField: 'sku',
};
const EPOCH_B = {
  epoch: 'B', prefix: '/api/v3',
  routes: ['/api/v3/catalog', '/api/v3/catalog/:code', '/api/v3/export/full'],
  fields: ['code', 'name', 'tier', 'band', 'zone'], keyField: 'code',
};

test('rotation: before rotate, epoch A paths are current and epoch B paths are stale', () => {
  const rot = createContractRotation({ contracts: [EPOCH_A, EPOCH_B] });
  assert.equal(rot.epoch(), 'A');
  assert.equal(rot.statusForPath('/api/v2/catalog'), 'current');
  assert.equal(rot.statusForPath('/api/v2'), 'current');
  assert.equal(rot.statusForPath('/api/v3/catalog'), 'stale');
  assert.equal(rot.statusForPath('/api/items'), 'not-decoy');
});

test('rotation: after rotate the epochs swap; real paths stay not-decoy in both states', () => {
  const rot = createContractRotation({ contracts: [EPOCH_A, EPOCH_B] });
  assert.equal(rot.statusForPath('/api/items'), 'not-decoy');
  const result = rot.rotate();
  assert.equal(result.rotated, true);
  assert.equal(result.current.epoch, 'B');
  assert.equal(rot.epoch(), 'B');
  assert.equal(rot.statusForPath('/api/v3/catalog'), 'current');
  assert.equal(rot.statusForPath('/api/v2/catalog'), 'stale');
  assert.equal(rot.statusForPath('/api/items'), 'not-decoy');
  // At the last contract, rotate does not wrap.
  const again = rot.rotate();
  assert.equal(again.rotated, false);
  assert.equal(rot.epoch(), 'B');
});

test('rotation: construction rejects an empty list and an unknown initial epoch', () => {
  assert.throws(() => createContractRotation({ contracts: [] }), /non-empty/);
  assert.throws(() => createContractRotation({ contracts: [EPOCH_A], initialEpoch: 'Z' }), /unknown initialEpoch/);
  const rot = createContractRotation({ contracts: [EPOCH_A, EPOCH_B], initialEpoch: 'B' });
  assert.equal(rot.epoch(), 'B');
});
