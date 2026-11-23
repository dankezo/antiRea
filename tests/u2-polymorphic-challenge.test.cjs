'use strict';
// U2 - per-session polymorphic challenge payload (3.3.2, DEC-1).
// Honest framing under test: U2 is an execution tax, not a wall -
// these tests execute the payload exactly as a real JS-running
// client would and expect it to PASS. What is pinned is that the
// pass is per-session, per-challenge, single-use and expiring,
// and that no payload structure is reusable across sessions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const server = require('../dist/tier2-active/polymorphic-challenge.js');
const client = require('../dist/client/u2-challenge-client.js');

const SECRET = 'u2-test-secret-not-a-real-one';

function executePayload(issue) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(issue.payload, sandbox);
  assert.equal(typeof sandbox[issue.entryName], 'function', 'payload exposes its rotated entry');
  return String(sandbox[issue.entryName]());
}

function assignedNames(payload) {
  return [...payload.matchAll(/var\s+(_[A-Za-z][A-Za-z0-9]*)\s*=/g)].map((m) => m[1]);
}

test('two sessions: payloads differ in identifiers AND step order, each answer accepted for its own session', () => {
  const c = server.createPolymorphicChallenge({ secret: SECRET });
  const a = c.issue('session-A');
  const b = c.issue('session-B');
  assert.notEqual(a.payload, b.payload);
  assert.notEqual(a.entryName, b.entryName);
  // No variable identifier is shared across the two payloads.
  const namesA = new Set(assignedNames(a.payload));
  for (const n of assignedNames(b.payload)) assert.ok(!namesA.has(n), `identifier ${n} reused across sessions`);
  // Step order differs: the assignment sequences are not the same shape
  // (names differ, so compare the operator sequence per step).
  const ops = (p) => [...p.matchAll(/var\s+_[A-Za-z0-9]+\s*=\s*([^\n;]+);/g)].map((m) => m[1].replace(/_[A-Za-z0-9]+/g, 'V'));
  assert.notDeepEqual(ops(a.payload), ops(b.payload), 'step sequence should be morphed per session');
  // Each executed payload yields an answer the server accepts - for its own session.
  assert.deepEqual(c.verify('session-A', a.challengeId, executePayload(a)), { ok: true });
  assert.deepEqual(c.verify('session-B', b.challengeId, executePayload(b)), { ok: true });
});

test('two challenges for the SAME session also differ (per-challenge morphing)', () => {
  const c = server.createPolymorphicChallenge({ secret: SECRET });
  const a = c.issue('session-A');
  const b = c.issue('session-A');
  assert.notEqual(a.challengeId, b.challengeId);
  assert.notEqual(a.payload, b.payload);
  assert.notEqual(a.entryName, b.entryName);
});

test('answer from session A is rejected for session B', () => {
  const c = server.createPolymorphicChallenge({ secret: SECRET });
  const a = c.issue('session-A');
  const b = c.issue('session-B');
  const answerA = executePayload(a);
  const cross = c.verify('session-B', b.challengeId, answerA);
  assert.equal(cross.ok, false);
  // Also: A's challenge id presented under B's session id is a mismatch.
  const c2 = server.createPolymorphicChallenge({ secret: SECRET });
  const a2 = c2.issue('session-A');
  const wrongSession = c2.verify('session-B', a2.challengeId, executePayload(a2));
  assert.deepEqual(wrongSession, { ok: false, reason: 'session_mismatch' });
});

test('wrong answer is rejected', () => {
  const c = server.createPolymorphicChallenge({ secret: SECRET });
  const a = c.issue('session-A');
  assert.deepEqual(c.verify('session-A', a.challengeId, 'not-the-answer'), { ok: false, reason: 'bad_answer' });
});

test('replay of a consumed challenge is rejected; a failed challenge cannot be probed twice', () => {
  const c = server.createPolymorphicChallenge({ secret: SECRET });
  const a = c.issue('session-A');
  const answer = executePayload(a);
  assert.deepEqual(c.verify('session-A', a.challengeId, answer), { ok: true });
  assert.deepEqual(c.verify('session-A', a.challengeId, answer), { ok: false, reason: 'replay' });

  const b = c.issue('session-A');
  const answerB = executePayload(b);
  assert.equal(c.verify('session-A', b.challengeId, 'wrong-first').ok, false);
  assert.deepEqual(c.verify('session-A', b.challengeId, answerB), { ok: false, reason: 'replay' });
});

test('expired challenge is rejected (injectable clock)', () => {
  let t = 1_000_000;
  const c = server.createPolymorphicChallenge({ secret: SECRET, ttlMs: 5_000, now: () => t });
  const a = c.issue('session-A');
  assert.equal(a.expiresAt, 1_005_000);
  const answer = executePayload(a);
  t += 5_001;
  assert.deepEqual(c.verify('session-A', a.challengeId, answer), { ok: false, reason: 'expired' });
});

test('unknown challenge id is rejected', () => {
  const c = server.createPolymorphicChallenge({ secret: SECRET });
  assert.deepEqual(c.verify('session-A', 'deadbeef'.repeat(4), '1'), { ok: false, reason: 'unknown_challenge' });
});

test('dead-code steps are present in the payload text but do not affect the result', () => {
  const c = server.createPolymorphicChallenge({ secret: SECRET });
  const a = c.issue('session-A');
  const names = assignedNames(a.payload);
  // Dead variables: assigned exactly once and never read afterwards
  // (the return line reads only the final real variable).
  const dead = names.filter((n) => {
    const uses = a.payload.split(n).length - 1; // 1 for its own `var n =`
    return uses === 1;
  });
  assert.ok(dead.length >= 2, `expected >=2 dead-step variables, found ${dead.length}: ${dead.join(',')}`);
  // Executing with the dead steps present still yields the accepted answer:
  // the server recomputes without them mattering.
  assert.deepEqual(c.verify('session-A', a.challengeId, executePayload(a)), { ok: true });
});

test('payload carries no fixed entry identifier shared across sessions', () => {
  const c = server.createPolymorphicChallenge({ secret: SECRET });
  const issues = [c.issue('s1'), c.issue('s2'), c.issue('s3')];
  const entries = new Set(issues.map((i) => i.entryName));
  assert.equal(entries.size, 3, 'every entry name is unique');
  for (const issue of issues) {
    assert.ok(issue.payload.includes(issue.entryName));
    for (const other of issues) {
      if (other !== issue) assert.ok(!issue.payload.includes(other.entryName), 'no foreign entry name leaks in');
    }
    // No conventional fixed entry name appears as an identifier.
    assert.ok(!/\b(?:solve|challenge|answer|verify|main|run)\s*[=(]/.test(issue.payload));
  }
});

test('DEC-1 client component solves an issuance the server accepts, and submits via transport', async () => {
  const c = server.createPolymorphicChallenge({ secret: SECRET });
  const issue = c.issue('session-client');
  const submitted = [];
  const u2client = client.createU2ChallengeClient({
    transport: async (req) => { submitted.push(req); return c.verify('session-client', req.challengeId, req.answer); },
  });
  const verdict = await u2client.submit(issue);
  assert.deepEqual(verdict, { ok: true });
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].challengeId, issue.challengeId);
  // The standalone solver agrees with the vm execution path.
  const issue2 = c.issue('session-client');
  assert.equal(client.solveU2Challenge(issue2), executePayload(issue2));
});

test('client rejects a malformed entry name instead of executing arbitrary lookups', () => {
  const c = server.createPolymorphicChallenge({ secret: SECRET });
  const issue = c.issue('session-A');
  assert.throws(
    () => client.solveU2Challenge({ ...issue, entryName: 'x;globalThis.pwned=1//' }),
    /entryName/,
  );
});
