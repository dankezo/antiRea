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
 *   part of the shape, not an option. Per-issue randomness
 *   (LCP-03): signing is deterministic, so the nonce is the
 *   per-issue random draw; `generateStepUpNonce` provides it
 *   from the SDK for hosts without their own CSPRNG discipline.
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
 *
 * ABS-08: the bound identity (`sub`) travels inside the signed JSON
 * payload, never in a colon-delimited token prefix, so an identity
 * that IS an IPv6 address ("2001:db8::1") round-trips verbatim
 * instead of being misparsed by colon splitting. Pinned by
 * tests/abs08-ipv6-token.test.cjs.
 */

import { canonicalSerializeConfig, ConfigProvenanceError } from "./config-provenance";
import { resolveIntervalClock } from "../internal/mono-clock";

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
  randomBytes(size: number): Uint8Array;
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

/* ------------------------------------------------------------------------ */
/* ABS-01: a signing secret must never default to a public constant.        */
/*                                                                          */
/* The neighbour failure: a settings object with no env secret fell back    */
/* to the public literal "change-me-abs-secret", and a token minted under   */
/* it verified (lab gates 4/4) - anyone who read the source could mint.     */
/* antiRea ships no default secret anywhere: every secret-bearing surface   */
/* takes its secret as a mandatory argument, so a missing secret already    */
/* fails closed at the call site. This guard closes the remaining hole: a   */
/* host pasting the well-known public literal (or its short form) into a    */
/* secret field gets a loud failure instead of a silently public key.       */
/* ------------------------------------------------------------------------ */

/** Signing-secret values that are public constants and must never be used as a real secret (ABS-01). */
export const PUBLIC_DEFAULT_SIGNING_SECRETS: readonly string[] = ["change-me-abs-secret", "change-me"];

/**
 * Fail-closed check for a host-configured signing secret (ABS-01):
 * returns the secret when it is a non-empty string that is not a
 * known public default; throws `StepUpProofError` otherwise. Secret
 * bearing surfaces that accept a raw secret string (the bulk access
 * key authority is wired to the same list) reject the public
 * literals at construction instead of minting forgeable tokens.
 */
export function assertSigningSecretConfigured(secret: unknown, field = "secret"): string {
  if (typeof secret !== "string" || secret.length === 0) {
    fail(`${field} must be configured: a missing signing secret fails closed (ABS-01)`);
  }
  if (PUBLIC_DEFAULT_SIGNING_SECRETS.includes(secret as string)) {
    fail(`${field} must not be a known public default value (ABS-01)`);
  }
  return secret as string;
}

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

/**
 * Draw a fresh single-use nonce for a step-up proof (LCP-03).
 *
 * The CAP-01 shape requires the host to supply an unguessable
 * nonce, and Ed25519 signing is deterministic: two issues with
 * identical inputs produce a byte-identical token. That is safe
 * only because the verifier consumes each nonce exactly once -
 * but it leaves per-issue randomness entirely to host discipline.
 * This helper is the SDK-side draw: 128 bits from node:crypto,
 * base64url-encoded, suitable verbatim as `IssueStepUpProofInput.nonce`.
 * Hosts that generate their own nonce with an equivalent CSPRNG
 * are unaffected; hosts that would otherwise reuse or derive a
 * nonce deterministically should call this per issue instead.
 */
export function generateStepUpNonce(): string {
  const crypto = getNodeCrypto();
  if (typeof crypto.randomBytes !== "function") {
    throw new Error("node:crypto randomBytes is not available in this runtime; step-up nonces require Node.js");
  }
  return base64UrlEncode(crypto.randomBytes(16));
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
  | "REPLAY"
  | "RATE_LIMITED";

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
  /**
   * ABS-04: the rate-limit bucket key when the verifier is built
   * with an `attemptLimiter`. This MUST be a PROVEN identity: the
   * server-side connection/session identity, or the issued nonce -
   * never a client-supplied fingerprint hash or request id, which
   * the caller rotates at will. A limiter-configured verifier
   * rejects `RATE_LIMITED` when this is missing (fail closed).
   */
  rateLimitKey?: string;
}

/* ------------------------------------------------------------------------ */
/* ABS-04: verify-attempt limiter keyed on proven identity only.            */
/*                                                                          */
/* The neighbour failure: the verify endpoint limited on fp_hash and on     */
/* request_id - both attacker-chosen strings. Rotating them evaded the      */
/* limits entirely (50 rotating verifies, all 200); the fp limit fired      */
/* only when the SAME fp_hash was reused, at exactly attempt 41 against     */
/* a 40-per-minute limit. This limiter's API takes exactly one key - a      */
/* proven identity - and has no parameter through which a client-chosen     */
/* value could become the bucket key. Windows run on the monotonic          */
/* clock so a wall-clock step cannot refill a bucket early.                 */
/* ------------------------------------------------------------------------ */

export interface StepUpVerifyAttemptLimiterOptions {
  /** Attempts allowed per window per proven key. Default 40 (the neighbour limit on record). */
  maxAttemptsPerWindow?: number;
  /** Window length in milliseconds. Default 60,000 (one minute). */
  windowMs?: number;
  /** Wall clock override (display only). */
  now?: () => number;
  /** Monotonic clock override: window arithmetic runs on this clock. */
  monoNow?: () => number;
}

export interface StepUpVerifyAttemptLimiter {
  /**
   * Record one verify attempt under a PROVEN key (connection/session
   * identity or issued nonce) and report whether it is inside the
   * limit. Throws `StepUpProofError` on an empty or non-string key:
   * a limiter keyed on nothing is a configuration bug, not a pass.
   */
  attempt(provenKey: string): { allowed: boolean; count: number };
  /** Attempts recorded for a key inside the current window. */
  countFor(provenKey: string): number;
}

/** Create the ABS-04 verify-attempt limiter. */
export function createStepUpVerifyAttemptLimiter(
  options: StepUpVerifyAttemptLimiterOptions = {},
): StepUpVerifyAttemptLimiter {
  const max = Math.floor(options.maxAttemptsPerWindow ?? 40);
  if (!Number.isFinite(max) || max < 1) fail("maxAttemptsPerWindow must be a positive integer");
  const windowMs = Math.floor(options.windowMs ?? 60_000);
  if (!Number.isFinite(windowMs) || windowMs < 1) fail("windowMs must be a positive integer");
  const { mono } = resolveIntervalClock(options);
  const buckets = new Map<string, number[]>();
  const prune = (key: string, at: number): number[] => {
    const list = (buckets.get(key) ?? []).filter((t) => at - t < windowMs);
    if (list.length === 0) buckets.delete(key);
    else buckets.set(key, list);
    return list;
  };
  return {
    attempt(provenKey: string) {
      if (typeof provenKey !== "string" || provenKey.length === 0) {
        fail("attempt limiter key must be a non-empty proven identity (ABS-04)");
      }
      const at = mono();
      const list = prune(provenKey, at);
      list.push(at);
      buckets.set(provenKey, list);
      return { allowed: list.length <= max, count: list.length };
    },
    countFor(provenKey: string) {
      if (typeof provenKey !== "string" || provenKey.length === 0) return 0;
      return prune(provenKey, mono()).length;
    },
  };
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
  /**
   * ABS-04 (opt-in): verify-attempt limiter keyed on proven
   * identity. When set, every verification first records an attempt
   * under `context.rateLimitKey`; a missing key or an exhausted
   * bucket rejects `RATE_LIMITED` before any other check, and the
   * nonce is never consumed for a limited attempt.
   */
  attemptLimiter?: StepUpVerifyAttemptLimiter;
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
  const attemptLimiter = options.attemptLimiter;
  const reject = (reason: StepUpProofRejectReason): StepUpProofOutcome => ({ outcome: "REJECT", reason });

  function verifyProof(token: unknown, context: StepUpProofContext): StepUpProofOutcome {
    // 0. ATTEMPT LIMIT (ABS-04, only when a limiter is configured):
    // counted on the proven key before every other check - invalid
    // attempts count too, exactly as the neighbour counters did -
    // and a limited attempt never reaches the replay step, so its
    // nonce is not burned.
    if (attemptLimiter) {
      const key = context?.rateLimitKey;
      if (typeof key !== "string" || key.length === 0) return reject("RATE_LIMITED");
      if (!attemptLimiter.attempt(key).allowed) return reject("RATE_LIMITED");
    }
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

/* ------------------------------------------------------------------------ */
/* ABP-05 proof-cookie flag policy.                                         */
/*                                                                          */
/* The neighbour failure, measured in the ABP Step-0 lab: its proof         */
/* cookie was set Secure-only, so on a plain-HTTP deployment the            */
/* browser never stored it - hasProof stayed false across all 5 HTTP        */
/* cycles and the operative path degraded from the challenge page to a      */
/* permanent 404. A Secure-only proof cookie BRICKS the challenge on        */
/* HTTP deployments. The antiRea form: the cookie flags are a POLICY        */
/* the host states, with the tradeoff written into the result, not a        */
/* constant baked into a helper.                                            */
/*                                                                          */
/* - `https-only` (default): Secure is set exactly when the deployment      */
/*   scheme is https. On http the cookie lands (no Secure) and the          */
/*   result carries the bearer-token warning below.                         */
/* - `always`: Secure is always set. On http this is the lab's brick:       */
/*   the result still emits it (the host asked for it) but warns, by         */
/*   name, that the proof can never land and the challenge dead-ends.       */
/* - `never`: Secure is never set, on either scheme, with the same          */
/*   bearer-token warning.                                                  */
/*                                                                          */
/* HttpOnly is not optional: a step-up proof is read by the server,         */
/* never by page script, so no policy here can remove it. Max-Age is        */
/* clamped to the proof lifetime cap (STEP_UP_PROOF_MAX_TTL_SEC).           */
/* ------------------------------------------------------------------------ */

export type StepUpProofCookieSecurePolicy = "https-only" | "always" | "never";

export interface StepUpProofCookieOptions {
  /** Cookie name. Defaults to "antirea_stepup_proof". */
  name?: string;
  /** The scheme the host serves the proof cookie over. Defaults to "https". */
  scheme?: "https" | "http";
  /** Secure-flag policy. Defaults to "https-only" (see the section header). */
  securePolicy?: StepUpProofCookieSecurePolicy;
  /** Max-Age in seconds; clamped into (0, STEP_UP_PROOF_MAX_TTL_SEC]. Defaults to the cap. */
  maxAgeSec?: number;
  /** Cookie Path. Defaults to "/". */
  path?: string;
  /** SameSite mode. Defaults to "Lax". "None" requires the Secure flag (browser rule). */
  sameSite?: "Lax" | "Strict" | "None";
}

export interface StepUpProofCookieResult {
  /** The full Set-Cookie header value. */
  header: string;
  /** Whether the emitted cookie carries the Secure flag. */
  secure: boolean;
  /** Named tradeoffs and dead-ends of the chosen policy (empty when none apply). */
  warnings: string[];
}

const HTTP_BEARER_WARNING =
  "proof cookie is sent without Secure on a plain-HTTP deployment: the proof is a bearer token, so any network observer can replay it until it expires - keep the proof TTL short and prefer HTTPS";
const SECURE_ON_HTTP_WARNING =
  "Secure cookie on a plain-HTTP deployment can never be stored by a browser: the proof will never land and the step-up challenge dead-ends (ABP-05) - use securePolicy https-only or never for HTTP deployments, or serve the challenge over HTTPS";

/** Build the Set-Cookie header for a step-up proof token under a stated flag policy. */
export function stepUpProofCookieHeader(token: string, options: StepUpProofCookieOptions = {}): StepUpProofCookieResult {
  if (typeof token !== "string" || token.length === 0 || /[\s;,]/.test(token)) {
    fail("cookie token must be a non-empty string without whitespace, semicolons or commas");
  }
  const name = options.name ?? "antirea_stepup_proof";
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) fail("cookie name must be a valid cookie-name token");
  const scheme = options.scheme ?? "https";
  const policy = options.securePolicy ?? "https-only";
  const secure = policy === "always" ? true : policy === "never" ? false : scheme === "https";
  const sameSite = options.sameSite ?? "Lax";
  if (sameSite === "None" && !secure) {
    fail('SameSite=None requires the Secure flag (browsers reject it otherwise); choose securePolicy "always" or a different SameSite');
  }
  const rawMaxAge = options.maxAgeSec ?? STEP_UP_PROOF_MAX_TTL_SEC;
  if (!Number.isFinite(rawMaxAge)) fail("maxAgeSec must be a finite number");
  const maxAgeSec = Math.min(STEP_UP_PROOF_MAX_TTL_SEC, Math.max(1, Math.floor(rawMaxAge)));
  const path = options.path ?? "/";
  if (typeof path !== "string" || !path.startsWith("/") || /[;\r\n]/.test(path)) fail("cookie path must start with / and contain no separators");
  const warnings: string[] = [];
  if (secure && scheme === "http") warnings.push(SECURE_ON_HTTP_WARNING);
  if (!secure && scheme === "http") warnings.push(HTTP_BEARER_WARNING);
  if (!secure && scheme === "https") {
    warnings.push("proof cookie is sent without Secure on an HTTPS deployment by explicit policy: the bearer-token exposure is limited to the browser's own cookie handling, but the flag should be on unless a legacy client requires otherwise");
  }
  const header =
    `${name}=${token}; Path=${path}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=${sameSite}` + (secure ? "; Secure" : "");
  return { header, secure, warnings };
}

/* ------------------------------------------------------------------------ */
/* ABS-06: PoW elapsed time must be server-measured.                        */
/*                                                                          */
/* The neighbour failure: two genuinely-solved verifies claiming elapsed    */
/* 180 and 180,000 both passed, because the only check was a range check    */
/* on the CLAIMED value (claims of 179 and 180,001 were refused). A         */
/* server that measures elapsed itself could accept at most one of the      */
/* two claims. This clock records challenge issuance on the server's own    */
/* monotonic clock and decides solely on the measured difference; the       */
/* claimed value is accepted as a parameter only so hosts (and tests)       */
/* can prove it does not decide. Checks are single-use: a checked           */
/* challenge is consumed whether it passed or failed, so a caller cannot    */
/* probe the boundary twice on one issuance.                                */
/* ------------------------------------------------------------------------ */

export interface ServerMeasuredPowClockOptions {
  /** Minimum acceptable server-measured elapsed, ms. Default 0. */
  minElapsedMs?: number;
  /** Maximum acceptable server-measured elapsed, ms. Default 300,000. */
  maxElapsedMs?: number;
  /** Wall clock override (accepted for clock-pair symmetry; never read for elapsed). */
  now?: () => number;
  /** Monotonic clock override: elapsed is measured on this clock. */
  monoNow?: () => number;
}

export type ServerMeasuredPowCheck =
  | { ok: true; serverElapsedMs: number }
  | { ok: false; reason: "unknown_challenge" | "too_fast" | "too_slow"; serverElapsedMs: number };

export interface ServerMeasuredPowClock {
  /** Record a challenge issuance on the server clock. Throws on a duplicate or empty id. */
  issueChallenge(challengeId: string): void;
  /**
   * Decide a completed challenge on SERVER-measured elapsed only.
   * `claimedElapsedMs` is deliberately ignored by the decision - it
   * is part of the signature so the ignoring is explicit and tested.
   */
  checkElapsed(challengeId: string, claimedElapsedMs?: number): ServerMeasuredPowCheck;
}

/** Create the ABS-06 server-measured PoW elapsed clock. */
export function createServerMeasuredPowClock(
  options: ServerMeasuredPowClockOptions = {},
): ServerMeasuredPowClock {
  const min = Math.floor(options.minElapsedMs ?? 0);
  const max = Math.floor(options.maxElapsedMs ?? 300_000);
  if (!Number.isFinite(min) || min < 0) fail("minElapsedMs must be a non-negative integer");
  if (!Number.isFinite(max) || max < min) fail("maxElapsedMs must be an integer >= minElapsedMs");
  const { mono } = resolveIntervalClock(options);
  const issuedAt = new Map<string, number>();
  return {
    issueChallenge(challengeId: string) {
      if (typeof challengeId !== "string" || challengeId.length === 0) {
        fail("challengeId must be a non-empty string");
      }
      if (issuedAt.has(challengeId)) {
        fail("challengeId is already issued; re-issuing would reset the server clock (ABS-06)");
      }
      issuedAt.set(challengeId, mono());
    },
    checkElapsed(challengeId: string, _claimedElapsedMs?: number) {
      const start = issuedAt.get(challengeId);
      if (start === undefined) return { ok: false, reason: "unknown_challenge", serverElapsedMs: 0 };
      issuedAt.delete(challengeId); // single-use, whatever the outcome
      const serverElapsedMs = Math.max(0, Math.floor(mono() - start));
      if (serverElapsedMs < min) return { ok: false, reason: "too_fast", serverElapsedMs };
      if (serverElapsedMs > max) return { ok: false, reason: "too_slow", serverElapsedMs };
      return { ok: true, serverElapsedMs };
    },
  };
}
