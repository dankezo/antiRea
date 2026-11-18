const { test } = require('node:test');
const assert = require('node:assert/strict');
// ABP-06 MEMORY-BACKEND-MUST-ENFORCE-TTL: the neighbour's in-memory
// expire() was a no-op, so per-IP state never expired and grew
// unbounded (uniquePaths 1000 after 1000 paths; only the times list
// was capped, at 50). antiRea form: the bundled in-memory stores must
// enforce their documented TTL not only lazily on access but through
// an explicit full-map sweep, so idle keys are reclaimed without
// traffic. Fixture numbers below mirror the lab's shape (state at
// t0 identical inside the TTL, gone at t0 + TTL + 1, 1000 distinct
// keys) against the shipped stores.
const sdk = require('../dist/index.js');

const T0 = 1_700_000_000_000;
const WINDOW = 60_000;

test('quota store: state inside the TTL survives a sweep untouched', () => {
  const store = sdk.createInMemoryQuotaStore();
  store.record('ip:203.0.113.1', T0, WINDOW);
  store.record('ip:203.0.113.1', T0 + 1_000, WINDOW);
  store.record('ip:203.0.113.2', T0, WINDOW);
  assert.equal(store.size(), 2);
  const removed = store.sweepExpired(T0 + WINDOW - 1, WINDOW);
  assert.equal(removed, 0);
  assert.equal(store.size(), 2);
  assert.equal(store.peek('ip:203.0.113.1', T0 + WINDOW - 1, WINDOW).count, 2);
});

test('quota store: sweep at t0 + TTL removes expired windows completely', () => {
  const store = sdk.createInMemoryQuotaStore();
  store.record('ip:203.0.113.1', T0, WINDOW);
  store.record('ip:203.0.113.2', T0, WINDOW);
  const removed = store.sweepExpired(T0 + WINDOW + 1, WINDOW);
  assert.equal(removed, 2);
  assert.equal(store.size(), 0);
  // A swept key behaves exactly like a never-seen key (fresh window).
  assert.equal(store.peek('ip:203.0.113.1', T0 + WINDOW + 1, WINDOW).count, 0);
});

test('quota store: sweep prunes only the expired entries of a mixed window', () => {
  const store = sdk.createInMemoryQuotaStore();
  store.record('ip:203.0.113.9', T0, WINDOW);
  store.record('ip:203.0.113.9', T0 + WINDOW + 5_000, WINDOW);
  const removed = store.sweepExpired(T0 + WINDOW + 1, WINDOW);
  assert.equal(removed, 0); // window still holds a live entry: not removed
  assert.equal(store.size(), 1);
  assert.equal(store.peek('ip:203.0.113.9', T0 + WINDOW + 1, WINDOW).count, 1);
});

test('quota store: 1000 idle keys do not grow the map past a sweep (lab growth shape)', () => {
  const store = sdk.createInMemoryQuotaStore();
  for (let i = 0; i < 1000; i++) store.record('ip:198.51.100.' + i, T0, WINDOW);
  assert.equal(store.size(), 1000);
  // Below the capacity cap nothing forces eviction: without a sweep
  // the keys would sit forever. The sweep is the TTL enforcement.
  const removed = store.sweepExpired(T0 + WINDOW + 1, WINDOW);
  assert.equal(removed, 1000);
  assert.equal(store.size(), 0);
});

test('quota store: sweep never evicts a live window to make room', () => {
  const store = sdk.createInMemoryQuotaStore(100);
  for (let i = 0; i < 100; i++) store.record('k' + i, T0, WINDOW);
  const removed = store.sweepExpired(T0 + 1_000, WINDOW);
  assert.equal(removed, 0);
  assert.equal(store.size(), 100);
});

test('quota store: recordIfBelow after a sweep starts a fresh window', () => {
  const store = sdk.createInMemoryQuotaStore();
  store.record('ip:192.0.2.1', T0, WINDOW);
  store.record('ip:192.0.2.1', T0, WINDOW);
  store.sweepExpired(T0 + WINDOW + 1, WINDOW);
  const outcome = store.recordIfBelow('ip:192.0.2.1', T0 + WINDOW + 2, WINDOW, 2);
  assert.equal(outcome.recorded, true);
  assert.equal(outcome.count, 1);
});

test('record budget: sweepExpired drops expired identities in both pools only', () => {
  let mono = 1_000_000;
  const budget = sdk.createRecordBudget({
    maxDistinctPerWindow: 10,
    windowMs: 60_000,
    now: () => 1_700_000_000_000,
    monoNow: () => mono,
  });
  budget.consume('account:a', ['r1']);
  budget.consume('ip:203.0.113.7', ['r2']);
  assert.equal(budget.sweepExpired(), 0); // inside the window: nothing expires
  assert.equal(budget.usage('account:a').used, 1);
  mono += 60_001;
  assert.equal(budget.sweepExpired(), 2);
  assert.equal(budget.usage('account:a').used, 0);
  assert.equal(budget.usage('ip:203.0.113.7').used, 0);
  assert.equal(budget.sweepExpired(), 0); // idempotent
});

test('record budget: a swept identity restarts with a full budget (no residue)', () => {
  let mono = 5_000_000;
  const budget = sdk.createRecordBudget({
    maxDistinctPerWindow: 2,
    windowMs: 10_000,
    now: () => 1_700_000_000_000,
    monoNow: () => mono,
  });
  budget.consume('account:b', ['x1', 'x2']);
  assert.equal(budget.check('account:b', 1).allowed, false);
  mono += 10_001;
  budget.sweepExpired();
  const again = budget.consume('account:b', ['y1']);
  assert.equal(again.used, 1);
  assert.equal(again.newlyCounted, 1);
});
