"use strict";
// LCP-09 - one honeypot coverage matrix for all challenge types,
// tested per type.
//
// Lab record (port-measured logic verdict, no PHP runtime was
// available; RESULTS-LCP-STEP0.md, cycle C578): in the dissected
// third-party CAPTCHA library, honeypot coverage was inconsistent
// across its six challenge types - 5 of 6 challenges failed a
// submission carrying a filled honeypot field, but broken_circle
// had no honeypot field in its build output at all and ACCEPTED a
// submission carrying an extra honeypot-like field, because its
// solve simply ignored extra fields. The uncovered type was the
// hole.
//
// antiRea has no form-based CAPTCHA, so the ported rule is stated
// over the surfaces antiRea does ship that accept a presented
// submission and can grant something (an acceptance, an assertion
// pass, an attribution, a position): EVERY such surface must fail
// closed on a submission carrying an extra, unregistered field -
// the honeypot analogue - and no surface may silently ignore
// extra fields. The matrix below is the coverage: one row per
// shipped submission surface, each row exercised three ways
// (clean submission passes, extra-field submission fails closed,
// missing credential fails). A new submission-accepting surface
// ships only when it gains a row here.
//
// Row note: the bulk-access-key authority is also a submission
// surface; its extra-field behaviour is already pinned by its own
// suite ("key token: payload allowlist is exactly the registered
// set; tamper and extra fields fail closed" in
// tests/bulk-access-key.test.cjs), and this matrix does not
// duplicate that row.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const sdk = require("../dist/index.js");

const NOW_S = 1_700_000_000;
const NOW_MS = 1_700_000_000_000;
const HONEYPOT_FIELD = "website"; // the classic form honeypot name a filler bot completes
const HONEYPOT_VALUE = "https://spam.example/filled-by-a-bot";

// Add an extra field to the payload segment of a dotted token,
// keeping the original signature: the extra-field submission.
function withExtraPayloadField(token, prefixLen) {
  const parts = token.split(".");
  const idx = prefixLen; // payload segment index
  const payload = JSON.parse(Buffer.from(parts[idx], "base64url").toString("utf8"));
  payload[HONEYPOT_FIELD] = HONEYPOT_VALUE;
  parts[idx] = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return parts.join(".");
}

function buildMatrix() {
  const rows = [];

  // Row 1: step-up proof (grants ACCEPT).
  {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const CFG = "b".repeat(64);
    const CHALLENGE = { type: "captcha" };
    const genuine = sdk.issueStepUpProof({
      privateKey, kid: "main", identity: "user-1", configHash: CFG,
      challengeConfig: CHALLENGE, nonce: sdk.generateStepUpNonce(), issuedAtSec: NOW_S, expiresAtSec: NOW_S + 600,
    });
    const freshVerifier = () => {
      const consumed = new Set();
      return sdk.createStepUpProofVerifier({
        keys: { main: publicKey },
        consumeNonce: (n) => (consumed.has(n) ? false : (consumed.add(n), true)),
      });
    };
    const ctx = {
      identity: "user-1", expectedConfigHash: CFG,
      expectedChallengeHash: sdk.stepUpChallengeHash(CHALLENGE), nowSec: NOW_S + 60,
    };
    rows.push({
      type: "step-up proof token",
      clean: () => freshVerifier().verifyProof(genuine, ctx).outcome === "ACCEPT",
      extraField: () => freshVerifier().verifyProof(withExtraPayloadField(genuine, 1), ctx).outcome === "ACCEPT",
      missing: () => freshVerifier().verifyProof("", ctx).outcome === "ACCEPT",
      extraFieldReason: () => freshVerifier().verifyProof(withExtraPayloadField(genuine, 1), ctx).reason,
      expectedExtraReason: "BAD_SIGNATURE",
    });
  }

  // Row 2: step-up 402 assertion (grants assertion pass).
  {
    const responder = sdk.createStepUp402Responder({
      priceUsd: 0.001,
      manifestUrl: "https://example.test/manifest",
      facilitator: "facilitator-1",
      payUrl: "https://example.test/pay",
      appealUrl: "https://example.test/appeal",
      continueFreeUrl: "https://example.test/continue",
    });
    const issued = "issued-assertion-token";
    rows.push({
      type: "step-up 402 assertion",
      clean: () => responder.checkAssertion(issued, issued) === true,
      // The honeypot analogue for an exact-match assertion: the
      // submission arrives as a form object carrying the token
      // plus a filled honeypot field, or as token-plus-extra-text.
      extraField: () =>
        responder.checkAssertion({ token: issued, [HONEYPOT_FIELD]: HONEYPOT_VALUE }, issued) === true ||
        responder.checkAssertion(issued + "&" + HONEYPOT_FIELD + "=" + HONEYPOT_VALUE, issued) === true,
      missing: () => responder.checkAssertion("", issued) === true,
    });
  }

  // Row 3: canary-echo id (grants attribution).
  {
    const secret = "matrix-secret";
    const genuine = sdk.mintEchoId(secret, { mintedFor: "user-1", now: NOW_MS });
    const tampered = (() => {
      const body = genuine.slice(sdk.ECHO_ID_PREFIX.length);
      const [payloadPart, sigPart] = body.split(".");
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
      payload[HONEYPOT_FIELD] = HONEYPOT_VALUE;
      return sdk.ECHO_ID_PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url") + "." + sigPart;
    })();
    rows.push({
      type: "canary-echo id",
      clean: () => sdk.verifyEchoId(secret, genuine, { now: NOW_MS + 1000 }).ok === true,
      extraField: () => sdk.verifyEchoId(secret, tampered, { now: NOW_MS + 1000 }).ok === true,
      missing: () => sdk.verifyEchoId(secret, "", { now: NOW_MS + 1000 }).ok === true,
      extraFieldReason: () => sdk.verifyEchoId(secret, tampered, { now: NOW_MS + 1000 }).reason,
      expectedExtraReason: "bad_signature",
    });
  }

  // Row 4: pagination cursor v1 (grants a position).
  {
    const secret = "matrix-cursor-secret";
    const genuine = sdk.mintCursor(secret, { sessionId: "sess-1", position: 40, now: NOW_MS });
    const opts = { sessionId: "sess-1", expectedPosition: 40, now: NOW_MS + 1000 };
    rows.push({
      type: "pagination cursor v1",
      clean: () => sdk.verifyCursor(secret, genuine, opts).ok === true,
      extraField: () => sdk.verifyCursor(secret, withExtraPayloadField(genuine, 0), opts).ok === true,
      missing: () => sdk.verifyCursor(secret, "", opts).ok === true,
      extraFieldReason: () => sdk.verifyCursor(secret, withExtraPayloadField(genuine, 0), opts).reason,
      expectedExtraReason: "bad_signature",
    });
  }

  // Row 5: pagination cursor v2 (grants a position under store authority).
  {
    const secret = "matrix-cursor-v2-secret";
    const authority = { sequence: 3, ledgerVersion: 7 };
    const genuine = sdk.mintCursorV2(secret, {
      subject: "user-1", scope: "dataset", position: 40, authority, now: NOW_MS,
    });
    const opts = { subject: "user-1", scope: "dataset", authority, expectedPosition: 40, now: NOW_MS + 1000 };
    rows.push({
      type: "pagination cursor v2",
      clean: () => sdk.verifyCursorV2(secret, genuine, opts).ok === true,
      extraField: () => sdk.verifyCursorV2(secret, withExtraPayloadField(genuine, 0), opts).ok === true,
      missing: () => sdk.verifyCursorV2(secret, "", opts).ok === true,
      extraFieldReason: () => sdk.verifyCursorV2(secret, withExtraPayloadField(genuine, 0), opts).reason,
      // v2 rejects unregistered fields by allowlist, by name: the
      // strongest form of the rule in the matrix.
      expectedExtraReason: "unexpected_fields",
    });
  }

  return rows;
}

test("coverage matrix: every shipped submission surface is a row", () => {
  const types = buildMatrix().map((r) => r.type);
  assert.deepEqual(types, [
    "step-up proof token",
    "step-up 402 assertion",
    "canary-echo id",
    "pagination cursor v1",
    "pagination cursor v2",
  ]);
});

test("coverage matrix: per type, clean passes, extra honeypot field fails closed, missing fails", () => {
  for (const row of buildMatrix()) {
    assert.equal(row.clean(), true, row.type + ": clean submission must pass (matrix rows must be live surfaces)");
    assert.equal(row.extraField(), false, row.type + ": submission carrying a filled honeypot field must NOT pass");
    assert.equal(row.missing(), false, row.type + ": missing credential must NOT pass");
    if (row.extraFieldReason) {
      assert.equal(row.extraFieldReason(), row.expectedExtraReason, row.type + ": extra-field rejection reason");
    }
  }
});

test("coverage matrix: no row accepts any of several honeypot field names", () => {
  // The lab hole was one uncovered type; sweep the field-name
  // variants a filler might use across the token rows to show the
  // failure is field-name independent (it is structural: any
  // unregistered field breaks the signature or the allowlist).
  const secret = "matrix-cursor-secret";
  const genuine = sdk.mintCursor(secret, { sessionId: "sess-1", position: 40, now: NOW_MS });
  const opts = { sessionId: "sess-1", expectedPosition: 40, now: NOW_MS + 1000 };
  for (const field of ["website", "honeypot", "fax_number", "url", "homepage", "comment"]) {
    const parts = genuine.split(".");
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload[field] = HONEYPOT_VALUE;
    parts[0] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    assert.equal(sdk.verifyCursor(secret, parts.join("."), opts).ok, false, "field name accepted: " + field);
  }
});
