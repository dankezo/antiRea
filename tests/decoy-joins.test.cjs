'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const SECRET = 'joins-test-secret';
const PARENTS = [
  { supplierId: 'SUP-{tag}-01', name: 'Northgate Trading' },
  { supplierId: 'SUP-{tag}-02', name: 'Saigon Agro Export' },
];
const CHILDREN = [
  { contractId: 'CT-1', supplierId: 'SUP-{tag}-01' },
  { contractId: 'CT-2', supplierId: 'SUP-{tag}-02' },
  { contractId: 'CT-3', supplierId: 'SUP-{tag}-01' },
];

test('gated tag: 6 hex chars, deterministic, keyed by secret and identity', () => {
  const tag = sdk.gatedTagForIdentity(SECRET, 'key-A');
  assert.match(tag, /^[0-9a-f]{6}$/);
  assert.equal(tag, sdk.gatedTagForIdentity(SECRET, 'key-A'));
  assert.notEqual(tag, sdk.gatedTagForIdentity(SECRET, 'key-B'));
  assert.notEqual(tag, sdk.gatedTagForIdentity('other-secret', 'key-A'));
  assert.throws(() => sdk.gatedTagForIdentity(SECRET, ''), sdk.DecoyJoinsError);
});

test('gatedIdFor replaces the placeholder, or appends the tag when there is none', () => {
  const tag = sdk.gatedTagForIdentity(SECRET, 'key-A');
  assert.equal(sdk.gatedIdFor(SECRET, 'key-A', 'SUP-{tag}-01'), `SUP-${tag}-01`);
  assert.equal(sdk.gatedIdFor(SECRET, 'key-A', 'PLAIN-7'), `PLAIN-7-${tag}`);
});

test('trial pins (v3 IDJ): same-identity capture orphans 0%, mixed-identity orphans 100%', () => {
  const parentsA = sdk.gateRecordIds(PARENTS, SECRET, 'key-A', ['supplierId']);
  const childrenA = sdk.gateRecordIds(CHILDREN, SECRET, 'key-A', ['supplierId']);
  const childrenB = sdk.gateRecordIds(CHILDREN, SECRET, 'key-B', ['supplierId']);
  const same = sdk.resolveJoins(parentsA, 'supplierId', childrenA, 'supplierId');
  assert.equal(same.orphanRate, 0);
  assert.equal(same.resolved.length, 3);
  const mixed = sdk.resolveJoins(parentsA, 'supplierId', childrenB, 'supplierId');
  assert.equal(mixed.orphanRate, 1);
  assert.equal(mixed.orphans.length, 3);
});

test('gateRecordIds leaves non-string fields and inputs untouched', () => {
  const input = [{ supplierId: 'SUP-{tag}-01', rank: 3, note: null }];
  const out = sdk.gateRecordIds(input, SECRET, 'key-A', ['supplierId', 'rank', 'note']);
  assert.equal(out[0].rank, 3);
  assert.equal(out[0].note, null);
  assert.equal(input[0].supplierId, 'SUP-{tag}-01', 'input not mutated');
});

test('resolveJoins with no children reports a zero orphan rate', () => {
  const r = sdk.resolveJoins(PARENTS, 'supplierId', [], 'supplierId');
  assert.equal(r.orphanRate, 0);
  assert.deepEqual(r.orphans, []);
});
