const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// AC-25 (PASS-LAB, ac-batch1-lab): parameter confirmation for the
// shipped C39 family. E = 80 verbatim confirms 200/200; control
// 1/200; clean 0/200; re-rounding does not wash the mark.

test('AC-25: the re-measurement parameters are pinned exactly', () => {
  assert.equal(sdk.AC25_POOLED_EDITIONS, 80);
  assert.equal(sdk.AC25_TAU_AT_E80, 0.5204);
  assert.deepEqual({ ...sdk.AC25_REMEASUREMENT }, {
    editions: 80,
    verbatimConfirmed: 200,
    verbatimTotal: 200,
    recomputedConfirmed: 1,
    recomputedTotal: 200,
    cleanConfirmed: 0,
    cleanTotal: 200,
    reroundedConfirmed: 200,
    reroundedTotal: 200,
    perturbationMedianPct: 0.376,
    perturbationP99Pct: 2.57,
  });
});

// Records large enough to carry all three scales.
const records = (n, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `r${offset + i}`, q: 100 + i, p: 300 }));

test('AC-25: a verbatim copy confirms through the shipped family', () => {
  const pooled = sdk.createAc25PooledWatermark({ key: 'ac25-host-key' });
  const marked = pooled.watermark.markEdition('ed-1', records(120));
  const verdict = pooled.watermark.verifyEdition('ed-1', marked);
  assert.equal(verdict.confirmed, true);
  assert.equal(verdict.enforcement, 'none');
});

test('AC-25: a recomputed edition does not confirm', () => {
  const pooled = sdk.createAc25PooledWatermark({ key: 'ac25-host-key' });
  const source = records(120);
  // Recomputed control: publishedTotal := q * p exactly (no residue).
  const recomputed = source.map(r => ({ ...r, publishedTotal: r.q * r.p }));
  const verdict = pooled.watermark.verifyEdition('ed-1', recomputed);
  assert.equal(verdict.confirmed, false);
});

test('AC-25: 2-decimal re-rounding of a verbatim copy does not wash the mark', () => {
  const pooled = sdk.createAc25PooledWatermark({ key: 'ac25-host-key' });
  const marked = pooled.watermark.markEdition('ed-1', records(120));
  const rerounded = marked.map(r => ({
    ...r,
    publishedTotal: Math.round(r.publishedTotal * 100) / 100,
  }));
  const verdict = pooled.watermark.verifyEdition('ed-1', rerounded);
  assert.equal(verdict.confirmed, true);
});

test('AC-25: the pooled point reports E = 80 as the operating point', () => {
  const pooled = sdk.createAc25PooledWatermark({ key: 'ac25-host-key' });
  assert.equal(pooled.pooledEditions, 80);
  assert.equal(pooled.pooledPointReached(), false);
});
