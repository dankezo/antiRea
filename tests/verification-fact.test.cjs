const { test } = require('node:test');
const assert = require('node:assert/strict');
// BS-01 VerifiedNeutral: the frozen 26-row table as behavior.
// Delta law: VERIFIED / UNVERIFIED / NO-CLAIM move evidence by 0;
// only SPOOFED carries "EVIDENCE", and the spoof set is exactly
// { WBA invalid_signature + conclusive crypto detail, FCrDNS
// contradiction }.
const sdk = require('../dist/tier2-active/verification-fact.js');

const REASONS = [
  'no_signature_headers', 'no_signature_agent', 'malformed_headers', 'missing_parameter',
  'wrong_tag', 'unsupported_algorithm', 'insufficient_coverage', 'duplicate_covered_components',
  'expired', 'not_yet_valid', 'validity_window_too_long', 'invalid_validity_window',
  'nonce_too_long', 'unknown_key', 'key_resolution_failed', 'replay_detected', 'invalid_signature',
];

test('all 17 shipped failure reasons classify with delta 0 except the crypto spoof', () => {
  for (const reason of REASONS) {
    const fact = sdk.classifyWebBotAuthVerdict({ verified: false, reason, detail: 'some detail' });
    assert.equal(fact.channel, 'bs01-verification-fact');
    assert.equal(fact.source, 'web-bot-auth');
    if (reason === 'no_signature_headers' || reason === 'no_signature_agent') {
      assert.equal(fact.state, 'no-claim', reason);
    } else {
      assert.equal(fact.state, 'unverified', reason);
    }
    assert.equal(fact.evidenceDelta, 0, reason);
    assert.equal(fact.sideEvent, reason === 'replay_detected' ? 'REPLAY' : null, reason);
  }
});

test('verified verdict is verified with delta 0 (identity known is not innocence)', () => {
  const fact = sdk.classifyWebBotAuthVerdict({ verified: true });
  assert.equal(fact.state, 'verified');
  assert.equal(fact.evidenceDelta, 0);
});

test('invalid_signature: only the conclusive crypto detail is spoofed', () => {
  const spoof = sdk.classifyWebBotAuthVerdict({
    verified: false, reason: 'invalid_signature', detail: 'Ed25519 verification failed',
  });
  assert.equal(spoof.state, 'spoofed');
  assert.equal(spoof.evidenceDelta, 'EVIDENCE');
  for (const detail of [
    'cannot derive covered component "@authority" from this request',
    'no signature label could be evaluated',
    'some future detail string',
    undefined,
  ]) {
    const fact = sdk.classifyWebBotAuthVerdict({ verified: false, reason: 'invalid_signature', detail });
    assert.equal(fact.state, 'unverified', String(detail));
    assert.equal(fact.evidenceDelta, 0);
  }
});

test('unknown future reasons default to unverified, never to evidence', () => {
  const fact = sdk.classifyWebBotAuthVerdict({ verified: false, reason: 'brand_new_reason', detail: 'x' });
  assert.equal(fact.state, 'unverified');
  assert.equal(fact.evidenceDelta, 0);
});

test('host channels: FCrDNS contradiction is the second and only other spoof', () => {
  assert.equal(sdk.classifyHostVerificationFact('fcrdns', 'forward-confirmed match').state, 'verified');
  const spoof = sdk.classifyHostVerificationFact('fcrdns', 'contradiction');
  assert.equal(spoof.state, 'spoofed');
  assert.equal(spoof.evidenceDelta, 'EVIDENCE');
  assert.equal(sdk.classifyHostVerificationFact('fcrdns', 'lookup failure').state, 'unverified');
  assert.equal(sdk.classifyHostVerificationFact('range', 'inside published range').state, 'verified');
  assert.equal(sdk.classifyHostVerificationFact('range', 'outside published range').state, 'unverified');
  assert.equal(sdk.classifyHostVerificationFact('range', 'list unavailable or stale').state, 'unverified');
  assert.equal(sdk.classifyHostVerificationFact('range', 'anything else').state, 'unverified');
});

test('config hash hook passes through (BS-01 spec hook via CS-02)', () => {
  const hash = 'a'.repeat(64);
  const fact = sdk.classifyWebBotAuthVerdict({ verified: true }, { configHash: hash });
  assert.equal(fact.configHash, hash);
  assert.equal(sdk.classifyWebBotAuthVerdict({ verified: true }).configHash, null);
});
