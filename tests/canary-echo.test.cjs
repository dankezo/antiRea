const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const SECRET = 'echo-test-secret-0123456789abcdef';
const OTHER_SECRET = 'echo-test-secret-fedcba9876543210';
const T0 = 1_700_000_000_000;

test('mint/verify roundtrip carries mintedFor, scope and expiry', () => {
  const id = sdk.mintEchoId(SECRET, { mintedFor: 'account:a', scope: 'accounts', now: T0, ttlMs: 60_000 });
  assert.ok(sdk.isEchoId(id));
  const v = sdk.verifyEchoId(SECRET, id, { now: T0 + 1000 });
  assert.equal(v.ok, true);
  assert.equal(v.mintedFor, 'account:a');
  assert.equal(v.scope, 'accounts');
  assert.equal(v.expiresAt, T0 + 60_000);
  assert.equal(sdk.resolveEchoFrom(SECRET, id, { now: T0 + 1000 }), 'account:a');
});

test('every mint is unique, so ids cannot be enumerated from one another', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const id = sdk.mintEchoId(SECRET, { mintedFor: 'account:a', now: T0 });
    assert.ok(!seen.has(id), 'two mints for the same identity must differ (random nonce)');
    seen.add(id);
    assert.equal(sdk.verifyEchoId(SECRET, id, { now: T0 }).ok, true);
  }
});

test('tampered payload and wrong secret fail as bad_signature and resolve to undefined', () => {
  const id = sdk.mintEchoId(SECRET, { mintedFor: 'account:a', now: T0 });
  // Rewrite the payload naming a different identity, keep the old signature.
  const body = id.slice(sdk.ECHO_ID_PREFIX.length);
  const [payloadPart, sig] = body.split('.');
  const payload = JSON.parse(Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  payload.f = 'account:victim';
  const forgedPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const forged = `${sdk.ECHO_ID_PREFIX}${forgedPart}.${sig}`;
  const v = sdk.verifyEchoId(SECRET, forged, { now: T0 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'bad_signature');
  assert.equal(sdk.resolveEchoFrom(SECRET, forged, { now: T0 }), undefined, 'a forged echo must never steer host behavior');
  assert.equal(sdk.verifyEchoId(OTHER_SECRET, id, { now: T0 }).reason, 'bad_signature');
});

test('malformed, expired and scope-mismatched ids fail with distinct reasons', () => {
  assert.equal(sdk.verifyEchoId(SECRET, 'not-an-echo').reason, 'malformed');
  assert.equal(sdk.verifyEchoId(SECRET, 'echo_nodot').reason, 'malformed');
  assert.equal(sdk.verifyEchoId(SECRET, '').reason, 'malformed');
  assert.equal(sdk.resolveEchoFrom(SECRET, 'ACC-1001'), undefined, 'ordinary record ids are not echoes');
  const id = sdk.mintEchoId(SECRET, { mintedFor: 'account:a', scope: 'accounts', now: T0, ttlMs: 5_000 });
  assert.equal(sdk.verifyEchoId(SECRET, id, { now: T0 + 6_000 }).reason, 'expired');
  assert.equal(sdk.resolveEchoFrom(SECRET, id, { now: T0 + 6_000 }), undefined);
  assert.equal(sdk.verifyEchoId(SECRET, id, { now: T0, expectedScope: 'reports' }).reason, 'scope_mismatch');
  assert.equal(sdk.verifyEchoId(SECRET, id, { now: T0, expectedScope: 'accounts' }).ok, true);
});

test('mintEchoRecord and canaryEchoLink embed verifiable ids for the host surface', () => {
  const rec = sdk.mintEchoRecord(SECRET, { mintedFor: 'account:a', now: T0 });
  assert.equal(rec.kind, 'echo_reference');
  assert.equal(sdk.resolveEchoFrom(SECRET, rec.id, { now: T0 }), 'account:a');
  const html = sdk.canaryEchoLink(SECRET, { mintedFor: 'account:b', now: T0 });
  assert.ok(html.includes('display:none'), 'trap link stays hidden like canaryTrapLink');
  assert.ok(html.includes('tabindex="-1"'));
  const m = /href="\/api\/accounts\/(echo_[^"]+)"/.exec(html);
  assert.ok(m, 'the link href carries the echo id on the detail-route shape');
  assert.equal(sdk.resolveEchoFrom(SECRET, m[1], { now: T0 }), 'account:b');
});

test('tripwire merge: identity B touching A\'s echo id joins A\'s cohort (and a forged echo merges nothing)', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  const echoId = sdk.mintEchoId(SECRET, { mintedFor: 'account:a', now: T0 });
  const range = (min, max) => ({ field: 'id', min, max, domainMin: 0, domainMax: 10_000 });
  const served = (from, n) => Array.from({ length: n }, (_, i) => from + i);
  // A serves a small slice (40 records: far below the 150-record
  // formation gate, so NO served-set formation can merge A and B -
  // the echo link is the only possible grouping signal).
  await tw.observe({ type: 'list', identity: 'account:a', predicate: range(0, 1000), recordIds: served(0, 40), ts: T0 });
  assert.equal(await tw.snapshotFor('account:a'), null, 'A alone is a singleton');
  // B presents A's echo id (the harness resolves it and feeds echoFrom).
  const echoFrom = sdk.resolveEchoFrom(SECRET, echoId, { now: T0 });
  assert.equal(echoFrom, 'account:a');
  await tw.observe({ type: 'detail', identity: 'account:b', echoFrom, ts: T0 + 1000 });
  const snap = await tw.snapshotFor('account:b');
  assert.ok(snap, 'B is in a cohort after touching A\'s echo');
  assert.deepEqual(snap.members, ['account:a', 'account:b']);
  // B's own abutting slice now accumulates into the SAME cohort.
  await tw.observe({ type: 'list', identity: 'account:b', predicate: range(1005, 2000), recordIds: served(1005, 40), ts: T0 + 2000 });
  const snap2 = await tw.snapshotFor('account:a');
  assert.deepEqual(snap2.members, ['account:a', 'account:b']);
  assert.equal(snap2.unionRecords, 80);

  // Forged echo: resolveEchoFrom returns undefined, so the host feeds
  // no echoFrom and C stays a singleton.
  const tw2 = sdk.createCusumTripwire({ alpha: 0.05 });
  await tw2.observe({ type: 'list', identity: 'account:a', predicate: range(0, 1000), recordIds: served(0, 40), ts: T0 });
  const forgedFrom = sdk.resolveEchoFrom(SECRET, `${echoId}x`, { now: T0 });
  assert.equal(forgedFrom, undefined);
  await tw2.observe({ type: 'detail', identity: 'account:c', ...(forgedFrom ? { echoFrom: forgedFrom } : {}), ts: T0 + 1000 });
  assert.equal(await tw2.snapshotFor('account:c'), null, 'a forged echo merges nothing');
});

test('self-echo is a no-op: an identity presenting its own echo does not cohort with itself', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  const echoId = sdk.mintEchoId(SECRET, { mintedFor: 'account:a', now: T0 });
  const echoFrom = sdk.resolveEchoFrom(SECRET, echoId, { now: T0 });
  await tw.observe({ type: 'detail', identity: 'account:a', echoFrom, ts: T0 });
  assert.equal(await tw.snapshotFor('account:a'), null);
});
