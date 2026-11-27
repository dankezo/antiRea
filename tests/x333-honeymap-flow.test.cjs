const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHoneymap } = require('../dist/tier2-active/honeymap.js');
const { createOneTimeFlow } = require('../dist/tier2-active/one-time-flow.js');

const SECRET = 'x333-test-secret';
const REAL_MAP = JSON.stringify({
  version: 3, file: 'app.js',
  sources: ['src/api.js', 'src/render.js', 'src/config.js'],
  sourcesContent: ['// real api', '// real render', '// real config'],
  names: [], mappings: 'AAAA',
});
const DECOY_MAP = JSON.stringify({
  version: 3, file: 'app.js',
  sources: ['src/catalog-v2.js', 'src/export.js', 'src/pricing.js'],
  sourcesContent: ['// decoy catalog', '// decoy export', '// decoy pricing'],
  names: [], mappings: 'AAAA',
});
const isFlagged = (id) => id === 'flagged-1';
const maps = { realMaps: { 'app.js': REAL_MAP }, decoyMaps: { 'app.js': DECOY_MAP } };

test('honeymap: clean token serves the exact real map string, identical to the disabled instance', () => {
  const on = createHoneymap({ enabled: true, secret: SECRET, isFlagged, ...maps });
  const off = createHoneymap({ enabled: false, isFlagged, ...maps });
  const cleanToken = on.tokenFor('app.js', 'clean-1');
  assert.ok(cleanToken.startsWith('c.'));
  const served = on.mapFor('app.js', cleanToken);
  assert.equal(served.handled, true);
  assert.equal(served.variant, 'real');
  assert.strictEqual(served.body, REAL_MAP);
  const offServed = off.mapFor('app.js', off.tokenFor('app.js', 'clean-1'));
  assert.strictEqual(offServed.body, served.body);
  // A disabled instance ignores even a flagged identity.
  assert.ok(off.tokenFor('app.js', 'flagged-1').startsWith('c.'));
});

test('honeymap: flagged token serves the decoy map and fires onLog', () => {
  const logs = [];
  const hm = createHoneymap({ enabled: true, secret: SECRET, isFlagged, ...maps, onLog: (e) => logs.push(e) });
  const tok = hm.tokenFor('app.js', 'flagged-1');
  assert.ok(tok.startsWith('f.'));
  const served = hm.mapFor('app.js', tok);
  assert.equal(served.variant, 'decoy');
  assert.strictEqual(served.body, DECOY_MAP);
  assert.deepEqual(logs, [{ source: 'honeymap', script: 'app.js', variant: 'decoy' }]);
});

test('honeymap: forged token (bad signature) serves the real map', () => {
  const hm = createHoneymap({ enabled: true, secret: SECRET, isFlagged, ...maps });
  const forged = 'f.000000000000000000000000';
  const served = hm.mapFor('app.js', forged);
  assert.equal(served.variant, 'real');
  assert.strictEqual(served.body, REAL_MAP);
  // Unknown variant also falls back to the real map (trial default).
  assert.strictEqual(hm.mapFor('app.js', 'x.abcdefabcdefabcdefabcdef').body, REAL_MAP);
  assert.strictEqual(hm.mapFor('app.js', 'garbage').body, REAL_MAP);
});

test('honeymap: factLine is appended only in the decoy map, at the configured source index', () => {
  const factLine = '// catalog snapshot: 2040 records (config).';
  const hm = createHoneymap({ enabled: true, secret: SECRET, isFlagged, ...maps, factLine, factSourceIndex: 2 });
  const decoyServed = hm.mapFor('app.js', hm.tokenFor('app.js', 'flagged-1'));
  const parsed = JSON.parse(decoyServed.body);
  assert.equal(parsed.sourcesContent[2], '// decoy pricing\n' + factLine);
  assert.equal(parsed.sourcesContent[0], '// decoy catalog');
  // Clean serve is untouched.
  const cleanServed = hm.mapFor('app.js', hm.tokenFor('app.js', 'clean-1'));
  assert.strictEqual(cleanServed.body, REAL_MAP);
});

test('honeymap: unknown script is not handled; enabled without secret throws', () => {
  const hm = createHoneymap({ enabled: true, secret: SECRET, isFlagged, ...maps });
  assert.deepEqual(hm.mapFor('nope.js', hm.tokenFor('nope.js', 'flagged-1')), { handled: false });
  assert.throws(() => createHoneymap({ enabled: true, isFlagged, ...maps }), /secret is required/);
});

test('one-time flow: token is delivered in the header only, never in the body', () => {
  const flow = createOneTimeFlow({ enabled: true, isFlagged });
  assert.equal(flow.required('flagged-1'), true);
  const minted = flow.mint('flagged-1');
  assert.ok(minted);
  const token = minted.headers['x-flow-token'];
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32);
  assert.ok(!JSON.stringify(minted.body).includes(token));
  assert.deepEqual(minted.body, { flow: 'export', expires_in_s: 120 });
});

test('one-time flow: authorize succeeds once; second use is flow_token_invalid', () => {
  const flow = createOneTimeFlow({ enabled: true, isFlagged });
  const token = flow.mint('flagged-1').headers['x-flow-token'];
  assert.deepEqual(flow.authorize('flagged-1', token), { ok: true });
  assert.deepEqual(flow.authorize('flagged-1', token), { ok: false, status: 403, error: 'flow_token_invalid' });
});

test('one-time flow: missing token is flow_token_required; unknown token is flow_token_invalid', () => {
  const flow = createOneTimeFlow({ enabled: true, isFlagged });
  assert.deepEqual(flow.authorize('flagged-1', ''), { ok: false, status: 403, error: 'flow_token_required' });
  assert.deepEqual(flow.authorize('flagged-1', undefined), { ok: false, status: 403, error: 'flow_token_required' });
  assert.deepEqual(flow.authorize('flagged-1', 'deadbeef'.repeat(4)), { ok: false, status: 403, error: 'flow_token_invalid' });
});

test('one-time flow: expired token (injected clock) is flow_token_invalid', () => {
  let t = 1_000_000;
  const flow = createOneTimeFlow({ enabled: true, isFlagged, now: () => t, ttlMs: 120000 });
  const token = flow.mint('flagged-1').headers['x-flow-token'];
  t += 120001;
  assert.deepEqual(flow.authorize('flagged-1', token), { ok: false, status: 403, error: 'flow_token_invalid' });
});

test('one-time flow: clean identity is never required and authorize is skipped-ok', () => {
  const flow = createOneTimeFlow({ enabled: true, isFlagged });
  assert.equal(flow.required('clean-1'), false);
  assert.strictEqual(flow.mint('clean-1'), null);
  assert.deepEqual(flow.authorize('clean-1', undefined), { ok: true, skipped: true });
  const off = createOneTimeFlow({ enabled: false, isFlagged });
  assert.equal(off.required('flagged-1'), false);
  assert.strictEqual(off.mint('flagged-1'), null);
  assert.deepEqual(off.authorize('flagged-1', 'anything'), { ok: true, skipped: true });
});
