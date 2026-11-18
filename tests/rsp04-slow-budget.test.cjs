const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

test('RSP-04 budget 2 admits exactly 2, third denied immediately', () => {
  const b = sdk.createRspSlowBudget({ budget: 2 });
  assert.equal(b.acquire(0).admitted, true);
  assert.equal(b.acquire(0).admitted, true);
  const third = b.acquire(0);
  assert.equal(third.admitted, false);
  assert.equal(third.delayMs, 0);
});

test('RSP-04 budget 0 admits 0/50', () => {
  const b = sdk.createRspSlowBudget({ budget: 0 });
  let admitted = 0;
  for (let i = 0; i < 50; i++) if (b.acquire(i).admitted) admitted++;
  assert.equal(admitted, 0);
});

test('RSP-04 aborts free the slot at the abort instant (20/20)', () => {
  const b = sdk.createRspSlowBudget({ budget: 1 });
  for (let i = 0; i < 20; i++) {
    const a = b.acquire(i * 1000);
    assert.equal(a.admitted, true);
    assert.equal(b.abort(a.slotId, i * 1000 + 500), true);
    assert.equal(b.activeCount(), 0);
    const again = b.acquire(i * 1000 + 500);
    assert.equal(again.admitted, true, 'slot must be free at the abort instant');
    b.release(again.slotId, i * 1000 + 600);
  }
});

test('RSP-04 stress: max concurrency 8 at budget 8, denials immediate', () => {
  const b = sdk.createRspSlowBudget({ budget: 8 });
  let admitted = 0, denied = 0;
  const held = [];
  for (let i = 0; i < 200; i++) {
    if (held.length === 8 && i % 3 === 0) b.release(held.shift(), i);
    const r = b.acquire(i);
    if (r.admitted) { admitted++; held.push(r.slotId); }
    else { denied++; assert.equal(r.delayMs, 0); }
  }
  assert.equal(b.maxConcurrencySeen(), 8);
  assert.ok(admitted > 0 && denied > 0, `expected a mix, got admitted=${admitted} denied=${denied}`);
  assert.equal(admitted + denied, 200);
});
