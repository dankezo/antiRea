"use strict";
// LCP-07 - verdict-TTL asymmetry: a positive verdict must have a
// bounded TTL and must not be silently inherited across identity
// reassignment.
//
// Lab record (port-measured logic verdict, no PHP runtime was
// available; RESULTS-LCP-STEP0.md, cycle C578): in the dissected
// third-party CAPTCHA library the verified-bot verdict cache held
// a POSITIVE verdict for 24 h (86,400 s) but a NEGATIVE verdict
// for only 300 s. Measured consequences: a positive verdict minted
// at t = 0 still bypassed at t = 3,600 s; a reassigned IP inherited
// the positive verdict for up to 24 h; a negative verdict minted
// at t = 0 was gone by t = 301 s, and the positive expired at
// exactly t = 86,400 s.
//
// Audit of antiRea's verification-grace (the surface with the same
// trust-timing semantics): its default window is also 24 h, it is
// keyed by an opaque host-supplied identity string, and before
// this change it had no TTL cap and no continuity binding - a host
// keying grace by IP reproduced the lab shape exactly. The upgrade
// shipped here is OPT-IN, defaults unchanged:
// - positiveVerdictMaxMs caps the effective window;
// - record bindings (with requireBinding to enforce them) make a
//   positive verdict non-transferable across reassignment.
// The tests below encode the lab's measured time points against
// both the default shape (the audit) and the opt-in policy.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const sdk = require("../dist/index.js");

const SECOND = 1_000;
const DAY = 86_400_000;

function fakeClocks(start = 1_700_000_000_000) {
  let wall = start;
  let mono = start;
  return {
    now: () => wall,
    monoNow: () => mono,
    advance: (ms) => { wall += ms; mono += ms; },
  };
}

function makeGrace(clocks, extra = {}) {
  return sdk.createVerificationGrace({
    flagThreshold: 10, escalationFactor: 2,
    now: clocks.now, monoNow: clocks.monoNow, ...extra,
  });
}

test("audit pin, default shape: positive verdict still suppresses at t = 3,600 s and expires at exactly t = 86,400 s", () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks); // default window: 24 h, as in the lab
  grace.recordVerified("ip-keyed-identity", { evidenceLevel: 12 });

  clocks.advance(3_600 * SECOND); // the lab bypass point
  let v = grace.guardStepUp("ip-keyed-identity", 12);
  assert.equal(v.stepUpSuppressed, true, "default shape reproduces the lab asymmetry at 3,600 s");
  assert.equal(v.reason, "in_grace");

  clocks.advance(86_400 * SECOND - 3_600 * SECOND - 1);
  assert.equal(grace.isInGrace("ip-keyed-identity"), true, "one ms before the 24 h line the verdict still holds");
  clocks.advance(1); // exactly t = 86,400 s
  v = grace.guardStepUp("ip-keyed-identity", 12);
  assert.equal(v.stepUpSuppressed, false);
  assert.equal(v.reason, "grace_expired");
});

test("audit pin, negative side: an identity with no positive verdict has nothing at t = 301 s or any other time", () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks);
  clocks.advance(301 * SECOND); // the lab point where a negative verdict is already gone
  const v = grace.guardStepUp("never-verified", 12);
  assert.equal(v.action, "step_up");
  assert.equal(v.reason, "no_grace");
  assert.equal(grace.snapshot().identities, 0, "no record is minted by evaluation or by waiting");
});

test("opt-in bound: positiveVerdictMaxMs at the negative scale (300 s) ends the positive verdict by t = 301 s", () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks, { graceWindowMs: DAY, positiveVerdictMaxMs: 300_000 });
  const rec = grace.recordVerified("bounded-identity", { evidenceLevel: 12 });
  assert.equal(rec.graceWindowMs, 300_000, "the enforced window is the capped one");
  assert.equal(grace.snapshot().graceWindowMs, 300_000);

  clocks.advance(299 * SECOND);
  let v = grace.guardStepUp("bounded-identity", 12);
  assert.equal(v.stepUpSuppressed, true);
  assert.equal(v.graceRemainingMs, 1_000);

  clocks.advance(2 * SECOND); // t = 301 s, the lab negative-expiry point
  v = grace.guardStepUp("bounded-identity", 12);
  assert.equal(v.stepUpSuppressed, false);
  assert.equal(v.reason, "grace_expired");
  assert.equal(grace.snapshot().expired, 1);
});

test("opt-in bound: a cap above the configured window never extends it, and invalid caps are refused", () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks, { graceWindowMs: 3_600_000, positiveVerdictMaxMs: 2 * DAY });
  grace.recordVerified("short-window", { evidenceLevel: 12 });
  clocks.advance(3_600 * SECOND);
  assert.equal(grace.guardStepUp("short-window", 12).reason, "grace_expired");
  assert.throws(() => makeGrace(fakeClocks(), { positiveVerdictMaxMs: 0 }), sdk.VerificationGraceError);
  assert.throws(() => makeGrace(fakeClocks(), { positiveVerdictMaxMs: Number.NaN }), sdk.VerificationGraceError);
  assert.throws(() => makeGrace(fakeClocks(), { positiveVerdictMaxMs: 999 }), sdk.VerificationGraceError);
});

test("opt-in binding: a reassigned key inherits nothing - binding mismatch suppresses nothing and latches nothing", () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks);
  const key = "ip:203.0.113.7"; // a reassignable key, the lab shape
  grace.recordVerified(key, { evidenceLevel: 12, binding: "account-a" });

  clocks.advance(3_600 * SECOND); // still inside 24 h: the lab inheritance window
  // The continuing holder presents its binding: suppressed.
  let v = grace.guardStepUp(key, 12, { binding: "account-a" });
  assert.equal(v.stepUpSuppressed, true);
  assert.equal(v.action, "observe");
  assert.equal(grace.isInGrace(key, { binding: "account-a" }), true);

  // The key is reassigned: the new holder presents a different
  // binding (or none) and inherits nothing, even at the exact
  // moment the lab measured inheritance.
  for (const presented of [{ binding: "account-b" }, {}, { binding: "" }]) {
    v = grace.guardStepUp(key, 12, presented);
    assert.equal(v.stepUpSuppressed, false);
    assert.equal(v.action, "step_up");
    assert.equal(v.reason, "binding_mismatch");
    assert.equal(grace.isInGrace(key, presented), false);
  }

  // A stranger's escalated presentation does not break the real
  // holder's grace either: mismatch mutates nothing.
  v = grace.guardStepUp(key, 500, { binding: "account-b" });
  assert.equal(v.reason, "binding_mismatch");
  assert.equal(v.escalated, false);
  assert.equal(grace.snapshot().broken, 0);
  v = grace.guardStepUp(key, 12, { binding: "account-a" });
  assert.equal(v.stepUpSuppressed, true, "the rightful holder's grace survives stranger presentations");
});

test("requireBinding: recording a positive verdict without a binding is refused, and bindings are validated", () => {
  const clocks = fakeClocks();
  const grace = makeGrace(clocks, { requireBinding: true });
  assert.throws(() => grace.recordVerified("id-1", { evidenceLevel: 12 }), sdk.VerificationGraceError);
  assert.throws(() => grace.recordVerified("id-1", { binding: "" }), sdk.VerificationGraceError);
  assert.throws(() => grace.recordVerified("id-1", { binding: "two\nlines" }), sdk.VerificationGraceError);
  assert.throws(() => grace.recordVerified("id-1", { binding: "x".repeat(1025) }), sdk.VerificationGraceError);
  const rec = grace.recordVerified("id-1", { evidenceLevel: 12, binding: "account-a" });
  assert.equal(rec.identity, "id-1");
  assert.equal(grace.guardStepUp("id-1", 12, { binding: "account-a" }).action, "observe");
  assert.equal(grace.guardStepUp("id-1", 12).reason, "binding_mismatch");

  // And the default instance is untouched by the policy: records
  // without bindings keep the pre-LCP-07 behaviour exactly.
  const legacy = makeGrace(fakeClocks());
  legacy.recordVerified("id-2", { evidenceLevel: 12 });
  assert.equal(legacy.guardStepUp("id-2", 12).action, "observe");
  assert.equal(legacy.isInGrace("id-2"), true);
});
