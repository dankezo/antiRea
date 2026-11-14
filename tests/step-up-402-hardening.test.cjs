"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStepUp402Responder, checkAssertion, manifestDocument } = require("../dist/index.js");
const options = { priceUsd: 0.001, manifestUrl: "https://lab.invalid/x402/manifest/v2", facilitator: "lab-stub-facilitator-v1", payUrl: "https://lab.invalid/pay", appealUrl: "https://lab.invalid/appeal", continueFreeUrl: "https://lab.invalid/continue-free" };
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

test("402 assertion preserves exact UTF-16 identity including lone surrogates", () => {
  const random = rng(202911402);
  const responder = createStepUp402Responder(options);
  for (let i = 0; i < 1000; i++) {
    let token = "";
    for (let j = 0; j < 1 + i % 32; j++) token += String.fromCharCode(Math.floor(random() * 65536));
    assert.equal(checkAssertion(token, token), true);
    assert.equal(responder.checkAssertion(token, token), true);
    const p = Math.floor(random() * token.length);
    const changed = token.slice(0, p) + String.fromCharCode((token.charCodeAt(p) + 1) % 65536) + token.slice(p + 1);
    assert.equal(checkAssertion(changed, token), false);
    assert.equal(checkAssertion(token + "\u0000", token), false);
    assert.equal(checkAssertion(token.slice(1), token), false);
  }
  for (const [a, b] of [["\ud800", "\ud801"], ["\ud800", "\ufffd"], ["a\ud800b", "a\ud801b"], ["\udc00", "\udfff"], ["\ud800\ud800", "\ufffd\ufffd"], ["é", "e\u0301"]]) assert.equal(checkAssertion(a, b), false);
});

test("402 assertion has bounded allocations and rejects missing tokens", () => {
  assert.equal(checkAssertion("x".repeat(4096), "x".repeat(4096)), true);
  assert.equal(checkAssertion("x".repeat(4097), "x".repeat(4097)), false);
  assert.equal(checkAssertion("", ""), false);
  for (const bad of [null, undefined, 1, true, {}, [], new String("x")]) {
    assert.equal(checkAssertion(bad, "x"), false); assert.equal(checkAssertion("x", bad), false);
  }
});

test("402 next-step URLs roundtrip hostile sessions and preserve configured query/fragment", () => {
  const sessions = ["a&admin=true#fragment", "__proto__", "a b?c=d", "Tiếng Việt", "😀", "x".repeat(1024)];
  for (const withQuery of [false, true]) {
    const suffix = withQuery ? "?plan=free#help" : "";
    const responder = createStepUp402Responder({ ...options, payUrl: options.payUrl + suffix, appealUrl: options.appealUrl + suffix, continueFreeUrl: options.continueFreeUrl + suffix });
    for (const session of sessions) {
      const parsed = JSON.parse(responder.respond(session, "token").body);
      assert.equal(parsed.session, session); assert.equal(parsed.pay_token_hint, "token");
      for (const [key, base] of [["pay", options.payUrl], ["appeal", options.appealUrl], ["continue_free", options.continueFreeUrl]]) {
        const url = new URL(parsed.next_steps[key]);
        assert.equal(url.searchParams.get("session"), session);
        assert.equal(url.origin + url.pathname, base);
        assert.equal(url.searchParams.get("plan"), withQuery ? "free" : null);
        assert.equal(url.hash, withQuery ? "#help" : "");
      }
    }
  }
});

test("402 response inputs are bounded and malformed Unicode sessions fail consistently", () => {
  const responder = createStepUp402Responder(options);
  for (const sid of ["", "x".repeat(1025), undefined, null, 1, {}]) assert.throws(() => responder.respond(sid, "token"), TypeError);
  for (const token of ["", "x".repeat(4097), undefined, null, 1, {}]) assert.throws(() => responder.respond("sid", token), TypeError);
  assert.doesNotThrow(() => responder.respond("x".repeat(1024), "x".repeat(4096)));
  for (const payUrl of [options.payUrl, options.payUrl + "?p=1#help"]) assert.throws(() => createStepUp402Responder({ ...options, payUrl }).respond("\ud800", "token"), URIError);
});

test("402 options reject header injection, oversized fields and unsafe URL schemes", () => {
  for (const field of ["manifestUrl", "facilitator", "payUrl", "appealUrl", "continueFreeUrl"]) {
    for (const value of ["", "x".repeat(4097), "https://a.test/\r\nx: injected", null, undefined, 1]) assert.throws(() => createStepUp402Responder({ ...options, [field]: value }), TypeError);
    if (field !== "facilitator") for (const value of ["javascript:alert(1)", "data:text/plain,a", "/relative", "ftp://lab.invalid/"]) assert.throws(() => manifestDocument({ ...options, [field]: value }), TypeError);
  }
  for (const priceUsd of [-1, NaN, Infinity, -Infinity, "0.1", null]) assert.throws(() => createStepUp402Responder({ ...options, priceUsd }), TypeError);
  assert.equal(manifestDocument({ ...options, priceUsd: 0 }).price_usd, 0);
  assert.equal(manifestDocument(options).settlement, "none");
  assert.equal(manifestDocument(options).currency, "USD");
  assert.equal(manifestDocument(options).error, "payment_required");
  const configured = { ...options }; const responder = createStepUp402Responder(configured); configured.priceUsd = 9; configured.payUrl = "https://bad.invalid/";
  assert.equal(JSON.parse(responder.respond("sid", "token").body).price_usd, options.priceUsd);
  assert.equal(JSON.parse(responder.respond("sid", "token").body).next_steps.pay, options.payUrl + "?session=sid");
});
