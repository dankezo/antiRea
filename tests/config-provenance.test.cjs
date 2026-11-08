const { test } = require('node:test');
const assert = require('node:assert/strict');
// CS-02 ProvenancePin. The seat-occupancy digest below is the lab
// probe's own hashDefault (cs02-results.json, version "2.7.4",
// capacity constant 100 over the factory's declared defaults) -
// this test pins byte-compatibility between the shipped port and
// the lab reference implementation that PASS-LAB measured.
const sdk = require('../dist/tier2-active/config-provenance.js');

test('lab vector: seat-occupancy default config hashes to the CS-02 probe digest', () => {
  const hash = sdk.configProvenanceHash('seat-occupancy', '2.7.4', {
    capacity: 100,
    threshold: 0.5,
    sustainMs: 600000,
    newnessWindowMs: 86400000,
    maxSessions: 100000,
  });
  assert.equal(hash, '8c8254a6fa4fcdaa73b47b2a9dd758b855ab7a39732503fdefaa340ec9616307');
});

test('determinism: key order at any depth does not move the hash', () => {
  const a = sdk.configProvenanceHash('k', '1', { b: 1, a: { d: 4, c: 3 } });
  const b = sdk.configProvenanceHash('k', '1', { a: { c: 3, d: 4 }, b: 1 });
  assert.equal(a, b);
});

test('default-equivalence: omitting an option hashes like passing its default', () => {
  const defaults = { threshold: 0.5, sustainMs: 600000 };
  const omitted = sdk.createConfigProvenance({ kind: 'x', version: '1', defaults, options: {} });
  const explicit = sdk.createConfigProvenance({ kind: 'x', version: '1', defaults, options: { threshold: 0.5 } });
  assert.equal(omitted.hash, explicit.hash);
  assert.deepEqual(omitted.effectiveOptions, { threshold: 0.5, sustainMs: 600000 });
});

test('mutation sensitivity and undeclared fields', () => {
  const defaults = { threshold: 0.5, sustainMs: 600000 };
  const base = sdk.createConfigProvenance({ kind: 'x', version: '1', defaults, options: {} });
  const mutated = sdk.createConfigProvenance({ kind: 'x', version: '1', defaults, options: { sustainMs: 600001 } });
  assert.notEqual(base.hash, mutated.hash);
  const extra = sdk.createConfigProvenance({ kind: 'x', version: '1', defaults, options: { bogus: 1 } });
  assert.equal(base.hash, extra.hash); // undeclared fields never enter the effective config
});

test('canonical rules: -0 normalizes, undefined drops in objects and nulls in arrays', () => {
  assert.equal(sdk.canonicalSerializeConfig({ a: -0 }), '{"a":0}');
  assert.equal(sdk.canonicalSerializeConfig({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(sdk.canonicalSerializeConfig([undefined, 1]), '[null,1]');
  assert.equal(sdk.canonicalSerializeConfig(undefined), undefined);
});

test('unhashable values throw ConfigProvenanceError', () => {
  assert.throws(() => sdk.canonicalSerializeConfig({ a: NaN }), sdk.ConfigProvenanceError);
  assert.throws(() => sdk.canonicalSerializeConfig({ a: Infinity }), sdk.ConfigProvenanceError);
  assert.throws(() => sdk.canonicalSerializeConfig({ a: () => 1 }), sdk.ConfigProvenanceError);
  assert.throws(() => sdk.createConfigProvenance({ kind: '', version: '1' }), sdk.ConfigProvenanceError);
});
