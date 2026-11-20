'use strict';
/*
 * B6 - visible per-identity fingerprint on decoy content.
 *
 * Pins: the keyed derivation (deterministic per identity,
 * distinct across identities, the trial's word/phrase lists
 * and moduli), the list transform (rotation, stock phrase on
 * every record's text, token on the first text-bearing
 * record, inputs never mutated), and the surface integration
 * - the fingerprint exists ONLY inside the decoy surface's
 * serving path: with the option off or absent every serve is
 * byte-identical, and with it on, only live-endpoint record
 * lists change while every other decoy response (spec, docs,
 * joins, chains, GraphQL, examples, pages) stays
 * byte-identical.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const { REGISTRY, req } = require('./fixtures/decoy-registry.cjs');
const { REGISTRY_331 } = require('./fixtures/decoy-registry-331.cjs');

const SECRET = 'b6-test-secret';

test('the derivation is deterministic, keyed, and distinct across identities', () => {
  const a1 = sdk.visibleFingerprintFor(SECRET, 'identity-a');
  const a2 = sdk.visibleFingerprintFor(SECRET, 'identity-a');
  assert.deepEqual(a1, a2, 'same secret + identity, same fingerprint');
  assert.match(a1.token, /^Assortment (Alpha|Bravo|Cobalt|Delta|Ember|Falcon|Granite|Harbor)-\d{2}$/);
  const nn = Number(a1.token.split('-')[1]);
  assert.ok(nn >= 10 && nn <= 99, 'NN in the trialled 10..99 band');
  assert.ok(sdk.DECOY_FINGERPRINT_PHRASES.includes(a1.stockPhrase));
  assert.ok(a1.rotation >= 0 && a1.rotation <= 6 && a1.rotationAlt >= 0 && a1.rotationAlt <= 6);

  const prints = ['identity-a', 'identity-b', 'identity-c', 'identity-d', 'identity-e', 'identity-f']
    .map((id) => sdk.visibleFingerprintFor(SECRET, id));
  const distinct = new Set(prints.map((p) => JSON.stringify(p)));
  assert.ok(distinct.size >= 4, `identities get distinct fingerprints (got ${distinct.size}/6 distinct)`);
  const otherSecret = ['identity-a', 'identity-b', 'identity-c'].map((id) => sdk.visibleFingerprintFor('another-secret', id));
  assert.notDeepEqual(otherSecret, prints.slice(0, 3), 'the derivation is keyed: another host secret, another fingerprint set');
  assert.throws(() => sdk.visibleFingerprintFor(SECRET, ''), sdk.DecoyFingerprintError);
});

test('rotateDecoyRecords rotates left, normalizes, and never mutates', () => {
  const list = [0, 1, 2, 3, 4];
  assert.deepEqual(sdk.rotateDecoyRecords(list, 0), [0, 1, 2, 3, 4]);
  assert.deepEqual(sdk.rotateDecoyRecords(list, 2), [2, 3, 4, 0, 1]);
  assert.deepEqual(sdk.rotateDecoyRecords(list, 7), [2, 3, 4, 0, 1], 'rotation normalizes against the length');
  assert.deepEqual(sdk.rotateDecoyRecords([], 3), []);
  assert.deepEqual(list, [0, 1, 2, 3, 4], 'input untouched');
});

function namedRecords(n) {
  return Array.from({ length: n }, (_, i) => ({ sku: `SKU-${30000 + i}`, name: `Decoy Item ${i + 1}`, priceVnd: 1000 * (i + 1) }));
}

test('applyVisibleFingerprint weaves phrase + token, rotates, and never mutates its input', () => {
  const records = namedRecords(10);
  const snapshot = JSON.parse(JSON.stringify(records));
  const fp = sdk.visibleFingerprintFor(SECRET, 'identity-a');
  const out = sdk.applyVisibleFingerprint(records, SECRET, 'identity-a');

  const expectedOrder = sdk.rotateDecoyRecords(snapshot, fp.rotation).map((r) => r.sku);
  assert.deepEqual(out.map((r) => r.sku), expectedOrder, 'the served order is the identity rotation of the declared order');
  for (const [i, r] of out.entries()) {
    assert.ok(r.name.includes(` - ${fp.stockPhrase}`), `record ${i} carries the stock phrase`);
    if (i > 0) assert.ok(r.name.endsWith(` - ${fp.stockPhrase}`), `record ${i} ends on the phrase`);
    assert.equal(r.name.includes(fp.token), i === 0, 'the token rides exactly the first text-bearing record');
  }
  assert.deepEqual(records, snapshot, 'inputs are never mutated');
  assert.deepEqual(sdk.applyVisibleFingerprint(records, SECRET, 'identity-a'), out, 'deterministic per identity');
  assert.notDeepEqual(sdk.applyVisibleFingerprint(records, SECRET, 'identity-b'), out, 'another identity, another woven list');
});

test('the weave lands in the fields sub-object when records carry one, and honors a declared text field', () => {
  const withFields = [{ id: 'r1', fields: { sku: 'SKU-1', title: 'Nested Title' } }, { id: 'r2', fields: { sku: 'SKU-2', title: 'Second' } }];
  const fp = sdk.visibleFingerprintFor(SECRET, 'identity-a');
  const out = sdk.applyVisibleFingerprint(withFields, SECRET, 'identity-a');
  const first = out.find((r) => r.id === 'r1');
  assert.ok(first.fields.title.endsWith(` - ${fp.stockPhrase}`), 'the weave lands inside fields, the canary convention');
  assert.equal(withFields[0].fields.title, 'Nested Title', 'nested input untouched');

  const custom = [{ sku: 'SKU-9', label: 'Label text', name: 'Name text' }];
  const out2 = sdk.applyVisibleFingerprint(custom, SECRET, 'identity-a', { textField: 'label' });
  assert.ok(out2[0].label.includes(fp.stockPhrase), 'a declared text field wins');
  assert.equal(out2[0].name, 'Name text', 'other fields untouched');

  const noText = [{ qty: 3 }, { qty: 5 }];
  const out3 = sdk.applyVisibleFingerprint(noText, SECRET, 'identity-a');
  assert.deepEqual(out3.map((r) => r.qty), sdk.rotateDecoyRecords(noText, fp.rotation).map((r) => r.qty), 'no text anywhere: rotation only, nothing invented');
});

/* --- surface integration ---------------------------------------------- */

const LIST_REGISTRY = {
  formatVersion: 1,
  endpoints: [
    { path: '/api/decoy/list', kind: 'live', payload: { items: namedRecords(10), total: 10 } },
    { path: '/api/decoy/bare', kind: 'live', payload: namedRecords(10) },
  ],
};

test('fingerprintVisible without a secret fails fast at construction', () => {
  const surface = sdk.generateDecoySurface(LIST_REGISTRY);
  assert.throws(() => sdk.createDecoySurface({ enabled: true, surface, fingerprintVisible: true }), sdk.DecoySurfaceError);
});

test('with the fingerprint on, decoy lists are woven per identity - bare arrays and enveloped lists alike', async () => {
  const surface = sdk.generateDecoySurface(LIST_REGISTRY);
  const h = sdk.createDecoySurface({ enabled: true, surface, fingerprintVisible: true, fingerprintSecret: SECRET });
  const fpA = sdk.visibleFingerprintFor(SECRET, 'identity-a');

  const enveloped = JSON.parse((await h.handle(req('/api/decoy/list', { 'x-identity': 'identity-a' }))).body);
  assert.equal(enveloped.total, 10, 'envelope fields outside the list are untouched');
  assert.deepEqual(enveloped.items.map((r) => r.sku), sdk.rotateDecoyRecords(namedRecords(10), fpA.rotation).map((r) => r.sku));
  assert.ok(enveloped.items.every((r) => r.name.includes(fpA.stockPhrase)));
  assert.ok(enveloped.items[0].name.includes(fpA.token));

  const bare = JSON.parse((await h.handle(req('/api/decoy/bare', { 'x-identity': 'identity-a' }))).body);
  assert.ok(Array.isArray(bare));
  assert.ok(bare.every((r) => r.name.includes(fpA.stockPhrase)));

  const again = JSON.parse((await h.handle(req('/api/decoy/list', { 'x-identity': 'identity-a' }))).body);
  assert.deepEqual(again, enveloped, 'stable per identity');
  const other = JSON.parse((await h.handle(req('/api/decoy/list', { 'x-identity': 'identity-b' }))).body);
  assert.notDeepEqual(other, enveloped, 'distinct per identity');

  const expansionBase = JSON.parse(JSON.stringify(LIST_REGISTRY.endpoints[0].payload));
  assert.deepEqual(expansionBase.items, namedRecords(10), 'the declared registry payload is never mutated by fingerprinted serves');
});

test('byte-identity: option off or absent, every serve of the 3.3.0 fixture is identical', async () => {
  const surface = sdk.generateDecoySurface(REGISTRY);
  const bare = sdk.createDecoySurface({ enabled: true, surface, joinSecret: 'surface-test-secret', surfaceSeed: 'surface-test' });
  const off = sdk.createDecoySurface({
    enabled: true, surface, joinSecret: 'surface-test-secret', surfaceSeed: 'surface-test',
    fingerprintVisible: false, fingerprintSecret: SECRET,
  });
  const paths = [
    '/robots.txt', '/sitemap.xml', '/openapi.json', '/api-docs',
    '/api/v2/products', '/api/admin-export', '/api/hidden-pricing',
    '/api/supplier/feed', '/api/clearance/list', '/api/partners/feed',
    '/api/v3/items', '/partner-terms', '/api/discounts/calculate',
    '/api/suppliers', '/api/contracts', '/api/v2/products?expand=supplier',
  ];
  for (const p of paths) {
    for (const headers of [{}, { 'x-identity': 'identity-a' }]) {
      const a = await bare.handle(req(p, headers));
      const b = await off.handle(req(p, headers));
      assert.equal(b.status, a.status, p);
      assert.equal(b.body, a.body, `${p} must be byte-identical with the option off`);
    }
  }
});

test('with the fingerprint ON, only live-endpoint record lists change - every other decoy response is byte-identical', async () => {
  const surface = sdk.generateDecoySurface(REGISTRY);
  const off = sdk.createDecoySurface({ enabled: true, surface, joinSecret: 'surface-test-secret', surfaceSeed: 'surface-test' });
  const on = sdk.createDecoySurface({
    enabled: true, surface, joinSecret: 'surface-test-secret', surfaceSeed: 'surface-test',
    fingerprintVisible: true, fingerprintSecret: SECRET,
  });
  const headers = { 'x-identity': 'identity-a' };
  const untouched = [
    '/robots.txt', '/sitemap.xml', '/openapi.json', '/api-docs',
    '/api/supplier/feed', '/api/clearance/list', '/api/partners/feed',
    '/api/v3/items', '/partner-terms', '/api/discounts/calculate',
    '/api/suppliers', '/api/contracts',
  ];
  for (const p of untouched) {
    const a = await off.handle(req(p, headers));
    const b = await on.handle(req(p, headers));
    assert.equal(b.body, a.body, `${p}: not a live-endpoint record list - the fingerprint must not touch it`);
  }
  const changed = await on.handle(req('/api/v2/products', headers));
  const plain = await off.handle(req('/api/v2/products', headers));
  assert.notEqual(changed.body, plain.body, 'the products list itself IS woven');
  const fp = sdk.visibleFingerprintFor(SECRET, 'identity-a');
  assert.ok(changed.body.includes(fp.stockPhrase) && changed.body.includes(fp.token));

  const expanded = await on.handle(req('/api/v2/products?expand=supplier', headers));
  assert.ok(expanded.body.includes(fp.stockPhrase), 'expansions build on the fingerprinted list');
});

test('byte-identity on the 3.3.1 fixture: chains and GraphQL never carry the fingerprint', async () => {
  const surface = sdk.generateDecoySurface(REGISTRY_331);
  const off = sdk.createDecoySurface({ enabled: true, surface, variantSecret: 'variant-test-secret' });
  const on = sdk.createDecoySurface({
    enabled: true, surface, variantSecret: 'variant-test-secret',
    fingerprintVisible: true, fingerprintSecret: SECRET,
  });
  const headers = { 'x-identity': 'identity-a' };
  for (const p of ['/graphql', '/api/suppliers/SUP-F-01', '/api/contracts/CT-F-01', '/api/rebate-plans/RB-F-01', '/openapi.json', '/api-docs']) {
    const a = await off.handle(req(p, headers));
    const b = await on.handle(req(p, headers));
    assert.equal(b.body, a.body, `${p} must be byte-identical with the fingerprint on`);
  }
  const directory = JSON.parse((await on.handle(req('/api/partners/directory', headers))).body);
  const fp = sdk.visibleFingerprintFor(SECRET, 'identity-a');
  assert.ok(directory.records.every((r) => r.name.includes(fp.stockPhrase)),
    'the variant-shaped directory list is woven after reshaping');
  assert.ok(JSON.stringify(directory).includes(fp.token), 'the token is present in the woven directory');
});
