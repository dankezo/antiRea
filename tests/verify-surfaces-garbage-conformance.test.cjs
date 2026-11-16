"use strict";
// SLC-05-RV conformance (permanent promotion): every request-path
// verify surface rejects garbage input with a structured rejection
// and never throws, and no garbage input ever returns a success
// verdict. This test promotes the ephemeral SLC-05-RV probe
// (antirea-study-2026-11-01/overnight-2026-11-02/slc05rv-lab/
// slc05rv-probe.cjs; results.json sha256
// d8682df9e4dacb1f4788e889c052dca5ae734f58981f9224f8477a478aefd9f9)
// into a permanent Gate-0 regression, per BUILD-SPEC-3.0 Item 4.
// The RV run measured, on the shipped 2.9.3 dist: 146 gated calls,
// 0 throws, 0 success verdicts, 146 structured rejections
// (RV-G1..RV-G4 PASS; RESULTS-SLC05RV.md).
//
// The frozen 23-input garbage table below is lifted VERBATIM from
// slc05rv-probe.cjs: the original 18 HYGIENE2 inputs plus the 5
// frozen extensions (__proto__ keys, NUL bytes, 1 MB token,
// correctly-signed object-typed exp/iat, correctly-signed
// non-numeric iat), run across all 7 verify surfaces exactly as
// the probe does: verifyCursor, verifyCursorV2, verifyEchoId,
// resolveEchoFrom, verifyProof (step-up), checkAssertion
// (step-up-402), Web Bot Auth verify (its 8 request forms).
// Fixed secret and fixed clock T0 = 1,700,000,000,000 as in the
// probe.
//
// importDeclarationLog is deliberately OUT of this test: it has a
// documented throw contract and is a file-import API, not a
// request-path verifier. In the RV run it was fed as a control
// only (excluded from the gates) and threw on all 5 control
// inputs - DeclarationLogError x4, TypeError x1 (non-string
// input) - matching that contract (RESULTS-SLC05RV.md).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const sdk = require("../dist/index.js");

const T0 = 1_700_000_000_000;
const SECRET = "slc05rv-test-secret";
const ISSUED_ASSERTION = "slc05rv-issued-assertion-v1";

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function seg(text) { return b64url(Buffer.from(text, "utf8")); }
function handCraft(payloadObj) {
  const part = seg(JSON.stringify(payloadObj));
  const sig = crypto.createHmac("sha256", SECRET).update(part).digest();
  return part + "." + b64url(sig);
}

// The frozen input set (REGISTRATION-SLC05RV R1 + R2), lifted
// verbatim from slc05rv-probe.cjs. `make` rebuilds the value so
// every surface sees a fresh instance.
const INPUTS = [
  { id: "in01", label: "'!!!.abc' (HYGIENE2 negative control)", make: () => "!!!.abc" },
  { id: "in02", label: "empty string", make: () => "" },
  { id: "in03", label: "'a.b.c'", make: () => "a.b.c" },
  { id: "in04", label: "base64 non-JSON payload", make: () => seg("this is not json") + "." + seg("sig") },
  { id: "in05", label: "wrong-shape JSON payload", make: () => seg('{"x":1}') + "." + seg("sig") },
  { id: "in06", label: "JSON array payload", make: () => seg("[1,2,3]") + "." + seg("sig") },
  { id: "in07", label: "wrong field types payload", make: () => seg(JSON.stringify({ v: "one", sid: 42, pos: "five", iat: "soon", exp: "never" })) + "." + seg("sig") },
  { id: "in08", label: "9,000-char token", make: () => "A".repeat(9000) },
  { id: "in09", label: "null", make: () => null },
  { id: "in10", label: "undefined", make: () => undefined },
  { id: "in11", label: "number 42", make: () => 42 },
  { id: "in12", label: "object {}", make: () => ({}) },
  { id: "in13", label: "array []", make: () => [] },
  { id: "in14", label: "boolean true", make: () => true },
  { id: "in15", label: "'a' (1 segment)", make: () => "a" },
  { id: "in16", label: "'a.b' (2 segments)", make: () => "a.b" },
  { id: "in17", label: "'a.b.c.d' (4 segments)", make: () => "a.b.c.d" },
  { id: "in18", label: "'..' (empty segments)", make: () => ".." },
  { id: "ex1", label: "__proto__-shaped keys payload", make: () => seg('{"__proto__":{"polluted":"slc05rv"},"v":1,"sid":"s1","pos":5,"iat":1700000000000,"exp":1700000300000}') + "." + seg("sig") },
  { id: "ex2", label: "token containing NUL bytes", make: () => "abc\u0000def.ghi\u0000jkl" },
  { id: "ex3", label: "1 MB token", make: () => "A".repeat(1_000_000) },
  { id: "ex4", label: "exp/iat as objects, correctly signed", make: () => handCraft({ v: 1, sid: "s1", pos: 5, iat: { unix: 1700000000000 }, exp: { unix: 1700000300000 } }) },
  { id: "ex5", label: "non-numeric iat, correctly signed (LPG-07 malformed cell)", make: () => handCraft({ v: 1, sid: "s1", pos: 5, iat: "soon", exp: 1700000300000 }) },
];

const WBA_FORMS = [
  { id: "wba1", label: "null", make: () => null, nullClass: true },
  { id: "wba2", label: "undefined", make: () => undefined, nullClass: true },
  { id: "wba3", label: "42", make: () => 42, nullClass: true },
  { id: "wba4", label: "'req'", make: () => "req", nullClass: true },
  { id: "wba5", label: "true", make: () => true, nullClass: true },
  { id: "wba6", label: "{}", make: () => ({}), nullClass: true },
  { id: "wba7", label: "{ headers: null }", make: () => ({ headers: null }), nullClass: false },
  { id: "wba8", label: "{ headers: { signature: '!!!' } }", make: () => ({ headers: { signature: "!!!" } }), nullClass: false },
];

function fixedProofVerifier() {
  const seed = Buffer.alloc(32, 0x5a);
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  const seen = new Set();
  return sdk.createStepUpProofVerifier({
    keys: { main: publicKey },
    consumeNonce: (nonce) => { if (seen.has(nonce)) return false; seen.add(nonce); return true; },
  });
}

function proofCtx() {
  return {
    identity: "user-1",
    expectedConfigHash: "b".repeat(64),
    expectedChallengeHash: sdk.stepUpChallengeHash({ type: "captcha", difficulty: 3 }),
    nowSec: T0 / 1000,
  };
}

// Runs one call and returns its result; a throw fails the test
// with the surface + input named (RV-G1: never throws).
async function callNoThrow(surface, input, call) {
  try {
    return await call(input.make());
  } catch (err) {
    assert.fail(surface + " threw on " + input.id + " (" + input.label + "): " + (err && err.message));
  }
}

// Exact rejection reasons measured in the RV run (results.json
// sha256 d8682df9...), per surface and input id.
function expectedCursorReason(id) {
  return id === "ex1" ? "bad_signature" : "malformed";
}
const CURSOR_V2_UNEXPECTED_FIELDS = new Set(["in05", "in06", "in07", "ex1", "ex4", "ex5"]);
function expectedCursorV2Reason(id) {
  return CURSOR_V2_UNEXPECTED_FIELDS.has(id) ? "unexpected_fields" : "malformed";
}

test("verifyCursor: 23 garbage inputs - never throws, never ok:true, structured rejection with the RV-measured reason", async () => {
  for (const input of INPUTS) {
    const result = await callNoThrow("verifyCursor", input,
      (tok) => sdk.verifyCursor(SECRET, tok, { sessionId: "s1", now: T0 }));
    assert.equal(result && result.ok, false, "verifyCursor " + input.id + " must not return a success verdict");
    assert.equal(typeof (result && result.reason), "string", "verifyCursor " + input.id + " rejection must carry a string reason");
    assert.equal(result.reason, expectedCursorReason(input.id), "verifyCursor " + input.id + " reason");
  }
});

test("verifyCursorV2: 23 garbage inputs - never throws, never ok:true, structured rejection with the RV-measured reason", async () => {
  for (const input of INPUTS) {
    const result = await callNoThrow("verifyCursorV2", input,
      (tok) => sdk.verifyCursorV2(SECRET, tok, { subject: "u1", scope: "records", authority: { sequence: 7, ledgerVersion: 3 }, now: T0 }));
    assert.equal(result && result.ok, false, "verifyCursorV2 " + input.id + " must not return a success verdict");
    assert.equal(typeof (result && result.reason), "string", "verifyCursorV2 " + input.id + " rejection must carry a string reason");
    assert.equal(result.reason, expectedCursorV2Reason(input.id), "verifyCursorV2 " + input.id + " reason");
  }
});

test("verifyEchoId: 23 garbage inputs - never throws, never ok:true, structured rejection (malformed)", async () => {
  for (const input of INPUTS) {
    const result = await callNoThrow("verifyEchoId", input,
      (id) => sdk.verifyEchoId(SECRET, id, { now: T0, expectedScope: "records" }));
    assert.equal(result && result.ok, false, "verifyEchoId " + input.id + " must not return a success verdict");
    assert.equal(typeof (result && result.reason), "string", "verifyEchoId " + input.id + " rejection must carry a string reason");
    assert.equal(result.reason, "malformed", "verifyEchoId " + input.id + " reason");
  }
});

test("resolveEchoFrom: 23 garbage inputs - never throws, never resolves a string, always undefined", async () => {
  for (const input of INPUTS) {
    const result = await callNoThrow("resolveEchoFrom", input,
      (id) => sdk.resolveEchoFrom(SECRET, id, { now: T0 }));
    assert.equal(typeof result, "undefined", "resolveEchoFrom " + input.id + " must not resolve an echo string");
    assert.equal(result, undefined, "resolveEchoFrom " + input.id + " structured rejection is undefined");
  }
});

test("verifyProof (step-up): 23 garbage inputs - never throws, never ACCEPT, structured REJECT (MALFORMED)", async () => {
  const verifier = fixedProofVerifier();
  const ctx = proofCtx();
  for (const input of INPUTS) {
    const result = await callNoThrow("verifyProof", input,
      (tok) => verifier.verifyProof(tok, ctx));
    assert.equal(result && result.outcome, "REJECT", "verifyProof " + input.id + " must not ACCEPT");
    assert.equal(result.reason, "MALFORMED", "verifyProof " + input.id + " reason");
  }
});

test("checkAssertion (step-up-402): 23 garbage inputs - never throws, never true against the fixed host-issued assertion", async () => {
  for (const input of INPUTS) {
    const result = await callNoThrow("checkAssertion", input,
      (presented) => sdk.checkAssertion(presented, ISSUED_ASSERTION));
    assert.equal(result, false, "checkAssertion " + input.id + " must not return true");
  }
});

test("Web Bot Auth verify: 8 request forms - never throws, never verified:true, structured rejection", async () => {
  const wba = sdk.createWebBotAuthVerifier({ keys: { keys: [] } });
  for (const form of WBA_FORMS) {
    const result = await callNoThrow("webBotAuthVerify", form,
      (req) => wba.verify(req));
    assert.equal(result && result.verified, false, "webBotAuthVerify " + form.id + " must not return a success verdict");
    assert.equal(typeof (result && result.reason), "string", "webBotAuthVerify " + form.id + " rejection must carry a string reason");
  }
});

test("Web Bot Auth verify: null-class forms return no_signature_headers (RV-G3), and all 8 forms agree", async () => {
  const wba = sdk.createWebBotAuthVerifier({ keys: { keys: [] } });
  for (const form of WBA_FORMS) {
    const result = await callNoThrow("webBotAuthVerify", form,
      (req) => wba.verify(req));
    assert.equal(result.verified, false, "webBotAuthVerify " + form.id);
    assert.equal(result.reason, "no_signature_headers", "webBotAuthVerify " + form.id + " (" + form.label + ") reason");
  }
});

test("LPG-07 cross-check: correctly-signed non-numeric iat (ex5) and object-typed exp/iat (ex4) return malformed from verifyCursor", async () => {
  for (const id of ["ex5", "ex4"]) {
    const input = INPUTS.find((i) => i.id === id);
    const result = await callNoThrow("verifyCursor", input,
      (tok) => sdk.verifyCursor(SECRET, tok, { sessionId: "s1", now: T0 }));
    assert.deepEqual(result, { ok: false, reason: "malformed" }, "verifyCursor " + id);
  }
});

test("__proto__ input (ex1): bad_signature from verifyCursor and no prototype pollution", async () => {
  const input = INPUTS.find((i) => i.id === "ex1");
  const result = await callNoThrow("verifyCursor", input,
    (tok) => sdk.verifyCursor(SECRET, tok, { sessionId: "s1", now: T0 }));
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});
