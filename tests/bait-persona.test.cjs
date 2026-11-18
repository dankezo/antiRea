'use strict';
// MGH-01 per-deployment bait persona, V1 form only - suite version of
// mgh-lab/mgh01.cjs. Expectations are the frozen Step-0 gates
// (REGISTRATION-MGH-STEP0.md): divergence, persistence, rotation,
// tripwire verification. The lab SEARCH gate (0 hits for 1024 V1
// identity strings over two public trees) is a lab measurement
// against those trees and is not re-run here; the locally testable
// properties are encoded below with the same fixture sizes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bp = require('../dist/tier2-active/bait-persona.js');

const SECRET_FIELDS = ['db_password', 'aws_access_key_id', 'aws_secret_access_key', 'jwt_secret', 'app_key'];
const FIELD_TO_PROP = {
  db_password: 'dbPassword',
  aws_access_key_id: 'awsAccessKeyId',
  aws_secret_access_key: 'awsSecretAccessKey',
  jwt_secret: 'jwtSecret',
  app_key: 'appKey',
};

// Deterministic deployment secrets for the fixture: 128 distinct
// 64-hex secrets derived from a fixed label stream. The lab used a
// seeded mulberry32 stream (seed 20311102); the property under test
// is the generation procedure, not the entropy source.
function deploymentSecret(i) {
  return crypto.createHash('sha256').update(`mgh01-suite-deployment-${i}`).digest('hex');
}
function deployments(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const secret = deploymentSecret(i);
    out.push({ secret, persona: bp.generateBaitPersona(secret) });
  }
  return out;
}

test('V1 vocabulary sizes: 15 prefixes, 14 suffixes, 24 qualifiers, 12 x 4 server matrix', () => {
  assert.equal(bp.BAIT_COMPANY_PREFIXES.length, 15);
  assert.equal(bp.BAIT_COMPANY_SUFFIXES.length, 14);
  assert.equal(bp.BAIT_COMPANY_QUALIFIERS.length, 24);
  assert.equal(bp.BAIT_SERVER_VERSIONS.length, 12);
  assert.equal(bp.BAIT_SERVER_DISTROS.length, 4);
  assert.deepEqual([...bp.BAIT_CREDENTIAL_FIELDS], SECRET_FIELDS);
});

test('DIV-SECRET and DIV-SLUG: 128 deployments, 0 collisions in all 5 secret fields and slugs', () => {
  const deps = deployments(128);
  for (const field of SECRET_FIELDS) {
    const values = deps.map((d) => d.persona[FIELD_TO_PROP[field]]);
    assert.equal(new Set(values).size, 128, `collision in ${field}`);
  }
  assert.equal(new Set(deps.map((d) => d.persona.slug)).size, 128, 'slug collision');
  assert.equal(new Set(deps.map((d) => d.persona.domain)).size, 128, 'domain collision');
});

test('HEADER: distinct server headers across 128 deployments is at least 24 of 48', () => {
  const deps = deployments(128);
  const distinct = new Set(deps.map((d) => d.persona.serverHeader)).size;
  assert.ok(distinct >= 24, `distinct server headers ${distinct} below the lab gate of 24`);
});

test('PERSIST: regeneration from the same secret is byte-identical (8 deployments x 3 reloads)', () => {
  const deps = deployments(8);
  for (const d of deps) {
    const canonical = JSON.stringify(d.persona);
    for (let r = 0; r < 3; r++) {
      assert.equal(JSON.stringify(bp.generateBaitPersona(d.secret)), canonical);
    }
  }
});

test('ROTATE: a new secret differs in all 5 secret fields and slug (8 rotations)', () => {
  const deps = deployments(8);
  for (let i = 0; i < 8; i++) {
    const fresh = bp.generateBaitPersona(deploymentSecret(1000 + i));
    for (const field of SECRET_FIELDS) {
      assert.notEqual(fresh[FIELD_TO_PROP[field]], deps[i].persona[FIELD_TO_PROP[field]], field);
    }
    assert.notEqual(fresh.slug, deps[i].persona.slug);
  }
});

test('TRIPWIRE: own-deployment verification 80/80, cross-deployment 0/1200', () => {
  const sample = deployments(16);
  let ownTrue = 0;
  let ownTotal = 0;
  let crossTrue = 0;
  let crossTotal = 0;
  for (let i = 0; i < sample.length; i++) {
    for (const field of SECRET_FIELDS) {
      const presented = sample[i].persona[FIELD_TO_PROP[field]];
      ownTotal++;
      if (bp.verifyBaitCredential(sample[i].secret, field, presented)) ownTrue++;
      for (let j = 0; j < sample.length; j++) {
        if (j === i) continue;
        crossTotal++;
        if (bp.verifyBaitCredential(sample[j].secret, field, presented)) crossTrue++;
      }
    }
  }
  assert.equal(ownTotal, 80);
  assert.equal(ownTrue, 80);
  assert.equal(crossTotal, 1200);
  assert.equal(crossTrue, 0);
});

test('credential formats match the lab bait formats', () => {
  const p = bp.generateBaitPersona(deploymentSecret(0));
  assert.match(p.awsAccessKeyId, /^AKIA[A-Z2-7]{16}$/);
  assert.match(p.awsSecretAccessKey, /^[A-Za-z0-9+/]{40}$/);
  assert.match(p.jwtSecret, /^[0-9a-f]{64}$/);
  assert.match(p.appKey, /^base64:[A-Za-z0-9+/]{43}=$/);
  assert.ok(p.dbPassword.length >= 24);
  assert.match(p.slug, /^[a-z]+-[a-z2-7]{6}$/);
  assert.equal(p.domain, `${p.slug}.corp`);
});

test('factory is default OFF: no persona, verifies nothing; enabling without a secret throws', () => {
  for (const opts of [{}, { enabled: false }, { enabled: false, secret: deploymentSecret(1) }]) {
    const f = bp.createBaitPersona(opts);
    assert.equal(f.enabled, false);
    assert.equal(f.persona, null);
    assert.equal(f.verifyCredential('db_password', 'anything'), false);
  }
  assert.throws(() => bp.createBaitPersona({ enabled: true }), bp.BaitPersonaError);
  assert.throws(() => bp.createBaitPersona({ enabled: true }), /secret is required/);
});

test('factory enabled: persona matches the pure generator and verifies its own credentials only', () => {
  const secret = deploymentSecret(42);
  const f = bp.createBaitPersona({ enabled: true, secret });
  assert.equal(f.enabled, true);
  assert.deepEqual(f.persona, bp.generateBaitPersona(secret));
  for (const field of SECRET_FIELDS) {
    assert.equal(f.verifyCredential(field, f.persona[FIELD_TO_PROP[field]]), true, field);
    assert.equal(f.verifyCredential(field, f.persona[FIELD_TO_PROP[field]] + 'x'), false, field);
    assert.equal(f.verifyCredential(field, ''), false, field);
    assert.equal(f.verifyCredential(field, undefined), false, field);
  }
});

test('generated deployment secrets are 64-hex and distinct', () => {
  const a = bp.generateBaitDeploymentSecret();
  const b = bp.generateBaitDeploymentSecret();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.match(b, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.notDeepEqual(bp.generateBaitPersona(a), bp.generateBaitPersona(b));
});
