/**
 * Cursor V2 - store-bound pagination cursors (CHATGPT-R8 contract).
 *
 * V1 cursors (`cursor.ts`) are session-chained and self-consistent: the
 * token's HMAC is the whole truth. That is exactly what makes rollback
 * possible - a client can replay an older authentic token and the
 * server has nothing to contradict it with. Cursor V2 keeps V1's HMAC
 * integrity but binds every token to server-side authority state:
 *
 * - the payload carries ONLY `position`, the subject / cohort / scope
 *   binding, a per-chain `cursorSequence`, and the `ledgerVersion` the
 *   token was minted against. It NEVER carries LLR values, evidence
 *   accumulators or evidence snapshots - those live server-side, where
 *   a client cannot roll them back (the payload key set is an allowlist
 *   enforced at verification: a token carrying extra keys is not a V2
 *   token and is rejected as `unexpected_fields`);
 * - on EVERY conflict the STORE WINS unconditionally: when the token's
 *   `ledgerVersion` differs from the store's current version, or its
 *   sequence differs from the store's expected sequence, verification
 *   fails (`stale_version` / `future_version` / `sequence_mismatch`).
 *   Stale and future tokens are rejected, never silently upgraded -
 *   the host re-reads its store and mints fresh, or refuses.
 *
 * The accepted cost (stated by the R8 review, not hidden): pagination
 * is no longer stateless. The host must read its authority (the
 * disclosure ledger's version, plus the chain sequence it issued) on
 * each V2 verification, and a store outage fails new disclosure closed
 * rather than falling back to token-only truth. V1 remains available
 * and unchanged for hosts that prefer stateless chaining.
 *
 * Like V1, a V2 token is integrity protection only: the payload is
 * readable by any holder and is not encryption.
 */

export type CursorV2Secret = string | Uint8Array;

/**
 * The server-side truth a V2 token is checked against. The host obtains
 * this from its own store (e.g. the disclosure ledger snapshot for
 * `ledgerVersion`, and the last sequence it minted for the chain).
 */
export interface CursorV2Authority {
  ledgerVersion: number;
  /** The sequence the NEXT presented token must carry for this chain. */
  sequence: number;
}

export interface MintCursorV2Options {
  subject: string;
  cohortId?: string;
  scope: string;
  position: number;
  authority: CursorV2Authority;
  ttlMs?: number;
  now?: number;
}

export interface VerifyCursorV2Options {
  subject: string;
  cohortId?: string;
  scope: string;
  authority: CursorV2Authority;
  expectedPosition?: number;
  now?: number;
}

export type CursorV2VerifyFailure =
  | "malformed"
  | "unexpected_fields"
  | "bad_signature"
  | "expired"
  | "binding_mismatch"
  | "position_mismatch"
  | "stale_version"
  | "future_version"
  | "sequence_mismatch";

export type CursorV2VerifyResult =
  | { ok: true; position: number; sequence: number; ledgerVersion: number; expiresAt: number }
  | { ok: false; reason: CursorV2VerifyFailure };

interface CursorV2Payload {
  v: 2;
  sub: string;
  coh?: string;
  scope: string;
  pos: number;
  seq: number;
  lv: number;
  iat: number;
  exp: number;
}

const PAYLOAD_KEYS = new Set(["v", "sub", "coh", "scope", "pos", "seq", "lv", "iat", "exp"]);

export const DEFAULT_CURSOR_V2_TTL_MS = 300_000;

/**
 * Maximum accepted V2 token length, in characters (NV-2). Same
 * bound and sizing basis as V1's `MAX_CURSOR_TOKEN_LENGTH` (typical
 * V2 tokens are ~190 characters; ~1.9 KB with 512-character binding
 * fields): longer tokens are rejected as `malformed` before any
 * decode or parse work, so an unauthenticated caller cannot buy
 * linear parse CPU with token length.
 */
export const MAX_CURSOR_V2_TOKEN_LENGTH = 8_192;

/* Minimal structural view of node:crypto (mirrors cursor.ts). */
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
      /* fall through */
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

const sign = (secret: CursorV2Secret, payloadPart: string): Uint8Array =>
  getNodeCrypto().createHmac("sha256", secret).update(payloadPart).digest();

/**
 * Mint a V2 token. There is deliberately no parameter for evidence,
 * scores or LLR state: the payload key set is fixed by construction,
 * and verification enforces the same allowlist on presented tokens.
 */
export function mintCursorV2(secret: CursorV2Secret, options: MintCursorV2Options): string {
  const now = options.now ?? Date.now();
  const ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? DEFAULT_CURSOR_V2_TTL_MS) || DEFAULT_CURSOR_V2_TTL_MS);
  const payload: CursorV2Payload = {
    v: 2,
    sub: options.subject,
    ...(options.cohortId ? { coh: options.cohortId } : {}),
    scope: options.scope,
    pos: Math.max(0, Math.floor(options.position) || 0),
    seq: Math.max(0, Math.floor(options.authority.sequence) || 0),
    lv: Math.max(0, Math.floor(options.authority.ledgerVersion) || 0),
    iat: now,
    exp: now + ttlMs,
  };
  const payloadPart = base64UrlEncode(utf8Encode(JSON.stringify(payload)));
  return `${payloadPart}.${base64UrlEncode(sign(secret, payloadPart))}`;
}

/**
 * Verify a V2 token against the store's current authority. Check order:
 * structure, payload allowlist, signature, expiry, binding, position,
 * then the store-wins checks (ledger version, sequence). A failure
 * result never carries payload fields - the host's recovery path is to
 * consult its store, not the rejected token.
 */
export function verifyCursorV2(
  secret: CursorV2Secret,
  token: string,
  options: VerifyCursorV2Options,
): CursorV2VerifyResult {
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "malformed" };
  // Length bound BEFORE any decode/parse (NV-2): see MAX_CURSOR_V2_TOKEN_LENGTH.
  if (token.length > MAX_CURSOR_V2_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1 || token.indexOf(".", dot + 1) !== -1) {
    return { ok: false, reason: "malformed" };
  }
  const payloadPart = token.slice(0, dot);
  const signaturePart = token.slice(dot + 1);

  const payloadBytes = tryBase64UrlDecode(payloadPart);
  if (!payloadBytes) return { ok: false, reason: "malformed" };
  let payload: CursorV2Payload;
  try {
    const parsed: unknown = JSON.parse(utf8Decode(payloadBytes));
    if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "malformed" };
    for (const key of Object.keys(parsed)) {
      if (!PAYLOAD_KEYS.has(key)) return { ok: false, reason: "unexpected_fields" };
    }
    const candidate = parsed as Partial<CursorV2Payload>;
    if (
      candidate.v !== 2 ||
      typeof candidate.sub !== "string" ||
      (candidate.coh !== undefined && typeof candidate.coh !== "string") ||
      typeof candidate.scope !== "string" ||
      typeof candidate.pos !== "number" || !Number.isFinite(candidate.pos) ||
      typeof candidate.seq !== "number" || !Number.isFinite(candidate.seq) ||
      typeof candidate.lv !== "number" || !Number.isFinite(candidate.lv) ||
      typeof candidate.exp !== "number" || !Number.isFinite(candidate.exp)
    ) {
      return { ok: false, reason: "malformed" };
    }
    payload = candidate as CursorV2Payload;
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
  if (now >= payload.exp) return { ok: false, reason: "expired" };
  if (
    payload.sub !== options.subject ||
    payload.scope !== options.scope ||
    (payload.coh ?? undefined) !== (options.cohortId ?? undefined)
  ) {
    return { ok: false, reason: "binding_mismatch" };
  }
  if (options.expectedPosition !== undefined && payload.pos !== options.expectedPosition) {
    return { ok: false, reason: "position_mismatch" };
  }

  /* Store wins: the token's view of the world must match the store's. */
  if (payload.lv < options.authority.ledgerVersion) return { ok: false, reason: "stale_version" };
  if (payload.lv > options.authority.ledgerVersion) return { ok: false, reason: "future_version" };
  if (payload.seq !== options.authority.sequence) return { ok: false, reason: "sequence_mismatch" };

  return { ok: true, position: payload.pos, sequence: payload.seq, ledgerVersion: payload.lv, expiresAt: payload.exp };
}

/**
 * Tiny in-memory authority for hosts (and tests) that do not yet read
 * version/sequence from their own store. The ledger version only moves
 * when the host says the ledger changed; the sequence advances once
 * per minted token in a chain.
 */
export function createCursorV2Authority(): {
  current(subject: string, scope: string): CursorV2Authority;
  advanceLedgerVersion(): number;
  advanceSequence(subject: string, scope: string): number;
} {
  let ledgerVersion = 0;
  const sequences = new Map<string, number>();
  // Length-prefixed key (F-23): a raw separator byte is ambiguous -
  // `${subject}\0${scope}` maps ("a\0b","c") and ("a","b\0c") to the
  // SAME key, so two different chains shared one sequence counter.
  // Prefixing each component with its length makes the encoding
  // injective: the first length fixes the subject boundary exactly,
  // so no shifted pair can collide.
  const key = (subject: string, scope: string): string =>
    `${subject.length}:${subject}${scope.length}:${scope}`;
  return {
    current(subject, scope) {
      return { ledgerVersion, sequence: sequences.get(key(subject, scope)) ?? 0 };
    },
    advanceLedgerVersion() {
      ledgerVersion += 1;
      return ledgerVersion;
    },
    advanceSequence(subject, scope) {
      const next = (sequences.get(key(subject, scope)) ?? 0) + 1;
      sequences.set(key(subject, scope), next);
      return next;
    },
  };
}
