'use strict';
// NHS-01 JA4H - suite version of nhs-lab/nhs01.cjs. Expectations are
// the frozen Step-0 semantics: order-INVARIANT (the bag's order claim
// was a defect), sensitivity is the header-name SET (6/6), values do
// not matter, 64-name silent truncation, zero hash only on overflow.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ja4h = require('../dist/tier2-active/ja4h.js');

const R0 = {
  method: 'GET', httpVersion: 1.1,
  headers: [['Host', 'example.com'], ['User-Agent', 'Mozilla/5.0'], ['Accept', 'text/html'],
    ['Accept-Language', 'en-US,en;q=0.9'], ['Accept-Encoding', 'gzip, deflate, br'],
    ['Connection', 'keep-alive']],
};
const clone = (r) => JSON.parse(JSON.stringify(r));
const withHeaders = (r, headers) => ({ method: r.method, httpVersion: r.httpVersion, headers });
const setHeader = (r, name, value) => withHeaders(r, r.headers.map(([n, v]) => (n === name ? [n, value] : [n, v])));
const addHeader = (r, name, value) => withHeaders(r, [...r.headers, [name, value]]);
const hash = (r) => ja4h.computeJa4h(r).hash;

test('base hash is stable, 24 hex chars, non-zero, and matches the lab base value', () => {
  const h0 = hash(R0);
  assert.equal(h0, hash(clone(R0)));
  assert.equal(h0.length, 24);
  assert.notEqual(h0, '0'.repeat(24));
  assert.equal(h0, '1a070cdb5d73705a3041a123');
});

test('order-invariant: reversed GET and shuffled POST hash identically to base', () => {
  const h0 = hash(R0);
  assert.equal(hash(withHeaders(R0, [...R0.headers].reverse())), h0);
  const postBase = { method: 'POST', httpVersion: 1.1, headers: R0.headers };
  const postShuffled = { method: 'POST', httpVersion: 1.1, headers: [R0.headers[3], R0.headers[0], R0.headers[5], R0.headers[1], R0.headers[4], R0.headers[2]] };
  assert.equal(hash(postShuffled), hash(postBase));
  assert.equal(hash(postBase), '363fe48b813694d724543eb3');
});

test('header values do not matter: UA and Accept value changes keep the hash', () => {
  const h0 = hash(R0);
  assert.equal(hash(setHeader(R0, 'User-Agent', 'Other/2.0')), h0);
  assert.equal(hash(setHeader(R0, 'Accept', '*/*')), h0);
});

test('sensitivity is the name set: 6/6 single-component changes alter the hash', () => {
  const h0 = hash(R0);
  const sens = [
    { method: 'POST', httpVersion: 1.1, headers: R0.headers },
    { method: 'GET', httpVersion: 1.0, headers: R0.headers },
    addHeader(R0, 'Cookie', 'a=b'),
    addHeader(R0, 'Referer', 'https://example.com/'),
    setHeader(R0, 'Accept-Language', 'fr-FR,fr;q=0.9'),
    addHeader(R0, 'X-Test', '1'),
  ];
  for (const r of sens) assert.notEqual(hash(r), h0);
});

test('language enters as first tag only', () => {
  assert.equal(hash(setHeader(R0, 'Accept-Language', 'en-US,de-DE')), hash(R0));
});

test('cap: 65+ headers truncate silently at the first 64 names (non-zero hash)', () => {
  const capHeaders = [['Host', 'h']];
  for (let i = 1; i <= 65; i++) capHeaders.push(['X-H-' + String(i).padStart(2, '0'), 'v']);
  const capHash = hash({ method: 'GET', httpVersion: 1.1, headers: capHeaders });
  const trunc64 = hash({ method: 'GET', httpVersion: 1.1, headers: capHeaders.slice(0, 64) });
  const trunc63 = hash({ method: 'GET', httpVersion: 1.1, headers: capHeaders.slice(0, 63) });
  assert.equal(capHash, '94336258c45dc45582d80f2e');
  assert.equal(capHash, trunc64);
  assert.notEqual(capHash, trunc63);
  assert.notEqual(capHash, '0'.repeat(24));
});

test('overflow: 64 x 80-char names yield exactly the zero hash', () => {
  const longHeaders = [];
  for (let i = 0; i < 64; i++) longHeaders.push(['X-' + 'a'.repeat(78), 'v']);
  assert.equal(hash({ method: 'GET', httpVersion: 1.1, headers: longHeaders }), '000000000000000000000000');
});

test('result shape: advisory only, cookie/referer bits and count reported', () => {
  const r = ja4h.computeJa4h(addHeader(R0, 'Cookie', 'a=b'));
  assert.equal(r.kind, 'ja4h');
  assert.equal(r.enforcement, 'none');
  assert.equal(r.hasCookie, true);
  assert.equal(r.hasReferer, false);
  assert.equal(r.headerCount, 6);
  assert.equal(r.language, 'en-US');
});
