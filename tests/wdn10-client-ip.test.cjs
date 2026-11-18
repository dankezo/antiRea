'use strict';
// WDN-10 trustProxy XFF resolution - suite version of wdn-lab/wdn10.cjs.
// Frozen lab properties: right-counted trust (1 and 2 exact), malformed
// left entries never believed, the CIDR walk stops at garbage and
// returns the peer, mapped IPv6 collapses, leading-zero rejected, and
// no-peer returns explicit undefined. The resolver is an opt-in utility;
// it does not replace the SDK default resolution path.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ci = require('../dist/tier2-active/wdn-client-ip.js');

const XFF = { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' };
const PEER = '9.9.9.9';

test('XFF-RIGHT: trustProxy 1 and 2 are exact and right-counted, never leftmost-first', () => {
  assert.equal(ci.resolveClientIp({ headers: XFF, peer: PEER, trustProxy: 1 }), '5.6.7.8');
  assert.equal(ci.resolveClientIp({ headers: XFF, peer: PEER, trustProxy: 2 }), '1.2.3.4');
});

test('XFF-DISTRUST: trustProxy false returns the peer', () => {
  assert.equal(ci.resolveClientIp({ headers: XFF, peer: PEER, trustProxy: false }), '9.9.9.9');
});

test('XFF-MALFORMED: D1 malformed-left is never consulted in number mode; D2 the CIDR walk stops at garbage and returns the peer', () => {
  assert.equal(
    ci.resolveClientIp({ headers: { 'x-forwarded-for': 'garbage, 5.6.7.8' }, peer: PEER, trustProxy: 1 }),
    '5.6.7.8',
  );
  assert.equal(
    ci.resolveClientIp({ headers: { 'x-forwarded-for': '5.6.7.8, garbage' }, peer: PEER, trustProxy: ['9.9.9.9/32'] }),
    '9.9.9.9',
  );
});

test('XFF-NORMALIZE: ::ffff:1.2.3.4 collapses to 1.2.3.4 both as peer and as an XFF entry', () => {
  assert.equal(ci.resolveClientIp({ headers: {}, peer: '::ffff:1.2.3.4', trustProxy: false }), '1.2.3.4');
  assert.equal(
    ci.resolveClientIp({ headers: { 'x-forwarded-for': '::ffff:1.2.3.4' }, peer: PEER, trustProxy: 1 }),
    '1.2.3.4',
  );
});

test('XFF-LEADZERO: 01.2.3.4 is rejected and resolution falls back to the peer', () => {
  assert.equal(
    ci.resolveClientIp({ headers: { 'x-forwarded-for': '01.2.3.4' }, peer: PEER, trustProxy: 1 }),
    '9.9.9.9',
  );
});

test('XFF-CF: cloudflare mode returns CF-Connecting-IP', () => {
  assert.equal(
    ci.resolveClientIp({ headers: { 'cf-connecting-ip': '198.51.100.23' }, peer: PEER, trustProxy: 'cloudflare' }),
    '198.51.100.23',
  );
});

test('XFF-NOPEER: no XFF and no peer returns explicit undefined, never a fabricated address', () => {
  assert.equal(ci.resolveClientIp({ headers: {}, peer: undefined, trustProxy: 1 }), undefined);
});

test('descriptive: railway behaves exactly as trustProxy 2; a bracketed peer normalizes to ::1', () => {
  assert.equal(ci.resolveClientIp({ headers: XFF, peer: PEER, trustProxy: 'railway' }), '1.2.3.4');
  assert.equal(ci.resolveClientIp({ headers: {}, peer: '[::1]:8080', trustProxy: false }), '::1');
});
