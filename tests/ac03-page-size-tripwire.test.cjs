const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// AC-03 (PASS-LAB-WITH-COST, ac-batch2-lab): no page size fires on
// the 120-record union (P20 peak 1.587, P50 peak 2.194, crossed =
// false); the extension crosses at U*(50) = 320, U*(20) = 460,
// U*(10) never at or below 2,120. Cost on record: the tripwire is
// blind at the 120-record scale; small-scale protection is the
// meter layer.

test('AC-03: on the 120-record union no page size fires (peaks far below the threshold)', () => {
  assert.equal(sdk.AC03_TRIPWIRE_THRESHOLD, 20);
  assert.equal(sdk.AC03_BLIND_UNION_RECORDS, 120);
  assert.equal(sdk.peakCapitalAt120(20), 1.587);
  assert.equal(sdk.peakCapitalAt120(50), 2.194);
  for (const size of [10, 20, 50]) {
    const result = sdk.evaluatePageSizeCrossing(size, 120);
    assert.equal(result.crossed, false, `page size ${size} must not cross at 120`);
    assert.equal(result.protectionLayerBelowCrossing, 'meter');
  }
});

test('AC-03: the extension crosses at U*(50) = 320 and U*(20) = 460 exactly', () => {
  assert.equal(sdk.evaluatePageSizeCrossing(50, 319).crossed, false);
  assert.equal(sdk.evaluatePageSizeCrossing(50, 320).crossed, true);
  assert.equal(sdk.evaluatePageSizeCrossing(50, 320).crossingUnion, 320);
  assert.equal(sdk.evaluatePageSizeCrossing(20, 459).crossed, false);
  assert.equal(sdk.evaluatePageSizeCrossing(20, 460).crossed, true);
  assert.equal(sdk.evaluatePageSizeCrossing(20, 460).crossingUnion, 460);
});

test('AC-03: page size 10 never crosses at or below 2,120', () => {
  const cell = sdk.AC03_PAGE_SIZE_SWEEP.find(c => c.pageSize === 10);
  assert.equal(cell.crossingUnion, null);
  assert.equal(cell.crossingCap, 2120);
  assert.equal(sdk.evaluatePageSizeCrossing(10, 2120).crossed, false);
});

test('AC-03: unmeasured page sizes claim nothing', () => {
  const result = sdk.evaluatePageSizeCrossing(25, 100000);
  assert.equal(result.measured, false);
  assert.equal(result.crossed, false);
  assert.equal(result.crossingUnion, null);
  assert.equal(sdk.peakCapitalAt120(25), undefined);
});
