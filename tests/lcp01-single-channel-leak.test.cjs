"use strict";
// LCP-01 - challenge rendering must not leak the answer in any single
// measurable channel.
//
// Lab record (port-measured logic verdict, no PHP runtime was
// available; RESULTS-LCP-STEP0.md, cycle C578): in the dissected
// third-party CAPTCHA library the solution glyphs were rendered at
// scale 3 while decoys were rendered at scale 1 or 2, so ranking
// glyphs by rendered tile area alone recovered the solution set on
// 20/20 sheets, with a minimum margin of 63 px^2, and no OCR.
//
// antiRea ships no CAPTCHA renderer. Its own step-up surfaces are
// the step-up proof token (step-up-proof.ts) and the step-up 402
// response (step-up-402.ts). The conformance rule ported here is:
// nothing a client can measure about one issued proof or one 402
// response - field set, field sizes, total payload size - may vary
// with the host's challenge configuration in a way that ranks or
// identifies the solution. The proof meets this by construction:
// the challenge config enters the token only as a fixed-length
// SHA-256 hash (the `ch` claim), never as rendered material.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const sdk = require("../dist/index.js");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const CFG = "b".repeat(64);
const NOW = 1_700_000_000;

function issue(challengeConfig, nonce) {
  return sdk.issueStepUpProof({
    privateKey, kid: "main", identity: "user-1", configHash: CFG,
    challengeConfig, nonce, issuedAtSec: NOW, expiresAtSec: NOW + 600,
  });
}

function decodePayload(token) {
  const parts = token.split(".");
  return {
    header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    payloadSegmentLength: parts[1].length,
    signatureSegmentLength: parts[2].length,
  };
}

test("proof payload field set and field sizes are fixed whatever the challenge config contains", () => {
  const configs = [
    { type: "scatter", solutionGlyphScale: 3, decoyGlyphScale: 1 },
    { type: "scatter", solutionGlyphScale: 3, decoyGlyphScale: 2 },
    { type: "scatter", solutionAreaPx2: 63, decoys: 32, shapes: 12, dots: 55 },
    { type: "scatter", solutionGlyphScale: 9999, decoyGlyphScale: 8888, note: "x".repeat(500) },
  ];
  const seen = configs.map((c, i) => decodePayload(issue(c, "nonce-" + i)));
  for (const s of seen) {
    assert.deepEqual(Object.keys(s.payload), ["v", "sub", "cfg", "ch", "nonce", "iat", "exp"]);
    assert.equal(typeof s.payload.ch, "string");
    assert.equal(s.payload.ch.length, 64);
    assert.equal(s.signatureSegmentLength, seen[0].signatureSegmentLength);
  }
  // The one channel the lab attack used - a measurable size - is
  // identical for every config once identity and nonce lengths are
  // held equal, so size ranking ties every candidate.
  const lengths = new Set(seen.map((s) => s.payloadSegmentLength));
  assert.equal(lengths.size, 1);
});

test("size ranking over 20 issued proofs (the lab sheet count) selects nothing", () => {
  // Mirror the lab shape: 20 challenges whose configs differ in the
  // solution scale and in the margin value. If payload size tracked
  // the solution, the top-ranked tokens would be the solutions.
  const lengths = [];
  for (let sheet = 0; sheet < 20; sheet++) {
    const token = issue(
      { type: "scatter", sheet, solutionGlyphScale: 3, decoyGlyphScale: (sheet % 2) + 1, marginPx2: 63 + sheet },
      "nonce-x",
    );
    lengths.push(decodePayload(token).payloadSegmentLength);
  }
  assert.equal(new Set(lengths).size, 1, "all 20 payload sizes tie; no top-6 subset exists");
});

test("no proof payload field carries a solution, scale or area value from the challenge config", () => {
  const { payload } = decodePayload(issue({ solutionGlyphScale: 3, solutionAreaPx2: 12345, answer: "ABCDEF" }, "nonce-9"));
  const values = Object.values(payload).map(String);
  for (const leaked of ["3", "12345", "ABCDEF", "solutionGlyphScale", "solutionAreaPx2", "answer"]) {
    assert.ok(!Object.keys(payload).includes(leaked), "key leaked: " + leaked);
    assert.ok(!values.includes(leaked), "value leaked: " + leaked);
  }
});

test("step-up 402 body and manifest field sets are fixed across sessions and prices", () => {
  const base = {
    priceUsd: 0.001,
    manifestUrl: "https://example.test/manifest",
    facilitator: "facilitator-1",
    payUrl: "https://example.test/pay",
    appealUrl: "https://example.test/appeal",
    continueFreeUrl: "https://example.test/continue",
  };
  const r1 = sdk.createStepUp402Responder(base);
  const r2 = sdk.createStepUp402Responder({ ...base, priceUsd: 999 });
  const keys1 = Object.keys(JSON.parse(r1.respond("sess-1", "tok-a").body));
  const keys2 = Object.keys(JSON.parse(r2.respond("sess-2", "tok-b").body));
  assert.deepEqual(keys1, keys2);
  assert.deepEqual(keys1, ["error", "price_usd", "manifest", "facilitator", "session", "pay_token_hint", "next_steps"]);
  assert.deepEqual(
    Object.keys(r1.manifestDocument()),
    ["error", "price_usd", "currency", "manifest", "facilitator", "settlement", "note", "next_steps"],
  );
  // No field name on either public surface names a challenge solution channel.
  for (const key of [...keys1, ...Object.keys(r1.manifestDocument())]) {
    assert.ok(!/solution|glyph|scale|area|answer/i.test(key), "solution-shaped field: " + key);
  }
});
