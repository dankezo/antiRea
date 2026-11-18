const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// AC-20 (PASS-LAB, existence pair only, ac-batch1-lab): pixel-diff
// 0.00216 (gate 0.005); blueprint match 0.070 (gate 0.60); trigger
// fragility noted on record.

test('AC-20: the lab fixture pair holds (28/12960 pixel cells, 5/71 blueprint nodes)', () => {
  const cellsA = Array.from({ length: 12960 }, (_, i) => i % 256);
  const cellsB = cellsA.slice();
  for (let i = 0; i < 28; i++) cellsB[i * 400] = (cellsB[i * 400] + 1) % 256;
  const keysA = Array.from({ length: 71 }, (_, i) => `node-${i}`);
  const keysB = [...keysA.slice(0, 5), ...Array.from({ length: 67 }, (_, i) => `other-${i}`)];
  const result = sdk.evaluateExistencePair({
    pixelCellsA: cellsA,
    pixelCellsB: cellsB,
    blueprintKeysA: keysA,
    blueprintKeysB: keysB,
  });
  assert.equal(result.differingCells, 28);
  assert.equal(result.totalCells, 12960);
  assert.ok(Math.abs(result.pixelDiffFraction - 0.00216) < 0.00001);
  assert.equal(result.matchedNodes, 5);
  assert.equal(result.totalNodes, 71);
  assert.ok(Math.abs(result.blueprintMatchFraction - 0.07) < 0.001);
  assert.equal(result.pairHolds, true);
  assert.equal(result.triggerFragility, 'noted-on-record');
  assert.equal(result.enforcement, 'none');
});

test('AC-20: identical captures do not form the pair (blueprint match 1.0)', () => {
  const cells = [1, 2, 3, 4];
  const keys = ['a', 'b'];
  const result = sdk.evaluateExistencePair({
    pixelCellsA: cells,
    pixelCellsB: cells,
    blueprintKeysA: keys,
    blueprintKeysB: keys,
  });
  assert.equal(result.pixelDiffFraction, 0);
  assert.equal(result.blueprintMatchFraction, 1);
  assert.equal(result.pairHolds, false);
});

test('AC-20: a visually different pair fails the pixel gate', () => {
  const result = sdk.evaluateExistencePair({
    pixelCellsA: Array.from({ length: 1000 }, () => 0),
    pixelCellsB: Array.from({ length: 1000 }, () => 1),
    blueprintKeysA: ['a'],
    blueprintKeysB: ['b'],
  });
  assert.equal(result.pixelDiffFraction, 1);
  assert.equal(result.pairHolds, false);
  assert.equal(sdk.AC20_PIXEL_DIFF_GATE, 0.005);
  assert.equal(sdk.AC20_BLUEPRINT_MATCH_GATE, 0.6);
});
