'use strict';
// NHS-18 multi-box ban sync - suite version of nhs-lab/nhs18.cjs,
// over the host-supplied store ADAPTER interface and its in-memory
// reference adapter (no Redis client, no new dependency). Frozen
// semantics: one SET by the origin box with EX 3600, local decisions
// continue with the store down, queued ban syncs after recovery,
// pulled bans are never re-pushed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bs = require('../dist/tier2-active/ban-sync.js');

const T0 = 5000;

function world() {
  const store = bs.createInMemoryBanSyncStore();
  const A = bs.createBanSyncBox({ name: 'A', store });
  const B = bs.createBanSyncBox({ name: 'B', store });
  return { store, A, B };
}

test('push and pull: A ban is stored with EX 3600 after one tick; B pulls it flagged and blocks', async () => {
  const { store, A, B } = world();
  A.blockLocal('203.0.113.9', 'ban', 3600, T0);
  await A.tick(T0);
  await B.tick(T0);
  const sets = store.writeLog.filter((w) => w.key === 'sentinel:ban:203.0.113.9');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].ex, 3600);
  assert.equal(sets[0].by, 'A');
  const pulled = B.ban('203.0.113.9');
  assert.equal(pulled.pulled, true);
  assert.equal(B.decide('203.0.113.9', T0), 'blocked');
});

test('loop guard: B never re-pushes a pulled ban - exactly 1 SET for the key, by A', async () => {
  const { store, A, B } = world();
  A.blockLocal('203.0.113.9', 'ban', 3600, T0);
  await A.tick(T0);
  await B.tick(T0);
  await B.tick(T0 + 10);
  await A.tick(T0 + 10);
  const sets = store.writeLog.filter((w) => w.key === 'sentinel:ban:203.0.113.9');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].by, 'A');
  assert.equal(B.pendingPushes(), 0);
});

test('store down: both boxes keep deciding locally, nothing errors; queued ban syncs after recovery', async () => {
  const { store, A, B } = world();
  A.blockLocal('203.0.113.9', 'ban', 3600, T0);
  await A.tick(T0);
  await B.tick(T0);
  store.setDown(true);
  A.blockLocal('203.0.113.10', 'ban', 3600, T0 + 20);
  B.blockLocal('192.0.2.5', 'ban', 3600, T0 + 20);
  await A.tick(T0 + 20);
  await B.tick(T0 + 20);
  assert.equal(A.decide('203.0.113.10', T0 + 20), 'blocked', 'A blocks its own new local ban with the store down');
  assert.equal(B.decide('192.0.2.5', T0 + 20), 'blocked', 'B blocks its own');
  assert.equal(B.ban('203.0.113.10'), null, 'not yet synced');
  assert.equal(A.pendingPushes(), 1, 'the push stays queued');
  store.setDown(false);
  await A.tick(T0 + 30);
  await B.tick(T0 + 30);
  assert.equal(B.ban('203.0.113.10') !== null, true, 'queued ban synced after recovery');
  assert.equal(B.decide('203.0.113.10', T0 + 30), 'blocked');
});

test('every SET in the write log carries EX > 0', async () => {
  const { store, A, B } = world();
  A.blockLocal('203.0.113.9', 'ban', 3600, T0);
  B.blockLocal('192.0.2.5', 'ban', 3600, T0);
  await A.tick(T0);
  await B.tick(T0);
  assert.ok(store.writeLog.length > 0);
  assert.ok(store.writeLog.every((w) => w.ex > 0));
});
