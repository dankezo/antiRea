'use strict';
// NHS-06 header anomaly - suite version of nhs-lab/nhs06.cjs. Frozen
// expectations: each single-violation row fires exactly its own
// check, clean rows 0, first-match wins, and the recorded gap:
// HTTP/2 without Host does NOT fire check 1.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ha = require('../dist/tier2-active/header-anomaly.js');

const run = (httpVersion, headers) => ha.analyzeHeaderAnomaly({ httpVersion, headers });

test('each single-violation row fires exactly its own check', () => {
  assert.equal(run(1.1, [['User-Agent', 'x'], ['Accept', 'y']]).check, 1);
  assert.equal(run(1.1, [['Host', 'a'], ['Content-Length', '5'], ['Transfer-Encoding', 'chunked'], ['User-Agent', 'x'], ['Accept', 'y']]).check, 2);
  assert.equal(run(1.1, [['Host', 'a'], ['host', 'b'], ['User-Agent', 'x'], ['Accept', 'y']]).check, 3);
  assert.equal(run(1.1, [['Host', 'a']]).check, 4);
});

test('clean rows fire 0', () => {
  assert.equal(run(1.1, [['Host', 'a'], ['User-Agent', 'x'], ['Accept', 'y'], ['Accept-Encoding', 'gzip'], ['Accept-Language', 'en']]).check, 0);
  assert.equal(run(1.1, [['Host', 'a'], ['User-Agent', 'x'], ['Accept', 'y']]).check, 0);
});

test('exceptions hold: HTTP/1.0 without Host, and Accept without UA, fire nothing', () => {
  assert.equal(run(1.0, [['User-Agent', 'x'], ['Accept', 'y']]).check, 0);
  assert.equal(run(1.1, [['Host', 'a'], ['Accept', 'y']]).check, 0);
});

test('first-match wins: the double-violation row fires check 1 only', () => {
  const r = run(1.1, [['Content-Length', '5'], ['Transfer-Encoding', 'chunked'], ['User-Agent', 'x'], ['Accept', 'y']]);
  assert.equal(r.check, 1);
  assert.equal(r.name, 'http11_without_host');
});

test('recorded gap: HTTP/2 without Host does not fire check 1', () => {
  const r = run(2.0, [['User-Agent', 'x'], ['Accept', 'y']]);
  assert.equal(r.check, 0);
  assert.equal(r.flagged, false);
});

test('duplicate Host detection is case-insensitive; result is advisory', () => {
  const r = run(1.1, [['Host', 'a'], ['HOST', 'b'], ['User-Agent', 'x'], ['Accept', 'y']]);
  assert.equal(r.check, 3);
  assert.equal(r.name, 'duplicate_host');
  assert.equal(r.enforcement, 'none');
});
