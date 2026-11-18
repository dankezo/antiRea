"use strict";
// LCP-05 - a wait is not a proof; step-up needs work or a verified fact.
//
// Lab record (port-measured logic verdict, no PHP runtime was
// available; RESULTS-LCP-STEP0.md, cycle C578): in the dissected
// third-party CAPTCHA library the queue challenge accepted any
// client whose elapsed time fell in the 10 to 18 s window - 20/20
// wait-only clients passed at 12 s having done zero work, and the
// boundaries were exact (9 s restarted the queue as too early,
// 19 s restarted it as too late). Elapsed time alone was the proof.
//
// antiRea conformance rule, applied to its own step-up surfaces:
// no antiRea surface grants anything for elapsed time. The
// verification-grace module suppresses step-up only after a
// recorded, passed verification (a verified fact); the step-up
// proof verifier accepts only a signed, single-use token (work
// presented and checked); the 402 assertion check accepts only
// the exact issued token. In every surface, waiting longer either
// changes nothing or makes a credential staler - never valid.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const sdk = require("../dist/index.js");

function fakeClocks(start = 1_700_000_000_000) {
  let wall = start;
  let mono = start;
  return {
    now: () => wall,
    monoNow: () => mono,
    advance: (ms) => { wall += ms; mono += ms; },
  };
}

test("20 wait-only identities at 12 s (the lab pass point) earn no grace and no suppression", () => {
  const clocks = fakeClocks();
  const grace = sdk.createVerificationGrace({
    graceWindowMs: 86_400_000, flagThreshold: 10, escalationFactor: 2,
    now: clocks.now, monoNow: clocks.monoNow,
  });
  clocks.advance(12_000); // the exact wait that passed 20/20 in the lab
  let suppressed = 0;
  for (let i = 0; i < 20; i++) {
    const verdict = grace.guardStepUp("wait-only-" + i, 15);
    if (verdict.stepUpSuppressed) suppressed++;
    assert.equal(verdict.action, "step_up");
    assert.equal(verdict.reason, "no_grace");
    assert.equal(grace.isInGrace("wait-only-" + i), false);
  }
  assert.equal(suppressed, 0, "wait-only grants: 0 of 20 (lab neighbour: 20 of 20)");
  assert.equal(grace.snapshot().active, 0);
});

test("the lab boundary waits (9 s, 10 s, 18 s, 19 s) and a full hour all grant exactly nothing", () => {
  const clocks = fakeClocks();
  const grace = sdk.createVerificationGrace({
    graceWindowMs: 86_400_000, flagThreshold: 10, escalationFactor: 2,
    now: clocks.now, monoNow: clocks.monoNow,
  });
  let waitedMs = 0;
  for (const targetMs of [9_000, 10_000, 18_000, 19_000, 3_600_000]) {
    clocks.advance(targetMs - waitedMs);
    waitedMs = targetMs;
    const verdict = grace.guardStepUp("waiter", 15);
    assert.equal(verdict.stepUpSuppressed, false, "waited " + targetMs + " ms and was suppressed");
    assert.equal(verdict.action, "step_up");
  }
  // Only the verified fact changes the outcome: record a pass, and
  // the same evidence level is suppressed without any further wait.
  grace.recordVerified("waiter", { evidenceLevel: 15 });
  assert.equal(grace.guardStepUp("waiter", 15).action, "observe");
});

test("a step-up proof verifier never accepts elapsed time in place of a token, and waiting only stales a real one", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const CFG = "b".repeat(64);
  const CHALLENGE = { type: "captcha" };
  const NOW = 1_700_000_000;
  const verifier = sdk.createStepUpProofVerifier({ keys: { main: publicKey }, consumeNonce: () => true });
  const ctx = {
    identity: "user-1", expectedConfigHash: CFG,
    expectedChallengeHash: sdk.stepUpChallengeHash(CHALLENGE), nowSec: NOW + 12,
  };
  // Twelve seconds of waiting, no token presented in any form.
  for (const nothing of [undefined, null, "", "waited-12s", 12]) {
    assert.deepEqual(verifier.verifyProof(nothing, ctx), { outcome: "REJECT", reason: "MALFORMED" });
  }
  // A real token presented after its window has fully elapsed is
  // EXPIRED: the wait degraded it, it did not complete it.
  const token = sdk.issueStepUpProof({
    privateKey, kid: "main", identity: "user-1", configHash: CFG,
    challengeConfig: CHALLENGE, nonce: "nonce-wait", issuedAtSec: NOW, expiresAtSec: NOW + 600,
  });
  assert.deepEqual(
    verifier.verifyProof(token, { ...ctx, nowSec: NOW + 600 + 61 }),
    { outcome: "REJECT", reason: "EXPIRED" },
  );
});

test("the 402 assertion check has no time input: only the exact issued token passes, however often or late it is asked", () => {
  const responder = sdk.createStepUp402Responder({
    priceUsd: 0.001,
    manifestUrl: "https://example.test/manifest",
    facilitator: "facilitator-1",
    payUrl: "https://example.test/pay",
    appealUrl: "https://example.test/appeal",
    continueFreeUrl: "https://example.test/continue",
  });
  for (let ask = 0; ask < 20; ask++) {
    assert.equal(responder.checkAssertion("", "issued-token"), false);
    assert.equal(responder.checkAssertion("waited-long-enough", "issued-token"), false);
    assert.equal(responder.checkAssertion(undefined, "issued-token"), false);
  }
  assert.equal(responder.checkAssertion("issued-token", "issued-token"), true);
});
