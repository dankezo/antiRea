'use strict';
// NHS-09 PoW hashcash - suite version of nhs-lab/nhs09.cjs, UPGRADED
// form. The lab measured real solves at difficulty 16 passing with
// the exact nonces below, and measured replay OPEN (the same nonce
// verified again in the same bucket). This build closes the replay
// hole with a CAP-01-style single-use consume hook, and this suite
// proves replay now FAILS - the condition the item ships under.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pow = require('../dist/tier2-active/pow-hashcash.js');

// The lab's frozen secret: 32 hex chars from the seed-20314101
// mulberry32 stream (nhs09.cjs), so the lab nonces must reproduce.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20314101);
let SECRET = '';
for (let i = 0; i < 16; i++) SECRET += Math.floor(rand() * 256).toString(16).padStart(2, '0');

const IP1 = '192.0.2.10';
const IP2 = '192.0.2.11';
const NOW = 3600 * 100 + 100; // inside bucket 100
const TTL = 3600;

function failingNonce(p, ip) {
  for (let n = 0; ; n++) {
    // A nonce that does not meet difficulty: probe via a throwaway
    // instance whose consume hook always succeeds, checking raw
    // difficulty through solve-order: use verifySolution on a fresh
    // instance and look for bad-nonce.
    const probe = pow.createPowHashcash({ secret: SECRET });
    const v = probe.verifySolution(ip, String(n), NOW);
    if (!v.ok && v.reason === 'bad-nonce') return String(n);
  }
}

test('lab fixture solves reproduce exactly: nonces 46884 (IP1) and 3345 (IP2) at difficulty 16', () => {
  const p = pow.createPowHashcash({ secret: SECRET });
  assert.equal(p.solve(IP1, NOW), '46884');
  assert.equal(p.solve(IP2, NOW), '3345');
});

test('real solves pass with a signed cookie issued; the issued cookie bypasses', () => {
  const p = pow.createPowHashcash({ secret: SECRET });
  const sol1 = p.dispatch({ ip: IP1, nonce: '46884' }, true, NOW);
  assert.equal(sol1.outcome, 'PASS');
  assert.equal(sol1.via, 'solution');
  assert.equal(typeof sol1.setCookie, 'string');
  const sol2 = p.dispatch({ ip: IP2, nonce: '3345' }, true, NOW);
  assert.equal(sol2.outcome, 'PASS');
  const bypass = p.dispatch({ ip: IP1, cookie: sol1.setCookie }, true, NOW);
  assert.deepEqual([bypass.outcome, bypass.via], ['PASS', 'cookie']);
});

test('REPLAY IS CLOSED: the same nonce never verifies twice in the same bucket', () => {
  const p = pow.createPowHashcash({ secret: SECRET });
  const first = p.dispatch({ ip: IP1, nonce: '46884' }, true, NOW);
  assert.equal(first.outcome, 'PASS');
  const replay = p.dispatch({ ip: IP1, nonce: '46884' }, true, NOW);
  assert.equal(replay.outcome, 'CHALLENGE');
  assert.equal(replay.via, 'replay');
  const v = p.verifySolution(IP1, '46884', NOW);
  assert.deepEqual(v, { ok: false, reason: 'replay' });
  // The other IP's distinct nonce is unaffected, and it too is single-use.
  assert.equal(p.verifySolution(IP2, '3345', NOW).ok, true);
  assert.equal(p.verifySolution(IP2, '3345', NOW).ok, false);
});

test('a failing nonce never burns the consume hook (CAP-01 ordering)', () => {
  const consumed = [];
  const p = pow.createPowHashcash({
    secret: SECRET,
    consumeNonce: (key) => { if (consumed.includes(key)) return false; consumed.push(key); return true; },
  });
  const bad = failingNonce(p, IP1);
  assert.equal(p.verifySolution(IP1, bad, NOW).reason, 'bad-nonce');
  assert.equal(consumed.length, 0, 'hook not called for a failing nonce');
  assert.equal(p.verifySolution(IP1, '46884', NOW).ok, true);
  assert.equal(consumed.length, 1, 'hook called exactly once, at the replay step');
});

test('bad nonce, forged cookie and expired cookie all re-challenge; forged/expired fail closed', () => {
  const p = pow.createPowHashcash({ secret: SECRET });
  const bad = p.dispatch({ ip: IP1, nonce: failingNonce(p, IP1) }, true, NOW);
  assert.deepEqual([bad.outcome, bad.via], ['CHALLENGE', 'bad-nonce']);
  const forged = p.dispatch({ ip: IP1, cookie: (NOW + TTL) + '.' + '0'.repeat(64) }, true, NOW);
  assert.deepEqual([forged.outcome, forged.via], ['CHALLENGE', 'fail-closed']);
  const expired = p.dispatch({ ip: IP1, cookie: p.makeCookie(IP1, NOW - 10) }, true, NOW);
  assert.deepEqual([expired.outcome, expired.via], ['CHALLENGE', 'fail-closed']);
});

test('bare request is challenged; disabled PoW passes (fail-open); challenges bind IP and bucket', () => {
  const p = pow.createPowHashcash({ secret: SECRET });
  assert.deepEqual([p.dispatch({ ip: IP1 }, true, NOW).outcome, p.dispatch({ ip: IP1 }, true, NOW).via], ['CHALLENGE', 'page']);
  assert.equal(p.dispatch({ ip: IP1 }, false, NOW).outcome, 'PASS');
  assert.notEqual(p.challengeFor(IP1, NOW), p.challengeFor(IP2, NOW));
  assert.notEqual(p.challengeFor(IP1, NOW), p.challengeFor(IP1, NOW + TTL));
});
