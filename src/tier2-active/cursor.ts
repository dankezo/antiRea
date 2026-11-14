/**
 * Session-chained pagination cursors.
 *
 * A cursor is an HMAC-SHA256-signed token that binds three things together:
 * the session that was issued the cursor, the dataset position the cursor
 * authorizes, and an expiry. The server mints a cursor for the NEXT position
 * whenever it serves a page; the client must present that exact cursor to
 * read on. Verification then rejects the three replay patterns a bulk
 * extractor relies on:
 *
 * - skip-ahead: asking for offset N with a cursor minted for position M < N
 *   fails with `position_mismatch`;
 * - cross-session replay: a cursor minted for session A fails under session
 *   B with `session_mismatch`;
 * - stale replay: a cursor presented after its TTL fails with `expired`.
 *
 * A cursor is integrity protection only. The payload is base64url-encoded
 * JSON that any holder can read - it is NOT encryption and provides no
 * confidentiality. It also does not slow down a client that simply follows
 * the chain at full speed; pair it with `createRecordBudget` so the chain
 * itself is metered.
 *
 * Bind `sessionId` to the account id or a LONG-LIVED session id - never to
 * a rotating access token. If the binding value rotates mid-chain, every
 * outstanding cursor fails with `session_mismatch` and honest users see
 * spurious 400s.
 *
 * Host failure-handling pattern:
 *
 * - `expired`: the signature verified, so the payload is authentic and the
 *   failure result carries its decoded fields (`sessionId`, `position`,
 *   `filterHash`). Re-mint a fresh cursor at that same position for the
 *   same session and let the user continue - expiry is a normal event for
 *   a user who left a tab open, not an attack.
 * - `bad_signature`, `session_mismatch`, `position_mismatch`, `malformed`:
 *   reject with 400. These results deliberately carry NO payload fields -
 *   an unauthenticated payload must never steer host behavior.
 *
 * Node.js builtins only (`node:crypto` HMAC); zero runtime dependencies.
 * Verification is one HMAC and one constant-time comparison per request.
 */

export type CursorSecret = string | Uint8Array;

export interface MintCursorOptions {
  /** Server-side session id the cursor is bound to. */
  sessionId: string;
  /** Dataset position this cursor authorizes (e.g. the next offset to serve). */
  position: number;
  /** Optional hash of the active filter/sort, so a cursor cannot be replayed against a different query. */
  filterHash?: string;
  /** Time-to-live in milliseconds. Defaults to 300_000 (5 minutes). */
  ttlMs?: number;
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. */
  now?: number;
}

export interface VerifyCursorOptions {
  /** Session id the cursor must have been minted for. */
  sessionId: string;
  /** When provided, the cursor position must equal this value exactly (this is what rejects skip-ahead). */
  expectedPosition?: number;
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. */
  now?: number;
}

export type CursorVerifyFailure =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "session_mismatch"
  | "position_mismatch";

export type CursorVerifyResult =
  | {
      ok: true;
      /** Position carried by the cursor. */
      position: number;
      /** Filter hash carried by the cursor, when one was minted into it. */
      filterHash?: string;
      /** Expiry (ms since epoch) carried by the cursor. */
      expiresAt: number;
    }
  | {
      ok: false;
      reason: "expired";
      /**
       * Decoded payload fields, present ONLY on expiry: the signature
       * verified, so these values are authentic. The host re-mints a fresh
       * cursor at `position` for `sessionId` and continues the chain.
       */
      sessionId: string;
      /** Position carried by the cursor. */
      position: number;
      /** Filter hash carried by the cursor, when one was minted into it. */
      filterHash?: string;
      /** Expiry (ms since epoch) carried by the cursor. */
      expiresAt: number;
    }
  | { ok: false; reason: Exclude<CursorVerifyFailure, "expired"> };

interface CursorPayload {
  v: 1;
  sid: string;
  pos: number;
  fh?: string;
  iat: number;
  exp: number;
}

export const DEFAULT_CURSOR_TTL_MS = 300_000;

/**
 * Clock skew tolerated on the issued-at edge (LPG-07): a cursor whose
 * `iat` is more than this far in the future fails as `not_yet_valid`.
 * Only the server can mint cursors, so a future `iat` means a host
 * clock or minting error; the check matches the 60 s skew the step-up
 * proof and the Web Bot Auth verifier already allow on their edges.
 */
export const CURSOR_IAT_SKEW_MS = 60_000;

/**
 * Maximum accepted cursor token length, in characters (NV-2).
 * Verification used to decode and JSON-parse the payload BEFORE the
 * HMAC check with no length bound, so a caller's CPU cost per verify
 * grew linearly with a token it fully controls (~300 ms per MB of
 * token measured on the audit machine; no amplification - plain
 * linear parse cost). A token longer than this is rejected as
 * `malformed` before any decode or parse work. Sizing: a typical
 * minted cursor is 140-190 characters, and even a cursor minted with
 * 512-character session id and filter hash fields is ~1.5 KB, so
 * 8192 leaves >40x headroom over typical tokens and >4x over that
 * stress case while capping worst-case verify cost at sub-ms.
 */
export const MAX_CURSOR_TOKEN_LENGTH = 8_192;

/* ------------------------------------------------------------------------ */
/* Minimal structural view of node:crypto (no @types/node in this repo,     */
/* mirroring the lazy-require pattern used by web-bot-auth).                */
/* ------------------------------------------------------------------------ */

interface NodeHmacLike {
  update(data: string | Uint8Array): NodeHmacLike;
  digest(): Uint8Array;
}

interface NodeCryptoLike {
  createHmac(algorithm: string, key: string | Uint8Array): NodeHmacLike;
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
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
  throw new Error("node:crypto is not available in this runtime; cursors require Node.js");
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

const sign = (secret: CursorSecret, payloadPart: string): Uint8Array =>
  getNodeCrypto().createHmac("sha256", secret).update(payloadPart).digest();

/** Mint a cursor token for `position` bound to `sessionId`. */
export function mintCursor(secret: CursorSecret, options: MintCursorOptions): string {
  const now = options.now ?? Date.now();
  const ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? DEFAULT_CURSOR_TTL_MS) || DEFAULT_CURSOR_TTL_MS);
  const payload: CursorPayload = {
    v: 1,
    sid: options.sessionId,
    pos: Math.max(0, Math.floor(options.position) || 0),
    ...(options.filterHash ? { fh: options.filterHash } : {}),
    iat: now,
    exp: now + ttlMs,
  };
  const payloadPart = base64UrlEncode(utf8Encode(JSON.stringify(payload)));
  return `${payloadPart}.${base64UrlEncode(sign(secret, payloadPart))}`;
}

/**
 * Verify a presented cursor. Checks run in a fixed order - structure,
 * signature, expiry, issued-at, session binding, position binding - and the first
 * failure is reported. Signature comparison uses `timingSafeEqual`. An
 * `expired` result (and only that result) carries the decoded payload
 * fields, because its signature verified - see the module header for the
 * host re-mint pattern.
 */
export function verifyCursor(
  secret: CursorSecret,
  token: string,
  options: VerifyCursorOptions,
): CursorVerifyResult {
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "malformed" };
  // Length bound BEFORE any decode/parse (NV-2): see MAX_CURSOR_TOKEN_LENGTH.
  if (token.length > MAX_CURSOR_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1 || token.indexOf(".", dot + 1) !== -1) {
    return { ok: false, reason: "malformed" };
  }
  const payloadPart = token.slice(0, dot);
  const signaturePart = token.slice(dot + 1);

  const payloadBytes = tryBase64UrlDecode(payloadPart);
  if (!payloadBytes) return { ok: false, reason: "malformed" };
  let payload: CursorPayload;
  try {
    const parsed: unknown = JSON.parse(utf8Decode(payloadBytes));
    if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "malformed" };
    const candidate = parsed as Partial<CursorPayload>;
    if (
      candidate.v !== 1 ||
      typeof candidate.sid !== "string" ||
      typeof candidate.pos !== "number" ||
      !Number.isFinite(candidate.pos) ||
      typeof candidate.exp !== "number" ||
      !Number.isFinite(candidate.exp) ||
      typeof candidate.iat !== "number" ||
      !Number.isFinite(candidate.iat) ||
      (candidate.fh !== undefined && typeof candidate.fh !== "string")
    ) {
      return { ok: false, reason: "malformed" };
    }
    payload = candidate as CursorPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const presented = tryBase64UrlDecode(signaturePart);
  if (!presented) return { ok: false, reason: "bad_signature" };
  const expected = sign(secret, payloadPart);
  if (presented.length !== expected.length || !getNodeCrypto().timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  const now = options.now ?? Date.now();
  if (now >= payload.exp) {
    // Signature already verified above: the payload is authentic, so its
    // fields are returned for the host's re-mint-and-continue path.
    return {
      ok: false,
      reason: "expired",
      sessionId: payload.sid,
      position: payload.pos,
      ...(payload.fh ? { filterHash: payload.fh } : {}),
      expiresAt: payload.exp,
    };
  }
  if (payload.iat > now + CURSOR_IAT_SKEW_MS) return { ok: false, reason: "not_yet_valid" };
  if (payload.sid !== options.sessionId) return { ok: false, reason: "session_mismatch" };
  if (options.expectedPosition !== undefined && payload.pos !== options.expectedPosition) {
    return { ok: false, reason: "position_mismatch" };
  }
  return {
    ok: true,
    position: payload.pos,
    ...(payload.fh ? { filterHash: payload.fh } : {}),
    expiresAt: payload.exp,
  };
}
