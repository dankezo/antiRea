const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const SECRET = 'cursor-test-secret';

test('cursor roundtrip: minted cursor verifies with its position and filter hash', () => {
  const token = sdk.mintCursor(SECRET, { sessionId: 'sess-1', position: 50, filterHash: 'f:abc', now: 1_000_000 });
  const result = sdk.verifyCursor(SECRET, token, { sessionId: 'sess-1', expectedPosition: 50, now: 1_000_100 });
  assert.equal(result.ok, true);
  assert.equal(result.position, 50);
  assert.equal(result.filterHash, 'f:abc');
  assert.equal(result.expiresAt, 1_000_000 + sdk.DEFAULT_CURSOR_TTL_MS);
});

test('cursor payload is readable but tampering fails the signature check', () => {
  const token = sdk.mintCursor(SECRET, { sessionId: 'sess-1', position: 50, now: 1_000_000 });
  const [payloadPart, signaturePart] = token.split('.');
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  assert.equal(payload.pos, 50); // integrity only: the payload is not encrypted
  payload.pos = 5000;
  const forged = `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${signaturePart}`;
  const result = sdk.verifyCursor(SECRET, forged, { sessionId: 'sess-1', now: 1_000_100 });
  assert.deepEqual(result, { ok: false, reason: 'bad_signature' });
});

test('cursor verified under the wrong secret fails the signature check', () => {
  const token = sdk.mintCursor(SECRET, { sessionId: 'sess-1', position: 0, now: 1_000_000 });
  assert.deepEqual(
    sdk.verifyCursor('another-secret', token, { sessionId: 'sess-1', now: 1_000_100 }),
    { ok: false, reason: 'bad_signature' },
  );
});

test('stale cursor replay fails as expired once the TTL passes', () => {
  const token = sdk.mintCursor(SECRET, { sessionId: 'sess-1', position: 50, ttlMs: 5_000, now: 1_000_000 });
  assert.equal(sdk.verifyCursor(SECRET, token, { sessionId: 'sess-1', now: 1_004_999 }).ok, true);
  const expired = sdk.verifyCursor(SECRET, token, { sessionId: 'sess-1', now: 1_005_000 });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');
});

test('an expired (but authentic) cursor result carries the decoded payload for re-minting', () => {
  const token = sdk.mintCursor(SECRET, {
    sessionId: 'sess-1', position: 150, filterHash: 'f:eu', ttlMs: 5_000, now: 1_000_000,
  });
  const result = sdk.verifyCursor(SECRET, token, { sessionId: 'sess-1', now: 1_006_000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
  // The host pattern: re-mint at the carried position and continue the chain.
  assert.equal(result.sessionId, 'sess-1');
  assert.equal(result.position, 150);
  assert.equal(result.filterHash, 'f:eu');
  assert.equal(result.expiresAt, 1_005_000);
  const reminted = sdk.mintCursor(SECRET, {
    sessionId: result.sessionId, position: result.position, filterHash: result.filterHash, now: 1_006_000,
  });
  assert.equal(sdk.verifyCursor(SECRET, reminted, { sessionId: 'sess-1', expectedPosition: 150, now: 1_006_100 }).ok, true);
});

test('tampered and malformed results carry NO payload fields', () => {
  const token = sdk.mintCursor(SECRET, { sessionId: 'sess-1', position: 50, now: 1_000_000 });
  const [payloadPart, signaturePart] = token.split('.');
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  payload.pos = 9999;
  const forged = `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${signaturePart}`;
  for (const bad of [forged, 'a.b.c', '']) {
    const result = sdk.verifyCursor(SECRET, bad, { sessionId: 'sess-1', now: 9_999_999 });
    assert.equal(result.ok, false);
    assert.equal('position' in result, false, `no position on ${result.reason}`);
    assert.equal('sessionId' in result, false, `no sessionId on ${result.reason}`);
    assert.equal('filterHash' in result, false, `no filterHash on ${result.reason}`);
  }
});

test('cross-session replay fails as session_mismatch', () => {
  const token = sdk.mintCursor(SECRET, { sessionId: 'sess-A', position: 50, now: 1_000_000 });
  assert.deepEqual(
    sdk.verifyCursor(SECRET, token, { sessionId: 'sess-B', now: 1_000_100 }),
    { ok: false, reason: 'session_mismatch' },
  );
});

test('skip-ahead fails as position_mismatch (the lab probe)', () => {
  const token = sdk.mintCursor(SECRET, { sessionId: 'sess-1', position: 50, now: 1_000_000 });
  assert.deepEqual(
    sdk.verifyCursor(SECRET, token, { sessionId: 'sess-1', expectedPosition: 5000, now: 1_000_100 }),
    { ok: false, reason: 'position_mismatch' },
  );
  // Without an expected position the same token is a valid chain step.
  assert.equal(sdk.verifyCursor(SECRET, token, { sessionId: 'sess-1', now: 1_000_100 }).ok, true);
});

test('malformed tokens are rejected before signature verification', () => {
  const notJson = `${Buffer.from('not json', 'utf8').toString('base64url')}.${Buffer.from('x').toString('base64url')}`;
  for (const bad of ['', 'no-dot-here', 'a.b.c', '.', notJson]) {
    assert.deepEqual(
      sdk.verifyCursor(SECRET, bad, { sessionId: 'sess-1' }),
      { ok: false, reason: 'malformed' },
      `token should be malformed: ${JSON.stringify(bad)}`,
    );
  }
});

test('garbage signature bytes fail as bad_signature, not malformed', () => {
  const token = sdk.mintCursor(SECRET, { sessionId: 'sess-1', position: 0, now: 1_000_000 });
  const [payloadPart] = token.split('.');
  assert.deepEqual(
    sdk.verifyCursor(SECRET, `${payloadPart}.!!!`, { sessionId: 'sess-1', now: 1_000_100 }),
    { ok: false, reason: 'bad_signature' },
  );
});
