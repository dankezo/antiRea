'use strict';
// ABG-06 NAT-aware threshold doubling, opt-in modifier form - suite
// version of abg-lab/abg06.cjs. Frozen gates (seed 20321206): 4
// legit-looking identities keep 50; 5 double to 100; 5 hostile-
// looking keep 50; 5 stale keep 50; after +3601 s the doubled IP is
// back to 50. Every scenario runs 10 seeded replicas and all must
// agree, exactly as in the lab.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../dist/tier2-active/nat-threshold-modifier.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20321206);
const NOW = 1_000_000_000; // ms
const IP = '203.0.113.99';
const legit = (i, seenAgoS) => ({
  identity: `id-${i}`, lastIp: IP, lastSeenMs: NOW - seenAgoS * 1000,
  staticLoads: 1 + Math.floor(rand() * 5), allowedCount: 3 + Math.floor(rand() * 10),
});
const hostile = (i, seenAgoS) => ({
  identity: `hx-${i}`, lastIp: IP, lastSeenMs: NOW - seenAgoS * 1000,
  staticLoads: 1 + Math.floor(rand() * 5), allowedCount: Math.floor(rand() * 3),
});
function replicas(make, atMs) {
  const out = [];
  for (let r = 0; r < 10; r++) out.push(m.natAwareThreshold(make(), IP, atMs ?? NOW));
  return out;
}

test('ABG-06 gate A: 4 legit-looking identities keep the threshold at 50 (10/10 replicas)', () => {
  for (const r of replicas(() => Array.from({ length: 4 }, (_, i) => legit(i, 100 + i * 10)))) {
    assert.equal(r.legitLookingCount, 4);
    assert.equal(r.threshold, 50);
    assert.equal(r.doubled, false);
  }
});

test('ABG-06 gate B: 5 legit-looking identities double the threshold to 100 (10/10 replicas)', () => {
  for (const r of replicas(() => Array.from({ length: 5 }, (_, i) => legit(i, 100 + i * 10)))) {
    assert.equal(r.legitLookingCount, 5);
    assert.equal(r.threshold, 100);
    assert.equal(r.doubled, true);
  }
});

test('ABG-06 gate C: 5 hostile-looking identities keep 50 (allowed_count < 3 never counts)', () => {
  for (const r of replicas(() => Array.from({ length: 5 }, (_, i) => hostile(i, 100 + i * 10)))) {
    assert.equal(r.legitLookingCount, 0);
    assert.equal(r.threshold, 50);
  }
});

test('ABG-06 gate D: 5 legit-looking identities seen 3601 s ago keep 50 (stale does not count)', () => {
  for (const r of replicas(() => Array.from({ length: 5 }, (_, i) => legit(i, 3601 + i * 10)))) {
    assert.equal(r.legitLookingCount, 0);
    assert.equal(r.threshold, 50);
  }
});

test('ABG-06 control (c): the doubled threshold returns to 50 as identities age out (+3601 s)', () => {
  for (let r = 0; r < 10; r++) {
    const ids = Array.from({ length: 5 }, (_, i) => legit(i, 100 + i * 10));
    const later = m.natAwareThreshold(ids, IP, NOW + 3601 * 1000);
    assert.equal(later.legitLookingCount, 0);
    assert.equal(later.threshold, 50);
  }
});

test('ABG-06: the stateful modifier is inert until wired - identities at another IP change nothing', () => {
  const mod = m.createNatThresholdModifier();
  for (let i = 0; i < 5; i++) {
    mod.observeIdentity({ identity: `id-${i}`, lastIp: '198.51.100.7', lastSeenMs: NOW - 100_000, staticLoads: 2, allowedCount: 5 });
  }
  assert.equal(mod.effectiveThreshold(IP, NOW).threshold, 50);
  assert.equal(mod.effectiveThreshold('198.51.100.7', NOW).threshold, 100);
  assert.equal(m.NAT_BASE_THRESHOLD, 50);
  assert.equal(m.NAT_DOUBLED_THRESHOLD, 100);
  assert.equal(m.NAT_IDENTITIES_THRESHOLD, 5);
});
