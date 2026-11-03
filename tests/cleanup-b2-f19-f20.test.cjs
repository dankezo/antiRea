const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/* ------------------------------------------------------------------ */
/* F-19 — evidence-attribution: `pairs` map must be bounded (LRU cap)  */
/* ------------------------------------------------------------------ */

test('F-19: pairs state is bounded at the default cap (1024); oldest pairs are evicted, newest keep working', () => {
  const attr = sdk.createEvidenceAttributor({ now: () => 10_000 });
  const TOTAL = 1030;
  for (let i = 0; i < TOTAL; i++) {
    attr.attribute({ actor: `a${i}`, about: `b${i}`, relation: 'declared', amount: 0.5 });
  }
  // Exactly the newest 1024 pairs retain credit; the 6 oldest are gone.
  let retained = 0;
  for (let i = 0; i < TOTAL; i++) {
    if (attr.crossCredit(`a${i}`, `b${i}`) > 0) retained++;
  }
  assert.equal(retained, 1024, `expected exactly 1024 retained pairs, got ${retained}`);
  assert.equal(attr.crossCredit('a0', 'b0'), 0, 'oldest pair must be evicted');
  assert.equal(attr.crossCredit('a5', 'b5'), 0, '6th-oldest pair must be evicted');
  assert.equal(attr.crossCredit('a6', 'b6'), 0.5, 'first retained pair keeps its credit');
  assert.equal(attr.crossCredit('a1029', 'b1029'), 0.5, 'newest pair keeps its credit');
  // A retained pair still accumulates under the per-pair cap as before.
  const more = attr.attribute({ actor: 'a1029', about: 'b1029', relation: 'declared', amount: 0.7 });
  assert.ok(Math.abs(more.creditedCross - 0.5) < 1e-9, 'per-pair cap still binds after eviction pressure');
  assert.ok(Math.abs(attr.crossCredit('a1029', 'b1029') - 1.0) < 1e-9);
});

test('F-19: a custom maxPairs bound is honoured exactly', () => {
  const attr = sdk.createEvidenceAttributor({ now: () => 10_000, maxPairs: 16 });
  for (let i = 0; i < 20; i++) {
    attr.attribute({ actor: `a${i}`, about: `b${i}`, relation: 'declared', amount: 0.5 });
  }
  let retained = 0;
  for (let i = 0; i < 20; i++) {
    if (attr.crossCredit(`a${i}`, `b${i}`) > 0) retained++;
  }
  assert.equal(retained, 16);
  assert.equal(attr.crossCredit('a3', 'b3'), 0);
  assert.equal(attr.crossCredit('a4', 'b4'), 0.5);
  assert.equal(attr.crossCredit('a19', 'b19'), 0.5);
});

test('F-19: re-writing a pair refreshes its LRU position (active pairs are evicted last)', () => {
  const attr = sdk.createEvidenceAttributor({ now: () => 10_000, maxPairs: 16 });
  for (let i = 0; i < 16; i++) {
    attr.attribute({ actor: `a${i}`, about: `b${i}`, relation: 'declared', amount: 0.5 });
  }
  // Touch the oldest pair so it becomes the most-recently-written.
  attr.attribute({ actor: 'a0', about: 'b0', relation: 'declared', amount: 0.1 });
  // One new pair must now evict a1 (the least-recently-written), not a0.
  attr.attribute({ actor: 'a16', about: 'b16', relation: 'declared', amount: 0.5 });
  assert.ok(Math.abs(attr.crossCredit('a0', 'b0') - 0.6) < 1e-9, 'refreshed pair survives with accumulated credit');
  assert.equal(attr.crossCredit('a1', 'b1'), 0, 'least-recently-written pair is the eviction victim');
  assert.equal(attr.crossCredit('a16', 'b16'), 0.5);
});

/* ------------------------------------------------------------------ */
/* F-20 (flow-scorer) — a throwing `isExempt` is treated as not exempt */
/* ------------------------------------------------------------------ */

test('F-20: isExempt throwing in observe() does not escape; the session is scored as not exempt', () => {
  const scorer = sdk.createFlowScorer({
    isExempt: () => { throw new Error('host isExempt boom'); },
  });
  let standing;
  assert.doesNotThrow(() => {
    standing = scorer.observe('account:x', { routeClass: 'canary', status: 404 });
  });
  assert.equal(standing.exempt, undefined, 'a throwing predicate must not exempt the session');
  assert.equal(standing.score, 50, 'the event is scored normally (canary weight)');
  assert.equal(standing.level, 'elevated');
});

test('F-20: isExempt throwing in score() does not escape and agrees with observe()', () => {
  const scorer = sdk.createFlowScorer({
    isExempt: () => { throw new Error('host isExempt boom'); },
  });
  scorer.observe('account:x', { routeClass: 'canary', status: 404 });
  let current;
  assert.doesNotThrow(() => { current = scorer.score('account:x'); });
  assert.equal(current, 50, 'score() treats the throw as not exempt, consistent with observe()');
  assert.deepEqual(scorer.reasons('account:x'), ['canary_contact']);
});

test('F-20: a non-throwing isExempt keeps its exact prior behaviour through the wrapper', () => {
  const scorer = sdk.createFlowScorer({ isExempt: key => key === 'bot:verified' });
  const exemptStanding = scorer.observe('bot:verified', { routeClass: 'canary', status: 404 });
  assert.equal(exemptStanding.exempt, true);
  assert.equal(scorer.score('bot:verified'), 0);
  const normalStanding = scorer.observe('account:y', { routeClass: 'canary', status: 404 });
  assert.equal(normalStanding.exempt, undefined);
  assert.equal(normalStanding.score, 50);
  assert.equal(scorer.score('account:y'), 50);
});
