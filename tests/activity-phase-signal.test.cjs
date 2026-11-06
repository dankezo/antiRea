const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/tier2-active/activity-phase-signal.js');

// ---------------------------------------------------------------------------
// Activity-phase signal (CAND-273-3): the herd-phase law (H7-01)
// run over ACTIVITY timestamps instead of joins, via a thin
// factory over the herd-phase core. Lab pin highlights these
// tests port:
//   - Shared-scheduler chat herd (60 bots, 900 s grid, +/-20 s
//     jitter): confirmed scoped, R_cohort 0.9230.
//   - Same herd on per-identity grid offsets: NOT confirmed
//     (R_cohort 0.0402) - the cohort leg separates them.
//   - Film-climax cell (regulars + first-timers bursting at six
//     IRREGULAR content moments): 0 members scoped and unscoped.
// Streams here are deterministic and smaller; they assert the
// law's mechanics and the scoped-usage contract, not lab values.
// ---------------------------------------------------------------------------

const BASE = Date.UTC(2026, 0, 5, 12, 0, 0);
const PERIOD_MS = 900_000;
const DAY = 86_400_000;

// Deterministic jitter in [-20 s, +20 s).
function jitter(i, j) {
  const x = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return Math.floor((x - Math.floor(x)) * 40_000) - 20_000;
}

function feedGrid(sig, id, offsetMs, events = 10) {
  for (let j = 0; j < events; j++) {
    sig.observe({ identity: id, ts: BASE + offsetMs + j * PERIOD_MS + jitter(id.length + offsetMs % 97, j) });
  }
}

test('a shared-scheduler activity herd confirms, scoped to the room cohort window', () => {
  const sig = sdk.createActivityPhaseSignal();
  for (let i = 0; i < 30; i++) feedGrid(sig, `bot-${i}`, 0);
  const r = sig.evaluate({ asOfTs: BASE + 10 * PERIOD_MS, cohortWindowMs: DAY });
  assert.equal(r.kind, 'activity-phase');
  assert.equal(r.confirmed, true);
  assert.equal(r.memberCount, 30);
  assert.equal(r.members.length, 30);
  assert.ok(r.cohortR >= 0.8);
  assert.equal(r.enforcement, 'none');
});

test('the same herd on per-identity grid offsets is NOT confirmed (cohort leg)', () => {
  const sig = sdk.createActivityPhaseSignal();
  for (let i = 0; i < 30; i++) feedGrid(sig, `bot-${i}`, i * 137_000);
  const r = sig.evaluate({ asOfTs: BASE + 10 * PERIOD_MS + 30 * 137_000, cohortWindowMs: DAY });
  assert.equal(r.confirmed, false);
  assert.equal(r.members.length, 0); // members named only on confirmation
});

test('content-driven simultaneity at irregular moments yields zero members (climax null)', () => {
  const sig = sdk.createActivityPhaseSignal();
  // 40 viewers each active at the same three IRREGULAR moments -
  // the whole room reacting to the same scenes. The phases of
  // these moments on the 900 s grid are uneven, so nobody locks.
  const moments = [0, 1_700_000, 4_300_000];
  for (let i = 0; i < 40; i++) {
    // A burst of 3 messages around each moment (9 events total,
    // above the scoring floor - the null must be earned by the
    // phase math, not by being unscored).
    for (const m of moments) {
      for (let b = 0; b < 3; b++) {
        sig.observe({ identity: `viewer-${i}`, ts: BASE + m + (i % 7) * 1_000 + b * 20_000 });
      }
    }
  }
  const r = sig.evaluate({ asOfTs: BASE + 4_400_000, cohortWindowMs: DAY });
  assert.equal(r.memberCount, 0);
  assert.equal(r.confirmed, false);
});

test('members are never named without confirmation', () => {
  const sig = sdk.createActivityPhaseSignal();
  // 9 grid-locked identities: below the frozen minMembers of 10.
  for (let i = 0; i < 9; i++) feedGrid(sig, `bot-${i}`, 0);
  const r = sig.evaluate({ asOfTs: BASE + 10 * PERIOD_MS, cohortWindowMs: DAY });
  assert.equal(r.confirmed, false);
  assert.deepEqual(r.members, []);
});

test('identities below minEvents are not scored', () => {
  const sig = sdk.createActivityPhaseSignal();
  for (let i = 0; i < 12; i++) feedGrid(sig, `bot-${i}`, 0);
  sig.observe({ identity: 'one-timer', ts: BASE });
  const r = sig.evaluate({ asOfTs: BASE + 10 * PERIOD_MS, cohortWindowMs: DAY });
  assert.equal(r.scoredIdentities, 12);
});

test('the room cohort window constant is the validated 24 h', () => {
  assert.equal(sdk.ACTIVITY_PHASE_ROOM_COHORT_WINDOW_MS, 86_400_000);
});

test('invalid ts is a structured no-op; bad options throw ActivityPhaseError', () => {
  const sig = sdk.createActivityPhaseSignal();
  assert.deepEqual(sig.observe({ identity: 'x', ts: Number.POSITIVE_INFINITY }), {
    status: 'invalid_ts',
    counted: false,
  });
  assert.throws(() => sdk.createActivityPhaseSignal({ periodSec: -1 }), sdk.ActivityPhaseError);
  assert.throws(() => sig.observe({ identity: '', ts: BASE }), sdk.ActivityPhaseError);
});

test('snapshot carries the law parameters and enforcement none', () => {
  const sig = sdk.createActivityPhaseSignal();
  feedGrid(sig, 'a', 0);
  const snap = sig.snapshot();
  assert.equal(snap.enforcement, 'none');
  assert.equal(snap.periodSec, 900);
  assert.equal(snap.minMembers, 10);
  assert.equal(snap.counters.observed, 10);
});
