const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const SECRET_A = 'echo-rotation-secret-A-0123456789ab';
const SECRET_B = 'echo-rotation-secret-B-fedcba987654';
const SECRET_C = 'echo-rotation-secret-C-00112233445566';
const UNKNOWN_SECRET = 'echo-rotation-secret-UNKNOWN-999999';
const T0 = 1_700_000_000_000;

test('L8c: id minted under secret A verifies after rotation to B with A in previousSecrets and reports previous generation', () => {
  const id = sdk.mintEchoId(SECRET_A, { mintedFor: 'account:a', scope: 'accounts', now: T0, ttlMs: 60_000 });
  // After rotation the current secret is B; A is retired but still in the window.
  const v = sdk.verifyEchoId(SECRET_B, id, { now: T0 + 1000, previousSecrets: [SECRET_A] });
  assert.equal(v.ok, true);
  assert.equal(v.mintedFor, 'account:a');
  assert.equal(v.scope, 'accounts');
  assert.equal(v.expiresAt, T0 + 60_000);
  assert.equal(v.secretGeneration, 'previous');
  assert.equal(v.previousSecretIndex, 0);
  // No secret material leaks through the result.
  assert.ok(!JSON.stringify(v).includes(SECRET_A));
  assert.ok(!JSON.stringify(v).includes(SECRET_B));
});

test('L8c: current-secret id reports current generation even when previousSecrets are configured', () => {
  const id = sdk.mintEchoId(SECRET_B, { mintedFor: 'account:b', now: T0 });
  const v = sdk.verifyEchoId(SECRET_B, id, { now: T0 + 1000, previousSecrets: [SECRET_A] });
  assert.equal(v.ok, true);
  assert.equal(v.secretGeneration, 'current');
  assert.equal(v.previousSecretIndex, undefined);
});

test('L8c: without previousSecrets, behavior is unchanged - current reports current, retired-secret id fails', () => {
  const currentId = sdk.mintEchoId(SECRET_B, { mintedFor: 'account:b', now: T0 });
  const vCurrent = sdk.verifyEchoId(SECRET_B, currentId, { now: T0 + 1000 });
  assert.equal(vCurrent.ok, true);
  assert.equal(vCurrent.secretGeneration, 'current');

  const oldId = sdk.mintEchoId(SECRET_A, { mintedFor: 'account:a', now: T0 });
  // No window configured: identical to pre-rotation behavior.
  assert.deepEqual(sdk.verifyEchoId(SECRET_B, oldId, { now: T0 + 1000 }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(sdk.verifyEchoId(SECRET_B, oldId, { now: T0 + 1000, previousSecrets: [] }), { ok: false, reason: 'bad_signature' });
  assert.equal(sdk.resolveEchoFrom(SECRET_B, oldId, { now: T0 + 1000 }), undefined);
});

test('L8c: after A is removed from previousSecrets, its ids fail as bad_signature', () => {
  const id = sdk.mintEchoId(SECRET_A, { mintedFor: 'account:a', now: T0 });
  // Inside the window it verifies.
  assert.equal(sdk.verifyEchoId(SECRET_B, id, { now: T0 + 1000, previousSecrets: [SECRET_A] }).ok, true);
  // Window closed for A (removed, or replaced by a different retired secret).
  assert.deepEqual(
    sdk.verifyEchoId(SECRET_B, id, { now: T0 + 1000, previousSecrets: [] }),
    { ok: false, reason: 'bad_signature' },
  );
  assert.deepEqual(
    sdk.verifyEchoId(SECRET_B, id, { now: T0 + 1000, previousSecrets: [SECRET_C] }),
    { ok: false, reason: 'bad_signature' },
  );
  assert.equal(sdk.resolveEchoFrom(SECRET_B, id, { now: T0 + 1000, previousSecrets: [] }), undefined);
});

test('L8c: minting under rotation never produces an id that verifies under a retired secret', () => {
  // Minting is called with the current secret B while A is retired.
  // There is no mint API that takes previousSecrets; every helper must
  // sign with B only.
  const id = sdk.mintEchoId(SECRET_B, { mintedFor: 'account:b', now: T0 });
  const rec = sdk.mintEchoRecord(SECRET_B, { mintedFor: 'account:b', now: T0 });
  const html = sdk.canaryEchoLink(SECRET_B, { mintedFor: 'account:b', now: T0 });
  const m = /href="\/api\/accounts\/(echo_[^"]+)"/.exec(html);
  assert.ok(m, 'trap link carries an echo id');

  for (const minted of [id, rec.id, m[1]]) {
    // Does NOT verify under A alone.
    assert.equal(sdk.verifyEchoId(SECRET_A, minted, { now: T0 + 1000 }).reason, 'bad_signature');
    assert.equal(sdk.resolveEchoFrom(SECRET_A, minted, { now: T0 + 1000 }), undefined);
    // Does NOT verify as "previous" when A is the retired secret - it is current under B.
    const v = sdk.verifyEchoId(SECRET_B, minted, { now: T0 + 1000, previousSecrets: [SECRET_A] });
    assert.equal(v.ok, true);
    assert.equal(v.secretGeneration, 'current');
    // And if the host mistakenly kept A as current with B retired, it still must not pass as previous-via-B either
    // for a different reason check: verify under A with B as previous must fail because the signature is B's
    // only when B is listed - so assert the precise semantics: under A(current)+[B](previous) it WOULD verify
    // as previous, which proves the signature really is B's. The bar is that it never verifies UNDER A
    // as the signing secret, i.e. not with A alone and not as current under A.
    const vSwapped = sdk.verifyEchoId(SECRET_A, minted, { now: T0 + 1000, previousSecrets: [SECRET_B] });
    assert.equal(vSwapped.ok, true);
    assert.equal(vSwapped.secretGeneration, 'previous');
  }
});

test('L8c: an id forged under an unknown secret still fails, even with previousSecrets configured', () => {
  const forged = sdk.mintEchoId(UNKNOWN_SECRET, { mintedFor: 'account:victim', now: T0 });
  assert.deepEqual(
    sdk.verifyEchoId(SECRET_B, forged, { now: T0 + 1000, previousSecrets: [SECRET_A] }),
    { ok: false, reason: 'bad_signature' },
  );
  assert.equal(
    sdk.resolveEchoFrom(SECRET_B, forged, { now: T0 + 1000, previousSecrets: [SECRET_A] }),
    undefined,
  );
  // Tampering with a previous-secret id's payload also still fails.
  const legit = sdk.mintEchoId(SECRET_A, { mintedFor: 'account:a', now: T0 });
  const body = legit.slice(sdk.ECHO_ID_PREFIX.length);
  const [payloadPart, sig] = body.split('.');
  const payload = JSON.parse(Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  payload.f = 'account:victim';
  const forgedPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tampered = `${sdk.ECHO_ID_PREFIX}${forgedPart}.${sig}`;
  assert.equal(
    sdk.verifyEchoId(SECRET_B, tampered, { now: T0 + 1000, previousSecrets: [SECRET_A] }).reason,
    'bad_signature',
  );
});

test('L8c: resolveEchoFrom returns the origin for a previous-secret id inside the window', () => {
  const id = sdk.mintEchoId(SECRET_A, { mintedFor: 'account:origin', now: T0 });
  assert.equal(
    sdk.resolveEchoFrom(SECRET_B, id, { now: T0 + 1000, previousSecrets: [SECRET_A] }),
    'account:origin',
  );
  // Same call without the window resolves nothing.
  assert.equal(sdk.resolveEchoFrom(SECRET_B, id, { now: T0 + 1000 }), undefined);
});

test('L8c: multiple previous secrets are tried in order and the index is reported', () => {
  const idUnderC = sdk.mintEchoId(SECRET_C, { mintedFor: 'account:c', now: T0 });
  const v = sdk.verifyEchoId(SECRET_B, idUnderC, { now: T0 + 1000, previousSecrets: [SECRET_A, SECRET_C] });
  assert.equal(v.ok, true);
  assert.equal(v.secretGeneration, 'previous');
  assert.equal(v.previousSecretIndex, 1);
  assert.equal(
    sdk.resolveEchoFrom(SECRET_B, idUnderC, { now: T0 + 1000, previousSecrets: [SECRET_A, SECRET_C] }),
    'account:c',
  );
  // Current secret takes precedence when it also appears in the retired list.
  const idUnderB = sdk.mintEchoId(SECRET_B, { mintedFor: 'account:b', now: T0 });
  const vDup = sdk.verifyEchoId(SECRET_B, idUnderB, { now: T0 + 1000, previousSecrets: [SECRET_B, SECRET_A] });
  assert.equal(vDup.ok, true);
  assert.equal(vDup.secretGeneration, 'current');
  assert.equal(vDup.previousSecretIndex, undefined);
});

test('L8c: expiry and scope checks still apply to previous-secret ids', () => {
  const id = sdk.mintEchoId(SECRET_A, { mintedFor: 'account:a', scope: 'accounts', now: T0, ttlMs: 5_000 });
  // Expired under a retired secret reports expired, not a success and not bad_signature.
  assert.deepEqual(
    sdk.verifyEchoId(SECRET_B, id, { now: T0 + 6_000, previousSecrets: [SECRET_A] }),
    { ok: false, reason: 'expired' },
  );
  assert.equal(sdk.resolveEchoFrom(SECRET_B, id, { now: T0 + 6_000, previousSecrets: [SECRET_A] }), undefined);
  // Scope mismatch under a retired secret reports scope_mismatch.
  assert.deepEqual(
    sdk.verifyEchoId(SECRET_B, id, { now: T0 + 1000, expectedScope: 'reports', previousSecrets: [SECRET_A] }),
    { ok: false, reason: 'scope_mismatch' },
  );
  assert.equal(
    sdk.verifyEchoId(SECRET_B, id, { now: T0 + 1000, expectedScope: 'accounts', previousSecrets: [SECRET_A] }).ok,
    true,
  );
});

test('L8c: Uint8Array secrets work across the rotation window', () => {
  const aBytes = new TextEncoder().encode(SECRET_A);
  const bBytes = new TextEncoder().encode(SECRET_B);
  const id = sdk.mintEchoId(aBytes, { mintedFor: 'account:a', now: T0 });
  const v = sdk.verifyEchoId(bBytes, id, { now: T0 + 1000, previousSecrets: [aBytes] });
  assert.equal(v.ok, true);
  assert.equal(v.secretGeneration, 'previous');
  assert.equal(v.previousSecretIndex, 0);
});
