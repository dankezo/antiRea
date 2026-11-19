const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const FILES = {
  'tier2-active/cursor.js': 'cursor module bytes v1',
  'tier2-active/canary-echo.js': 'canary echo module bytes v1',
};

function readerFrom(map) {
  return (p) => (Object.prototype.hasOwnProperty.call(map, p) ? map[p] : null);
}

test('variant integrity: sha256 helper matches the known abc vector', () => {
  assert.equal(
    sdk.hashVariantContent('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('variant integrity: clean files verify ok', () => {
  const manifest = sdk.buildVariantManifest(FILES);
  assert.equal(manifest.algorithm, 'sha256');
  assert.equal(manifest.version, 1);
  const signal = sdk.verifyVariantManifest(manifest, readerFrom(FILES));
  assert.equal(signal.ok, true);
  assert.equal(signal.checked, 2);
  assert.deepEqual(signal.mismatches, []);
});

test('variant integrity: tampered file is detected as hash_mismatch', () => {
  const manifest = sdk.buildVariantManifest(FILES);
  const tampered = { ...FILES, 'tier2-active/cursor.js': 'cursor module bytes TAMPERED' };
  const signal = sdk.verifyVariantManifest(manifest, readerFrom(tampered));
  assert.equal(signal.ok, false);
  assert.equal(signal.checked, 2);
  assert.equal(signal.mismatches.length, 1);
  const m = signal.mismatches[0];
  assert.equal(m.path, 'tier2-active/cursor.js');
  assert.equal(m.reason, 'hash_mismatch');
  assert.equal(m.expected, manifest.files['tier2-active/cursor.js']);
  assert.equal(m.actual, sdk.hashVariantContent('cursor module bytes TAMPERED'));
});

test('variant integrity: missing file is reported, not thrown', () => {
  const manifest = sdk.buildVariantManifest(FILES);
  const partial = { 'tier2-active/cursor.js': FILES['tier2-active/cursor.js'] };
  let signal;
  assert.doesNotThrow(() => { signal = sdk.verifyVariantManifest(manifest, readerFrom(partial)); });
  assert.equal(signal.ok, false);
  assert.equal(signal.mismatches.length, 1);
  assert.equal(signal.mismatches[0].path, 'tier2-active/canary-echo.js');
  assert.equal(signal.mismatches[0].reason, 'missing');
});

test('variant integrity: a throwing reader is reported as unreadable, not thrown', () => {
  const manifest = sdk.buildVariantManifest(FILES);
  const badReader = () => { throw new Error('disk on fire'); };
  let signal;
  assert.doesNotThrow(() => { signal = sdk.verifyVariantManifest(manifest, badReader); });
  assert.equal(signal.ok, false);
  assert.equal(signal.mismatches.length, 2);
  assert.ok(signal.mismatches.every((m) => m.reason === 'unreadable'));
});

test('variant integrity: malformed manifests are reported, not thrown', () => {
  for (const bad of [null, undefined, 42, {}, { algorithm: 'md5', files: {} }, { algorithm: 'sha256' }]) {
    let signal;
    assert.doesNotThrow(() => { signal = sdk.verifyVariantManifest(bad, readerFrom(FILES)); });
    assert.equal(signal.ok, false);
    assert.equal(signal.mismatches.length, 1);
    assert.equal(signal.mismatches[0].reason, 'invalid_manifest');
  }
});

test('variant integrity: byte-array contents hash and verify like strings', () => {
  const bytes = new TextEncoder().encode(FILES['tier2-active/cursor.js']);
  const manifest = sdk.buildVariantManifest({ 'tier2-active/cursor.js': bytes });
  assert.equal(manifest.files['tier2-active/cursor.js'], sdk.hashVariantContent(FILES['tier2-active/cursor.js']));
  const signal = sdk.verifyVariantManifest(manifest, readerFrom(FILES));
  assert.equal(signal.ok, true);
});
