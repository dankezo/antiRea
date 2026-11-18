const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

test('RSP-08 roundtrip exact: owner sees the token, other IP 404, unknown id 404', () => {
  const c = sdk.createRspInjectionCanary({});
  const p = c.post('10.8.0.1', 'tok-abc');
  const own = c.view(p.id, '10.8.0.1');
  assert.equal(own.status, 200);
  assert.equal(own.post.token, 'tok-abc');
  assert.equal(c.view(p.id, '10.8.0.2').status, 404);
  assert.equal(c.view(999999, '10.8.0.1').status, 404);
});

test('RSP-08 flood: newest-512 survival 512/512 with monotonic ids and evict-oldest', () => {
  const c = sdk.createRspInjectionCanary({});
  const ids = [];
  for (let i = 0; i < 601; i++) ids.push(c.post('10.8.1.1', `tok-${i}`).id);
  assert.equal(c.size(), 512, 'store must cap at 512, never stall at 511 and never clear-all');
  assert.equal(new Set(ids).size, 601, 'monotonic ids must never collide');
  const newest = ids.slice(-512);
  let survived = 0;
  for (const id of newest) if (c.view(id, '10.8.1.1').status === 200) survived++;
  assert.equal(survived, 512);
  assert.equal(c.view(ids[0], '10.8.1.1').status, 404, 'oldest posts are evicted, not the newest');
});
