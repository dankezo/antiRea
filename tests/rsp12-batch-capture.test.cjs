const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const carrying = (n) => Array.from({ length: n }, (_, i) => ({ user: `u${i}`, pass: `p${i}` }));

test('RSP-12 batch of 3 gives 3 rows, envelope on row 1 only, 3 sub-responses', () => {
  const r = sdk.rspProcessBatch(carrying(3));
  assert.equal(r.rows.length, 3);
  assert.equal(r.subResponseCount, 3);
  assert.equal(r.rows[0].hasEnvelope, true);
  assert.equal(r.rows[1].hasEnvelope, false);
  assert.equal(r.capHit, false);
});

test('RSP-12 batches of 30 and 50 cap at 25 rows with the cap reported', () => {
  for (const n of [30, 50]) {
    const r = sdk.rspProcessBatch(carrying(n));
    assert.equal(r.rows.length, 25);
    assert.equal(r.capHit, true);
  }
});

test('RSP-12 measured split: 30 sub-requests with 3 carrying give 3 rows but 25 sub-responses', () => {
  const subs = [...carrying(3), ...Array.from({ length: 27 }, () => ({}))];
  const r = sdk.rspProcessBatch(subs);
  assert.equal(r.rows.length, 3);
  assert.equal(r.subResponseCount, 25);
});

test('RSP-12 username-only sub-request writes a row but no registry record', () => {
  const r = sdk.rspProcessBatch([{ user: 'only-name' }]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.registryRecords, 0);
  const full = sdk.rspProcessBatch(carrying(2));
  assert.equal(full.registryRecords, 2);
});
