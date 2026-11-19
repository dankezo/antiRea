const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sdk = require('../dist/index.js');

// The generator's pure parts must load without javascript-obfuscator
// (it is an optional build-time tool, loaded lazily). If the module
// itself cannot be required in this environment, skip rather than fail.
let gen = null;
let genError = null;
try {
  gen = require('../tools/polymorph/polymorph.cjs');
} catch (err) {
  genError = err;
}
let extractor = null;
try {
  extractor = require('../tools/polymorph/extract-fingerprint.cjs');
} catch { /* covered by the same skip */ }

const SEED = 'generator-test-host-seed';

test('polymorph generator: path derivation matches the runtime module exactly', (t) => {
  if (!gen) return t.skip('generator module unavailable: ' + (genError && genError.message));
  for (const [seed, epoch, count] of [[SEED, 2900, 4], [SEED, 2901, 4], ['another-seed', 1234, 6], [SEED, 2900, 2]]) {
    assert.deepEqual(gen.genCanaryPaths(seed, epoch, count), sdk.derivePolymorphCanaryPaths(seed, epoch, count));
  }
  assert.equal(gen.epochOf(new Date(2900 * 7 * 24 * 3600 * 1000)), sdk.polymorphEpochOf(2900 * sdk.POLYMORPH_EPOCH_MS));
});

test('polymorph generator: fingerprint is the sha256 of the seed and matches the runtime short form', (t) => {
  if (!gen) return t.skip('generator module unavailable');
  const expected = crypto.createHash('sha256').update(SEED).digest('hex');
  assert.equal(gen.hostFingerprint(SEED), expected);
  assert.equal(gen.hostFingerprintShort(SEED), sdk.polymorphHostFingerprint(SEED));
});

test('polymorph generator: fingerprint embed/extract roundtrip via the marker module', (t) => {
  if (!gen || !extractor) return t.skip('generator/extractor module unavailable');
  const fp = gen.hostFingerprint(SEED);
  const marker = gen.buildMarkerModule(fp, SEED);
  assert.equal(extractor.extractFingerprint(marker), fp);
  assert.equal(extractor.extractFingerprint('no shards here'), null);
  assert.equal(extractor.extractFingerprint(marker.replace('__variantShard3', '__variantShardX')), null);
});

test('polymorph generator: extractor CLI prints the embedded fingerprint of a variant dir', (t) => {
  if (!gen) return t.skip('generator module unavailable');
  const fp = gen.hostFingerprint(SEED);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antirea-variant-'));
  try {
    fs.mkdirSync(path.join(dir, 'tier2-active'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tier2-active', 'variant-marker.js'), gen.buildMarkerModule(fp, SEED));
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'polymorph', 'extract-fingerprint.cjs'), dir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), fp);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('polymorph generator: manifest carries surface, retired set and module hashes', (t) => {
  if (!gen) return t.skip('generator module unavailable');
  const manifest = gen.buildManifest({
    seedStr: SEED, epoch: 2900, count: 4,
    moduleHashes: { 'tier2-active/cursor.js': 'ab'.repeat(32) },
    sdkVersion: '3.2.0',
  });
  assert.equal(manifest.hostFingerprint, sdk.polymorphHostFingerprint(SEED));
  assert.deepEqual(manifest.canaryPaths, sdk.derivePolymorphCanaryPaths(SEED, 2900, 4));
  assert.deepEqual(manifest.retiredTrapPaths, sdk.derivePolymorphCanaryPaths(SEED, 2899, 4));
  assert.equal(manifest.moduleHashes['tier2-active/cursor.js'], 'ab'.repeat(32));
  assert.equal(manifest.marker, gen.MARKER_REL_PATH);
});

test('polymorph generator: decoy block renders exactly the names it reports, all inert-looking business logic', (t) => {
  if (!gen) return t.skip('generator module unavailable');
  for (const label of ['marker', 'tier2-active-cursor-js']) {
    const names = gen.decoyNamesFor(SEED, label, 3);
    const block = gen.renderDecoyBlock(SEED, label, 3);
    assert.equal(names.length, 3);
    for (const name of names) assert.ok(block.includes('__decoy_' + name), name + ' rendered');
    assert.ok(!block.includes('module.exports'), 'decoys are never exported');
    assert.ok(!block.includes('require('), 'decoys pull in nothing');
  }
});
