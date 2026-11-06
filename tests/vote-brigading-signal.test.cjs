const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/tier2-active/vote-brigading-signal.js');

// ---------------------------------------------------------------------------
// Vote-brigading signal (CAND-273-4). Frozen lab law: per clock
// 60 s window, s = N - 0.5*T (T >= 5 votes; N = votes from
// identities created < 24 h before voting); accumulator
// A = max(0, A + s); flag iff A >= 12 AND >= 2 contributing
// windows. Lab pin: legit weeks A = 0 (incl. an alternative
// population at 3x signups / 35% skip rates); a first-time raid
// mass-skipping ONE hated song peaked A = 9 in ONE window (s = 9,
// bigger than a brigade window's 7.5) and never flagged - the
// two-window rule is the separating leg; a 15-bot brigade
// flagged after exactly two wrecked songs.
// ---------------------------------------------------------------------------

const W = 60_000;
const BASE = Math.floor(1_700_000_000_000 / W) * W; // window-aligned
const HOUR = 3_600_000;
const DAY = 86_400_000;

function vote(sig, identity, ts, createdTs) {
  sig.observe({ identity, ts, accountCreatedTs: createdTs });
}
function newVote(sig, identity, ts) {
  vote(sig, identity, ts, ts - HOUR);
}
function oldVote(sig, identity, ts) {
  vote(sig, identity, ts, ts - 30 * DAY);
}
/** One window of voting starting at windowStart: n new + o old. */
function windowVotes(sig, windowStart, n, o, tag) {
  for (let i = 0; i < n; i++) newVote(sig, `${tag}-new-${windowStart}-${i}`, windowStart + 1_000 + i * 100);
  for (let i = 0; i < o; i++) oldVote(sig, `${tag}-old-${windowStart}-${i}`, windowStart + 30_000 + i * 100);
}

test('a two-song brigade flags at the end of the second contributing window', () => {
  const sig = sdk.createVoteBrigadingSignal();
  windowVotes(sig, BASE, 18, 2, 'a'); // s = 18 - 10 = 8
  windowVotes(sig, BASE + W, 18, 2, 'a'); // s = 8 -> A = 16 >= 12, 2 windows
  const r = sig.evaluate();
  assert.equal(r.flagged, true);
  assert.equal(r.firstFlagTs, BASE + 2 * W);
  assert.equal(r.accumulator, 16);
  assert.equal(r.contributingWindows, 2);
  assert.equal(r.enforcement, 'none');
  assert.equal(r.kind, 'vote-brigading');
});

test('one mass skip by first-timers cannot flag, however big the window', () => {
  const sig = sdk.createVoteBrigadingSignal();
  windowVotes(sig, BASE, 27, 9, 'raid'); // s = 27 - 18 = 9 (the lab raid peak)
  const r = sig.evaluate();
  assert.equal(r.flagged, false);
  assert.equal(r.maxAccumulator, 9);
  assert.equal(r.contributingWindows, 1);
});

test('ordinary voting never moves the accumulator off 0', () => {
  const sig = sdk.createVoteBrigadingSignal();
  for (let k = 0; k < 30; k++) windowVotes(sig, BASE + k * W, 2, 8, 'legit'); // s = 2 - 5 < 0
  const r = sig.evaluate();
  assert.equal(r.accumulator, 0);
  assert.equal(r.flagged, false);
});

test('windows under the 5-vote floor score 0 even when unanimously new', () => {
  const sig = sdk.createVoteBrigadingSignal();
  windowVotes(sig, BASE, 4, 0, 'tiny');
  windowVotes(sig, BASE + W, 4, 0, 'tiny');
  windowVotes(sig, BASE + 2 * W, 4, 0, 'tiny');
  assert.equal(sig.evaluate().accumulator, 0);
});

test('negative windows drain the accumulator and reset the window count', () => {
  const sig = sdk.createVoteBrigadingSignal();
  windowVotes(sig, BASE, 18, 2, 'b'); // A = 8, contrib 1
  for (let k = 1; k <= 4; k++) windowVotes(sig, BASE + k * W, 0, 10, 'calm'); // s = -5 each
  windowVotes(sig, BASE + 5 * W, 18, 2, 'b'); // alone again: A = 8, contrib 1
  const r = sig.evaluate();
  assert.equal(r.flagged, false);
  assert.equal(r.accumulator, 8);
  assert.equal(r.contributingWindows, 1);
});

test('votes from aged accounts are not new (newness is the estimand leg)', () => {
  const sig = sdk.createVoteBrigadingSignal();
  for (let k = 0; k < 3; k++) windowVotes(sig, BASE + k * W, 0, 20, 'aged'); // all old: s = -10
  const r = sig.evaluate();
  assert.equal(r.accumulator, 0);
  assert.equal(r.flagged, false);
});

test('first observation stands in for creation time when accountCreatedTs is absent', () => {
  const sig = sdk.createVoteBrigadingSignal();
  // 'veteran' first votes 40 days "ago" relative to the brigade
  // windows, so its later votes are old; the brigade is fresh.
  oldVote(sig, 'veteran', BASE - 40 * DAY);
  windowVotes(sig, BASE, 18, 2, 'c');
  sig.observe({ identity: 'veteran', ts: BASE + W + 1_000 }); // old vote in window 2
  for (let i = 0; i < 17; i++) newVote(sig, `c2-new-${i}`, BASE + W + 2_000 + i * 100);
  oldVote(sig, 'c2-old-0', BASE + W + 30_000);
  const r = sig.evaluate();
  assert.equal(r.flagged, true); // window 2: T = 20, N = 17, s = 7 -> A = 15
});

test('the result names no identity (room state, population family)', () => {
  const sig = sdk.createVoteBrigadingSignal();
  windowVotes(sig, BASE, 18, 2, 'd');
  const r = sig.evaluate();
  for (const key of Object.keys(r)) {
    assert.ok(!/identit|member/i.test(key), `unexpected identity-bearing key ${key}`);
  }
});

test('asOfTs folds only windows that have ended by then', () => {
  const sig = sdk.createVoteBrigadingSignal();
  windowVotes(sig, BASE, 18, 2, 'e');
  windowVotes(sig, BASE + W, 18, 2, 'e');
  const early = sig.evaluate({ asOfTs: BASE + W }); // only window 1 ended
  assert.equal(early.flagged, false);
  assert.equal(early.windows, 1);
  assert.equal(sig.evaluate({ asOfTs: BASE + 2 * W }).flagged, true);
});

test('malformed input: invalid ts no-op, bad options throw VoteBrigadingError', () => {
  const sig = sdk.createVoteBrigadingSignal();
  assert.deepEqual(sig.observe({ identity: 'x', ts: Number.NaN }), { status: 'invalid_ts', counted: false });
  assert.throws(() => sig.observe({ identity: '', ts: BASE }), sdk.VoteBrigadingError);
  assert.throws(() => sdk.createVoteBrigadingSignal({ threshold: 0 }), sdk.VoteBrigadingError);
  assert.throws(() => sdk.createVoteBrigadingSignal({ minWindows: 0 }), sdk.VoteBrigadingError);
  assert.equal(sig.snapshot().counters.invalidTs, 1);
});
