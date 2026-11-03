/**
 * Cleanup C1 regression tests (antiRea 2.7.0 pre-release audit wave):
 *
 * - F-23 (cursor-v2 authority): the in-memory authority keyed chains by
 *   `${subject}\0${scope}` with a raw NUL separator, so the pairs
 *   ("a\0b","c") and ("a","b\0c") shared one sequence counter. The key
 *   is now length-prefixed and the two counters are independent.
 * - NV-1 (cusum velocity): a cursor object whose issuedAtMs / pageSize
 *   / step is not a finite number (or whose dwell is not a plausible
 *   per-record measurement) permanently poisoned the identity's EWMA
 *   dwell - NaN/Infinity pinned it to the fastest bin, -Infinity and
 *   extreme magnitudes pinned it to the human bin. Invalid cursors are
 *   now skipped whole: no EWMA mutation, no increment, no throw.
 * - NV-2 (cursor / cursor-v2 / canary-echo): verifiers parsed the JSON
 *   payload BEFORE the HMAC with no token length bound (measured
 *   linear CPU, ~300 ms per MB of token on the audit machine, no
 *   amplification). Each verifier now rejects tokens longer than
 *   8192 characters as `malformed` before any decode/parse.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const SECRET = 'cleanup-c1-secret';
const T0 = 1_700_000_000_000;

/* ---------------------------------- F-23 --------------------------------- */

test('F-23: NUL-shifted (subject, scope) pairs own independent sequence counters', () => {
  const authority = sdk.createCursorV2Authority();
  authority.advanceSequence('a\0b', 'c');
  authority.advanceSequence('a\0b', 'c');
  assert.equal(authority.current('a\0b', 'c').sequence, 2);
  assert.equal(
    authority.current('a', 'b\0c').sequence,
    0,
    'the shifted pair must not share the first pair\'s counter',
  );
  authority.advanceSequence('a', 'b\0c');
  assert.equal(authority.current('a', 'b\0c').sequence, 1);
  assert.equal(authority.current('a\0b', 'c').sequence, 2, 'advancing one pair never moves the other');
});

test('F-23: separator-shaped pairs in general position stay independent', () => {
  const authority = sdk.createCursorV2Authority();
  // Any delimiter-joined key admits some shifted pair; length-prefixing admits none.
  for (const [subject, scope] of [['1:a', 'b'], ['1', ':ab'], ['12:x', 'y'], ['1', '2:xy']]) {
    authority.advanceSequence(subject, scope);
    assert.equal(authority.current(subject, scope).sequence, 1, `counter for ${JSON.stringify([subject, scope])}`);
  }
  assert.equal(authority.current('1:a', 'b').sequence, 1);
  assert.equal(authority.current('1', ':ab').sequence, 1);
});

test('F-23: the normal V2 chain through the in-memory authority still verifies end to end', () => {
  const authority = sdk.createCursorV2Authority();
  const first = sdk.mintCursorV2(SECRET, {
    subject: 'account:a', scope: 'records', position: 0,
    authority: authority.current('account:a', 'records'), now: 1_000_000,
  });
  assert.equal(
    sdk.verifyCursorV2(SECRET, first, {
      subject: 'account:a', scope: 'records',
      authority: authority.current('account:a', 'records'), now: 1_000_100,
    }).ok,
    true,
  );
  authority.advanceSequence('account:a', 'records');
  const second = sdk.mintCursorV2(SECRET, {
    subject: 'account:a', scope: 'records', position: 50,
    authority: authority.current('account:a', 'records'), now: 1_000_200,
  });
  const result = sdk.verifyCursorV2(SECRET, second, {
    subject: 'account:a', scope: 'records',
    authority: authority.current('account:a', 'records'), expectedPosition: 50, now: 1_000_300,
  });
  assert.deepEqual(result, {
    ok: true, position: 50, sequence: 1, ledgerVersion: 0,
    expiresAt: 1_000_200 + sdk.DEFAULT_CURSOR_V2_TTL_MS,
  });
});

/* ---------------------------------- NV-1 --------------------------------- */

const HUMAN_CURSOR = ts => ({ issuedAtMs: ts - 50_000, pageSize: 10, step: 5 }); // dwell 5000 ms/record
const FAST_CURSOR = ts => ({ issuedAtMs: ts - 100, pageSize: 10, step: 5 }); // dwell 10 ms/record

async function feedCursors(tw, identity, makeCursor, count, startTs) {
  let decision;
  for (let i = 0; i < count; i++) {
    const ts = startTs + (i + 1) * 1000;
    decision = await tw.observe({ type: 'list', identity, cursor: makeCursor(ts), ts });
  }
  return decision;
}

const POISONS = [
  ['issuedAtMs NaN', { issuedAtMs: NaN, pageSize: 10, step: 5 }],
  ['issuedAtMs Infinity', { issuedAtMs: Infinity, pageSize: 10, step: 5 }],
  ['issuedAtMs -Infinity', { issuedAtMs: -Infinity, pageSize: 10, step: 5 }],
  ['issuedAtMs string', { issuedAtMs: 'not-a-number', pageSize: 10, step: 5 }],
  ['issuedAtMs -1e308 (dwell overflow-scale)', { issuedAtMs: -1e308, pageSize: 10, step: 5 }],
  ['issuedAtMs +1e308 (dwell overflow-scale)', { issuedAtMs: 1e308, pageSize: 10, step: 5 }],
  ['issuedAtMs 0 at epoch-scale ts (stale dwell)', { issuedAtMs: 0, pageSize: 10, step: 5 }],
  ['pageSize NaN', { issuedAtMs: T0, pageSize: NaN, step: 5 }],
  ['pageSize Infinity', { issuedAtMs: T0, pageSize: Infinity, step: 5 }],
  ['step NaN (poison used to land before the step gate)', { issuedAtMs: NaN, pageSize: 10, step: 1 }],
];

for (const [label, poison] of POISONS) {
  test(`NV-1: poisoned cursor (${label}) is inert and the EWMA recovers in both directions`, async () => {
    // The poison event itself: no velocity evidence, no EWMA touch, no throw.
    const tw0 = sdk.createCusumTripwire({});
    const poisoned = await tw0.observe({ type: 'list', identity: 'account:x', cursor: poison, ts: T0 });
    assert.equal(poisoned.bins.velocity, null, 'an invalid cursor yields no velocity bin');
    assert.equal(poisoned.increments.velocity, 0, 'an invalid cursor yields no velocity increment');

    // After poisoning, human-paced traffic must read human again...
    const twHuman = sdk.createCusumTripwire({});
    await twHuman.observe({ type: 'list', identity: 'account:x', cursor: poison, ts: T0 });
    const human = await feedCursors(twHuman, 'account:x', HUMAN_CURSOR, 7, T0);
    assert.equal(human.bins.velocity, 'human');
    assert.equal(human.increments.velocity, sdk.R6_CALIB_1_LLR_TABLES.velocity.human);

    // ...and machine-paced traffic must read fastest-bin again.
    const twFast = sdk.createCusumTripwire({});
    await twFast.observe({ type: 'list', identity: 'account:x', cursor: poison, ts: T0 });
    const fast = await feedCursors(twFast, 'account:x', FAST_CURSOR, 7, T0);
    assert.equal(fast.bins.velocity, 'v_lt_30');
    assert.equal(fast.increments.velocity, sdk.R6_CALIB_1_LLR_TABLES.velocity.v_lt_30);
  });
}

test('NV-1: non-object and all-NaN cursors never throw and carry no velocity evidence', async () => {
  const tw = sdk.createCusumTripwire({});
  for (const cursor of [42, 'cursor', { issuedAtMs: NaN, pageSize: NaN, step: NaN }]) {
    const decision = await tw.observe({ type: 'list', identity: 'account:y', cursor, ts: T0 });
    assert.equal(decision.bins.velocity, null);
    assert.equal(decision.increments.velocity, 0);
  }
});

test('NV-1: legitimate velocity behavior is unchanged (fast chain still hits the fastest bin)', async () => {
  const tw = sdk.createCusumTripwire({});
  const decision = await feedCursors(tw, 'account:fast', FAST_CURSOR, 7, T0);
  assert.equal(decision.bins.velocity, 'v_lt_30');
  assert.equal(decision.increments.velocity, sdk.R6_CALIB_1_LLR_TABLES.velocity.v_lt_30);
  const tw2 = sdk.createCusumTripwire({});
  const human = await feedCursors(tw2, 'account:slow', HUMAN_CURSOR, 7, T0);
  assert.equal(human.bins.velocity, 'human');
});

/* ---------------------------------- NV-2 --------------------------------- */

test('NV-2: the token length caps are exported and set at 8192 characters', () => {
  assert.equal(sdk.MAX_CURSOR_TOKEN_LENGTH, 8192);
  assert.equal(sdk.MAX_CURSOR_V2_TOKEN_LENGTH, 8192);
  assert.equal(sdk.MAX_ECHO_ID_LENGTH, 8192);
});

test('NV-2: an oversized but validly signed V1 cursor is rejected as malformed before parsing', () => {
  const token = sdk.mintCursor(SECRET, {
    sessionId: 'sess-1', position: 50, filterHash: `f:${'x'.repeat(7000)}`, now: 1_000_000,
  });
  assert.ok(token.length > sdk.MAX_CURSOR_TOKEN_LENGTH, `fixture token is ${token.length} chars`);
  assert.deepEqual(
    sdk.verifyCursor(SECRET, token, { sessionId: 'sess-1', now: 1_000_100 }),
    { ok: false, reason: 'malformed' },
  );
});

test('NV-2: an oversized wrong-HMAC token is malformed, not bad_signature (rejected before parse/HMAC work)', () => {
  const payload = { v: 1, sid: 'sess-1', pos: 0, fh: 'y'.repeat(9000), iat: 1_000_000, exp: 2_000_000 };
  const part = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const token = `${part}.${Buffer.from('x'.repeat(32)).toString('base64url')}`;
  assert.ok(token.length > 8192);
  assert.deepEqual(
    sdk.verifyCursor(SECRET, token, { sessionId: 'sess-1', now: 1_500_000 }),
    { ok: false, reason: 'malformed' },
  );
});

test('NV-2: large-but-legitimate V1 cursors (512-char session and filter) still verify', () => {
  const sessionId = 's'.repeat(512);
  const token = sdk.mintCursor(SECRET, {
    sessionId, position: 50, filterHash: `f:${'h'.repeat(512)}`, now: 1_000_000,
  });
  assert.ok(token.length < sdk.MAX_CURSOR_TOKEN_LENGTH, `fixture token is ${token.length} chars`);
  const result = sdk.verifyCursor(SECRET, token, { sessionId, expectedPosition: 50, now: 1_000_100 });
  assert.equal(result.ok, true);
  assert.equal(result.position, 50);
});

test('NV-2: an oversized but validly signed V2 cursor is rejected as malformed; a large legitimate one verifies', () => {
  const AUTH = { ledgerVersion: 3, sequence: 7 };
  const oversized = sdk.mintCursorV2(SECRET, {
    subject: 'a'.repeat(4000), scope: 'b'.repeat(4000), position: 0, authority: AUTH, now: 1_000_000,
  });
  assert.ok(oversized.length > sdk.MAX_CURSOR_V2_TOKEN_LENGTH, `fixture token is ${oversized.length} chars`);
  assert.deepEqual(
    sdk.verifyCursorV2(SECRET, oversized, {
      subject: 'a'.repeat(4000), scope: 'b'.repeat(4000), authority: AUTH, now: 1_000_100,
    }),
    { ok: false, reason: 'malformed' },
  );

  const large = sdk.mintCursorV2(SECRET, {
    subject: 'a'.repeat(1000), scope: 'b'.repeat(1000), position: 25, authority: AUTH, now: 1_000_000,
  });
  assert.ok(large.length < sdk.MAX_CURSOR_V2_TOKEN_LENGTH, `fixture token is ${large.length} chars`);
  assert.equal(
    sdk.verifyCursorV2(SECRET, large, {
      subject: 'a'.repeat(1000), scope: 'b'.repeat(1000), authority: AUTH, now: 1_000_100,
    }).ok,
    true,
  );
});

test('NV-2: an oversized echo id is rejected as malformed and resolves to undefined; a large legitimate one resolves', () => {
  const oversized = sdk.mintEchoId(SECRET, { mintedFor: 'a'.repeat(7000), now: T0 });
  assert.ok(oversized.length > sdk.MAX_ECHO_ID_LENGTH, `fixture id is ${oversized.length} chars`);
  assert.deepEqual(sdk.verifyEchoId(SECRET, oversized, { now: T0 }), { ok: false, reason: 'malformed' });
  assert.equal(sdk.resolveEchoFrom(SECRET, oversized, { now: T0 }), undefined);

  const large = sdk.mintEchoId(SECRET, { mintedFor: 'a'.repeat(512), scope: 's'.repeat(512), now: T0 });
  assert.ok(large.length < sdk.MAX_ECHO_ID_LENGTH, `fixture id is ${large.length} chars`);
  assert.equal(sdk.verifyEchoId(SECRET, large, { now: T0 }).ok, true);
  assert.equal(sdk.resolveEchoFrom(SECRET, large, { now: T0 }), 'a'.repeat(512));
});
