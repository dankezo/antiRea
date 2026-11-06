const { test } = require('node:test');
const assert = require('node:assert/strict');
// Tests import the compiled module directly (the bunching-monitor
// tests use the same subpath pattern).
const sdk = require('../dist/tier2-active/herd-phase-signal.js');
const { createHerdPhaseSignal, HerdPhaseError } = sdk;

// ---------------------------------------------------------------------------
// Herd-phase signal (HARVEST candidate H7-01 + roomguard room-join pin).
// These tests pin the decisive lab cells on the SDK module:
//   - H7-01 Step 1 (harness-v2, fresh seeds): shared herd confirmed
//     (86/86 members, R_cohort 0.9977, recall 1.000); independent herd
//     NOT confirmed (88 R_i members, R_cohort 0.0794); FP member rate
//     0/86 VALID, 0/96 SALE, 0/85 NAT-GROUP-DIRECT.
//   - Roomguard pin (room-join streams, 24 h first-seen scoping):
//     shared rejoin herd confirmed (60/60, R_cohort 0.9978);
//     independent-offset herd NOT confirmed (R_cohort 0.0421);
//     four legitimate room cells produced no confirmation.
// The synthetic herds below are deterministic (mulberry32 streams),
// so the assertions are exact, not statistical hopes.
// ---------------------------------------------------------------------------

const BASE = 1_730_000_000_000; // fixed epoch ms; no wall clock anywhere
const PERIOD_MS = 900_000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Feed one herd: `count` identities x `events` events on a 900 s grid. */
function feedHerd(sig, prefix, count, events, mode, seed) {
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const offset = mode === 'indep' ? Math.floor(rng() * PERIOD_MS) : mode === 'anti' && i % 2 === 1 ? PERIOD_MS / 2 : 0;
    for (let k = 0; k < events; k++) {
      const ts = BASE + offset + k * PERIOD_MS + Math.round(gauss(rng) * 30_000);
      sig.observe({ identity: `${prefix}-${i}`, ts });
    }
  }
}

test('shared-grid herd confirms and names its members (H7-01 B2 / roomguard G-B5 shape)', () => {
  const sig = createHerdPhaseSignal();
  feedHerd(sig, 'bot', 60, 12, 'shared', 101);
  const r = sig.evaluate();
  assert.equal(r.kind, 'herd-phase');
  assert.equal(r.status, 'scored');
  assert.equal(r.scoredIdentities, 60);
  assert.equal(r.memberCount, 60);
  assert.ok(r.cohortR >= 0.8, `R_cohort ${r.cohortR} must clear tau_C`);
  assert.equal(r.confirmed, true);
  assert.equal(r.members.length, 60);
  assert.equal(r.members[0], 'bot-0');
  assert.equal(r.enforcement, 'none');
});

test('independent-offset herd: every identity is a member, the cohort is NOT confirmed (B3 / G-B6)', () => {
  const sig = createHerdPhaseSignal();
  feedHerd(sig, 'bot', 60, 12, 'indep', 202);
  const r = sig.evaluate();
  assert.equal(r.memberCount, 60); // R_i alone would flag everyone...
  assert.ok(r.cohortR < 0.8, `R_cohort ${r.cohortR} must stay under tau_C`);
  assert.equal(r.confirmed, false); // ...the cohort leg refuses
  assert.deepEqual(r.members, []); // and nobody is named
});

test('two opposed sub-herds cancel: members counted, nobody named', () => {
  const sig = createHerdPhaseSignal();
  feedHerd(sig, 'bot', 12, 12, 'anti', 303);
  const r = sig.evaluate();
  assert.equal(r.memberCount, 12);
  assert.ok(r.cohortR < 0.8);
  assert.equal(r.confirmed, false);
  assert.deepEqual(r.members, []);
});

test('uniform-random legitimate stream does not confirm', () => {
  const sig = createHerdPhaseSignal();
  const rng = mulberry32(404);
  for (let i = 0; i < 86; i++) {
    for (let k = 0; k < 10; k++) {
      sig.observe({ identity: `user-${i}`, ts: BASE + Math.floor(rng() * 7 * 86_400_000) });
    }
  }
  const r = sig.evaluate();
  assert.equal(r.confirmed, false);
  assert.deepEqual(r.members, []);
  assert.ok(r.cohortR < 0.8);
});

test('a herd below minMembers cannot confirm even with a perfect cohort R', () => {
  const sig = createHerdPhaseSignal();
  feedHerd(sig, 'bot', 6, 12, 'shared', 505);
  const r = sig.evaluate();
  assert.equal(r.memberCount, 6);
  assert.ok(r.cohortR >= 0.8);
  assert.equal(r.confirmed, false);
  assert.deepEqual(r.members, []);
});

test('identities below the event floor are not scored: insufficient_population', () => {
  const sig = createHerdPhaseSignal();
  feedHerd(sig, 'bot', 20, 5, 'shared', 606);
  const r = sig.evaluate();
  assert.equal(r.status, 'insufficient_population');
  assert.equal(r.scoredIdentities, 0);
  assert.equal(r.cohortR, null);
  assert.equal(r.confirmed, false);
});

test('cohortWindowMs scopes the cohort to recently first-seen identities (roomguard scoping)', () => {
  const sig = createHerdPhaseSignal();
  // Old herd on the opposed offset, first seen at BASE.
  const rngOld = mulberry32(707);
  for (let i = 0; i < 60; i++) {
    for (let k = 0; k < 12; k++) {
      sig.observe({ identity: `old-${i}`, ts: BASE + PERIOD_MS / 2 + k * PERIOD_MS + Math.round(gauss(rngOld) * 30_000) });
    }
  }
  // Fresh herd on offset 0, first seen 20 days after BASE.
  const freshStart = BASE + 20 * 86_400_000;
  const rngNew = mulberry32(808);
  for (let i = 0; i < 60; i++) {
    for (let k = 0; k < 12; k++) {
      sig.observe({ identity: `new-${i}`, ts: freshStart + k * PERIOD_MS + Math.round(gauss(rngNew) * 30_000) });
    }
  }
  const asOf = freshStart + 12 * PERIOD_MS;
  const unscoped = sig.evaluate({ asOfTs: asOf });
  assert.equal(unscoped.cohortIdentities, 120);
  assert.equal(unscoped.confirmed, false); // opposed offsets cancel
  const scoped = sig.evaluate({ asOfTs: asOf, cohortWindowMs: 86_400_000 });
  assert.equal(scoped.cohortIdentities, 60);
  assert.equal(scoped.confirmed, true);
  assert.equal(scoped.members.length, 60);
  assert.ok(scoped.members.every((m) => m.startsWith('new-')));
});

test('asOfTs cuts off later events', () => {
  const sig = createHerdPhaseSignal();
  feedHerd(sig, 'bot', 20, 12, 'shared', 909);
  const early = sig.evaluate({ asOfTs: BASE + 5 * PERIOD_MS });
  assert.equal(early.status, 'insufficient_population'); // only ~6 events each so far
  const full = sig.evaluate({ asOfTs: BASE + 12 * PERIOD_MS });
  assert.equal(full.status, 'scored');
  assert.equal(full.confirmed, true);
});

test('malformed events: invalid ts is a structured no-op, bad identity throws', () => {
  const sig = createHerdPhaseSignal();
  assert.deepEqual(sig.observe({ identity: 'u1', ts: Number.NaN }), { status: 'invalid_ts', counted: false });
  assert.deepEqual(sig.observe({ identity: 'u1', ts: Infinity }), { status: 'invalid_ts', counted: false });
  const snap = sig.snapshot();
  assert.equal(snap.identities, 0);
  assert.equal(snap.counters.invalidTs, 2);
  assert.throws(() => sig.observe({ identity: '  ', ts: BASE }), HerdPhaseError);
  // A non-number ts fails the validity discipline as a structured no-op.
  assert.deepEqual(sig.observe({ identity: 'u1', ts: 'now' }), { status: 'invalid_ts', counted: false });
});

test('invalid options throw HerdPhaseError', () => {
  assert.throws(() => createHerdPhaseSignal({ periodSec: 0 }), HerdPhaseError);
  assert.throws(() => createHerdPhaseSignal({ memberThreshold: 1.5 }), HerdPhaseError);
  assert.throws(() => createHerdPhaseSignal({ cohortThreshold: 0 }), HerdPhaseError);
  assert.throws(() => createHerdPhaseSignal({ minEvents: 1 }), HerdPhaseError);
  assert.throws(() => createHerdPhaseSignal({ minEvents: 8, maxEventsPerIdentity: 4 }), HerdPhaseError);
  assert.throws(() => createHerdPhaseSignal(null), HerdPhaseError);
});

test('memory caps: identities evicted past maxIdentities, events truncated past maxEventsPerIdentity', () => {
  const sig = createHerdPhaseSignal({ maxIdentities: 5 });
  for (let i = 0; i < 8; i++) sig.observe({ identity: `u-${i}`, ts: BASE + i });
  let snap = sig.snapshot();
  assert.equal(snap.identities, 5);
  assert.equal(snap.counters.evictedIdentities, 3);

  const sig2 = createHerdPhaseSignal({ minEvents: 8, maxEventsPerIdentity: 10 });
  let last;
  for (let k = 0; k < 25; k++) last = sig2.observe({ identity: 'u', ts: BASE + k * 1000 });
  assert.equal(last.eventsTotal, 10);
  snap = sig2.snapshot();
  assert.equal(snap.events, 10);
  assert.equal(snap.counters.truncatedEvents, 15);
});

test('evaluation is deterministic and the snapshot carries enforcement none', () => {
  const sig = createHerdPhaseSignal();
  feedHerd(sig, 'bot', 60, 12, 'shared', 111);
  const a = sig.evaluate();
  const b = sig.evaluate();
  assert.deepEqual(a, b);
  const snap = sig.snapshot();
  assert.equal(snap.enforcement, 'none');
  assert.equal(snap.periodSec, 900);
  assert.equal(snap.memberThreshold, 0.9);
  assert.equal(snap.cohortThreshold, 0.8);
  assert.equal(snap.identities, 60);
  assert.equal(snap.events, 720);
});
