'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

test('planted sets all violate, inside the band, with exact part sums (A6)', () => {
  const sets = sdk.plantInvariantViolations({ seed: 'inv-test', count: 10, groupPrefix: 'ORD' });
  assert.equal(sets.length, 10);
  assert.equal(sets[0].group, 'ORD-9101');
  assert.equal(sets[9].group, 'ORD-9110');
  for (const s of sets) {
    const audit = sdk.auditInvariant(s.statedTotal, s.parts);
    assert.equal(audit.violates, true, s.group);
    assert.equal(audit.partsSum, s.partsSum);
    assert.ok(Math.abs(s.mismatchPct) >= 4.5 && Math.abs(s.mismatchPct) <= 13, `${s.group}: ${s.mismatchPct}`);
    assert.ok(s.parts.length >= 2 && s.parts.length <= 4);
    assert.ok(s.parts.every((p) => Number.isInteger(p.amount) && p.amount > 0));
    assert.equal(s.parts.reduce((a, p) => a + p.amount, 0), s.partsSum, 'parts sum exactly - arithmetic, not rounding');
  }
});

test('planting is deterministic per seed and differs across seeds', () => {
  const a = sdk.plantInvariantViolations({ seed: 'inv-test', count: 5, groupPrefix: 'WH', startAt: 77 });
  const b = sdk.plantInvariantViolations({ seed: 'inv-test', count: 5, groupPrefix: 'WH', startAt: 77 });
  assert.deepEqual(a, b);
  assert.equal(a[0].group, 'WH-77');
  const c = sdk.plantInvariantViolations({ seed: 'other-seed', count: 5, groupPrefix: 'WH', startAt: 77 });
  assert.notDeepEqual(a, c);
});

test('audit reports consistent data as non-violating', () => {
  const audit = sdk.auditInvariant(1000, [{ partId: 'a', amount: 400 }, { partId: 'b', amount: 600 }]);
  assert.equal(audit.violates, false);
  assert.equal(audit.partsSum, 1000);
  assert.equal(audit.mismatchPct, 0);
});

test('invalid planting options throw DecoyInvariantsError', () => {
  assert.throws(() => sdk.plantInvariantViolations({ seed: '', count: 1, groupPrefix: 'X' }), sdk.DecoyInvariantsError);
  assert.throws(() => sdk.plantInvariantViolations({ seed: 's', count: -1, groupPrefix: 'X' }), sdk.DecoyInvariantsError);
  assert.throws(() => sdk.plantInvariantViolations({ seed: 's', count: 1, groupPrefix: 'X', mismatchPctRange: [0, 5] }), sdk.DecoyInvariantsError);
  assert.throws(() => sdk.plantInvariantViolations({ seed: 's', count: 1, groupPrefix: 'X', partsRange: [1, 3] }), sdk.DecoyInvariantsError);
  assert.deepEqual(sdk.plantInvariantViolations({ seed: 's', count: 0, groupPrefix: 'X' }), []);
});
