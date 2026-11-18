'use strict';
// WDN-05 JA3 static denylist - suite version of wdn-lab/wdn05.cjs.
// Frozen lab properties: known hashes 9/9 at score 0.8 / confidence 0.9,
// Chrome JA3 no match, unknown and empty fail open. No JA4 table exists.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ja3 = require('../dist/tier2-active/wdn-ja3-denylist.js');

test('JA3-KNOWN 9/9: every table hash matches with its frozen client name and score 0.8 / confidence 0.9', () => {
  const entries = Object.entries(ja3.KNOWN_BOT_JA3_HASHES);
  assert.equal(entries.length, 9);
  for (const [hash, name] of entries) {
    const d = ja3.checkJa3Fingerprint(hash);
    assert.ok(d, hash);
    assert.equal(d.clientName, name);
    assert.equal(d.score, 0.8);
    assert.equal(d.confidence, 0.9);
    assert.equal(d.reason, `TLS fingerprint matches: ${name}`);
    assert.equal(d.enforcement, 'none');
  }
});

test('JA3-BROWSER: the Chrome JA3 does not match', () => {
  assert.equal(ja3.checkJa3Fingerprint('cd08e31494f9531f560d64c695473da9'), null);
});

test('JA3-UNKNOWN: a 32-hex value absent from the table does not match (exact match only)', () => {
  const unknown = '0123456789abcdef0123456789abcdef';
  assert.ok(!(unknown in ja3.KNOWN_BOT_JA3_HASHES));
  assert.equal(ja3.checkJa3Fingerprint(unknown), null);
});

test('JA3-EMPTY: empty string, null and undefined produce no detection', () => {
  assert.equal(ja3.checkJa3Fingerprint(''), null);
  assert.equal(ja3.checkJa3Fingerprint(null), null);
  assert.equal(ja3.checkJa3Fingerprint(undefined), null);
});

test('no JA4 surface is exported (no JA4 data exists in the lab record)', () => {
  assert.equal(ja3.KNOWN_BOT_JA4_HASHES, undefined);
  assert.equal(ja3.checkJa4Fingerprint, undefined);
});
