'use strict';
// NHS-04 C2 IP deny table - suite version of nhs-lab/nhs04.cjs.
// Frozen expectations: longest prefix wins (/32 over covering /24),
// outside queries miss, non-IP returns null, empty table fails open.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dt = require('../dist/tier2-active/ip-deny-table.js');

const ENTRIES = [
  { cidr: '203.0.113.7/32', id: 'A' },
  { cidr: '198.51.100.0/24', id: 'B' },
  { cidr: '198.51.100.9/32', id: 'C' },
  { cidr: '192.0.2.55/32', id: 'E' },
  { cidr: '2001:db8::/32', id: 'D' },
];

test('hits: exact /32 entries and the covering /24 match', () => {
  const t = dt.createIpDenyTable(ENTRIES);
  assert.equal(t.lookup('203.0.113.7').id, 'A');
  assert.equal(t.lookup('192.0.2.55').id, 'E');
  assert.equal(t.lookup('198.51.100.10').id, 'B');
  assert.equal(t.lookup('2001:db8::1').id, 'D');
});

test('longest prefix wins: /32 entry C beats covering /24 entry B', () => {
  const t = dt.createIpDenyTable(ENTRIES);
  const m = t.lookup('198.51.100.9');
  assert.equal(m.id, 'C');
  assert.equal(m.prefixLength, 32);
  assert.equal(m.cidr, '198.51.100.9/32');
});

test('outside queries miss: one-bit-outside and outside-/24 return null', () => {
  const t = dt.createIpDenyTable(ENTRIES);
  assert.equal(t.lookup('198.51.101.9'), null);
  assert.equal(t.lookup('203.0.113.8'), null);
  assert.equal(t.lookup('8.8.8.8'), null);
});

test('non-IP inputs return null without throwing', () => {
  const t = dt.createIpDenyTable(ENTRIES);
  assert.equal(t.lookup('unix:/var/run/sock'), null);
  assert.equal(t.lookup(''), null);
  assert.equal(t.lookup('999.1.1.1'), null);
});

test('empty table fails open', () => {
  const t = dt.createIpDenyTable([]);
  assert.equal(t.lookup('203.0.113.7'), null);
  assert.equal(t.size(), 0);
});

test('invalid entry is a loud construction error, not a silent hole', () => {
  assert.throws(() => dt.createIpDenyTable([{ cidr: 'not-a-cidr', id: 'X' }]), TypeError);
  assert.throws(() => dt.createIpDenyTable([{ cidr: '10.0.0.0/33', id: 'X' }]), TypeError);
});
