const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const SEED = 'polymorph-surface-test-seed';
const EPOCH = 2900;

test('polymorph surface: same seed and epoch derive identical paths', () => {
  const a = sdk.derivePolymorphCanaryPaths(SEED, EPOCH);
  const b = sdk.derivePolymorphCanaryPaths(SEED, EPOCH);
  assert.deepEqual(a, b);
  assert.equal(a.length, 4);
});

test('polymorph surface: different seed derives different paths', () => {
  const a = sdk.derivePolymorphCanaryPaths(SEED, EPOCH);
  const b = sdk.derivePolymorphCanaryPaths(SEED + '-other', EPOCH);
  assert.notDeepEqual(a, b);
  assert.equal(a.filter((p) => b.includes(p)).length, 0);
});

test('polymorph surface: different epoch derives different paths', () => {
  const a = sdk.derivePolymorphCanaryPaths(SEED, EPOCH);
  const b = sdk.derivePolymorphCanaryPaths(SEED, EPOCH + 1);
  assert.notDeepEqual(a, b);
});

test('polymorph surface: retired set is exactly the previous epoch set', () => {
  const surface = sdk.derivePolymorphSurface(SEED, EPOCH);
  assert.equal(surface.epoch, EPOCH);
  assert.deepEqual(surface.canaryPaths, sdk.derivePolymorphCanaryPaths(SEED, EPOCH));
  assert.deepEqual(surface.retiredTrapPaths, sdk.derivePolymorphCanaryPaths(SEED, EPOCH - 1));
});

test('polymorph surface: paths look like natural API routes and are unique', () => {
  const paths = sdk.derivePolymorphCanaryPaths(SEED, EPOCH, 8);
  assert.equal(new Set(paths).size, paths.length);
  for (const p of paths) {
    assert.match(p, /^\/api\/v[123]\/[a-z]+\/[a-z]+-[a-z]+$/);
  }
});

test('polymorph surface: count parameter is honored', () => {
  assert.equal(sdk.derivePolymorphCanaryPaths(SEED, EPOCH, 2).length, 2);
  assert.equal(sdk.derivePolymorphCanaryPaths(SEED, EPOCH, 7).length, 7);
  assert.equal(sdk.derivePolymorphCanaryPaths(SEED, EPOCH, 0).length, 0);
  const surface = sdk.derivePolymorphSurface(SEED, EPOCH, 3);
  assert.equal(surface.canaryPaths.length, 3);
  assert.equal(surface.retiredTrapPaths.length, 3);
});

test('polymorph surface: epoch is a weekly bucket of time', () => {
  assert.equal(sdk.POLYMORPH_EPOCH_MS, 7 * 24 * 3600 * 1000);
  assert.equal(sdk.polymorphEpochOf(0), 0);
  assert.equal(sdk.polymorphEpochOf(sdk.POLYMORPH_EPOCH_MS - 1), 0);
  assert.equal(sdk.polymorphEpochOf(sdk.POLYMORPH_EPOCH_MS), 1);
  assert.equal(sdk.polymorphEpochOf(EPOCH * sdk.POLYMORPH_EPOCH_MS + 12345), EPOCH);
});

test('polymorph surface: host fingerprint is deterministic, short and seed-bound', () => {
  const fp = sdk.polymorphHostFingerprint(SEED);
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(fp, sdk.polymorphHostFingerprint(SEED));
  assert.notEqual(fp, sdk.polymorphHostFingerprint(SEED + '-other'));
});

test('polymorph surface: empty seed is rejected', () => {
  assert.throws(() => sdk.derivePolymorphCanaryPaths('', EPOCH));
  assert.throws(() => sdk.polymorphHostFingerprint(''));
});
