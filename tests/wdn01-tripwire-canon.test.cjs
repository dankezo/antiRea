'use strict';
// WDN-01 tripwire path canonicalization - suite version of wdn-lab/wdn01.cjs.
// Frozen lab properties: disguised 4/4 canonicalize and match, clean 4/4,
// query/fragment stripped, near-miss 0/2, the 5-level encoding correctly
// unmatched (4-pass bound), and dot segments clamped at the root.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const hm = require('../dist/tier2-active/honeypot-middleware.js');

const matcher = hm.createTripwireMatcher();

test('CANON-DISGUISED 4/4: disguised paths canonicalize to the frozen forms and match', () => {
  const cases = [
    ['//.env', '/.env'],
    ['/x/..%2f.git/config', '/.git/config'],
    ['/%2Eenv', '/.env'],
    ['/%252Eenv', '/.env'],
  ];
  for (const [input, canon] of cases) {
    assert.equal(hm.canonicalizeTripwirePath(input), canon, input);
    assert.equal(matcher.matches(input), true, input);
  }
});

test('CANON-CLEAN 4/4 and CANON-STRIP 2/2: clean paths and query/fragment forms match', () => {
  for (const p of ['/.env', '/.git/config', '/.env.local', '/.ssh/id_rsa']) {
    assert.equal(matcher.matches(p), true, p);
  }
  for (const p of ['/.env?x=1', '/.env#frag']) {
    assert.equal(matcher.matches(p), true, p);
  }
});

test('CANON-NEARMISS 0/2: near-miss paths do not match (no match-surface widening)', () => {
  for (const p of ['/.env.bak', '/x/.env']) {
    assert.equal(matcher.matches(p), false, p);
    assert.equal(hm.isTripwirePath(p), false, p);
  }
});

test('CANON-CAP: the 5-level encoding does not match (the 4-pass bound bites)', () => {
  assert.equal(matcher.matches('/%252525252Eenv'), false);
});

test('CANON-CLAMP: /a/../../.env canonicalizes to /.env, in-root with no residual dot segments', () => {
  assert.equal(hm.canonicalizeTripwirePath('/a/../../.env'), '/.env');
});

test('descriptive: the bag literal 4-level string canonicalizes fully and matches (R-WDN-2 miscount on record)', () => {
  assert.equal(hm.canonicalizeTripwirePath('/%2525252Eenv'), '/.env');
  assert.equal(matcher.matches('/%2525252Eenv'), true);
});

test('the default trap set is the frozen 18-entry lab set', () => {
  assert.equal(hm.DEFAULT_TRIPWIRE_PATHS.length, 18);
  assert.equal(matcher.paths.size, 18);
});
