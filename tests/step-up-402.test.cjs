"use strict";
// RECOMB-09 step-up 402 responder - tests pin the lab's frozen
// response shape byte-for-byte (status, both headers, body fields
// in lab order), the session query params on all three next
// steps, the assertion checker's accept/reject semantics, and
// responder purity. The lab numbers themselves (94% cooperative
// stop-or-assert, 0 legit dead-ends) are simulation results, not
// unit-test claims - what is tested here is that the shipped
// shaping matches the measured lab shaping exactly.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStepUp402Responder, manifestDocument, checkAssertion } = require("../dist/index.js");

const OPTIONS = {
  priceUsd: 0.001,
  manifestUrl: "https://example.test/x402/manifest/v2",
  facilitator: "test-facilitator-v1",
  payUrl: "https://example.test/pay",
  appealUrl: "https://example.test/appeal",
  continueFreeUrl: "https://example.test/continue-free",
};

test("respond returns status 402 and the exact lab header strings", () => {
  const responder = createStepUp402Responder(OPTIONS);
  const r = responder.respond("sess-1", "tok-abc");
  assert.equal(r.status, 402);
  assert.equal(r.headers["X-Payment-Required"], "price=0.001 USD; manifest=https://example.test/x402/manifest/v2");
  assert.equal(r.headers["X-X402-Manifest"], "https://example.test/x402/manifest/v2");
});

test("respond body is byte-for-byte the lab shape402 body", () => {
  const responder = createStepUp402Responder(OPTIONS);
  const r = responder.respond("sess-1", "tok-abc");
  const expected = JSON.stringify({
    error: "payment_required",
    price_usd: 0.001,
    manifest: "https://example.test/x402/manifest/v2",
    facilitator: "test-facilitator-v1",
    session: "sess-1",
    pay_token_hint: "tok-abc",
    next_steps: {
      pay: "https://example.test/pay?session=sess-1",
      appeal: "https://example.test/appeal?session=sess-1",
      continue_free: "https://example.test/continue-free?session=sess-1",
    },
  });
  assert.equal(r.body, expected);
  const parsed = JSON.parse(r.body);
  assert.deepEqual(Object.keys(parsed), ["error", "price_usd", "manifest", "facilitator", "session", "pay_token_hint", "next_steps"]);
  assert.deepEqual(Object.keys(parsed.next_steps), ["pay", "appeal", "continue_free"]);
});

test("session query params follow the session id on every next step", () => {
  const responder = createStepUp402Responder(OPTIONS);
  const parsed = JSON.parse(responder.respond("sess-xyz-42", "t").body);
  assert.equal(parsed.session, "sess-xyz-42");
  assert.equal(parsed.next_steps.pay, "https://example.test/pay?session=sess-xyz-42");
  assert.equal(parsed.next_steps.appeal, "https://example.test/appeal?session=sess-xyz-42");
  assert.equal(parsed.next_steps.continue_free, "https://example.test/continue-free?session=sess-xyz-42");
});

test("checkAssertion accepts exactly the issued token", () => {
  const responder = createStepUp402Responder(OPTIONS);
  assert.equal(responder.checkAssertion("pay-token-123", "pay-token-123"), true);
  assert.equal(checkAssertion("pay-token-123", "pay-token-123"), true);
});

test("checkAssertion rejects a wrong token of the same length", () => {
  const responder = createStepUp402Responder(OPTIONS);
  assert.equal(responder.checkAssertion("pay-token-124", "pay-token-123"), false);
  assert.equal(responder.checkAssertion("PAY-TOKEN-123", "pay-token-123"), false);
});

test("checkAssertion rejects different-length tokens", () => {
  const responder = createStepUp402Responder(OPTIONS);
  assert.equal(responder.checkAssertion("pay-token-12", "pay-token-123"), false);
  assert.equal(responder.checkAssertion("pay-token-1234", "pay-token-123"), false);
  assert.equal(responder.checkAssertion("", "pay-token-123"), false);
});

test("checkAssertion rejects non-string inputs on either side", () => {
  const responder = createStepUp402Responder(OPTIONS);
  for (const bad of [undefined, null, 123, true, {}, [], ["pay-token-123"]]) {
    assert.equal(responder.checkAssertion(bad, "pay-token-123"), false);
    assert.equal(responder.checkAssertion("pay-token-123", bad), false);
    assert.equal(responder.checkAssertion(bad, bad), false);
  }
});

test("respond is pure: same input, same output, no shared state", () => {
  const responder = createStepUp402Responder(OPTIONS);
  const a = responder.respond("sess-9", "tok-9");
  const b = responder.respond("sess-9", "tok-9");
  assert.equal(a.body, b.body);
  assert.deepEqual(a.headers, b.headers);
  a.headers["X-X402-Manifest"] = "https://evil.test/";
  const c = responder.respond("sess-9", "tok-9");
  assert.equal(c.headers["X-X402-Manifest"], "https://example.test/x402/manifest/v2");
  assert.equal(c.body, b.body);
});

test("manifestDocument returns the parsed manifest with settlement none", () => {
  const doc = manifestDocument(OPTIONS);
  assert.equal(doc.error, "payment_required");
  assert.equal(doc.price_usd, 0.001);
  assert.equal(doc.currency, "USD");
  assert.equal(doc.manifest, "https://example.test/x402/manifest/v2");
  assert.equal(doc.facilitator, "test-facilitator-v1");
  assert.equal(doc.settlement, "none");
  assert.deepEqual(doc.next_steps, {
    pay: "https://example.test/pay",
    appeal: "https://example.test/appeal",
    continue_free: "https://example.test/continue-free",
  });
  const responder = createStepUp402Responder(OPTIONS);
  assert.deepEqual(responder.manifestDocument(), doc);
});

test("factory rejects malformed options", () => {
  assert.throws(() => createStepUp402Responder(), TypeError);
  assert.throws(() => createStepUp402Responder({ ...OPTIONS, priceUsd: Number.NaN }), TypeError);
  assert.throws(() => createStepUp402Responder({ ...OPTIONS, priceUsd: -1 }), TypeError);
  assert.throws(() => createStepUp402Responder({ ...OPTIONS, manifestUrl: "" }), TypeError);
  assert.throws(() => manifestDocument({ ...OPTIONS, payUrl: 42 }), TypeError);
});
