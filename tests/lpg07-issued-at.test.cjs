"use strict";
// LPG-07 regression tests: the cursor, cursor-v2 and canary-echo
// verifiers reject tokens whose iat is in the future beyond the 60 s
// clock skew, and treat a non-numeric iat as malformed. Before the fix
// all three verified only exp, so a server-signed token with
// iat = now + 3600 s verified. Registration + probe:
// antirea-study-2026-11-01/overnight-2026-11-02/rem293-lab/REGISTRATION-LPG07-2026-11-14.md
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const sdk = require("../dist/index.js");

const T0 = 1_700_000_000_000;
const SECRET = "lpg07-test-secret";

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function handCraft(payloadObj, prefix) {
  const part = b64url(Buffer.from(JSON.stringify(payloadObj), "utf8"));
  const sig = crypto.createHmac("sha256", SECRET).update(part).digest();
  return (prefix || "") + part + "." + b64url(sig);
}

test("cursor: future iat beyond skew is not_yet_valid, inside skew verifies", () => {
  const future = sdk.mintCursor(SECRET, { sessionId: "s1", position: 5, now: T0 + 3_600_000, ttlMs: 300_000 });
  assert.deepEqual(sdk.verifyCursor(SECRET, future, { sessionId: "s1", now: T0 }), { ok: false, reason: "not_yet_valid" });
  const edge = sdk.mintCursor(SECRET, { sessionId: "s1", position: 5, now: T0 + 61_000, ttlMs: 300_000 });
  assert.deepEqual(sdk.verifyCursor(SECRET, edge, { sessionId: "s1", now: T0 }), { ok: false, reason: "not_yet_valid" });
  const inside = sdk.mintCursor(SECRET, { sessionId: "s1", position: 5, now: T0 + 30_000, ttlMs: 300_000 });
  assert.equal(sdk.verifyCursor(SECRET, inside, { sessionId: "s1", now: T0 }).ok, true);
  const bad = handCraft({ v: 1, sid: "s1", pos: 5, iat: "soon", exp: T0 + 300_000 });
  assert.deepEqual(sdk.verifyCursor(SECRET, bad, { sessionId: "s1", now: T0 }), { ok: false, reason: "malformed" });
});

test("cursor-v2: future iat beyond skew is not_yet_valid, inside skew verifies", () => {
  const auth = { sequence: 7, ledgerVersion: 3 };
  const mint = (now) => sdk.mintCursorV2(SECRET, { subject: "u1", scope: "records", position: 5, authority: auth, now, ttlMs: 300_000 });
  const verify = (tok) => sdk.verifyCursorV2(SECRET, tok, { subject: "u1", scope: "records", authority: auth, now: T0 });
  assert.deepEqual(verify(mint(T0 + 3_600_000)), { ok: false, reason: "not_yet_valid" });
  assert.deepEqual(verify(mint(T0 + 61_000)), { ok: false, reason: "not_yet_valid" });
  assert.equal(verify(mint(T0 + 30_000)).ok, true);
  const bad = handCraft({ v: 2, sub: "u1", scope: "records", pos: 5, seq: 7, lv: 3, iat: "soon", exp: T0 + 300_000 });
  assert.deepEqual(verify(bad), { ok: false, reason: "malformed" });
});

test("canary-echo: future iat beyond skew is not_yet_valid, inside skew verifies", () => {
  const mint = (now) => sdk.mintEchoId(SECRET, { mintedFor: "u1", scope: "records", now, ttlMs: 300_000 });
  const verify = (id) => sdk.verifyEchoId(SECRET, id, { now: T0, expectedScope: "records" });
  assert.deepEqual(verify(mint(T0 + 3_600_000)), { ok: false, reason: "not_yet_valid" });
  assert.deepEqual(verify(mint(T0 + 61_000)), { ok: false, reason: "not_yet_valid" });
  assert.equal(verify(mint(T0 + 30_000)).ok, true);
  const bad = handCraft({ v: 1, f: "u1", s: "records", n: "nonce123", iat: "soon", exp: T0 + 300_000 }, "echo_");
  assert.deepEqual(verify(bad), { ok: false, reason: "malformed" });
});
