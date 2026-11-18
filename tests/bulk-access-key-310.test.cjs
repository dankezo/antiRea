'use strict';
/*
 * GATEKEY-01 regression tests for the 3.1.0 fixes (Grok round 1 + 2):
 *
 * 1. Stranded tokens: keys minted inside another identity's
 *    requestKey call (the day-rollover refill) were returned to
 *    nobody, and their owners could never claim them - the drain
 *    stops at the pool cap before reaching mint's replay branch.
 *    The claim path is now idempotent: an identity holding an
 *    active key gets the same key back from requestKey directly.
 * 2. Default proof lane: with no verifyStepUpProof configured, any
 *    non-empty proof used to count as valid and buy fast-lane
 *    queue position, so junk proofs took the whole anon pool.
 *    The lane now fails closed (no verifier = no lane); with a
 *    verifier configured, only accepted proofs take the lane.
 * 3. Epoch seed: the permutation used to be a mulberry32 shuffle
 *    seeded with only the first 4 bytes of the epoch HMAC, i.e. a
 *    function of a 32-bit value, brute-forceable from one slice.
 *    It is now driven by a counter-mode HMAC stream.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const mod = require('../dist/tier2-active/bulk-access-key.js');

const DAY = 86_400_000;
const T0 = 1_700_006_400_000; // a day boundary
const SECRET = ['gatekey', '310', 'regression'].join('-');

function makeAuth(extra) {
  const clock = { t: T0 };
  const auth = mod.createBulkAccessKeyAuthority(Object.assign({
    secret: SECRET,
    now: () => clock.t,
  }, extra || {}));
  return { auth, clock };
}

/* -------- 1. stranded tokens: the exact losing sequence -------- */

test('3.1.0 stranded claim: keys minted inside another call stay claimable by their owners', () => {
  const { auth, clock } = makeAuth();
  clock.t = T0;
  const ids = Array.from({ length: 20 }, (_, i) => 'a' + i);
  const day1 = ids.map((id) => auth.requestKey(id, 'anon'));
  assert.deepEqual(day1.slice(0, 6).map((r) => r.status),
    ['issued', 'issued', 'issued', 'issued', 'issued', 'issued']);
  assert.ok(day1.slice(0, 6).every((r) => typeof r.token === 'string'));
  assert.ok(day1.slice(6).every((r) => r.status === 'queued' && r.token === undefined));
  assert.equal(auth.stats().totalIssuedByChannel.anon, 6);
  assert.equal(auth.stats().pendingAnonRequests, 14);

  // Day 2: a fresh identity's bare requestKey triggers the refill.
  // Six more keys are minted inside that call (for a6..a11, blocks
  // 6..11) and the caller itself gets queued with no token.
  clock.t = T0 + DAY;
  const fresh = auth.requestKey('fresh', 'anon');
  assert.equal(fresh.status, 'queued');
  assert.equal(fresh.token, undefined);
  assert.equal(auth.stats().totalIssuedByChannel.anon, 12);
  assert.equal(auth.stats().poolUsedToday, 6);
  assert.equal(auth.stats().pendingAnonRequests, 9);

  // Each waiting owner now claims the very key the refill minted
  // for it: same token back (replay), no new mint, no pool spent.
  const tokens = new Set();
  for (let i = 6; i < 12; i++) {
    const res = auth.requestKey('a' + i, 'anon');
    assert.equal(res.status, 'replay', `a${i} claim status`);
    assert.equal(typeof res.token, 'string');
    assert.equal(res.key.sub, 'a' + i);
    assert.equal(res.key.block, i);
    tokens.add(res.token);
    const presented = auth.presentKey('a' + i, res.token);
    assert.equal(presented.accepted, true, `a${i} claimed token must verify`);
  }
  assert.equal(tokens.size, 6);
  assert.equal(auth.stats().totalIssuedByChannel.anon, 12);
  assert.equal(auth.stats().poolUsedToday, 6);
  assert.equal(auth.stats().pendingAnonRequests, 9);

  // A waiter the refill did not reach is still honestly queued.
  const a12 = auth.requestKey('a12', 'anon');
  assert.equal(a12.status, 'queued');
  assert.equal(a12.token, undefined);
});

/* -------- 2. default proof lane fails closed -------- */

test('3.1.0 proof lane: junk proof buys no queue position when no verifier is configured', () => {
  const { auth, clock } = makeAuth(); // no verifyStepUpProof
  clock.t = T0;
  auth.requestKey('honest', 'anon', { queueOnly: true });
  for (let i = 0; i < 10; i++) {
    auth.requestKey('sybil-' + i, 'anon', { queueOnly: true, stepUpProof: 'junk-' + i });
  }
  const settled = auth.drainAnonPool();
  const issued = settled.filter((r) => r.status === 'issued').map((r) => r.key.sub);
  assert.equal(issued.length, 6);
  // Plain FIFO: the honest first arrival keeps its place and the
  // junk proofs sort exactly as if they carried no proof at all.
  assert.deepEqual(issued, ['honest', 'sybil-0', 'sybil-1', 'sybil-2', 'sybil-3', 'sybil-4']);
});

test('3.1.0 proof lane: with a verifier configured, only accepted proofs take the fast lane', () => {
  const { auth, clock } = makeAuth({ verifyStepUpProof: (_id, proof) => proof === 'real-proof' });
  clock.t = T0;
  auth.requestKey('honest', 'anon', { queueOnly: true });
  auth.requestKey('junk', 'anon', { queueOnly: true, stepUpProof: 'junk' });
  auth.requestKey('vip', 'anon', { queueOnly: true, stepUpProof: 'real-proof' });
  const settled = auth.drainAnonPool();
  const issued = settled.filter((r) => r.status === 'issued').map((r) => r.key.sub);
  assert.deepEqual(issued, ['vip', 'honest', 'junk']);
});

/* -------- 3. epoch permutation is not a 32-bit function -------- */

// The pre-3.1.0 derivation, frozen here as the attacker's model:
// mulberry32 seeded with the first 4 bytes of the epoch HMAC.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function modelBlocks(secret, epoch, corpusSize, sliceSize) {
  const digest = createHmac('sha256', secret).update(`gatekey-epoch:${epoch}`).digest();
  const seed = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]);
  const rand = mulberry32(seed >>> 0);
  const perm = Array.from({ length: corpusSize }, (_, i) => i);
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  const blocks = [];
  for (let j = 0; j * sliceSize < corpusSize; j++) blocks.push(new Set(perm.slice(j * sliceSize, (j + 1) * sliceSize)));
  return blocks;
}
function epochBlocksOf(auth, clock) {
  const blocks = [];
  for (let j = 0; j < 67; j++) {
    clock.t = T0 + j * DAY;
    const req = auth.requestKey('partner', 'verified', { allowlisted: true, webBotAuthVerified: true });
    assert.equal(req.status, 'issued');
    blocks.push(new Set(auth.sliceForKey(req.key.kid)));
  }
  return blocks;
}
function sameSet(a, b) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

test('3.1.0 epoch seed: permutation is not recoverable from a 32-bit seed', () => {
  const { auth, clock } = makeAuth();
  const blocks = epochBlocksOf(auth, clock);
  // The tiling contract is unchanged: 67 disjoint blocks, full corpus.
  const union = new Set();
  for (const b of blocks) for (const r of b) { assert.ok(!union.has(r), 'blocks must stay disjoint'); union.add(r); }
  assert.equal(union.size, 10000);
  // The attacker's 32-bit model no longer reproduces any block.
  const model = modelBlocks(SECRET, 0, 10_000, 150);
  let matches = 0;
  for (let j = 0; j < 67; j++) if (sameSet(blocks[j], model[j])) matches++;
  assert.equal(matches, 0, 'permutation still equals the 32-bit-seeded derivation');
  // Determinism is preserved: same secret, same permutation.
  const again = makeAuth();
  const blocksAgain = epochBlocksOf(again.auth, again.clock);
  assert.ok(sameSet(blocks[0], blocksAgain[0]), 'same secret must derive the same permutation');
  // A different secret derives a different permutation.
  const other = makeAuth({ secret: ['gatekey', '310', 'other'].join('-') });
  const blocksOther = epochBlocksOf(other.auth, other.clock);
  assert.ok(!sameSet(blocks[0], blocksOther[0]), 'different secret must derive a different permutation');
});
