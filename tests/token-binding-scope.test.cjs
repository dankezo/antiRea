const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
// LPG-06 TOKEN-BINDING-SCOPE: these tests re-run the NEW
// measurement of 2026-11-18 (this candidate had no prior
// measurement run; ledger status was "frozen design only").
// Part B of the probe ran a 31-cell fixture matrix against
// reference logic identical to this module and passed 31/31;
// Part A measured the gap it fills (shipped cursor / echo /
// step-up verifiers take no network context at all, and the
// bulk access key accepts its owner from a fully disjoint
// context, 7/7 cells as expected). Fixtures below are the
// probe's verbatim: IPv4 issuer 192.0.2.10, IPv6 issuer
// 2001:db8:abcd:12::10, family chromium, JA4_A and JA4_B in
// the same family with different cipher sets, JA4_F foreign.
const m = require('../dist/tier2-active/token-binding-scope.js');

const JA4_A = 't13d1516h2_aaaabbbbcccc_111111111111';
const JA4_B = 't13d1516h2_zzzzyyyyxxxx_111111111111';
const JA4_F = 't13d1715h2_qqqqwwwwuuuu_222222222222';
const V4 = { ip: '192.0.2.10', browserFamily: 'chromium', ja4: JA4_A };
const V6 = { ip: '2001:db8:abcd:12::10', browserFamily: 'chromium', ja4: JA4_A };
const lax4 = m.deriveTokenBinding('lax', V4);
const strict4 = m.deriveTokenBinding('strict', V4);
const lax6 = m.deriveTokenBinding('lax', V6);
const strict6 = m.deriveTokenBinding('strict', V6);
const ok = (scope) => ({ ok: true, scope });
const no = (reason) => ({ ok: false, reason });

test('a derived binding states its scope, and the scope is readable without verifying', () => {
  assert.equal(JSON.parse(lax4)[0], 'lax');
  assert.equal(JSON.parse(strict4)[0], 'strict');
  assert.equal(m.tokenBindingScopeOf(lax4), 'lax');
  assert.equal(m.tokenBindingScopeOf(strict6), 'strict');
  assert.equal(m.tokenBindingScopeOf('not-a-binding'), null);
  assert.equal(m.tokenBindingScopeOf(42), null);
  // The two scopes never derive the same value for one context.
  assert.notEqual(lax4, strict4);
  assert.notEqual(lax6, strict6);
});

test('identical context verifies under both scopes (probe P1 and V1, 4/4)', () => {
  assert.deepEqual(m.verifyTokenBinding(lax4, V4), ok('lax'));
  assert.deepEqual(m.verifyTokenBinding(strict4, V4), ok('strict'));
  assert.deepEqual(m.verifyTokenBinding(lax6, V6), ok('lax'));
  assert.deepEqual(m.verifyTokenBinding(strict6, V6), ok('strict'));
});

test('registered probe cell: same /24, different JA4 in the same family - lax passes, strict fails', () => {
  const presented = { ...V4, ip: '192.0.2.99', ja4: JA4_B };
  assert.deepEqual(m.verifyTokenBinding(lax4, presented), ok('lax'));
  assert.deepEqual(m.verifyTokenBinding(strict4, presented), no('ip_out_of_scope'));
});

test('same /24 with the same JA4: lax passes on prefix alone, strict still fails on the address', () => {
  const presented = { ...V4, ip: '192.0.2.99' };
  assert.deepEqual(m.verifyTokenBinding(lax4, presented), ok('lax'));
  assert.deepEqual(m.verifyTokenBinding(strict4, presented), no('ip_out_of_scope'));
});

test('same address with an in-family JA4 change isolates the TLS leg: lax passes, strict fails tls_mismatch', () => {
  const presented = { ...V4, ja4: JA4_B };
  assert.deepEqual(m.verifyTokenBinding(lax4, presented), ok('lax'));
  assert.deepEqual(m.verifyTokenBinding(strict4, presented), no('tls_mismatch'));
});

test('out-of-prefix presentations fail under both scopes (probe P4 and V3)', () => {
  assert.deepEqual(m.verifyTokenBinding(lax4, { ...V4, ip: '192.0.3.10' }), no('ip_out_of_scope'));
  assert.deepEqual(m.verifyTokenBinding(strict4, { ...V4, ip: '192.0.3.10' }), no('ip_out_of_scope'));
  assert.deepEqual(m.verifyTokenBinding(lax6, { ...V6, ip: '2001:db8:abce:12::10' }), no('ip_out_of_scope'));
  assert.deepEqual(m.verifyTokenBinding(strict6, { ...V6, ip: '2001:db8:abce:12::10' }), no('ip_out_of_scope'));
});

test('a foreign browser family fails the TLS leg under both scopes (probe P5)', () => {
  const presented = { ...V4, browserFamily: 'firefox', ja4: JA4_F };
  assert.deepEqual(m.verifyTokenBinding(lax4, presented), no('tls_mismatch'));
  assert.deepEqual(m.verifyTokenBinding(strict4, presented), no('tls_mismatch'));
});

test('IPv6 lax binds the /48 and strict binds the exact address (probe V2 and V4)', () => {
  const samePrefix = { ...V6, ip: '2001:db8:abcd:99::77' };
  assert.deepEqual(m.verifyTokenBinding(lax6, samePrefix), ok('lax'));
  assert.deepEqual(m.verifyTokenBinding(strict6, samePrefix), no('ip_out_of_scope'));
  const sameAddrNewJa4 = { ...V6, ja4: JA4_B };
  assert.deepEqual(m.verifyTokenBinding(lax6, sameAddrNewJa4), ok('lax'));
  assert.deepEqual(m.verifyTokenBinding(strict6, sameAddrNewJa4), no('tls_mismatch'));
});

test('a required scope must match the stated scope exactly, in both directions (probe S1 and S2)', () => {
  assert.deepEqual(m.verifyTokenBinding(lax4, V4, { requireScope: 'strict' }), no('scope_mismatch'));
  assert.deepEqual(m.verifyTokenBinding(strict4, V4, { requireScope: 'lax' }), no('scope_mismatch'));
  assert.deepEqual(m.verifyTokenBinding(lax4, V4, { requireScope: 'lax' }), ok('lax'));
  assert.deepEqual(m.verifyTokenBinding(strict4, V4, { requireScope: 'strict' }), ok('strict'));
});

test('verification fails closed: missing context legs and malformed addresses never pass (probe F1-F3)', () => {
  assert.deepEqual(m.verifyTokenBinding(strict4, { ip: '192.0.2.10', browserFamily: 'chromium' }), no('missing_context'));
  assert.deepEqual(m.verifyTokenBinding(lax4, { ip: '192.0.2.10', ja4: JA4_A }), no('missing_context'));
  assert.deepEqual(m.verifyTokenBinding(lax4, { ...V4, ip: 'not-an-ip' }), no('ip_out_of_scope'));
  assert.deepEqual(m.verifyTokenBinding(lax4, null), no('missing_context'));
});

test('address families never mix: a v4 binding presented from v6 (and the reverse) fails ip_out_of_scope', () => {
  assert.deepEqual(m.verifyTokenBinding(lax4, V6), no('ip_out_of_scope'));
  assert.deepEqual(m.verifyTokenBinding(strict6, V4), no('ip_out_of_scope'));
});

test('malformed or unscoped binding values fail as malformed_binding and state no scope', () => {
  for (const bad of ['', 'not json', '[]', '["lax"]', '["wide","v4:192.0.2.0/24","chromium"]', 42, null, undefined]) {
    assert.deepEqual(m.verifyTokenBinding(bad, V4), no('malformed_binding'), `binding: ${String(bad)}`);
    assert.equal(m.tokenBindingScopeOf(bad), null);
  }
  const oversized = JSON.stringify(['lax', 'v4:192.0.2.0/24', 'x'.repeat(2000)]);
  assert.deepEqual(m.verifyTokenBinding(oversized, V4), no('malformed_binding'));
});

test('derivation throws on invalid input instead of minting a weakened binding', () => {
  assert.throws(() => m.deriveTokenBinding('wide', V4), m.TokenBindingScopeError);
  assert.throws(() => m.deriveTokenBinding('lax', { ...V4, ip: '999.1.1.1' }), m.TokenBindingScopeError);
  assert.throws(() => m.deriveTokenBinding('lax', { ...V4, ip: '2001:db8:::1' }), m.TokenBindingScopeError);
  assert.throws(() => m.deriveTokenBinding('strict', { ip: '192.0.2.10', browserFamily: 'chromium' }), m.TokenBindingScopeError);
  assert.throws(() => m.deriveTokenBinding('lax', { ip: '192.0.2.10', ja4: JA4_A }), m.TokenBindingScopeError);
  assert.throws(() => m.deriveTokenBinding('strict', { ...V4, ja4: 'x'.repeat(513) }), m.TokenBindingScopeError);
});

test('address text forms normalize: compressed and expanded IPv6 forms bind identically', () => {
  const expanded = { ...V6, ip: '2001:0db8:abcd:0012:0000:0000:0000:0010' };
  assert.equal(m.deriveTokenBinding('strict', expanded), strict6);
  assert.equal(m.deriveTokenBinding('lax', expanded), lax6);
  assert.deepEqual(m.verifyTokenBinding(strict6, expanded), ok('strict'));
  const upper = { ...V6, ip: '2001:DB8:ABCD:12::10' };
  assert.deepEqual(m.verifyTokenBinding(strict6, upper), ok('strict'));
});

test('host wiring pattern: the binding rides inside a signed payload, and a transplant fails the binding even with a valid signature', () => {
  const secret = 'host-token-secret';
  const sign = (payloadPart) => crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
  const payload = { sub: 'acct:1', pos: 50, binding: m.deriveTokenBinding('strict', V4) };
  const part = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const token = `${part}.${sign(part)}`;
  // Host verification: signature first, then the binding check.
  const [presentedPart, presentedSig] = token.split('.');
  assert.equal(crypto.timingSafeEqual(Buffer.from(sign(presentedPart)), Buffer.from(presentedSig)), true);
  const decoded = JSON.parse(Buffer.from(presentedPart, 'base64url').toString('utf8'));
  assert.deepEqual(m.verifyTokenBinding(decoded.binding, V4, { requireScope: 'strict' }), ok('strict'));
  // The same authentic token presented from the registered
  // probe context (other /24 address, in-family JA4 change)
  // keeps its valid signature and fails the binding.
  assert.deepEqual(
    m.verifyTokenBinding(decoded.binding, { ...V4, ip: '192.0.3.10', ja4: JA4_B }, { requireScope: 'strict' }),
    no('ip_out_of_scope'),
  );
  // Editing the binding inside the payload breaks the signature.
  const forgedPayload = { ...decoded, binding: m.deriveTokenBinding('lax', V4) };
  const forgedPart = Buffer.from(JSON.stringify(forgedPayload), 'utf8').toString('base64url');
  assert.notEqual(sign(forgedPart), presentedSig);
});
