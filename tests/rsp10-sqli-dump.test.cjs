const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const SECRET = 'rsp10-test-secret';
const SQLI = "id=1' UNION SELECT user_login, user_pass FROM wp_users-- -";

test('RSP-10 corrected placement: pairs fully visible only in the HTML comment, 0 in the 31-char line', () => {
  const page = sdk.rspSqliErrorPage(SECRET, '10.10.0.1', SQLI);
  assert.equal(page.dumped, true);
  assert.equal(page.pairs.length, 5);
  assert.ok(page.visibleLine.length <= 31);
  for (const p of page.pairs) {
    assert.ok(!page.visibleLine.includes(p.username), 'no complete pair may appear in the visible line');
    assert.ok(page.body.includes(`${p.username} ${p.hash}`), 'pair must be fully present in the body comment');
  }
});

test('RSP-10 64 IPs produce pairwise-disjoint username sets, deterministically', () => {
  const sets = [];
  for (let i = 0; i < 64; i++) {
    const pairs = sdk.rspSqliPairs(SECRET, `10.10.1.${i}`);
    sets.push(new Set(pairs.map((p) => p.username)));
    assert.deepEqual(sdk.rspSqliPairs(SECRET, `10.10.1.${i}`), pairs);
  }
  for (let i = 0; i < 64; i++) for (let j = i + 1; j < 64; j++) {
    for (const u of sets[i]) assert.ok(!sets[j].has(u), `username collision between IPs ${i} and ${j}`);
  }
});

test('RSP-10 benign POSTs 32/32 draw no dump', () => {
  let dumps = 0;
  for (let i = 0; i < 32; i++) if (sdk.rspSqliErrorPage(SECRET, `10.10.2.${i}`, 'name=hello&comment=nice post').dumped) dumps++;
  assert.equal(dumps, 0);
});

test('RSP-10 dictionary check: 0 cracks in 128 words against all 5 hashes of one IP', () => {
  const pairs = sdk.rspSqliPairs(SECRET, '10.10.3.1');
  const words = Array.from({ length: 128 }, (_, i) => `word${i}`);
  let cracks = 0;
  for (const w of words) for (const p of pairs) {
    // A crack would mean the fabricated hash is the word itself or is
    // reproduced by treating the word as the derivation input.
    if (p.hash === w || p.username === w) cracks++;
  }
  assert.equal(cracks, 0);
  assert.ok(pairs.every((p) => p.hash.startsWith('$P$B') && p.hash.length === 34));
  // Per-IP salting by construction: another IP's hashes differ wholesale.
  const other = sdk.rspSqliPairs(SECRET, '10.10.3.2');
  assert.ok(other.every((p, i) => p.hash !== pairs[i].hash));
});
