const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

test('RSP-05 rungs exact at hits 1,9,10,19,20,25,30,39,40,100,10000', () => {
  const hits = [1, 9, 10, 19, 20, 25, 30, 39, 40, 100, 10000];
  const expected = [0, 0, 2, 2, 5, 5, 10, 10, 20, 20, 20];
  assert.deepEqual(hits.map((h) => sdk.rspReconDelayForHits(h)), expected);
});

test('RSP-05 counter is shared across .env/.git/secrets; 10th mixed hit lands on rung 1', () => {
  const l = sdk.createRspReconLadder();
  const families = ['env', 'git', 'secrets'];
  let last = null;
  for (let i = 0; i < 10; i++) last = l.recordHit('10.5.0.1', families[i % 3]);
  assert.equal(last.hits, 10);
  assert.equal(last.delaySeconds, 2);
});

test('RSP-05 per-IP isolation holds; 9 shared-IP hits all draw 0 s', () => {
  const l = sdk.createRspReconLadder();
  for (let i = 0; i < 9; i++) assert.equal(l.recordHit('10.5.1.1', 'env').delaySeconds, 0);
  assert.equal(l.delaySecondsFor('10.5.1.2'), 0);
  assert.equal(l.hitsFor('10.5.1.2'), 0);
  assert.equal(l.hitsFor('10.5.1.1'), 9);
});
