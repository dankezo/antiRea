"use strict";
// SLC-05 regression: createWebBotAuthVerifier().verify must return a
// structured verdict for a null/undefined/non-object request instead of
// throwing a TypeError from header access. Found by the 2.9.3 hygiene
// verification (HYGIENE2-VERIFY-2026-11-14.md): every token verifier
// already never throws on garbage tokens; this was the one adjacent gap.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const sdk = require("../dist/index.js");

test("web-bot-auth verify: null, undefined and non-object requests return no_signature_headers", async () => {
  const verifier = sdk.createWebBotAuthVerifier({ keys: { keys: [] } });
  for (const bad of [null, undefined, 42, "req", true]) {
    const verdict = await verifier.verify(bad);
    assert.equal(verdict.verified, false);
    assert.equal(verdict.reason, "no_signature_headers");
  }
});

test("web-bot-auth verify: empty object request still returns no_signature_headers", async () => {
  const verifier = sdk.createWebBotAuthVerifier({ keys: { keys: [] } });
  const verdict = await verifier.verify({});
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, "no_signature_headers");
});
