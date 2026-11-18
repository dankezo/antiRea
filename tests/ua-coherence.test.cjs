'use strict';
// NHS-05 UA coherence - suite version of nhs-lab/nhs05.cjs. Frozen
// expectations: flag stratum 6/6, clean 0/2, scope 0/4 (curl, empty
// and absent UA never flag). Flag on ANY missing component.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const uc = require('../dist/tier2-active/ua-coherence.js');

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
const FULL = { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US', 'accept-encoding': 'gzip, deflate, br' };
const drop = (h, k) => { const c = { ...h }; delete c[k]; return c; };
const run = (userAgent, headers, httpVersion) => uc.analyzeUaCoherence({ userAgent, headers, httpVersion });

test('flag stratum 6/6: each single missing component flags', () => {
  assert.equal(run(CHROME, drop(FULL, 'accept'), 1.1).flagged, true);
  assert.equal(run(CHROME, drop(FULL, 'accept-language'), 1.1).flagged, true);
  assert.equal(run(CHROME, { ...FULL, 'accept-encoding': 'identity' }, 1.1).flagged, true);
  assert.equal(run(CHROME, FULL, 1.0).flagged, true);
  assert.equal(run(FIREFOX, drop(FULL, 'accept-language'), 1.1).flagged, true);
  const all = run(CHROME, { 'accept-encoding': 'identity' }, 1.0);
  assert.equal(all.flagged, true);
  assert.deepEqual(all.missing, ['accept', 'accept_language', 'accept_encoding_compression', 'http_version']);
});

test('clean stratum 0/2: complete Chrome and Firefox shapes do not flag', () => {
  assert.equal(run(CHROME, FULL, 1.1).flagged, false);
  assert.equal(run(FIREFOX, FULL, 1.1).flagged, false);
  assert.deepEqual(run(CHROME, FULL, 1.1).missing, []);
});

test('scope stratum 0/4: curl, empty and absent UA never flag', () => {
  assert.equal(run('curl/8.4.0', {}, 1.1).flagged, false);
  assert.equal(run('curl/8.4.0', FULL, 1.1).flagged, false);
  assert.equal(run('', {}, 1.1).flagged, false);
  assert.equal(run(null, {}, 1.1).flagged, false);
  assert.equal(run('curl/8.4.0', {}, 1.1).inScope, false);
});

test('gzip/br test is case-sensitive, following the source code over its comment', () => {
  const r = run(CHROME, { ...FULL, 'accept-encoding': 'GZIP, BR' }, 1.1);
  assert.equal(r.flagged, true);
  assert.deepEqual(r.missing, ['accept_encoding_compression']);
});

test('advisory only', () => {
  assert.equal(run(CHROME, {}, 1.0).enforcement, 'none');
});
