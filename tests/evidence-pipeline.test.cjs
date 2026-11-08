const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
// Evidence-layer integration + drift guards (test-battery upgrade,
// 2026-11-09). The 2.8.0 unit tests pin each evidence module in
// isolation against its frozen lab table; this file wires the layer
// together the way a host would (real signal result -> provenance
// pin -> decoration -> pack audit -> step-up proof bound to that
// exact pin), and adds mechanical drift guards so a future source
// change cannot silently desync the frozen tables:
//   - every WebBotAuthFailureReason literal in the shipped verifier
//     source must still classify through BS-01, and the reason count
//     must still be 17 (the frozen BS-01 pin);
//   - every shipped signal kind must carry a KT-01 role.
const sdk = require('../dist/index.js');

const T0 = 1_700_000_100_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

test('pipeline: real seat-occupancy flag decorates into an eligible pack', () => {
  const sig = sdk.createSeatOccupancySignal({ capacity: 30 });
  for (let i = 0; i < 30; i++) {
    const joinTs = T0 + i * 4000;
    sig.observe({ type: 'join', identity: 'sq' + i, ts: joinTs, accountCreatedTs: joinTs - HOUR });
  }
  const res = sig.evaluate({ asOfTs: T0 + 1_500_000 });
  assert.equal(res.kind, 'seat-occupancy');
  assert.equal(res.flagged, true);

  const pin = sdk.createConfigProvenance({
    kind: 'seat-occupancy',
    version: '2.8.0',
    defaults: { capacity: 100, threshold: 0.5, sustainMs: 600000, newnessWindowMs: 86400000, maxSessions: 100000 },
    options: { capacity: 30 },
  });
  assert.match(pin.hash, /^[0-9a-f]{64}$/);

  const decorated = sdk.decorateSignalResult(res, { configHash: pin.hash });
  assert.equal(decorated.role, 'CONVICTING');
  assert.equal(decorated.fired, true);
  assert.equal(decorated.configHash, pin.hash);

  const quietSig = sdk.createSeatOccupancySignal({ capacity: 30 });
  const quiet = quietSig.evaluate({ asOfTs: T0 });
  const quietDecorated = sdk.decorateSignalResult(quiet);
  assert.equal(quietDecorated.fired, false);

  const pack = sdk.auditEvidencePack([
    { channel: 'seat-occupancy', fired: true, claimedRole: 'CONVICTING' },
    { channel: 'bs01-verification-fact', fired: true, state: 'unverified', claimedRole: 'CORROBORATING' },
  ]);
  assert.deepEqual(pack, { valid: true, eligible: true });

  const corroboratingOnly = sdk.auditEvidencePack([
    { channel: 'bs01-verification-fact', fired: true, state: 'unverified' },
  ]);
  assert.deepEqual(corroboratingOnly, { valid: true, eligible: false });

  const forged = sdk.auditEvidencePack([
    { channel: 'bs01-verification-fact', fired: true, state: 'spoofed' },
  ]);
  assert.deepEqual(forged, { valid: true, eligible: true });

  const lying = sdk.auditEvidencePack([
    { channel: 'seat-occupancy', fired: true, claimedRole: 'CORROBORATING' },
  ]);
  assert.equal(lying.valid, false);
  const unknown = sdk.auditEvidencePack([{ channel: 'no-such-channel', fired: true }]);
  assert.equal(unknown.valid, false);
});

test('pipeline: step-up proof binds the provenance pin of the config that flagged', () => {
  const pin = sdk.createConfigProvenance({
    kind: 'seat-occupancy',
    version: '2.8.0',
    defaults: { capacity: 100, threshold: 0.5, sustainMs: 600000, newnessWindowMs: 86400000, maxSessions: 100000 },
    options: { capacity: 30 },
  });
  const otherPin = sdk.configProvenanceHash('seat-occupancy', '2.8.0', {
    capacity: 31, threshold: 0.5, sustainMs: 600000, newnessWindowMs: 86400000, maxSessions: 100000,
  });
  assert.notEqual(otherPin, pin.hash);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const consumed = new Set();
  const verifier = sdk.createStepUpProofVerifier({
    keys: { k1: publicKey },
    consumeNonce: (n) => {
      if (consumed.has(n)) return false;
      consumed.add(n);
      return true;
    },
  });
  const challenge = { type: 'captcha', difficulty: 3 };
  const token = sdk.issueStepUpProof({
    privateKey,
    kid: 'k1',
    identity: 'user-7',
    configHash: pin.hash,
    challengeConfig: challenge,
    nonce: 'nonce-pipeline-1',
    issuedAtSec: 1700000000,
    expiresAtSec: 1700000600,
  });
  const ctx = {
    identity: 'user-7',
    expectedConfigHash: pin.hash,
    expectedChallengeHash: sdk.stepUpChallengeHash(challenge),
    nowSec: 1700000100,
  };
  assert.equal(verifier.verifyProof(token, ctx).outcome, 'ACCEPT');
  // Same token again: the nonce is spent, so replay is rejected.
  assert.equal(verifier.verifyProof(token, ctx).reason, 'REPLAY');
  // A proof minted for a different detector configuration must not
  // verify against this pin.
  const token2 = sdk.issueStepUpProof({
    privateKey,
    kid: 'k1',
    identity: 'user-7',
    configHash: pin.hash,
    challengeConfig: challenge,
    nonce: 'nonce-pipeline-2',
    issuedAtSec: 1700000000,
    expiresAtSec: 1700000600,
  });
  assert.equal(
    verifier.verifyProof(token2, { ...ctx, expectedConfigHash: otherPin }).reason,
    'CONFIG_MISMATCH',
  );
});

test('drift guard: every shipped Web Bot Auth failure reason classifies through BS-01', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tier2-active', 'web-bot-auth.ts'), 'utf8');
  const start = src.indexOf('export type WebBotAuthFailureReason =');
  assert.ok(start >= 0, 'WebBotAuthFailureReason union not found in source');
  const end = src.indexOf(';', start);
  const union = src.slice(start, end);
  const reasons = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.equal(reasons.length, 17, 'frozen BS-01 pin covers exactly 17 shipped reasons');
  for (const reason of reasons) {
    const fact = sdk.classifyWebBotAuthVerdict({ verified: false, reason, detail: 'drift probe' });
    assert.equal(fact.channel, 'bs01-verification-fact');
    assert.equal(fact.source, 'web-bot-auth');
    // Frozen BS-01 semantics: the two "no signature present"
    // reasons are a NO-CLAIM (the client never claimed an identity);
    // every other failure with a generic detail is UNVERIFIED.
    // Both carry an evidence delta of exactly 0.
    const expectedState = reason === 'no_signature_headers' || reason === 'no_signature_agent'
      ? 'no-claim'
      : 'unverified';
    assert.equal(fact.state, expectedState, reason);
    assert.equal(fact.evidenceDelta, 0);
    // replay_detected is the one reason that surfaces as a side
    // event (still unverified, still delta 0).
    assert.equal(fact.sideEvent, reason === 'replay_detected' ? 'REPLAY' : null, reason);
  }
  // The one conclusive forgery detail, and only that detail, is evidence.
  const forged = sdk.classifyWebBotAuthVerdict({
    verified: false,
    reason: 'invalid_signature',
    detail: sdk.WEB_BOT_AUTH_CRYPTO_FAILURE_DETAIL,
  });
  assert.equal(forged.state, 'spoofed');
  assert.equal(forged.evidenceDelta, 'EVIDENCE');
  // Host-side channels: contradiction is forgery, a match is
  // verified-neutral, anything unrecognized stays unverified.
  assert.equal(sdk.classifyHostVerificationFact('fcrdns', 'contradiction').state, 'spoofed');
  const match = sdk.classifyHostVerificationFact('fcrdns', 'forward-confirmed match');
  assert.equal(match.state, 'verified');
  assert.equal(match.evidenceDelta, 0);
  assert.equal(sdk.classifyHostVerificationFact('range', 'something-new').state, 'unverified');
});

test('drift guard: every shipped signal kind carries a KT-01 role', () => {
  const kinds = [
    'herd-phase', 'activity-phase', 'seat-occupancy', 'vote-brigading',
    'room-hop', 'reconnect-storm', 'herd-tightness', 'room-guard',
  ];
  for (const kind of kinds) {
    assert.equal(sdk.evidentiaryRoleOf({ channel: kind }), 'CONVICTING', kind);
    assert.equal(sdk.EVIDENTIARY_ROLE_TABLE[kind], 'CONVICTING', kind);
  }
  assert.equal(sdk.evidentiaryRoleOf({ channel: 'bs01-verification-fact', state: 'spoofed' }), 'CONVICTING');
  assert.equal(sdk.evidentiaryRoleOf({ channel: 'bs01-verification-fact', state: 'verified' }), 'CORROBORATING');
  assert.equal(sdk.evidentiaryRoleOf({ channel: 'definitely-not-a-channel' }), undefined);
});
