/**
 * One-time flows (antiRea 3.3.3, X33-06) - OPT-IN, default OFF.
 *
 * WHAT IT DOES. A sensitive action (the trial's dataset export)
 * requires, for flagged identities only, a single-use token that
 * is minted on demand and delivered ONLY in a response header
 * (`x-flow-token`), never in any body. A recorded scenario that
 * replays the action without re-running the mint step holds no
 * valid token and is refused: missing token answers
 * `flow_token_required`, an unknown, expired or already-consumed
 * token answers `flow_token_invalid`, both with status 403.
 * Ported faithfully from the headline twin
 * (twin-server-x33-headline.cjs: GET /api/flow/mint stores
 * token -> expiresAt with a 120 s TTL; POST /api/export checks
 * the header, deletes on success; tokens are NOT bound to an
 * identity - possession is the whole credential, exactly as in
 * the trial).
 *
 * MEASURED BASIS. X33-06 passed Wave 2; in the headline trial
 * the replay leg (arm 6, SC-C) hit 403 on both lab twins. All
 * agent numbers in this program are lab numbers on free models.
 *
 * CLAIM DISCIPLINE (freeze section 2.2). This module breaks
 * naive replay of one flow. It does not prevent the underlying
 * records from being read through other routes, and it makes
 * no cost claim.
 *
 * CONTRACT.
 * - The requirement applies only when the module is enabled AND
 *   `isFlagged(identity)` is true. Everyone else: `required`
 *   false, `mint` null, `authorize` ok with `skipped: true` -
 *   host behavior byte-identical to 3.3.2.
 * - The minted token appears ONLY in the returned headers
 *   object, never in the body (trial mechanic).
 * - A valid token is consumed on success (single-use). An
 *   expired token is deleted on access. Failed attempts do not
 *   consume a still-valid token presented later under its own
 *   value; each token value is independent.
 */

interface NodeCryptoLike {
  randomBytes(size: number): { toString(encoding: string): string };
}

declare const require: ((id: string) => NodeCryptoLike) | undefined;

function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.randomBytes === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; one-time flows require Node.js");
}

export interface OneTimeFlowLogEntry {
  source: "one-time-flow";
  event: "mint" | "authorized" | "rejected";
  identity: string;
  error?: string;
}

export interface OneTimeFlowOptions {
  /** The module acts only when this is exactly `true`. Default false (OFF). */
  enabled?: boolean;
  /** Flagging seam: return true for identities the flow requirement applies to. Default: nobody is flagged. */
  isFlagged?: (identity: string) => boolean;
  /** Token lifetime in milliseconds. Default 120000 (the trial's 120 s). */
  ttlMs?: number;
  /** Clock seam for tests. Default Date.now. */
  now?: () => number;
  /** Random bytes per token; the token is hex, so 2x characters. Default 16 (the trial's form). */
  tokenBytes?: number;
  /** Flow name reported in the mint body. Default "export". */
  flowName?: string;
  /** Sink for flow events. A throwing sink never breaks the flow. */
  onLog?: (entry: OneTimeFlowLogEntry) => void;
}

export interface OneTimeFlowMint {
  headers: { "x-flow-token": string };
  body: { flow: string; expires_in_s: number };
}

export type OneTimeFlowAuthorizeResult =
  | { ok: true; skipped?: boolean }
  | { ok: false; status: 403; error: "flow_token_required" | "flow_token_invalid" };

export interface OneTimeFlow {
  readonly enabled: boolean;
  /** Whether this identity must present a one-time token. */
  required: (identity: string) => boolean;
  /** Mint a token for a required identity; null when not required. */
  mint: (identity: string) => OneTimeFlowMint | null;
  /** Check (and on success consume) a presented token. */
  authorize: (identity: string, presented: string | null | undefined) => OneTimeFlowAuthorizeResult;
}

/** Create the one-time flow module. See the module header for the full contract. */
export function createOneTimeFlow(opts: OneTimeFlowOptions = {}): OneTimeFlow {
  const enabled = opts.enabled === true;
  const isFlagged = opts.isFlagged ?? (() => false);
  const ttlMs = opts.ttlMs ?? 120000;
  const now = opts.now ?? (() => Date.now());
  const tokenBytes = opts.tokenBytes ?? 16;
  // Construction-time validation: tokenBytes 0 would mint the empty
  // token (which authorize always rejects as "required", and every
  // mint would collide on the same map key); a negative value makes
  // crypto.randomBytes throw a raw RangeError at mint time. A
  // non-positive ttlMs mints already-expired tokens.
  if (!Number.isInteger(tokenBytes) || tokenBytes < 1) {
    throw new Error("createOneTimeFlow: tokenBytes must be a positive integer");
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("createOneTimeFlow: ttlMs must be a positive finite number");
  }
  const flowName = opts.flowName ?? "export";
  const tokens = new Map<string, number>(); // token -> expiresAt; NOT bound to identity (trial)

  const log = (entry: OneTimeFlowLogEntry): void => {
    try {
      opts.onLog?.(entry);
    } catch {
      /* monitoring must never break the host */
    }
  };

  const required = (identity: string): boolean => enabled && isFlagged(identity);

  const mint = (identity: string): OneTimeFlowMint | null => {
    if (!required(identity)) return null;
    // Opportunistic sweep: expired tokens are otherwise deleted
    // only when presented to authorize, so a flagged identity
    // minting without redeeming could grow the store without
    // bound. Sweeping on mint bounds live state to one TTL window
    // of mints (plus tokens still inside their TTL).
    const t = now();
    for (const [tok, exp] of tokens) {
      if (exp < t) tokens.delete(tok);
    }
    const token = getNodeCrypto().randomBytes(tokenBytes).toString("hex");
    tokens.set(token, t + ttlMs);
    log({ source: "one-time-flow", event: "mint", identity });
    // The token appears ONLY in the header value, never in the body.
    return { headers: { "x-flow-token": token }, body: { flow: flowName, expires_in_s: ttlMs / 1000 } };
  };

  const authorize = (identity: string, presented: string | null | undefined): OneTimeFlowAuthorizeResult => {
    if (!required(identity)) return { ok: true, skipped: true };
    if (presented === undefined || presented === null || presented === "") {
      log({ source: "one-time-flow", event: "rejected", identity, error: "flow_token_required" });
      return { ok: false, status: 403, error: "flow_token_required" };
    }
    const expiresAt = tokens.get(presented);
    if (expiresAt === undefined || expiresAt < now()) {
      tokens.delete(presented); // expired tokens are deleted on access
      log({ source: "one-time-flow", event: "rejected", identity, error: "flow_token_invalid" });
      return { ok: false, status: 403, error: "flow_token_invalid" };
    }
    tokens.delete(presented); // single-use: consume on success
    log({ source: "one-time-flow", event: "authorized", identity });
    return { ok: true };
  };

  return { enabled, required, mint, authorize };
}
