const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ABS-06: PoW elapsed time must be server-measured. Neighbour
// measurement (abs-lab RESULTS-ABS-STEP0): two genuinely-solved
// verifies claiming elapsed 180 and 180,000 both passed - only a
// range check on the CLAIMED value existed (claims of 179 and
// 180,001 were refused 400). A server that measures elapsed itself
// could accept at most one of those two claims. The clock below
// records issuance on the server's own monotonic clock and decides
// solely on the measured difference; the claimed value is accepted
// as an argument only so tests can prove it does not decide.

function makeClock(minElapsedMs = 1_000, maxElapsedMs = 180_000) {
  let mono = 10_000_000;
  const clock = sdk.createServerMeasuredPowClock({
    minElapsedMs, maxElapsedMs, monoNow: () => mono,
  });
  return { clock, advance: (ms) => { mono += ms; } };
}

test('ABS-06: claims of 180 and 180,000 get the same verdict at the same server-measured elapsed', () => {
  const { clock, advance } = makeClock();
  clock.issueChallenge('c1');
  advance(5_000);
  const a = clock.checkElapsed('c1', 180);
  clock.issueChallenge('c2');
  advance(5_000);
  const b = clock.checkElapsed('c2', 180_000);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.serverElapsedMs, 5_000);
  assert.equal(b.serverElapsedMs, 5_000);
});

test('ABS-06: an in-range claim cannot rescue a too-fast server-measured solve', () => {
  const { clock, advance } = makeClock();
  clock.issueChallenge('fast');
  advance(100); // server measured 100 ms, below the 1,000 ms floor
  const result = clock.checkElapsed('fast', 5_000); // claim sits inside the old range check
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too_fast');
  assert.equal(result.serverElapsedMs, 100);
});

test('ABS-06: an out-of-range claim cannot sink a valid server-measured solve', () => {
  const { clock, advance } = makeClock();
  clock.issueChallenge('slow-claim');
  advance(2_000);
  const result = clock.checkElapsed('slow-claim', 180_001); // the neighbour range check refused this claim
  assert.equal(result.ok, true);
  assert.equal(result.serverElapsedMs, 2_000);
});

test('ABS-06: server-measured elapsed past the ceiling rejects as too_slow whatever the claim', () => {
  const { clock, advance } = makeClock();
  clock.issueChallenge('slow');
  advance(180_001);
  const result = clock.checkElapsed('slow', 180);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too_slow');
});

test('ABS-06: unknown and replayed challenges fail closed', () => {
  const { clock, advance } = makeClock();
  assert.deepEqual(clock.checkElapsed('never-issued', 5_000), {
    ok: false, reason: 'unknown_challenge', serverElapsedMs: 0,
  });
  clock.issueChallenge('once');
  advance(2_000);
  assert.equal(clock.checkElapsed('once', 2_000).ok, true);
  // Single-use: the same challenge cannot be checked twice.
  assert.equal(clock.checkElapsed('once', 2_000).reason, 'unknown_challenge');
});

test('ABS-06: issuing the same challenge id twice throws instead of resetting the clock', () => {
  const { clock } = makeClock();
  clock.issueChallenge('dup');
  assert.throws(() => clock.issueChallenge('dup'), sdk.StepUpProofError);
  assert.throws(() => clock.issueChallenge(''), sdk.StepUpProofError);
});
