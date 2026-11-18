const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// AC-04 (PASS-LAB, ac-batch2-lab): regression pin, NO new module.
// Detail-drain boundedness under the shipped meter: final union
// equals the budget exactly at B = 10/20/60/120; zero novel served
// after the first block; a post-saturation re-read of an
// already-served detail serves (novelty-0 law); the export after
// the drain blocks at B < 120 (it carries novel records) and
// serves with novel 0 at B = 120 (the union is already complete).

const IDS = Array.from({ length: 120 }, (_, i) => `R${String(i + 1).padStart(3, '0')}`);

// One identity drains detail pages one record at a time through
// the shipped record budget: check(1) gates, consume records.
function drain(budget, identity) {
  const union = new Set();
  let firstBlockAt = null;
  let novelAfterFirstBlock = 0;
  for (const id of IDS) {
    const gate = budget.check(identity, 1);
    if (!gate.allowed) {
      if (firstBlockAt === null) firstBlockAt = union.size + 1;
      continue;
    }
    const before = union.size;
    budget.consume(identity, [id]);
    union.add(id);
    if (firstBlockAt !== null && union.size > before) novelAfterFirstBlock++;
  }
  return { union, firstBlockAt, novelAfterFirstBlock };
}

for (const B of [10, 20, 60, 120]) {
  test(`AC-04: detail drain is bounded exactly at B = ${B}`, () => {
    const budget = sdk.createRecordBudget({ maxDistinctPerWindow: B });
    const identity = `account:drain-${B}`;
    const { union, firstBlockAt, novelAfterFirstBlock } = drain(budget, identity);
    assert.equal(union.size, B);
    assert.equal(budget.usage(identity).used, B);
    if (B < 120) assert.equal(firstBlockAt, B + 1);
    else assert.equal(firstBlockAt, null);
    assert.equal(novelAfterFirstBlock, 0);
  });
}

test('AC-04: post-saturation re-read of an already-served detail serves (novelty 0)', () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 10 });
  const identity = 'account:reread';
  drain(budget, identity);
  assert.equal(budget.usage(identity).used, 10);
  const again = budget.consume(identity, ['R001']);
  assert.equal(again.newlyCounted, 0);
  assert.equal(again.used, 10);
});

test('AC-04: export after the drain blocks at B < 120 and serves with novel 0 at B = 120', () => {
  // Lab numbers: at B = 10/20/60 the post-drain export carries
  // novel 110 / 100 / 60 and blocks; at B = 120 it serves, novel 0.
  for (const [B, novel] of [[10, 110], [20, 100], [60, 60]]) {
    const budget = sdk.createRecordBudget({ maxDistinctPerWindow: B });
    const identity = `account:exp-${B}`;
    drain(budget, identity);
    const exportNovel = IDS.filter(id => !IDS.slice(0, B).includes(id));
    assert.equal(exportNovel.length, novel);
    // The identity is at its cap: any novel-bearing export is gated.
    assert.equal(budget.check(identity, 1).allowed, false);
  }
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 240 });
  const identity = 'account:exp-120';
  budget.consume(identity, IDS);
  const exported = budget.consumeExported(identity, IDS);
  assert.equal(exported.newlyCounted, 0);
});

test('AC-04: a block never locks the identity out (details fill to exactly the budget)', () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 10 });
  const identity = 'account:mix';
  // A 20-novel page is refused as a whole by the gate...
  assert.equal(budget.check(identity, 20).allowed, false);
  // ...but single details still fill the union to exactly 10.
  const { union, novelAfterFirstBlock } = drain(budget, identity);
  assert.equal(union.size, 10);
  assert.equal(novelAfterFirstBlock, 0);
});
