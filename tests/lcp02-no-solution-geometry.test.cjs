"use strict";
// LCP-02 - never publish solution geometry in the client payload.
//
// Lab record (port-measured logic verdict, no PHP runtime was
// available; RESULTS-LCP-STEP0.md, cycle C578): in the dissected
// third-party CAPTCHA library the public payload carried the focus
// windows, and 120/120 focus windows contained the solution glyph
// centre within the 7 px bound (observed maximum offset 2 px, the
// effective jitter after the fit formula). Reading the public
// payload was enough to locate the solution.
//
// antiRea conformance rule, applied to its own client-bound payload
// construction in the step-up surfaces: a challenge configuration
// that contains solution geometry may influence a client payload
// only through a fixed-length one-way hash. The raw geometry - keys,
// coordinates, window bounds - must appear nowhere in the token the
// client receives, and the step-up 402 surfaces must carry no
// geometry fields at all.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const sdk = require("../dist/index.js");

const { privateKey } = generateKeyPairSync("ed25519");
const CFG = "b".repeat(64);
const NOW = 1_700_000_000;

function issue(challengeConfig, nonce) {
  return sdk.issueStepUpProof({
    privateKey, kid: "main", identity: "user-1", configHash: CFG,
    challengeConfig, nonce, issuedAtSec: NOW, expiresAtSec: NOW + 600,
  });
}

function payloadJson(token) {
  return Buffer.from(token.split(".")[1], "base64url").toString("utf8");
}

test("120 focus windows (the lab count) contribute no geometry to any issued payload", () => {
  let windowsChecked = 0;
  for (let sheet = 0; sheet < 20; sheet++) {
    const windows = [];
    for (let w = 0; w < 6; w++) {
      windows.push({ x: 1000 + sheet * 37 + w * 11, y: 2000 + sheet * 53 + w * 7, width: 56, height: 56 });
    }
    const config = { type: "scatter", focusWindows: windows, solutionCentre: { x: windows[2].x, y: windows[2].y } };
    const token = issue(config, "nonce-" + sheet);
    const payload = JSON.parse(payloadJson(token));
    assert.deepEqual(Object.keys(payload), ["v", "sub", "cfg", "ch", "nonce", "iat", "exp"]);
    // A leak means a geometry value present as a payload value, or a
    // geometry key present at all. (A digit run inside the hex hash
    // is not a leak: the hash is fixed-length hex whatever the
    // geometry is, which is exactly the LCP-01 size pin.)
    const values = Object.values(payload);
    for (const win of windows) {
      windowsChecked++;
      assert.ok(!values.includes(win.x), "window x leaked: " + win.x);
      assert.ok(!values.includes(win.y), "window y leaked: " + win.y);
      assert.ok(!values.includes(win.width) && !values.includes(win.height), "window size leaked");
    }
    for (const key of Object.keys(payload)) {
      assert.ok(!/focus|window|centre|center|solution/i.test(key), "geometry key leaked: " + key);
    }
  }
  assert.equal(windowsChecked, 120);
});

test("solution geometry changes the binding hash but publishes only hex of a fixed length", () => {
  const a = sdk.stepUpChallengeHash({ focusWindows: [{ x: 1111, y: 2222 }] });
  const b = sdk.stepUpChallengeHash({ focusWindows: [{ x: 3333, y: 4444 }] });
  assert.notEqual(a, b, "different geometry must bind differently server-side");
  for (const h of [a, b]) {
    assert.match(h, /^[0-9a-f]{64}$/);
  }
});

test("step-up 402 response and manifest carry no geometry fields or values", () => {
  const responder = sdk.createStepUp402Responder({
    priceUsd: 0.001,
    manifestUrl: "https://example.test/manifest",
    facilitator: "facilitator-1",
    payUrl: "https://example.test/pay",
    appealUrl: "https://example.test/appeal",
    continueFreeUrl: "https://example.test/continue",
  });
  const body = JSON.parse(responder.respond("sess-1", "tok-a").body);
  const manifest = responder.manifestDocument();
  const allKeys = [...Object.keys(body), ...Object.keys(body.next_steps), ...Object.keys(manifest), ...Object.keys(manifest.next_steps)];
  for (const key of allKeys) {
    assert.ok(!/focus|window|centre|center|coord|position|geometry|^x$|^y$/i.test(key), "geometry field present: " + key);
  }
  const serialized = JSON.stringify(body) + JSON.stringify(manifest);
  assert.ok(!/focus|window|centre|center|coordinate|geometry/i.test(serialized));
});

test("a payload tampered to add solution geometry fails signature verification", () => {
  const pair = generateKeyPairSync("ed25519");
  const token = sdk.issueStepUpProof({
    privateKey: pair.privateKey, kid: "main", identity: "user-1", configHash: CFG,
    challengeConfig: { type: "scatter" }, nonce: "nonce-geo", issuedAtSec: NOW, expiresAtSec: NOW + 600,
  });
  const verifier = sdk.createStepUpProofVerifier({ keys: { main: pair.publicKey }, consumeNonce: () => true });
  const ctx = {
    identity: "user-1", expectedConfigHash: CFG,
    expectedChallengeHash: sdk.stepUpChallengeHash({ type: "scatter" }), nowSec: NOW + 60,
  };
  assert.equal(verifier.verifyProof(token, ctx).outcome, "ACCEPT");
  const [h, p, s] = token.split(".");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  payload.focusWindow = { x: 1111, y: 2222 };
  const tampered = h + "." + Buffer.from(JSON.stringify(payload)).toString("base64url") + "." + s;
  assert.deepEqual(verifier.verifyProof(tampered, ctx), { outcome: "REJECT", reason: "BAD_SIGNATURE" });
});
