/**
 * Canary-echo ids: signed synthetic reference ids that link identities.
 *
 * A canary trap answers "did anyone touch a route nobody should call".
 * A canary-ECHO id answers a different question: "did the reference I
 * handed to identity A come back in the hands of identity B?" The host
 * mints a synthetic id FOR one identity (`mintEchoId`) and embeds it in
 * that identity's surface - a hidden trap link (`canaryEchoLink`), a
 * synthetic related-record reference in a list response
 * (`mintEchoRecord`), a "see also" id in a detail payload. The id is
 * inert: it names no real record, and a client that only uses what it
 * was served for itself never presents it anywhere. When a DIFFERENT
 * identity presents the id back (requests it as a record, follows the
 * link, cites it in a query), the host resolves it
 * (`resolveEchoFrom`) and feeds the result into the CUSUM tripwire as
 * `CusumEvent.echoFrom` - the tripwire merges the two identities into
 * one cohort, so the rotation's evidence accumulates jointly instead
 * of resetting with each fresh identity. The merge is the shipped
 * tripwire behavior; this module is the missing mint/verify/embed
 * half that makes the field usable.
 *
 * Token form, following `mintCursor`'s pattern: an HMAC-SHA256-signed
 * base64url payload, `echo_<payload>.<signature>`. The payload carries
 * the identity the id was minted for (`f`), an optional host scope
 * (`s`), issue/expiry times, and a 128-bit random nonce (`n`). Three
 * properties follow:
 *
 * - Attribution is unforgeable: without the server secret a caller
 *   cannot mint an id naming another identity, and editing the payload
 *   of a real id fails verification (`bad_signature`) - framing
 *   another identity by echo is exactly as hard as forging an HMAC.
 * - Ids are unguessable in bulk: the random nonce makes each mint
 *   unique (two ids for the same identity differ), and there is no
 *   enumeration that walks from one valid id to another - a caller
 *   can only ever present ids it was actually handed (or handed to a
 *   cohort-mate whose surface it copied, which is the signal).
 * - Integrity is not confidentiality: the payload is readable by any
 *   holder, like a cursor's. Do not mint an echo id for an identity
 *   string that is itself secret; use the same opaque account keys
 *   the rest of the SDK uses (`account:<id>`).
 *
 * Host failure handling: `resolveEchoFrom` returns `undefined` for
 * anything that does not verify - malformed, forged, or expired ids
 * are indistinguishable from random strings and must be treated as
 * ordinary unknown ids (a 404 for a missing record), never as
 * evidence. An echo touch is a correlation signal, not proof of
 * malice: it feeds cohort formation, and consequences stay governed
 * by the same consequence floor and tiering law as every other
 * tripwire signal.
 *
 * Secret rotation: ids live up to their TTL (24 h by default), so a
 * host that rotates its HMAC secret on schedule would otherwise
 * blind the echo channel - every outstanding id would resolve as
 * `bad_signature` and feed nothing. The rotation window closes that
 * gap: verifiers accept an optional `previousSecrets` list of
 * retired secrets. Verification tries the current secret first,
 * then each retired secret in order; a successful result reports
 * which generation verified (`secretGeneration`, plus
 * `previousSecretIndex` for a retired secret) without leaking any
 * secret material. Minting ALWAYS uses only the current secret -
 * retired secrets are verify-only and are never used to mint, so
 * removing a secret from the list is the moment its outstanding
 * ids stop verifying. Hosts should keep a retired secret in the
 * list only for the maximum id TTL after rotation, then remove it.
 *
 * Node.js builtins only (`node:crypto` HMAC + CSPRNG); zero runtime
 * dependencies. Verification is one HMAC and one constant-time
 * comparison per presented id.
 */

export type EchoSecret = string | Uint8Array;

export interface MintEchoIdOptions {
  /** Identity the echo id is minted FOR (the same identity key the tripwire uses, e.g. `account:<id>`). */
  mintedFor: string;
  /** Optional host scope (surface, tenant, dataset shard) the id is bound to; verifiers may require a match. */
  scope?: string;
  /** Time-to-live in milliseconds. Defaults to 86_400_000 (24 h). */
  ttlMs?: number;
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. */
  now?: number;
}

export interface VerifyEchoIdOptions {
  /** When provided, the id's scope must equal this value exactly. */
  expectedScope?: string;
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. */
  now?: number;
  /**
   * Retired HMAC secrets still accepted for VERIFICATION only, in
   * order. Verification tries the current secret (the first argument
   * to `verifyEchoId` / `resolveEchoFrom`) first, then each retired
   * secret. Minting never uses these secrets. Keep a retired secret
   * listed only for the maximum echo-id TTL after rotation, then
   * remove it - once removed, ids minted under it fail as
   * `bad_signature`. When omitted or empty, behavior is identical to
   * single-secret verification.
   */
  previousSecrets?: readonly EchoSecret[];
}

export type EchoVerifyFailure = "malformed" | "bad_signature" | "expired" | "not_yet_valid" | "scope_mismatch";

/** Which secret generation verified an echo id. Carries no secret material. */
export type EchoSecretGeneration = "current" | "previous";

export type EchoVerifyResult =
  | {
      ok: true;
      /** Identity the id was minted for - the value to pass as `CusumEvent.echoFrom`. */
      mintedFor: string;
      /** Scope carried by the id, when one was minted into it. */
      scope?: string;
      /** Expiry (ms since epoch) carried by the id. */
      expiresAt: number;
      /**
       * Which generation verified the id: `"current"` for the secret
       * passed as the verifier's first argument, `"previous"` for a
       * retired secret from `VerifyEchoIdOptions.previousSecrets`.
       */
      secretGeneration: EchoSecretGeneration;
      /**
       * Zero-based index into `previousSecrets` of the retired secret
       * that verified the id. Present only when
       * `secretGeneration` is `"previous"`.
       */
      previousSecretIndex?: number;
    }
  | { ok: false; reason: EchoVerifyFailure };

interface EchoPayload {
  v: 1;
  f: string;
  s?: string;
  n: string;
  iat: number;
  exp: number;
}

export const DEFAULT_ECHO_TTL_MS = 86_400_000;

/**
 * Clock skew tolerated on the issued-at edge (LPG-07): an id whose
 * `iat` is more than this far in the future fails as `not_yet_valid`.
 * Only the server can mint echo ids, so a future `iat` means a host
 * clock or minting error; 60 s matches the skew the step-up proof
 * and the Web Bot Auth verifier already allow.
 */
export const ECHO_IAT_SKEW_MS = 60_000;

/**
 * Maximum accepted echo id length, in characters, including the
 * `echo_` prefix (NV-2). Same bound and sizing basis as the cursor
 * caps (typical echo ids are ~180 characters; ~1.5 KB with
 * 512-character identity and scope fields): longer ids are rejected
 * as `malformed` before any decode or parse work, so presenting an
 * id cannot buy linear parse CPU with its length.
 */
export const MAX_ECHO_ID_LENGTH = 8_192;
/** Structural prefix of every echo id; `isEchoId` is a shape check only, never evidence. */
export const ECHO_ID_PREFIX = "echo_";

/* ------------------------------------------------------------------------ */
/* Minimal structural view of node:crypto (mirrors cursor.ts).              */
/* ------------------------------------------------------------------------ */

interface NodeHmacLike {
  update(data: string | Uint8Array): NodeHmacLike;
  digest(): Uint8Array;
}

interface NodeCryptoLike {
  createHmac(algorithm: string, key: string | Uint8Array): NodeHmacLike;
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  randomBytes(size: number): Uint8Array;
}

declare const require: ((id: string) => NodeCryptoLike) | undefined;

function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.createHmac === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; echo ids require Node.js");
}

const utf8Encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf8Decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  const STEP = 0x4000;
  for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tryBase64UrlDecode(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const bin = atob(padded);
    return Uint8Array.from(bin, ch => ch.charCodeAt(0));
  } catch {
    return undefined;
  }
}

const sign = (secret: EchoSecret, payloadPart: string): Uint8Array =>
  getNodeCrypto().createHmac("sha256", secret).update(payloadPart).digest();

/** Structural check: does this string have the echo-id shape? (Not a verification.) */
export function isEchoId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ECHO_ID_PREFIX) && value.includes(".");
}

const signatureMatches = (secret: EchoSecret, payloadPart: string, presented: Uint8Array): boolean => {
  const expected = sign(secret, payloadPart);
  return presented.length === expected.length && getNodeCrypto().timingSafeEqual(presented, expected);
};

/**
 * Mint a signed echo id for `mintedFor`. Every mint is unique (random
 * 128-bit nonce), so a host may mint one id per response, per record
 * or per identity without any stored state: verification is stateless.
 * Minting ALWAYS uses only `secret` (the current secret) - retired
 * secrets from `VerifyEchoIdOptions.previousSecrets` are verify-only
 * and are never used here.
 */
export function mintEchoId(secret: EchoSecret, options: MintEchoIdOptions): string {
  if (typeof options.mintedFor !== "string" || options.mintedFor.length === 0) {
    throw new Error("mintEchoId: mintedFor must be a non-empty identity string");
  }
  const now = options.now ?? Date.now();
  const ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? DEFAULT_ECHO_TTL_MS) || DEFAULT_ECHO_TTL_MS);
  const nonce = base64UrlEncode(getNodeCrypto().randomBytes(16));
  const payload: EchoPayload = {
    v: 1,
    f: options.mintedFor,
    ...(options.scope ? { s: options.scope } : {}),
    n: nonce,
    iat: now,
    exp: now + ttlMs,
  };
  const payloadPart = base64UrlEncode(utf8Encode(JSON.stringify(payload)));
  return `${ECHO_ID_PREFIX}${payloadPart}.${base64UrlEncode(sign(secret, payloadPart))}`;
}

/**
 * Verify a presented echo id. Checks run in a fixed order - structure,
 * signature, expiry, issued-at, scope - and the first failure is reported.
 * Signature verification tries the current secret first, then each
 * secret in `options.previousSecrets` in order; the successful result
 * reports the verifying generation via `secretGeneration` (and
 * `previousSecretIndex` for a retired secret). Failure results carry
 * NO payload fields: an unauthenticated payload must never steer
 * host behavior (the cursor discipline).
 */
export function verifyEchoId(
  secret: EchoSecret,
  id: string,
  options: VerifyEchoIdOptions = {},
): EchoVerifyResult {
  if (!isEchoId(id)) return { ok: false, reason: "malformed" };
  // Length bound BEFORE any decode/parse (NV-2): see MAX_ECHO_ID_LENGTH.
  if (id.length > MAX_ECHO_ID_LENGTH) return { ok: false, reason: "malformed" };
  const body = id.slice(ECHO_ID_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot === body.length - 1 || body.indexOf(".", dot + 1) !== -1) {
    return { ok: false, reason: "malformed" };
  }
  const payloadPart = body.slice(0, dot);
  const signaturePart = body.slice(dot + 1);

  const payloadBytes = tryBase64UrlDecode(payloadPart);
  if (!payloadBytes) return { ok: false, reason: "malformed" };
  let payload: EchoPayload;
  try {
    const parsed: unknown = JSON.parse(utf8Decode(payloadBytes));
    if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "malformed" };
    const candidate = parsed as Partial<EchoPayload>;
    if (
      candidate.v !== 1 ||
      typeof candidate.f !== "string" ||
      candidate.f.length === 0 ||
      typeof candidate.n !== "string" ||
      candidate.n.length === 0 ||
      typeof candidate.exp !== "number" ||
      !Number.isFinite(candidate.exp) ||
      typeof candidate.iat !== "number" ||
      !Number.isFinite(candidate.iat) ||
      (candidate.s !== undefined && typeof candidate.s !== "string")
    ) {
      return { ok: false, reason: "malformed" };
    }
    payload = candidate as EchoPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const presented = tryBase64UrlDecode(signaturePart);
  if (!presented) return { ok: false, reason: "bad_signature" };
  let secretGeneration: EchoSecretGeneration | undefined;
  let previousSecretIndex: number | undefined;
  if (signatureMatches(secret, payloadPart, presented)) {
    secretGeneration = "current";
  } else if (options.previousSecrets) {
    for (let i = 0; i < options.previousSecrets.length; i++) {
      const candidateSecret = options.previousSecrets[i];
      if (candidateSecret === undefined) continue;
      if (signatureMatches(candidateSecret, payloadPart, presented)) {
        secretGeneration = "previous";
        previousSecretIndex = i;
        break;
      }
    }
  }
  if (secretGeneration === undefined) {
    return { ok: false, reason: "bad_signature" };
  }

  const now = options.now ?? Date.now();
  if (now >= payload.exp) return { ok: false, reason: "expired" };
  if (payload.iat > now + ECHO_IAT_SKEW_MS) return { ok: false, reason: "not_yet_valid" };
  if (options.expectedScope !== undefined && payload.s !== options.expectedScope) {
    return { ok: false, reason: "scope_mismatch" };
  }
  return {
    ok: true,
    mintedFor: payload.f,
    ...(payload.s ? { scope: payload.s } : {}),
    expiresAt: payload.exp,
    secretGeneration,
    ...(previousSecretIndex !== undefined ? { previousSecretIndex } : {}),
  };
}

/**
 * The host-side one-liner for the serving path: resolve a presented
 * id to the identity it was minted for, or `undefined` when the id
 * is not a valid echo id. Feed a non-`undefined` result that differs
 * from the presenting identity into the tripwire as
 * `CusumEvent.echoFrom`; a result equal to the presenter is its own
 * echo coming home and links nothing. Accepts the same
 * `VerifyEchoIdOptions` as `verifyEchoId`, including
 * `previousSecrets`: an id verified under a retired secret inside
 * the rotation window still resolves its origin here.
 */
export function resolveEchoFrom(
  secret: EchoSecret,
  presentedId: string,
  options: VerifyEchoIdOptions = {},
): string | undefined {
  if (!isEchoId(presentedId)) return undefined;
  const result = verifyEchoId(secret, presentedId, options);
  return result.ok ? result.mintedFor : undefined;
}

/**
 * A synthetic record carrying an echo id, for hosts that embed
 * references in list/detail payloads: insert it into the response's
 * related-references surface (never into the real dataset). The
 * record is deliberately inert - a label field says what it is to a
 * human reader, and the id itself is the only machine signal.
 */
export function mintEchoRecord(
  secret: EchoSecret,
  options: MintEchoIdOptions & { label?: string },
): { id: string; kind: "echo_reference"; label: string } {
  return {
    id: mintEchoId(secret, options),
    kind: "echo_reference",
    label: options.label ?? "related reference",
  };
}

const escapeHtmlAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Bait-link snippet embedding an echo id, following `canaryTrapLink`'s
 * pattern: the link is `display:none`, out of the accessibility tree
 * and tab order, `rel="nofollow"`. The href is
 * `<basePath>/<echoId>` (default base `/api/accounts`, the detail
 * route shape), so an automated caller that follows or replays the
 * reference presents the echo id to the host's detail handler, where
 * `resolveEchoFrom` links it back to `mintedFor`. Pair with a detail
 * handler that resolves echo ids before its not-found path.
 */
export function canaryEchoLink(
  secret: EchoSecret,
  options: MintEchoIdOptions & { basePath?: string; label?: string },
): string {
  const base = (options.basePath ?? "/api/accounts").replace(/\/+$/, "");
  const href = escapeHtmlAttribute(`${base}/${mintEchoId(secret, options)}`);
  const label = escapeHtmlAttribute(options.label ?? "related");
  return `<span style="display:none" aria-hidden="true"><a href="${href}" tabindex="-1" rel="nofollow">${label}</a></span>`;
}
