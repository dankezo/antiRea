"use strict";
// LCP-04 - do not ship the answer distribution as public parameters.
//
// Lab record (port-measured logic verdict, no PHP runtime was
// available; RESULTS-LCP-STEP0.md, cycle C578): in the dissected
// third-party CAPTCHA library the slider's public payload carried
// fixed, vertical and travel on 20/20 renders, the gap cross-axis
// coordinate equalled the public fixed value exactly, and the
// answer was drawn from [(int)(0.35 x travel), travel] on 20/20 -
// the public parameters themselves narrowed the answer to a known
// interval covering only the top 65 percent of the travel range.
//
// antiRea conformance rule, applied to its own public parameter
// surfaces (the step-up proof token, the step-up 402 headers, body
// and manifest): no public surface may carry challenge answer
// parameters - no range bounds, no travel, no fixed coordinate, no
// tolerance. A host challenge config that contains such parameters
// binds server-side through its hash only, and changing the
// distribution server-side invalidates proofs issued under the old
// one (CHALLENGE_MISMATCH), instead of the distribution travelling
// with the challenge.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const sdk = require("../dist/index.js");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const CFG = "b".repeat(64);
const NOW = 1_700_000_000;

function sliderConfig(travel) {
  // The lab's operative distribution: answer in [(int)(0.35 x travel), travel].
  return {
    type: "slider", fixed: 137, vertical: 88, travel,
    answerMin: Math.floor(0.35 * travel), answerMax: travel, tolerance: 10,
  };
}

function issue(challengeConfig, nonce) {
  return sdk.issueStepUpProof({
    privateKey, kid: "main", identity: "user-1", configHash: CFG,
    challengeConfig, nonce, issuedAtSec: NOW, expiresAtSec: NOW + 600,
  });
}

test("20 slider configs (the lab render count) publish none of fixed, vertical, travel or the answer range", () => {
  const distributionKeys = ["fixed", "vertical", "travel", "answerMin", "answerMax", "tolerance", "answer"];
  for (let i = 0; i < 20; i++) {
    const config = sliderConfig(200 + i * 7);
    const token = issue(config, "nonce-" + i);
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    assert.deepEqual(Object.keys(payload), ["v", "sub", "cfg", "ch", "nonce", "iat", "exp"]);
    const values = Object.values(payload);
    for (const key of distributionKeys) assert.ok(!Object.keys(payload).includes(key), "distribution key published: " + key);
    for (const leaked of [config.fixed, config.vertical, config.travel, config.answerMin, config.answerMax, config.tolerance]) {
      assert.ok(!values.includes(leaked), "distribution value published: " + leaked);
    }
  }
});

test("the width of the answer distribution is not measurable from the public payload size", () => {
  const narrow = issue(sliderConfig(248), "nonce-a"); // answer range width 248 - 86 = 162
  const wide = issue({ type: "slider", answerMin: 0, answerMax: 100000, tolerance: 1 }, "nonce-a");
  assert.equal(narrow.split(".")[1].length, wide.split(".")[1].length);
  assert.equal(sdk.stepUpChallengeHash(sliderConfig(248)).length, 64);
});

test("step-up 402 headers, body and manifest publish no answer-distribution parameters", () => {
  const responder = sdk.createStepUp402Responder({
    priceUsd: 0.001,
    manifestUrl: "https://example.test/manifest",
    facilitator: "facilitator-1",
    payUrl: "https://example.test/pay",
    appealUrl: "https://example.test/appeal",
    continueFreeUrl: "https://example.test/continue",
  });
  const response = responder.respond("sess-1", "tok-a");
  assert.deepEqual(Object.keys(response.headers), ["X-Payment-Required", "X-X402-Manifest"]);
  const surfaces = [
    JSON.stringify(response.headers),
    response.body,
    JSON.stringify(responder.manifestDocument()),
  ].join(" ");
  for (const term of ["travel", "vertical", "fixed", "answer", "tolerance", "range"]) {
    assert.ok(!new RegExp(term, "i").test(surfaces.replace(/X-Payment-Required/g, "")), "distribution term on a public surface: " + term);
  }
});

test("changing the answer distribution server-side invalidates old proofs instead of publishing the new one", () => {
  const consumed = new Set();
  const verifier = sdk.createStepUpProofVerifier({
    keys: { main: publicKey },
    consumeNonce: (nonce) => {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  });
  const oldConfig = sliderConfig(248);
  const token = issue(oldConfig, "nonce-dist");
  const baseCtx = { identity: "user-1", expectedConfigHash: CFG, nowSec: NOW + 60 };
  // Host still runs the old distribution: the proof binds and accepts.
  assert.equal(
    verifier.verifyProof(token, { ...baseCtx, expectedChallengeHash: sdk.stepUpChallengeHash(oldConfig) }).outcome,
    "ACCEPT",
  );
  // Host narrows the distribution: the same proof no longer matches,
  // and the client learns nothing about the new range from the rejection.
  const rejected = verifier.verifyProof(issue(oldConfig, "nonce-dist-2"), {
    ...baseCtx, expectedChallengeHash: sdk.stepUpChallengeHash(sliderConfig(120)),
  });
  assert.deepEqual(rejected, { outcome: "REJECT", reason: "CHALLENGE_MISMATCH" });
});
