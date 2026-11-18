"use strict";
// LCP-03 - challenge assets need per-issue randomness.
//
// Lab record (port-measured logic verdict, no PHP runtime was
// available; RESULTS-LCP-STEP0.md, cycle C578): in the dissected
// third-party CAPTCHA library, rendering was deterministic - the
// rotate challenge rendered byte-identically twice and produced
// 70/70 distinct hashes only across different images and angles,
// the tiles crop rendered byte-identically, and the slider config
// block carried no noise key at all. A solver could precompute or
// replay rendered material.
//
// Audit of antiRea's own issuance surfaces, and what this file pins:
// - canary-echo minting already draws 128 bits of randomness per
//   mint inside the SDK (randomBytes in canary-echo.ts).
// - step-up proof issuance was the deterministic path: the shape
//   requires a host-supplied nonce and Ed25519 signing is
//   deterministic, so identical inputs gave a byte-identical token.
//   Single-use nonce consumption bounded the damage (a re-issued
//   identical token can still be consumed only once), but per-issue
//   randomness depended entirely on host discipline. LCP-03 adds
//   generateStepUpNonce, the SDK-side per-issue draw, and pins all
//   three properties below.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const sdk = require("../dist/index.js");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const CFG = "b".repeat(64);
const CHALLENGE = { type: "captcha", difficulty: 3 };
const NOW = 1_700_000_000;

function issue(nonce) {
  return sdk.issueStepUpProof({
    privateKey, kid: "main", identity: "user-1", configHash: CFG,
    challengeConfig: CHALLENGE, nonce, issuedAtSec: NOW, expiresAtSec: NOW + 600,
  });
}

test("generateStepUpNonce draws a fresh value per call: 70/70 distinct (the lab distinct count)", () => {
  const nonces = new Set();
  for (let i = 0; i < 70; i++) {
    const nonce = sdk.generateStepUpNonce();
    assert.equal(typeof nonce, "string");
    assert.ok(nonce.length >= 20, "128-bit base64url nonce expected, got length " + nonce.length);
    assert.match(nonce, /^[A-Za-z0-9_-]+$/);
    nonces.add(nonce);
  }
  assert.equal(nonces.size, 70);
});

test("proofs issued with per-issue nonces are distinct even when every other input is identical", () => {
  const tokens = new Set();
  for (let i = 0; i < 70; i++) tokens.add(issue(sdk.generateStepUpNonce()));
  assert.equal(tokens.size, 70);
});

test("the deterministic re-issue path is bounded by single-use: an identical token verifies only once", () => {
  const consumed = new Set();
  const verifier = sdk.createStepUpProofVerifier({
    keys: { main: publicKey },
    consumeNonce: (nonce) => {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  });
  const ctx = {
    identity: "user-1", expectedConfigHash: CFG,
    expectedChallengeHash: sdk.stepUpChallengeHash(CHALLENGE), nowSec: NOW + 60,
  };
  const a = issue("fixed-nonce");
  const b = issue("fixed-nonce");
  assert.equal(a, b, "same inputs sign byte-identically - this is the path the nonce draw exists to avoid");
  assert.equal(verifier.verifyProof(a, ctx).outcome, "ACCEPT");
  assert.deepEqual(verifier.verifyProof(b, ctx), { outcome: "REJECT", reason: "REPLAY" });
});

test("issuance refuses an empty nonce, so a no-randomness issue cannot be minted silently", () => {
  assert.throws(() => issue(""), sdk.StepUpProofError);
  assert.throws(() => issue(undefined), sdk.StepUpProofError);
});

test("canary-echo minting (the other SDK issuance surface) draws per-mint randomness: 70/70 distinct ids", () => {
  const ids = new Set();
  for (let i = 0; i < 70; i++) {
    ids.add(sdk.mintEchoId("test-secret", { mintedFor: "user-1", now: NOW * 1000 }));
  }
  assert.equal(ids.size, 70);
  // The distinct part is the nonce claim inside the signed payload.
  const nonces = [...ids].map((id) => {
    const body = id.slice(sdk.ECHO_ID_PREFIX.length).split(".")[0];
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")).n;
  });
  assert.equal(new Set(nonces).size, 70);
});
