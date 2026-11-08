/**
 * Step-up proof token shape (CAP-01 StepUpProofShape, lab pin
 * cap01-lab/REGISTRATION-CAP-01-STEP0.md, results in
 * CAP01-RESULTS.md).
 *
 * WHAT IT IS. When a signal steps an identity up (an extra
 * challenge: a captcha, a confirmation, a delayed action), the
 * host needs a way to remember "this identity passed THAT
 * challenge under THAT detector configuration" that the client
 * cannot forge, transplant to another identity, or replay. This
 * module freezes that token shape:
 *
 *   token = b64url(header) "." b64url(payload) "." b64url(sig)
 *   header  = { alg: "EdDSA", typ: "anti-rea-stepup-proof", kid }
 *   payload = { v: 1, sub, cfg, ch, nonce, iat, exp }
 *   sig     = Ed25519 over the first two parts (UTF-8)
 *
 * - `sub` binds ONE identity.
 * - `cfg` is the CS-02 provenance hash of the signal
 *   configuration whose step-up this proof answers - a config
 *   change invalidates outstanding proofs by construction.
 * - `ch` is the SHA-256 of the canonical serialization (CS-02
 *   rules) of the host's declared challenge config - passing a
 *   DIFFERENT challenge does not satisfy the proof.
 * - `nonce` is single-use: the verifier REQUIRES a consume hook
 *   at construction and calls it exactly once per verification,
 *   only after every other check has passed (a token rejected
 *   for any other reason never burns its nonce). Single-use is
 *   part of the shape, not an option.
 * - Lifetime is capped: exp - iat must be in (0, 3600] seconds;
 *   verification allows 60 s of clock skew on both edges.
 *
 * Verification check order is frozen: structure -> key ->
 * signature -> claims -> temporal -> binding (sub, cfg, ch) ->
 * replay. Every rejection names its reason; acceptance is the
 * single outcome { outcome: "ACCEPT" }.
 *
 * WHAT THE LAB MEASURED (deterministic conformance, real
 * Ed25519 keys generated in-process; no traffic): 19/19 cases
 * exact - the valid token accepts; malformed structure, unknown
 * kid, tampered payload/signature, each claim defect, expiry,
 * not-yet-valid, each binding mismatch and replay each reject
 * with their frozen reason; the consume hook fired exactly 4
 * times across the suite (once per token that reached the
 * replay step), never earlier.
 *
 * This module is a SHAPE, not a challenge: it issues and
 * verifies proofs for whatever challenge the host runs. It
 * never decides who gets stepped up - pair it with a signal's
 * advisory output and the KT-01 tier rules.
 *
 * Keys are node:crypto Ed25519 keys (KeyObject, PEM or DER as
 * node:crypto accepts). Pure computation on a Node builtin;
 * zero runtime dependencies.
 */

import { canonicalSerializeConfig, ConfigProvenanceError } from "./config-provenance";

export const STEP_UP_PROOF_TOKEN_TYPE = "anti-rea-stepup-proof";
export const STEP_UP_PROOF_MAX_TTL_SEC = 3600;
export const STEP_UP_PROOF_SKEW_SEC = 60;

const HEX64 = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------------ */
/* Minimal structural view of node:crypto (mirroring web-bot-auth).         */
/* ------------------------------------------------------------------------ */

interface NodeHashLike {
  update(data: string, encoding: string): NodeHashLike;
  digest(encoding: string): string;
}

interface NodeCryptoLike {
  createHash(algorithm: string): NodeHashLike;
  sign(algorithm: null, data: Uint8Array, key: unknown): Uint8Array;
  verify(algorithm: null, data: Uint8Array, key: unknown, signature: Uint8Array): boolean;
}

declare const require: ((id: string) => NodeCryptoLike) | undefined;

function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.sign === "function" && typeof nodeCrypto.verify === "function") {
        return nodeCrypto;
      }
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; step-up proofs require Node.js");
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  const STEP = 0x4000;
  for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeText(text: string): string {
  return base64UrlEncode(utf8(text));
}

function base64Decode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function base64UrlDecodeJson(part: string): unknown {
  const bytes = base64Decode(part);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function hashCanonical(value: unknown): string {
  const text = canonicalSerializeConfig(value);
  return getNodeCrypto().createHash("sha256").update(text as string, "utf8").digest("hex");
}

/** Named error thrown for invalid step-up proof inputs. */
export class StepUpProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepUpProofError";
  }
}

const fail = (message: string): never => {
  throw new StepUpProofError(`step-up proof: ${message}`);
};

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string`);
  return value as string;
}

function requireHex64(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX64.test(value)) fail(`${field} must be a 64-char lowercase hex SHA-256`);
  return value as string;
}

export interface IssueStepUpProofInput {
  /** Ed25519 private key (any form node:crypto sign accepts). */
  privateKey: unknown;
  /** Key id placed in the header; the verifier resolves keys by it. */
  kid: string;
  /** The identity this proof is bound to (`sub`). */
  identity: string;
  /** CS-02 provenance hash of the stepping-up signal's effective config. */
  configHash: string;
  /** The host's declared challenge config; enters the token as its CS-02-style hash. */
  challengeConfig: unknown;
  /** Single-use nonce (host-generated, unguessable). */
  nonce: string;
  /** Issued-at, seconds since epoch. */
  issuedAtSec: number;
  /** Expiry, seconds since epoch. Lifetime must be in (0, 3600] s. */
  expiresAtSec: number;
}

/** Issue a step-up proof token in the frozen CAP-01 shape. */
export function issueStepUpProof(input: IssueStepUpProofInput): string {
  if (typeof input !== "object" || input === null) fail("input must be an object");
  const kid = requireNonEmptyString(input.kid, "kid");
  const identity = requireNonEmptyString(input.identity, "identity");
  const configHash = requireHex64(input.configHash, "configHash");
  const nonce = requireNonEmptyString(input.nonce, "nonce");
  if (!Number.isFinite(input.issuedAtSec) || !Number.isFinite(input.expiresAtSec)) {
    fail("issuedAtSec and expiresAtSec must be finite numbers (seconds)");
  }
  const ttl = input.expiresAtSec - input.issuedAtSec;
  if (!(ttl > 0) || ttl > STEP_UP_PROOF_MAX_TTL_SEC) {
    fail(`lifetime (expiresAtSec - issuedAtSec) must be in (0, ${STEP_UP_PROOF_MAX_TTL_SEC}] seconds`);
  }
  let challengeHash: string;
  try {
    challengeHash = hashCanonical(input.challengeConfig);
  } catch (err) {
    if (err instanceof ConfigProvenanceError) fail(`challengeConfig is unhashable: ${err.message}`);
    throw err;
  }
  const header = { alg: "EdDSA", typ: STEP_UP_PROOF_TOKEN_TYPE, kid };
  const payload = {
    v: 1,
    sub: identity,
    cfg: configHash,
    ch: challengeHash,
    nonce,
    iat: input.issuedAtSec,
    exp: input.expiresAtSec,
  };
  const signingInput = base64UrlEncodeText(JSON.stringify(header)) + "." + base64UrlEncodeText(JSON.stringify(payload));
  const signature = getNodeCrypto().sign(null, utf8(signingInput), input.privateKey);
  return signingInput + "." + base64UrlEncode(signature);
}

export type StepUpProofRejectReason =
  | "MALFORMED"
  | "UNKNOWN_KEY"
  | "BAD_SIGNATURE"
  | "EXPIRED"
  | "NOT_YET_VALID"
  | "SUBJECT_MISMATCH"
  | "CONFIG_MISMATCH"
  | "CHALLENGE_MISMATCH"
  | "REPLAY";

export type StepUpProofOutcome = { outcome: "ACCEPT" } | { outcome: "REJECT"; reason: StepUpProofRejectReason };

export interface StepUpProofContext {
  /** The identity presenting the proof. */
  identity: string;
  /** CS-02 hash of the config the host currently requires a proof for. */
  expectedConfigHash: string;
  /** CS-02-style hash of the challenge config the host currently runs. */
  expectedChallengeHash: string;
  /** Current time, seconds since epoch. */
  nowSec: number;
}

export interface CreateStepUpProofVerifierOptions {
  /** kid -> Ed25519 public key (any form node:crypto verify accepts). */
  keys: Record<string, unknown>;
  /**
   * Single-use nonce store: return true exactly once per nonce
   * (atomically consuming it), false on any later presentation.
   * REQUIRED - the verifier throws at construction without it.
   */
  consumeNonce: (nonce: string) => boolean;
}

export interface StepUpProofVerifier {
  verifyProof(token: unknown, context: StepUpProofContext): StepUpProofOutcome;
}

/** Create a verifier for CAP-01 step-up proof tokens. */
export function createStepUpProofVerifier(options: CreateStepUpProofVerifierOptions): StepUpProofVerifier {
  if (typeof options !== "object" || options === null) fail("options must be an object");
  if (typeof options.consumeNonce !== "function") {
    fail("consumeNonce hook is required (single-use is part of the shape)");
  }
  if (typeof options.keys !== "object" || options.keys === null) fail("keys must be an object keyed by kid");
  const keys = options.keys;
  const consumeNonce = options.consumeNonce;
  const reject = (reason: StepUpProofRejectReason): StepUpProofOutcome => ({ outcome: "REJECT", reason });

  function verifyProof(token: unknown, context: StepUpProofContext): StepUpProofOutcome {
    // 1. STRUCTURE
    if (typeof token !== "string") return reject("MALFORMED");
    const parts = token.split(".");
    if (parts.length !== 3) return reject("MALFORMED");
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = base64UrlDecodeJson(parts[0] as string) as Record<string, unknown>;
      payload = base64UrlDecodeJson(parts[1] as string) as Record<string, unknown>;
    } catch {
      return reject("MALFORMED");
    }
    if (
      !header ||
      header.alg !== "EdDSA" ||
      header.typ !== STEP_UP_PROOF_TOKEN_TYPE ||
      typeof header.kid !== "string" ||
      (header.kid as string).length === 0
    ) {
      return reject("MALFORMED");
    }
    // 2. KEY
    const publicKey = keys[header.kid as string];
    if (!publicKey) return reject("UNKNOWN_KEY");
    // 3. SIGNATURE
    let ok = false;
    try {
      ok = getNodeCrypto().verify(
        null,
        utf8((parts[0] as string) + "." + (parts[1] as string)),
        publicKey,
        base64Decode(parts[2] as string),
      );
    } catch {
      ok = false;
    }
    if (!ok) return reject("BAD_SIGNATURE");
    // 4. CLAIMS
    if (
      !payload ||
      payload.v !== 1 ||
      typeof payload.sub !== "string" ||
      (payload.sub as string).length === 0 ||
      typeof payload.cfg !== "string" ||
      !HEX64.test(payload.cfg as string) ||
      typeof payload.ch !== "string" ||
      !HEX64.test(payload.ch as string) ||
      typeof payload.nonce !== "string" ||
      (payload.nonce as string).length === 0 ||
      !Number.isFinite(payload.iat) ||
      !Number.isFinite(payload.exp) ||
      !((payload.exp as number) - (payload.iat as number) > 0) ||
      (payload.exp as number) - (payload.iat as number) > STEP_UP_PROOF_MAX_TTL_SEC
    ) {
      return reject("MALFORMED");
    }
    // 5. TEMPORAL
    if (context.nowSec > (payload.exp as number) + STEP_UP_PROOF_SKEW_SEC) return reject("EXPIRED");
    if (context.nowSec < (payload.iat as number) - STEP_UP_PROOF_SKEW_SEC) return reject("NOT_YET_VALID");
    // 6. BINDING (sub, then cfg, then ch)
    if (payload.sub !== context.identity) return reject("SUBJECT_MISMATCH");
    if (payload.cfg !== context.expectedConfigHash) return reject("CONFIG_MISMATCH");
    if (payload.ch !== context.expectedChallengeHash) return reject("CHALLENGE_MISMATCH");
    // 7. REPLAY (hook invoked exactly here, never earlier)
    if (!consumeNonce(payload.nonce as string)) return reject("REPLAY");
    return { outcome: "ACCEPT" };
  }

  return { verifyProof };
}

/** CS-02-style hash of a challenge config, for building StepUpProofContext. */
export function stepUpChallengeHash(challengeConfig: unknown): string {
  return hashCanonical(challengeConfig);
}
