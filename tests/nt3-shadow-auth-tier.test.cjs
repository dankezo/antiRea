'use strict';
/*
 * N-T3 shadow auth tier (3.3.2) - direct-module tests.
 * The module is required from dist directly (the coordinator wires
 * the index export at integration). Flag gate mirrors the lab
 * twin's registered gate: identities starting with "atk-nt" are
 * flagged; every other identity is clean.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require('../dist/tier2-active/shadow-auth-tier.js');
const { req } = require('./fixtures/decoy-registry.cjs');

const flagged = (identity) => identity.startsWith('atk-nt');
const enabledHandler = (extra = {}) => mod.createShadowAuthTier({ enabled: true, isFlagged: flagged, ...extra });

const FLAGGED = { 'x-identity': 'atk-nt3-on-1' };
const CLEAN = { 'x-identity': 'sess-clean-1' };
const EXAMPLE_AUTH = { authorization: 'Bearer demo-readonly-token' };
const demoLogin = (headers, body) => {
  const r = req('/api/auth/login', headers, 'POST');
  r.body = body === undefined ? JSON.stringify({ username: 'partner-demo', password: 'demo-pass' }) : body;
  return r;
};

test('disabled by default: nothing is handled, so the real auth flow is byte-identical', async () => {
  const off = mod.createShadowAuthTier({ isFlagged: flagged });
  assert.equal(off.enabled, false);
  assert.equal((await off.handle(demoLogin(FLAGGED))).handled, false);
  assert.equal((await off.handle(req('/api/account/records', { ...FLAGGED, ...EXAMPLE_AUTH }))).handled, false);
  const bare = mod.createShadowAuthTier();
  assert.equal(bare.enabled, false);
  assert.equal((await bare.handle(demoLogin(FLAGGED))).handled, false);
});

test('enabled without an isFlagged gate fails fast - there is no ungated mode', () => {
  assert.throws(() => mod.createShadowAuthTier({ enabled: true }), mod.ShadowAuthTierError);
  assert.throws(() => mod.createShadowAuthTier({ enabled: true, isFlagged: 'yes' }), mod.ShadowAuthTierError);
});

test('unflagged identity: handled:false on both auth paths (real flow untouched, P-T3c)', async () => {
  const h = enabledHandler();
  assert.equal((await h.handle(demoLogin(CLEAN))).handled, false, 'clean demo login passes through');
  assert.equal((await h.handle(req('/api/account/records', { ...CLEAN, ...EXAMPLE_AUTH }))).handled, false, 'clean example-token read passes through');
  // No identity header at all resolves to "anonymous", which is not flagged.
  assert.equal((await h.handle(req('/api/account/records', EXAMPLE_AUTH))).handled, false);
});

test('flagged identity with wrong or absent credentials passes through untouched', async () => {
  const h = enabledHandler();
  const wrong = demoLogin(FLAGGED, JSON.stringify({ username: 'partner-demo', password: 'nope' }));
  assert.equal((await h.handle(wrong)).handled, false);
  assert.equal((await h.handle(req('/api/account/records', FLAGGED))).handled, false, 'no credential');
  assert.equal((await h.handle(req('/api/account/records', { ...FLAGGED, authorization: 'Bearer rt_real_session_token' }))).handled, false, 'real-shaped token is the host\u2019s business, never answered here');
  assert.equal((await h.handle(req('/api/other', { ...FLAGGED, ...EXAMPLE_AUTH }))).handled, false, 'unowned path');
  assert.equal((await h.handle(req('/api/account/records', { ...FLAGGED, ...EXAMPLE_AUTH }, 'POST'))).handled, false, 'wrong method');
});

test('flagged shadow login succeeds with the documented demo credentials and yields partner_readonly', async () => {
  const h = enabledHandler();
  const r = await h.handle(demoLogin(FLAGGED));
  assert.equal(r.handled, true);
  assert.equal(r.isDecoy, true);
  assert.equal(r.status, 200);
  assert.equal(r.role, 'partner_readonly');
  const body = JSON.parse(r.body);
  assert.equal(body.role, 'partner_readonly');
  assert.equal(body.token, 'demo-readonly-token', 'login issues the documented example credential, closing the twin\u2019s docs loop');
  assert.equal(body.token_type, 'Bearer');
  assert.equal(body.permissions['records:read'], true);
  assert.equal(body.permissions.admin, false);
  // Object-form bodies (host body parser) work identically.
  const r2 = await h.handle(demoLogin(FLAGGED, { username: 'partner-demo', password: 'demo-pass' }));
  assert.equal(r2.status, 200);
  assert.equal(JSON.parse(r2.body).role, 'partner_readonly');
});

test('flagged records read returns ONLY SKU-900xx decoy records and fake-namespace account ids', async () => {
  const h = enabledHandler();
  const login = JSON.parse((await h.handle(demoLogin(FLAGGED))).body);
  const r = await h.handle(req('/api/account/records', { ...FLAGGED, authorization: `Bearer ${login.token}` }));
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.role, 'partner_readonly');
  assert.equal(body.records.length, 30);
  for (const rec of body.records) {
    assert.match(rec.sku, /^SKU-900\d{2}$/, rec.sku);
    assert.equal(rec.tier, 'partner_readonly');
    assert.ok(rec.accountId.startsWith('shadow-account-'), rec.accountId);
  }
  assert.equal(body.account_id, mod.SHADOW_ACCOUNT_ID);
  assert.ok(body.account_id.startsWith('shadow-account-'));
});

test('no code path can emit a real-shaped record: payload scan over every shadow serve', async () => {
  const h = enabledHandler();
  const serves = [
    await h.handle(demoLogin(FLAGGED)),
    await h.handle(req('/api/account/records', { ...FLAGGED, ...EXAMPLE_AUTH })),
  ];
  for (const r of serves) {
    assert.equal(r.handled, true);
    assert.doesNotMatch(r.body, /ACCT-\d/, 'no real-shaped ACCT-* id anywhere in a shadow response (P-T3b)');
    const skus = r.body.match(/SKU-\d+/g) ?? [];
    for (const sku of skus) assert.match(sku, /^SKU-900\d{2}$/, sku);
    const accountIds = r.body.match(/shadow-account-\d+/g) ?? [];
    assert.ok(accountIds.length >= 1, 'fake-namespace account id present');
  }
  // The exported record set itself is confined to the decoy namespace.
  assert.equal(mod.SHADOW_RECORDS.length, 30);
  assert.equal(mod.SHADOW_RECORDS[0].sku, 'SKU-90001');
  assert.equal(mod.SHADOW_RECORDS[29].sku, 'SKU-90030');
});

test('a throwing isFlagged gate fails closed: nothing is served', async () => {
  const h = mod.createShadowAuthTier({ enabled: true, isFlagged: () => { throw new Error('gate down'); } });
  assert.equal((await h.handle(demoLogin(FLAGGED))).handled, false);
  assert.equal((await h.handle(req('/api/account/records', { ...FLAGGED, ...EXAMPLE_AUTH }))).handled, false);
});

test('logging has the fixed shape, fires only on shadow serves, and a throwing sink never breaks the handler', async () => {
  const entries = [];
  const h = enabledHandler({ onLog: (e) => { entries.push(e); } });
  await h.handle(req('/api/account/records', { ...CLEAN, ...EXAMPLE_AUTH })); // unflagged: no serve, no log
  await h.handle(demoLogin(FLAGGED, JSON.stringify({ username: 'x', password: 'y' }))); // not a shadow serve, no log
  await h.handle(demoLogin({ ...FLAGGED, 'user-agent': 'test-agent' }));
  await h.handle(req('/api/account/records', { ...FLAGGED, ...EXAMPLE_AUTH }));
  assert.equal(entries.length, 2);
  assert.deepEqual(Object.keys(entries[0]).sort(), ['identity', 'kind', 'method', 'path', 'role', 'source', 'ua']);
  assert.equal(entries[0].source, 'shadow-auth-tier');
  assert.equal(entries[0].kind, 'login');
  assert.equal(entries[0].path, '/api/auth/login');
  assert.equal(entries[0].method, 'POST');
  assert.equal(entries[0].ua, 'test-agent');
  assert.equal(entries[0].identity, 'atk-nt3-on-1');
  assert.equal(entries[0].role, 'partner_readonly');
  assert.equal(entries[1].kind, 'records');

  const throwing = enabledHandler({ onLog: () => { throw new Error('sink down'); } });
  const r = await throwing.handle(req('/api/account/records', { ...FLAGGED, ...EXAMPLE_AUTH }));
  assert.equal(r.status, 200, 'host response unaffected by a broken sink');
});

test('handler advertises exactly the two auth paths', () => {
  const h = enabledHandler();
  assert.deepEqual([...h.paths], ['/api/auth/login', '/api/account/records']);
  assert.equal(mod.SHADOW_ROLE, 'partner_readonly');
});
