const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ---------------------------------------------------------------------------
// Post-verification grace (operator's ruling, 2026-11-03). These tests
// port the exact scenario the operator raised: a legitimate user whose
// work pattern keeps resembling a bot's is flagged, passes step-up,
// and - before this module - was step-up challenged AGAIN for as long
// as the pattern continued. Grace is the missing state: verified once,
// left alone for a window, unless the evidence escalates decisively.
//
// The harness below fakes BOTH clocks. The grace window is a duration
// and must be measured on the monotonic clock (L-DEEP-2 discipline):
// one test steps the WALL clock +/-5 minutes mid-grace and asserts the
// grace neither stretches nor shrinks; only monotonic time moves it.
//
// The ceiling test (d) wires a real record budget next to the grace
// instance: grace holds no reference to any budget, so the ceiling
// must bite at exactly the same record count with grace active as it
// does for a no-grace control identity. No network, no real time.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A pair of hand-driven clocks: wall and monotonic, independently steppable. */
function fakeClocks(startWall = 1_700_000_000_000) {
  let wall = startWall;
  let mono = startWall;
  return {
    now: () => wall,
    monoNow: () => mono,
    advanceWall: (ms) => { wall += ms; },
    advanceMono: (ms) => { mono += ms; },
    advanceBoth: (ms) => { wall += ms; mono += ms; },
  };
}

function makeGrace(clocks, extra = {}) {
  return sdk.createVerificationGrace({
    graceWindowMs: DAY,
    flagThreshold: 10,
    escalationFactor: 2, // escalation line: 20
    now: clocks.now,
    monoNow: clocks.monoNow,
    ...extra,
  });
}

test('(a) flagged -> step-up -> verified: ordinary evidence no longer re-triggers step-up inside the window', () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks);
  const id = 'account:legit-power-user';

  // Before verification: no grace, step-up applies at flag level (10).
  let v = grace.guardStepUp(id, 12);
  assert.equal(v.action, 'step_up');
  assert.equal(v.reason, 'no_grace');

  // The user passes the challenge; the host records it with the score
  // observed at the pass.
  const rec = grace.recordVerified(id, { evidenceLevel: 12, reason: 'passed step-up challenge' });
  assert.equal(rec.identity, id);
  assert.equal(rec.baselineEvidence, 12);
  assert.equal(rec.verifications, 1);
  assert.equal(rec.graceWindowMs, DAY);

  // The pattern continues: evidence stays at and above the flag
  // threshold (10), even a bit hotter than at verification - but below
  // the escalation line (20). Step-up must stay suppressed throughout.
  for (const level of [10, 12, 15, 19.99]) {
    v = grace.guardStepUp(id, level);
    assert.equal(v.stepUpSuppressed, true);
    assert.equal(v.action, 'observe');
    assert.equal(v.reason, 'in_grace');
    assert.equal(v.inGrace, true);
  }

  // Half a day later, still ordinary evidence: still suppressed, and
  // the remaining window is reported from the monotonic clock.
  clocks.advanceBoth(12 * HOUR);
  v = grace.evaluate(id, 14);
  assert.equal(v.stepUpSuppressed, true);
  assert.equal(v.graceRemainingMs, 12 * HOUR);
  assert.equal(grace.isInGrace(id), true);
});

test('(b) evidence spiking past the escalation line breaks grace immediately - and it latches', () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks);
  const id = 'account:verified-then-hostile';

  grace.recordVerified(id, { evidenceLevel: 11 });
  clocks.advanceBoth(HOUR);
  assert.equal(grace.evaluate(id, 15).stepUpSuppressed, true);

  // One minute later the evidence jumps to 25 (>= line 20): step-up
  // returns NOW, not at window end, and the breaking evaluation says so.
  clocks.advanceBoth(60_000);
  const v = grace.guardStepUp(id, 25);
  assert.equal(v.escalated, true);
  assert.equal(v.stepUpSuppressed, false);
  assert.equal(v.action, 'step_up');
  assert.equal(v.reason, 'grace_broken_escalation');
  assert.equal(v.inGrace, false);

  // The break latches: evidence dipping back to ordinary levels does
  // NOT quietly restore the shield (no burst-dip-burst riding).
  const after = grace.evaluate(id, 10);
  assert.equal(after.stepUpSuppressed, false);
  assert.equal(after.escalated, false); // history, not news
  assert.equal(after.reason, 'grace_broken_escalation');
  assert.equal(grace.isInGrace(id), false);
  assert.equal(grace.snapshot().broken, 1);

  // Re-verification after the new step-up re-baselines the grace.
  grace.recordVerified(id, { evidenceLevel: 25 });
  assert.equal(grace.evaluate(id, 19).stepUpSuppressed, true);
  assert.equal(grace.snapshot().broken, 0);
});

test('(c) after the window expires, hot evidence brings step-up back', () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks);
  const id = 'account:slow-burn';

  grace.recordVerified(id, { evidenceLevel: 12 });
  clocks.advanceBoth(DAY - 1);
  assert.equal(grace.evaluate(id, 13).stepUpSuppressed, true);

  clocks.advanceBoth(2); // now 1 ms past the 24 h window
  const v = grace.guardStepUp(id, 13);
  assert.equal(v.stepUpSuppressed, false);
  assert.equal(v.action, 'step_up');
  assert.equal(v.reason, 'grace_expired');
  assert.equal(v.graceRemainingMs, null);
  assert.equal(grace.isInGrace(id), false);
  assert.equal(grace.snapshot().expired, 1);
});

test('(d) ceilings are untouched by grace: the record budget bites at the same count inside the window', () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks);
  // A real budget, wired the way a host wires it, next to the grace
  // instance. Grace gets no handle on it - the test proves the ceiling
  // behaves identically for a graced and an ungraced identity.
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 5, windowMs: DAY, now: clocks.now });
  const graced = 'account:in-grace';
  const control = 'account:no-grace';

  grace.recordVerified(graced, { evidenceLevel: 12 });
  assert.equal(grace.evaluate(graced, 12).stepUpSuppressed, true);

  for (const id of [graced, control]) {
    for (let i = 1; i <= 5; i++) {
      assert.equal(budget.check(id, 1).allowed, true, `${id} record ${i} should be allowed`);
      budget.consume(id, [`rec-${i}`]);
    }
    // The 6th distinct record is refused for BOTH - grace bought the
    // first identity zero extra records.
    assert.equal(budget.check(id, 1).allowed, false, `${id} must hit the same ceiling`);
  }
  // And the graced identity is still, separately, shielded from step-up.
  assert.equal(grace.evaluate(graced, 12).stepUpSuppressed, true);
});

test('(e) grace is per identity: A\'s verification never leaks to B', () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks);
  grace.recordVerified('account:a', { evidenceLevel: 12 });

  assert.equal(grace.evaluate('account:a', 12).stepUpSuppressed, true);
  const b = grace.guardStepUp('account:b', 12);
  assert.equal(b.stepUpSuppressed, false);
  assert.equal(b.action, 'step_up');
  assert.equal(b.reason, 'no_grace');
  assert.equal(grace.isInGrace('account:b'), false);

  // Escalation on B also leaves A's grace fully intact.
  grace.recordVerified('account:b', { evidenceLevel: 12 });
  grace.evaluate('account:b', 30);
  assert.equal(grace.evaluate('account:a', 12).stepUpSuppressed, true);
  assert.equal(grace.evaluate('account:b', 12).stepUpSuppressed, false);
});

test('(f) an identity that never verified behaves exactly as before this module existed', () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks);
  const id = 'account:never-verified';

  for (const level of [0, 9.99, 10, 19.99, 20, 500]) {
    const v = grace.guardStepUp(id, level);
    assert.equal(v.stepUpSuppressed, false);
    assert.equal(v.action, 'step_up');
    assert.equal(v.reason, 'no_grace');
    assert.equal(v.escalated, false);
  }
  assert.equal(grace.isInGrace(id), false);
  assert.equal(grace.forget(id), false);
  assert.deepEqual(grace.snapshot(), {
    identities: 0,
    active: 0,
    broken: 0,
    expired: 0,
    graceWindowMs: DAY,
    flagThreshold: 10,
    escalationFactor: 2,
    escalationThreshold: 20,
  });
});

test('clock discipline: wall-clock steps (NTP) neither stretch nor shrink grace; only monotonic time does', () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks, { graceWindowMs: HOUR });
  const id = 'account:ntp-victim';
  grace.recordVerified(id, { evidenceLevel: 12 });

  // 30 monotonic minutes pass; the wall clock steps BACK 5 minutes
  // (NTP correction). Grace must still have exactly 30 minutes left:
  // the wall step buys the user nothing and costs the user nothing.
  clocks.advanceMono(30 * 60_000);
  clocks.advanceWall(-5 * 60_000);
  let v = grace.evaluate(id, 12);
  assert.equal(v.stepUpSuppressed, true);
  assert.equal(v.graceRemainingMs, 30 * 60_000);

  // A FORWARD wall step of an hour must not expire the grace early
  // either - only the monotonic remainder counts.
  clocks.advanceWall(2 * HOUR);
  v = grace.evaluate(id, 12);
  assert.equal(v.stepUpSuppressed, true);
  assert.equal(v.graceRemainingMs, 30 * 60_000);

  // Monotonic time reaching the window end expires it, wall unmoved.
  clocks.advanceMono(30 * 60_000);
  assert.equal(grace.evaluate(id, 12).reason, 'grace_expired');
});

test('resolution rule: injecting only `now` keeps single-clock behavior for host/test clocks (L-DEEP-2)', () => {
  let t = 1_000_000;
  const grace = sdk.createVerificationGrace({
    graceWindowMs: HOUR,
    flagThreshold: 10,
    now: () => t, // no monoNow: the injected clock drives both domains
  });
  grace.recordVerified('account:single-clock');
  t += HOUR - 1;
  assert.equal(grace.evaluate('account:single-clock', 5).stepUpSuppressed, true);
  t += 2;
  assert.equal(grace.evaluate('account:single-clock', 5).reason, 'grace_expired');
});

test('invalid evidence never poisons state: it suppresses nothing and breaks nothing', () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks);
  const id = 'account:nan-host';
  grace.recordVerified(id, { evidenceLevel: 12 });

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const v = grace.evaluate(id, bad);
    assert.equal(v.reason, 'invalid_evidence');
    assert.equal(v.stepUpSuppressed, false);
    assert.equal(v.escalated, false);
    assert.equal(v.inGrace, true); // the record itself is unharmed
  }
  // A following ordinary evaluation still finds the grace intact.
  assert.equal(grace.evaluate(id, 12).stepUpSuppressed, true);
  assert.equal(grace.snapshot().broken, 0);
});

test('option and input validation throws the named error', () => {
  const clocks = fakeClocks();
  const bad = (opts) => () => sdk.createVerificationGrace(opts);
  assert.throws(bad({ graceWindowMs: 500 }), sdk.VerificationGraceError); // sub-second: unit mistake
  assert.throws(bad({ graceWindowMs: Number.NaN }), sdk.VerificationGraceError);
  assert.throws(bad({ flagThreshold: 0 }), sdk.VerificationGraceError);
  assert.throws(bad({ flagThreshold: -1 }), sdk.VerificationGraceError);
  assert.throws(bad({ escalationFactor: 1 }), sdk.VerificationGraceError); // would void grace at grant time
  assert.throws(bad({ escalationFactor: 0.5 }), sdk.VerificationGraceError);
  assert.throws(bad({ maxIdentities: 0 }), sdk.VerificationGraceError);
  assert.throws(bad({ maxIdentities: 2.5 }), sdk.VerificationGraceError);

  const grace = makeGrace(clocks);
  assert.throws(() => grace.recordVerified(''), sdk.VerificationGraceError);
  assert.throws(() => grace.recordVerified('account:x', { evidenceLevel: -1 }), sdk.VerificationGraceError);
  assert.throws(() => grace.recordVerified('account:x', { evidenceLevel: Number.NaN }), sdk.VerificationGraceError);
  assert.throws(() => grace.evaluate('account:x\ny'), sdk.VerificationGraceError);

  try {
    sdk.createVerificationGrace({ escalationFactor: 1 });
    assert.unreachable('should have thrown');
  } catch (err) {
    assert.equal(err.name, 'VerificationGraceError');
  }
});

test('defaults: 24 h window, normalized flag threshold 1, escalation at 2x, shipped constants agree', () => {
  const clocks = fakeClocks();
  const grace = sdk.createVerificationGrace({ now: clocks.now, monoNow: clocks.monoNow });
  assert.equal(sdk.DEFAULT_GRACE_WINDOW_MS, DAY);
  assert.equal(sdk.DEFAULT_GRACE_ESCALATION_FACTOR, 2);
  const snap = grace.snapshot();
  assert.equal(snap.graceWindowMs, DAY);
  assert.equal(snap.flagThreshold, 1);
  assert.equal(snap.escalationThreshold, 2);

  grace.recordVerified('account:normalized');
  assert.equal(grace.evaluate('account:normalized', 1.5).stepUpSuppressed, true);
  assert.equal(grace.evaluate('account:normalized', 2).escalated, true);
});

test('state is bounded: eviction removes the oldest record and fails toward MORE friction, never less', () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks, { maxIdentities: 2 });
  grace.recordVerified('account:oldest');
  grace.recordVerified('account:middle');
  grace.recordVerified('account:newest'); // evicts 'account:oldest'

  assert.equal(grace.snapshot().identities, 2);
  // The evicted identity lost only its shield: step-up applies again,
  // exactly the pre-grace behavior. Nobody gained anything.
  assert.equal(grace.evaluate('account:oldest', 12).reason, 'no_grace');
  assert.equal(grace.evaluate('account:middle', 12).stepUpSuppressed, true);
  assert.equal(grace.evaluate('account:newest', 12).stepUpSuppressed, true);

  // forget() drops a record deliberately.
  assert.equal(grace.forget('account:middle'), true);
  assert.equal(grace.evaluate('account:middle', 12).reason, 'no_grace');
});
