const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/tier2-active/vote-brigading-signal.js');

// ---------------------------------------------------------------------------
// Queue-stuffing signal (CAND-273-4, stuffing axis). This suite tests
// the LAW, transplanted verbatim from the vote axis onto queue
// submissions: per clock-aligned 60 s window, s = N - 0.5*T
// (T >= 5 submissions; N = submissions from identities created
// < 24 h before submitting); accumulator A = max(0, A + s); the
// room flags iff A >= 12 AND >= 2 contributing windows.
//
// The POPULATIONS were measured in the lab, not here: the pin
// cells below are deterministic hand-built streams shaped like
// the lab's seeded cells (cand2734-lab, REGISTRATION-CAND2734-
// STUFFING.md / RESULTS-CAND2734-STUFFING.md, PASS-LAB): LEGIT,
// LEGIT-ALT and RAID-QUEUE never flagged in 7 simulated evenings,
// STUFF-BURST flagged at the second burst's window close with
// A = 15. STUFF-DRIP is descriptive only in the registration and
// is deliberately NOT a gated test here.
// ---------------------------------------------------------------------------

const W = 60_000;
const BASE = Math.floor(1_700_000_000_000 / W) * W; // window-aligned
const HOUR = 3_600_000;
const DAY = 86_400_000;

function submit(sig, identity, ts, createdTs, songRef) {
  sig.observe({ identity, ts, accountCreatedTs: createdTs, songRef });
}
function freshSubmit(sig, identity, ts, songRef) {
  submit(sig, identity, ts, ts - HOUR, songRef);
}
function oldSubmit(sig, identity, ts, songRef) {
  submit(sig, identity, ts, ts - 30 * DAY, songRef);
}
/** One window of submissions starting at windowStart: n fresh + o old identities. */
function windowSubs(sig, windowStart, n, o, tag, songRef = 'song-x') {
  for (let i = 0; i < n; i++) freshSubmit(sig, `${tag}-new-${windowStart}-${i}`, windowStart + 1_000 + i * 100, songRef);
  for (let i = 0; i < o; i++) oldSubmit(sig, `${tag}-old-${windowStart}-${i}`, windowStart + 30_000 + i * 100, songRef);
}

test('LEGIT: old-account singers submitting sparsely never move the accumulator', () => {
  const sig = sdk.createQueueStuffingSignal();
  for (let k = 0; k < 30; k++) {
    // Sparse old-account submissions: some windows under the
    // 5-submission floor, some above it with N = 0 (s = -0.5*T).
    windowSubs(sig, BASE + k * W, 0, k % 2 === 0 ? 3 : 8, 'legit');
  }
  const r = sig.evaluate();
  assert.equal(r.kind, 'queue-stuffing');
  assert.equal(r.flagged, false);
  assert.equal(r.accumulator, 0);
  assert.equal(r.maxAccumulator, 0);
  assert.equal(r.enforcement, 'none');
});

test('LEGIT-ALT: hot legit parameters (new singers diluted by room volume) never flag', () => {
  const sig = sdk.createQueueStuffingSignal();
  for (let k = 0; k < 20; k++) {
    // Busy room, enthusiastic new singers, but the new share stays
    // at or below half the window volume: s = 5 - 7.5 < 0, or
    // s = 4 - 4 = 0 in the even windows. A never leaves 0.
    if (k % 2 === 0) windowSubs(sig, BASE + k * W, 5, 10, 'alt');
    else windowSubs(sig, BASE + k * W, 4, 4, 'alt');
  }
  const r = sig.evaluate();
  assert.equal(r.flagged, false);
  assert.equal(r.accumulator, 0);
  assert.equal(r.maxAccumulator, 0);
});

test('RAID-QUEUE (the dangerous null): 18 fresh singers spread across ~12 windows peak at A <= 3 and never flag', () => {
  const sig = sdk.createQueueStuffingSignal();
  // First window: 6 of the fresh singers land together
  // (T = 6, N = 6, s = 3 - the lab cell's peak, in exactly one
  // contributing window).
  windowSubs(sig, BASE, 6, 0, 'raid');
  // The remaining 12 fresh singers trickle in over the next 11
  // windows, diluted by old-account submissions, so every later
  // window scores negative and drains the accumulator.
  const trickle = [2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  trickle.forEach((n, k) => windowSubs(sig, BASE + (k + 1) * W, n, 8, 'raid'));
  const r = sig.evaluate();
  assert.equal(r.flagged, false);
  assert.ok(r.maxAccumulator <= 3, `peak A must stay <= 3, got ${r.maxAccumulator}`);
  assert.equal(r.maxAccumulator, 3);
  assert.equal(r.accumulator, 0);
});

test('STUFF-BURST: two bursts of 15 fresh-identity submissions flag at the second window close, A = 15', () => {
  const sig = sdk.createQueueStuffingSignal();
  // Burst 1: T = 15, N = 15, s = 7.5 -> A = 7.5, one contributing
  // window: no flag yet (below 12, and the two-window rule).
  windowSubs(sig, BASE, 15, 0, 'burst', 'song-spam');
  const afterFirst = sig.evaluate({ asOfTs: BASE + W });
  assert.equal(afterFirst.flagged, false);
  assert.equal(afterFirst.accumulator, 7.5);
  assert.equal(afterFirst.contributingWindows, 1);
  // Burst 2: another s = 7.5 -> A = 15 >= 12 with 2 contributing
  // windows: flag at this window's close.
  windowSubs(sig, BASE + W, 15, 0, 'burst', 'song-spam');
  const r = sig.evaluate();
  assert.equal(r.flagged, true);
  assert.equal(r.firstFlagTs, BASE + 2 * W);
  assert.equal(r.accumulator, 15);
  assert.equal(r.contributingWindows, 2);
  assert.equal(r.enforcement, 'none');
});

test('songRef is carried on the event but never enters the statistic', () => {
  const streams = [
    (sig) => { windowSubs(sig, BASE, 15, 0, 's', 'song-spam'); windowSubs(sig, BASE + W, 15, 0, 's', 'song-spam'); },
    (sig) => { windowSubs(sig, BASE, 15, 0, 's', 'a-different-song'); windowSubs(sig, BASE + W, 15, 0, 's', 'another-one'); },
    (sig) => {
      for (let i = 0; i < 15; i++) freshSubmit(sig, `s-new-${BASE}-${i}`, BASE + 1_000 + i * 100, undefined);
      for (let i = 0; i < 15; i++) freshSubmit(sig, `s-new-${BASE + W}-${i}`, BASE + W + 1_000 + i * 100, undefined);
    },
  ];
  const results = streams.map((feed) => {
    const sig = sdk.createQueueStuffingSignal();
    feed(sig);
    return sig.evaluate();
  });
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.equal(results[0].flagged, true);
});

test('the result names no identity (room state, population family)', () => {
  const sig = sdk.createQueueStuffingSignal();
  windowSubs(sig, BASE, 15, 0, 'burst', 'song-spam');
  const r = sig.evaluate();
  for (const key of Object.keys(r)) {
    assert.ok(!/identit|member/i.test(key), `unexpected identity-bearing key ${key}`);
  }
});

test('malformed input: bad songRef and bad options throw QueueStuffingError, invalid ts is a no-op', () => {
  const sig = sdk.createQueueStuffingSignal();
  assert.deepEqual(sig.observe({ identity: 'x', ts: Number.NaN, songRef: 'song-1' }), { status: 'invalid_ts', counted: false });
  assert.throws(
    () => sig.observe({ identity: 'x', ts: BASE, songRef: 42 }),
    (err) => err.name === 'QueueStuffingError',
  );
  assert.throws(() => sdk.createQueueStuffingSignal({ threshold: 0 }), sdk.QueueStuffingError);
  assert.throws(() => sig.observe({ identity: '', ts: BASE }), sdk.QueueStuffingError);
});
