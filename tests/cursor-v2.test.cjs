const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sdk = require('../dist/index.js');

const SECRET = 'cursor-v2-test-secret';
const AUTH = { ledgerVersion: 3, sequence: 7 };

function signPayload(payload) {
  const part = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(part).digest();
  return `${part}.${Buffer.from(sig).toString('base64url')}`;
}

test('cursor v2: roundtrip verifies position, sequence and ledger version', () => {
  const token = sdk.mintCursorV2(SECRET, {
    subject: 'account:a', cohortId: 'coh:1', scope: 'records', position: 50, authority: AUTH, now: 1_000_000,
  });
  const result = sdk.verifyCursorV2(SECRET, token, {
    subject: 'account:a', cohortId: 'coh:1', scope: 'records', authority: AUTH, expectedPosition: 50, now: 1_000_100,
  });
  assert.deepEqual(result, { ok: true, position: 50, sequence: 7, ledgerVersion: 3, expiresAt: 1_000_000 + sdk.DEFAULT_CURSOR_V2_TTL_MS });
});

test('cursor v2: payload carries only the allowlisted keys - no evidence fields exist', () => {
  const token = sdk.mintCursorV2(SECRET, {
    subject: 'account:a', scope: 'records', position: 0, authority: AUTH, now: 1_000_000,
  });
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload).sort(), ['exp', 'iat', 'lv', 'pos', 'scope', 'seq', 'sub', 'v']);
  assert.equal('llr' in payload, false);
  assert.equal('evidence' in payload, false);
  assert.equal('score' in payload, false);
});

test('cursor v2: a signed token carrying an evidence field is rejected as unexpected_fields', () => {
  const forged = signPayload({
    v: 2, sub: 'account:a', scope: 'records', pos: 0, seq: 7, lv: 3, llr: 4.2, iat: 1_000_000, exp: 2_000_000,
  });
  const result = sdk.verifyCursorV2(SECRET, forged, {
    subject: 'account:a', scope: 'records', authority: AUTH, now: 1_500_000,
  });
  assert.deepEqual(result, { ok: false, reason: 'unexpected_fields' });
});

test('cursor v2: STORE WINS - a token minted before a ledger write is stale and rejected, never upgraded', () => {
  const token = sdk.mintCursorV2(SECRET, {
    subject: 'account:a', scope: 'records', position: 50, authority: AUTH, now: 1_000_000,
  });
  const result = sdk.verifyCursorV2(SECRET, token, {
    subject: 'account:a', scope: 'records', authority: { ledgerVersion: 4, sequence: 7 }, now: 1_000_100,
  });
  assert.deepEqual(result, { ok: false, reason: 'stale_version' });
});

test('cursor v2: STORE WINS - a token from ahead of the store is a future version and rejected', () => {
  const token = sdk.mintCursorV2(SECRET, {
    subject: 'account:a', scope: 'records', position: 50, authority: { ledgerVersion: 9, sequence: 7 }, now: 1_000_000,
  });
  const result = sdk.verifyCursorV2(SECRET, token, {
    subject: 'account:a', scope: 'records', authority: AUTH, now: 1_000_100,
  });
  assert.deepEqual(result, { ok: false, reason: 'future_version' });
});

test('cursor v2: replaying an earlier chain token fails the sequence check', () => {
  const authority = sdk.createCursorV2Authority();
  const first = sdk.mintCursorV2(SECRET, {
    subject: 'account:a', scope: 'records', position: 0, authority: authority.current('account:a', 'records'), now: 1_000_000,
  });
  authority.advanceSequence('account:a', 'records');
  const replay = sdk.verifyCursorV2(SECRET, first, {
    subject: 'account:a', scope: 'records', authority: authority.current('account:a', 'records'), now: 1_000_100,
  });
  assert.deepEqual(replay, { ok: false, reason: 'sequence_mismatch' });
});

test('cursor v2: binding, expiry, tamper and position failures keep distinct reasons', () => {
  const token = sdk.mintCursorV2(SECRET, {
    subject: 'account:a', scope: 'records', position: 50, authority: AUTH, ttlMs: 5_000, now: 1_000_000,
  });
  const base = { subject: 'account:a', scope: 'records', authority: AUTH, now: 1_000_100 };
  assert.deepEqual(sdk.verifyCursorV2(SECRET, token, { ...base, subject: 'account:b' }), { ok: false, reason: 'binding_mismatch' });
  assert.deepEqual(sdk.verifyCursorV2(SECRET, token, { ...base, now: 1_006_000 }), { ok: false, reason: 'expired' });
  assert.deepEqual(sdk.verifyCursorV2(SECRET, token, { ...base, expectedPosition: 51 }), { ok: false, reason: 'position_mismatch' });
  const [part] = token.split('.');
  const tampered = `${part}.${Buffer.from('x'.repeat(32)).toString('base64url')}`;
  assert.deepEqual(sdk.verifyCursorV2(SECRET, tampered, base), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(sdk.verifyCursorV2(SECRET, 'not-a-token', base), { ok: false, reason: 'malformed' });
});

test('cursor v2: v1 cursors are untouched and still verify through the v1 path', () => {
  const v1 = sdk.mintCursor(SECRET, { sessionId: 'sess-1', position: 10, now: 1_000_000 });
  const result = sdk.verifyCursor(SECRET, v1, { sessionId: 'sess-1', now: 1_000_100 });
  assert.equal(result.ok, true);
});
