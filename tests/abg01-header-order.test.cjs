'use strict';
// ABG-01 header-order library fingerprint - suite version of abg-lab/abg01.cjs.
// Expectations are the frozen Step-0 gates (REGISTRATION-ABG-STEP0.md,
// seed 20321201): 6/6 library orders flag, 0/3 browser orders flag,
// shuffled order does not flag, CTRL-A/B/C per R-ABG-1.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../dist/tier2-active/header-order-fingerprint.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const L = [
  ['User-Agent', 'Accept-Encoding', 'Accept', 'Connection'],
  ['User-Agent', 'Accept-Encoding', 'Accept'],
  ['User-Agent', 'Accept'],
  ['User-Agent', 'Accept-Encoding'],
  ['Accept', 'Accept-Encoding', 'Accept-Language', 'User-Agent', 'Connection'],
  ['Accept', 'Accept-Encoding', 'Accept-Language', 'User-Agent'],
];
const B = [
  ['Sec-Ch-Ua', 'Sec-Ch-Ua-Mobile', 'Sec-Ch-Ua-Platform', 'Upgrade-Insecure-Requests', 'User-Agent', 'Accept', 'Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-User', 'Accept-Encoding', 'Accept-Language', 'Cookie'],
  ['User-Agent', 'Accept', 'Accept-Language', 'Accept-Encoding', 'Connection', 'Upgrade-Insecure-Requests', 'Sec-Fetch-Dest', 'Sec-Fetch-Mode', 'Sec-Fetch-Site', 'Sec-Fetch-User'],
  ['User-Agent', 'Accept', 'Accept-Language', 'Accept-Encoding', 'Connection'],
];

test('ABG-01: all 6 library orders flag (6/6)', () => {
  for (const names of L) assert.equal(m.isLibraryHeaderOrder(names), true, names.join(':'));
});

test('ABG-01: no browser order flags (0/3), including the Firefox/Safari prefix orders', () => {
  for (const names of B) assert.equal(m.isLibraryHeaderOrder(names), false, names.join(':'));
});

test('ABG-01: shuffled python-requests order does not flag', () => {
  assert.equal(m.isLibraryHeaderOrder(['Accept', 'User-Agent', 'Connection', 'Accept-Encoding']), false);
});

test('ABG-01 CTRL-A: Chrome UA + curl order flags (order drives, UA irrelevant)', () => {
  const r = m.analyzeHeaderOrder({ headerNames: ['User-Agent', 'Accept'], userAgent: 'Mozilla/5.0 Chrome/131.0.0.0' });
  assert.equal(r.flagged, true);
  assert.equal(r.enforcement, 'none');
});

test('ABG-01 CTRL-B: python-requests UA + Chrome order does not flag', () => {
  const r = m.analyzeHeaderOrder({ headerNames: B[0], userAgent: 'python-requests/2.32.3' });
  assert.equal(r.flagged, false);
});

test('ABG-01 CTRL-C: one renamed header breaks the signature', () => {
  assert.equal(m.isLibraryHeaderOrder(['User-Agent', 'X-Accept']), false);
});

test('ABG-01: exported orders hash exactly to the frozen signature set', () => {
  const computed = m.LIBRARY_HEADER_ORDERS.map((o) => m.headerOrderSignature(o)).sort();
  assert.deepEqual(computed, [...m.LIBRARY_HEADER_ORDER_SIGS].sort());
});

test('ABG-01: host header is excluded and case is normalised', () => {
  assert.equal(m.isLibraryHeaderOrder(['Host', 'USER-AGENT', 'Accept']), true);
});

test('ABG-01 descriptive: seeded shuffle breaks the signature in 9/10 draws (seed 20321201)', () => {
  const rand = mulberry32(20321201);
  const base = ['User-Agent', 'Accept-Encoding', 'Accept', 'Connection'];
  let flagged = 0;
  for (let i = 0; i < 10; i++) {
    const arr = base.slice();
    for (let j = arr.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [arr[j], arr[k]] = [arr[k], arr[j]];
    }
    if (m.isLibraryHeaderOrder(arr)) flagged++;
  }
  assert.equal(flagged, 1, 'the 1 flagged draw is the identity permutation');
});
