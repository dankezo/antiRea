const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

test('RSP-17 safe budget measured first: default block stays under the 8 KiB proxy ceiling', () => {
  const b = sdk.createRspCookieBomb();
  const r = b.attach({ grantIndex: 0, recordable: true });
  assert.equal(r.bombCookies, 20);
  assert.equal(r.headers.length, 22, '20 bomb cookies plus 2 session cookies');
  assert.ok(r.totalBytes <= b.budgetBytes, `block ${r.totalBytes} must fit the budget ${b.budgetBytes}`);
  assert.ok(r.totalBytes < 8192, 'block must stay under the common 8 KiB proxy header ceiling');
});

test('RSP-17 grants 1 and 5 attach 0; non-recordable POSTs never reach attach', () => {
  const b = sdk.createRspCookieBomb();
  assert.equal(b.attach({ grantIndex: 1, recordable: true }).bombCookies, 0);
  assert.equal(b.attach({ grantIndex: 5, recordable: true }).bombCookies, 0);
  assert.equal(b.attach({ grantIndex: 0, recordable: false }).bombCookies, 0);
});

test('RSP-17 count=0 and size=0 both disable; a tighter budget shrinks cookies, never exceeds itself', () => {
  assert.equal(sdk.createRspCookieBomb({ count: 0 }).attach({ grantIndex: 0, recordable: true }).bombCookies, 0);
  assert.equal(sdk.createRspCookieBomb({ size: 0 }).attach({ grantIndex: 0, recordable: true }).bombCookies, 0);
  const tight = sdk.createRspCookieBomb({ budgetBytes: 2048 });
  const r = tight.attach({ grantIndex: 0, recordable: true });
  assert.ok(r.totalBytes <= 2048);
  assert.equal(r.bombCookies, 20);
});
