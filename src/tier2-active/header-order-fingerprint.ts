/**
 * Header-order library fingerprint (ABG-01, Step-0 PASS-LAB, seed
 * 20321201) - port of tarrinho/AntiBotGW identity.py
 * `_header_order_sig` + `_LIBRARY_HEADER_SIGS` + `_is_library_headers`
 * (HEAD 580b46b).
 *
 * WHAT IT MEASURES. The ORDER of header names is the signal, not the
 * User-Agent. The signature is sha256[:12] of the ":"-joined lowercase
 * non-host header names in request order (joined string truncated to
 * 300 characters). A request flags iff its signature exactly equals
 * one of the 6 frozen library signatures. UA is not an input to the
 * source check and is not an input here: a browser-UA request carrying
 * a library order MUST flag, and a library-UA request carrying a
 * browser order MUST NOT flag (R-ABG-1 operative pair, verified in the
 * lab controls CTRL-A / CTRL-B).
 *
 * EXACT MATCH ONLY (binding). Firefox and Safari navigation orders
 * start "user-agent:accept:...", a prefix of the curl signature, and
 * do NOT flag: the signature is an exact ordered string, never a
 * prefix match. One renamed header in a library order breaks the
 * signature (CTRL-C). A shuffled library order breaks the signature
 * in 9 of 10 seeded draws; the 1 flagged draw was the identity
 * permutation (the shuffle that did not shuffle).
 *
 * FIXTURE SIZE, HONESTLY. The lab fixture is small: 10 requests
 * (6 library orders, 3 browser orders, 1 shuffled order) plus 3
 * controls. This module encodes exactly that. No broader detection
 * rate, no real-traffic false-positive rate, is claimed: the 3
 * browser orders are hand-built fixtures, not a corpus. Header order
 * is L7 and spoofable by reordering headers.
 *
 * ADVISORY ONLY, OPT-IN. Every result carries enforcement: "none".
 * A flag is an advisory scoring input beside header-coherence.ts; it
 * must never be a sole blocking key and never an exemption. Nothing
 * runs until the host calls this module.
 *
 * Pure computation: no I/O, no state. Node.js builtins only
 * (node:crypto SHA-256); zero runtime dependencies.
 */

interface NodeHashLike {
  update(data: string, encoding?: string): NodeHashLike;
  digest(encoding: string): string;
}

interface NodeCryptoLike {
  createHash(algorithm: string): NodeHashLike;
}

declare const require: ((id: string) => NodeCryptoLike) | undefined;

function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.createHash === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; header-order signatures require Node.js");
}

/** The 6 frozen library header-order signatures from the source, verified Node == Python in the lab. */
export const LIBRARY_HEADER_ORDER_SIGS: readonly string[] = Object.freeze([
  "ac39ae9a8f83",
  "0ed4a94f4d3f",
  "1dba901e91c2",
  "53b351d4e0dc",
  "9ca1efdf057b",
  "d943b0e3af30",
]);

const LIBRARY_SIG_SET = new Set<string>(LIBRARY_HEADER_ORDER_SIGS);

/**
 * The 6 library header-name orders (lowercase, host excluded) whose
 * signatures are frozen above, in the lab fixture order L1..L6.
 * Exported so hosts and tests can see exactly what is matched.
 */
export const LIBRARY_HEADER_ORDERS: ReadonlyArray<readonly string[]> = Object.freeze([
  Object.freeze(["user-agent", "accept-encoding", "accept", "connection"]),
  Object.freeze(["user-agent", "accept-encoding", "accept"]),
  Object.freeze(["user-agent", "accept"]),
  Object.freeze(["user-agent", "accept-encoding"]),
  Object.freeze(["accept", "accept-encoding", "accept-language", "user-agent", "connection"]),
  Object.freeze(["accept", "accept-encoding", "accept-language", "user-agent"]),
]);

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): the order of header names exactly matches a known " +
  "HTTP-library order. The User-Agent is not an input. Exact match only: a Firefox/Safari prefix " +
  "of a library signature does not flag. Lab fixture is small (10 requests); no real-traffic " +
  "false-positive rate is claimed. Never a sole blocking key, never an exemption.";

/**
 * Compute the header-order signature: sha256[:12] of the ":"-joined
 * lowercase non-host header names in the given order, the joined
 * string truncated to 300 characters (source semantics verbatim).
 */
export function headerOrderSignature(headerNames: readonly string[]): string {
  const joined = headerNames
    .map((n) => String(n).toLowerCase())
    .filter((n) => n !== "host")
    .join(":")
    .slice(0, 300);
  return getNodeCrypto().createHash("sha256").update(joined, "utf8").digest("hex").slice(0, 12);
}

/** True iff the header-name order exactly matches a frozen library signature. */
export function isLibraryHeaderOrder(headerNames: readonly string[]): boolean {
  return LIBRARY_SIG_SET.has(headerOrderSignature(headerNames));
}

export interface HeaderOrderRequest {
  /** Header names in request (wire) order. Case-insensitive; "host" is excluded. */
  headerNames: readonly string[];
  /**
   * Accepted for host convenience and deliberately IGNORED by the
   * verdict: the source check reads header names only (R-ABG-1).
   */
  userAgent?: string;
}

export interface HeaderOrderResult {
  kind: "header_order_fingerprint";
  /** The computed signature, sha256[:12] hex. */
  signature: string;
  /** True iff the signature exactly equals a frozen library signature. */
  flagged: boolean;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

/** Score one request's header order against the frozen library signatures. */
export function analyzeHeaderOrder(request: HeaderOrderRequest): HeaderOrderResult {
  const names = Array.isArray(request?.headerNames) ? request.headerNames : [];
  const signature = headerOrderSignature(names);
  return {
    kind: "header_order_fingerprint",
    signature,
    flagged: LIBRARY_SIG_SET.has(signature),
    enforcement: "none",
    notice: ADVISORY_NOTICE,
  };
}
