"use strict";
// LCP-06 - a challenge shape's solve-by-chance rate must be measured
// and bounded before the shape ships.
//
// Lab record (port-measured logic verdict, no PHP runtime was
// available; RESULTS-LCP-STEP0.md, cycle C578, with harness
// correction H-LCP-6): in the dissected third-party CAPTCHA library
// the broken-circle challenge fell to uniform random clicks - 60
// hits in 2,000 random clicks (observed rate 3.00 percent; the
// corrected model rate is 2.76 percent, expected 55.2 hits), which
// is about 36 submits to first solve (model 36.2; observed 33.3).
// Nobody had measured the chance rate before the shape shipped.
//
// This file is the measurement harness for antiRea's own
// credential-shaped surfaces, plus the bound they must meet:
//
//   BOUND (LCP-06): a shipped antiRea challenge or credential shape
//   must show 0 accepts in 2,000 seeded uniform-random attempts in
//   this harness - a measured rate of 0 at a resolution of 1/2000,
//   against the lab shape's 3.00 percent - before it may be treated
//   as a step-up answer. A shape that accepts even one random
//   attempt fails this file and must not ship as a step-up answer
//   until its chance rate is re-measured and re-bounded.
//
// The harness PRNG is a deterministic mulberry32 with the fixed
// seed below, so the attempt stream is reproducible run to run;
// the attempts are uniform random over each shape's input space
// (random strings, random mutations of a real token, random
// echo-shaped ids), the analogue of the lab's uniform random
// clicks over the canvas.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const sdk = require("../dist/index.js");

const ATTEMPTS = 2000; // the lab's random-click count
const LAB_OBSERVED_RATE = 0.03; // 60 / 2000 in the lab
const LAB_MODEL_SUBMITS_TO_FIRST_SOLVE = 36.2;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function measureChance(attempts, attemptFn) {
  let accepts = 0;
  let firstAcceptAt = null;
  for (let i = 0; i < attempts; i++) {
    if (attemptFn(i)) {
      accepts++;
      if (firstAcceptAt === null) firstAcceptAt = i + 1;
    }
  }
  return {
    attempts,
    accepts,
    rate: accepts / attempts,
    // Geometric expectation; Infinity when nothing was ever accepted.
    expectedSubmitsToFirstSolve: accepts === 0 ? Infinity : attempts / accepts,
    firstAcceptAt,
  };
}

function assertWithinBound(result, shapeName) {
  assert.equal(result.accepts, 0, shapeName + " accepted a random attempt at submit " + result.firstAcceptAt);
  assert.equal(result.rate, 0);
  assert.ok(result.rate < LAB_OBSERVED_RATE, shapeName + " chance rate must sit below the lab broken-circle rate");
  assert.ok(
    result.expectedSubmitsToFirstSolve > LAB_MODEL_SUBMITS_TO_FIRST_SOLVE,
    shapeName + " expected submits to first solve must exceed the lab model value",
  );
  assert.ok(result.expectedSubmitsToFirstSolve >= ATTEMPTS, shapeName + ": no solve inside the whole attempt stream");
}

test("harness self-check: the lab broken-circle rate would fail this bound", () => {
  // Feed the harness a synthetic shape that accepts at exactly the
  // lab's observed count (60 of 2000, deterministic positions) and
  // confirm the harness reports it and the bound rejects it. This
  // proves the harness can see a chance-solvable shape, so a pass
  // below is a measurement, not a blind instrument.
  const hitPositions = new Set(Array.from({ length: 60 }, (_, i) => i * 33));
  const result = measureChance(ATTEMPTS, (i) => hitPositions.has(i));
  assert.equal(result.accepts, 60);
  assert.equal(result.rate, LAB_OBSERVED_RATE);
  assert.throws(() => assertWithinBound(result, "synthetic broken-circle"), /accepted a random attempt/);
});

test("step-up proof shape: 2,000 random and mutated tokens, 0 accepts", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const CFG = "b".repeat(64);
  const CHALLENGE = { type: "captcha" };
  const NOW = 1_700_000_000;
  const verifier = sdk.createStepUpProofVerifier({ keys: { main: publicKey }, consumeNonce: () => true });
  const ctx = {
    identity: "user-1", expectedConfigHash: CFG,
    expectedChallengeHash: sdk.stepUpChallengeHash(CHALLENGE), nowSec: NOW + 60,
  };
  const genuine = sdk.issueStepUpProof({
    privateKey, kid: "main", identity: "user-1", configHash: CFG,
    challengeConfig: CHALLENGE, nonce: "nonce-chance", issuedAtSec: NOW, expiresAtSec: NOW + 600,
  });
  const rand = mulberry32(20321606); // the lab candidate's seed family (LCP-06)
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const randomToken = () => {
    const parts = [];
    for (let p = 0; p < 3; p++) {
      const len = 8 + Math.floor(rand() * 80);
      let s = "";
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
      parts.push(s);
    }
    return parts.join(".");
  };
  const mutatedToken = () => {
    // Mutate one fully significant character of the signature
    // segment. (Mutating the final base64 character of a segment
    // can change only ignored padding bits, which re-encodes the
    // SAME genuine token - a malleability note, not a chance
    // solve - so the harness samples the credential space, not
    // the encoding padding.)
    const parts = genuine.split(".");
    const sig = parts[2].split("");
    const at = Math.floor(rand() * (sig.length - 2));
    let replacement = alphabet[Math.floor(rand() * alphabet.length)];
    if (replacement === sig[at]) replacement = replacement === "A" ? "B" : "A";
    sig[at] = replacement;
    parts[2] = sig.join("");
    return parts.join(".");
  };
  const result = measureChance(ATTEMPTS, (i) =>
    verifier.verifyProof(i % 2 === 0 ? randomToken() : mutatedToken(), ctx).outcome === "ACCEPT",
  );
  assertWithinBound(result, "step-up proof");
});

test("step-up 402 assertion shape: 2,000 random token guesses, 0 accepts", () => {
  const responder = sdk.createStepUp402Responder({
    priceUsd: 0.001,
    manifestUrl: "https://example.test/manifest",
    facilitator: "facilitator-1",
    payUrl: "https://example.test/pay",
    appealUrl: "https://example.test/appeal",
    continueFreeUrl: "https://example.test/continue",
  });
  const issued = "issued-token-for-chance-harness";
  const rand = mulberry32(20321616);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-";
  const result = measureChance(ATTEMPTS, () => {
    const len = 1 + Math.floor(rand() * 40);
    let guess = "";
    for (let i = 0; i < len; i++) guess += alphabet[Math.floor(rand() * alphabet.length)];
    return responder.checkAssertion(guess, issued);
  });
  assertWithinBound(result, "step-up 402 assertion");
});

test("canary-echo id shape: 2,000 random echo-shaped ids, 0 verify", () => {
  const rand = mulberry32(20321626);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const randomPart = (len) => {
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
    return s;
  };
  const result = measureChance(ATTEMPTS, () => {
    const id = sdk.ECHO_ID_PREFIX + randomPart(40) + "." + randomPart(43);
    return sdk.verifyEchoId("chance-harness-secret", id, { now: 1_700_000_000_000 }).ok;
  });
  assertWithinBound(result, "canary-echo id");
});
