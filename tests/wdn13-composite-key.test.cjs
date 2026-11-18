'use strict';
// WDN-13 composite caller key - suite version of wdn-lab/wdn13.cjs.
// Frozen lab properties: identical requests key identically, different
// paths key differently, a missing characteristic falls the WHOLE key
// back to the bare IP (never merging strangers), a function
// characteristic contributes its value, an explicit characteristic
// list wins over the default, and a throwing characteristic is treated
// as absent with no exception escaping. Integration: the keyBy option
// on the quota guard keys the ip dimension by the composite key.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const qg = require('../dist/tier2-active/quota-guard.js');

const CH = ['ip', 'path'];
const ctxA1 = { ip: '1.1.1.1', path: '/a', method: 'GET' };
const ctxA2 = { ip: '1.1.1.1', path: '/b', method: 'GET' };

test('KEY-COMPOSITE: same-IP requests for /a and /b key differently; identical requests key identically', () => {
  assert.equal(qg.deriveCompositeKey(ctxA1, CH), '1.1.1.1|/a');
  assert.equal(qg.deriveCompositeKey(ctxA2, CH), '1.1.1.1|/b');
  assert.equal(qg.deriveCompositeKey({ ...ctxA1 }, CH), '1.1.1.1|/a');
});

test('KEY-FALLBACK: a path-less request keys as the bare IP, and path-less requests from two IPs key differently', () => {
  assert.equal(qg.deriveCompositeKey({ ip: '1.1.1.1', method: 'GET' }, CH), '1.1.1.1');
  assert.equal(qg.deriveCompositeKey({ ip: '2.2.2.2', method: 'GET' }, CH), '2.2.2.2');
});

test('KEY-FUNCTION: a function characteristic reading x-api-key contributes its value', () => {
  const fn = (ctx) => ctx.headers['x-api-key'];
  const ctx = { ip: '1.1.1.1', path: '/a', method: 'GET', headers: { 'x-api-key': 'k1' } };
  assert.equal(qg.deriveCompositeKey(ctx, ['ip', fn]), '1.1.1.1|k1');
});

test('KEY-PRECEDENCE: an explicit characteristic list wins over the default list for the same request', () => {
  assert.equal(qg.deriveCompositeKey(ctxA1, ['ip', 'method']), '1.1.1.1|GET');
  assert.equal(qg.deriveCompositeKey(ctxA1, CH), '1.1.1.1|/a');
});

test('KEY-THROW: a throwing characteristic is treated as absent - the key falls back to the IP and no exception escapes', () => {
  const throwing = () => { throw new Error('operator bug'); };
  let key;
  assert.doesNotThrow(() => { key = qg.deriveCompositeKey(ctxA1, ['ip', throwing]); });
  assert.equal(key, '1.1.1.1');
});

test('guard integration: with keyBy [ip, path] the same IP gets separate buckets per path; without keyBy the bucket is shared', async () => {
  const tiers = { anonymous: { maxRequests: 1, windowMs: 60000, maxPageSize: 25, maxPage: 5 } };
  const req = (path) => ({ url: `http://quota.test${path}`, method: 'GET', ip: '1.1.1.1', headers: { get: () => null } });

  const composite = qg.createQuotaGuard({ tiers, keyBy: ['ip', 'path'] });
  assert.equal((await composite.checkRequest(req('/a'))).allowed, true);
  assert.equal((await composite.checkRequest(req('/a'))).allowed, false); // same composite key, limit 1
  assert.equal((await composite.checkRequest(req('/b'))).allowed, true); // different composite key

  const plain = qg.createQuotaGuard({ tiers });
  assert.equal((await plain.checkRequest(req('/a'))).allowed, true);
  assert.equal((await plain.checkRequest(req('/b'))).allowed, false); // shared ip bucket

  const throwingGuard = qg.createQuotaGuard({ tiers, keyBy: ['ip', () => { throw new Error('boom'); }] });
  assert.equal((await throwingGuard.checkRequest(req('/a'))).allowed, true); // falls back to ip keying, no throw
});
