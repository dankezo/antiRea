'use strict';
// NHS-02 JA3/JA4/JA4T deny-list - suite version of nhs-lab/nhs02.cjs.
// Frozen expectations: 8/8 match rows flag (exact, case-insensitive),
// clean 0/2, near-miss and empty fail open.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const deny = require('../dist/tier2-active/tls-fingerprint-deny.js');

const JA4 = 't13d1516h2_8daaf6152771_b186095e22b6';
const JA3MD5 = 'e7d705a3286e19ea42f587b344ee6865';
const JA3RAW = '771,4865-4866,4867,0-23-65281,29-23-24,0';
const JA4T1 = '65535_2-4-6_1460_512';
const JA4T2 = '42300_2-4-6_1460_65535';

test('8/8 match rows flag across JA4, JA3 and JA4T', () => {
  const d = deny.createTlsFingerprintDenyList({
    ja4: [JA4], ja3: [JA3MD5, JA3RAW], ja4t: [JA4T1, JA4T2],
  });
  assert.equal(d.check('ja4', JA4).flagged, true);
  assert.equal(d.check('ja4', JA4.toUpperCase()).flagged, true);
  assert.equal(d.check('ja3', JA3MD5).flagged, true);
  assert.equal(d.check('ja3', JA3MD5.toUpperCase()).flagged, true);
  assert.equal(d.check('ja3', JA3RAW).flagged, true);
  assert.equal(d.check('ja4t', JA4T1).flagged, true);
  assert.equal(d.check('ja4t', JA4T2).flagged, true);
  const mixed = deny.createTlsFingerprintDenyList({ ja4: ['T13d1516H2_8daaf6152771_B186095e22b6'] });
  assert.equal(mixed.check('ja4', JA4).flagged, true, 'stored mixed case still matches');
});

test('clean rows 0/2 flag', () => {
  const d = deny.createTlsFingerprintDenyList({ ja3: [JA3MD5, JA3RAW], ja4: [JA4] });
  assert.equal(d.check('ja3', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').flagged, false);
  assert.equal(d.check('ja4', 't13d0000h2_000000000000_000000000000').flagged, false);
});

test('near-miss never flags: last-char flip and one-char-longer fail', () => {
  const d = deny.createTlsFingerprintDenyList({ ja3: [JA3MD5, JA3RAW] });
  assert.equal(d.check('ja3', JA3MD5.slice(0, 31) + '6').flagged, false);
  assert.equal(d.check('ja3', JA3MD5 + 'a').flagged, false);
});

test('empty value, null value and empty list all fail open', () => {
  const d = deny.createTlsFingerprintDenyList({ ja3: [JA3MD5] });
  assert.equal(d.check('ja3', '').flagged, false);
  assert.equal(d.check('ja3', null).flagged, false);
  assert.equal(d.check('ja3', undefined).flagged, false);
  const empty = deny.createTlsFingerprintDenyList({ ja3: [] });
  assert.equal(empty.check('ja3', JA3MD5).flagged, false);
  const none = deny.createTlsFingerprintDenyList();
  assert.equal(none.checkAll({ ja3: JA3MD5, ja4: JA4, ja4t: JA4T1 }).flagged, false);
});

test('checkAll flags iff any kind matches; results are advisory', () => {
  const d = deny.createTlsFingerprintDenyList({ ja4t: [JA4T1] });
  const all = d.checkAll({ ja3: JA3MD5, ja4: 'nope', ja4t: JA4T1 });
  assert.equal(all.flagged, true);
  assert.equal(all.results.ja4t.flagged, true);
  assert.equal(all.results.ja3.flagged, false);
  assert.equal(all.results.ja4t.enforcement, 'none');
  assert.equal(all.results.ja4t.kind, 'tls_fingerprint_deny');
});
