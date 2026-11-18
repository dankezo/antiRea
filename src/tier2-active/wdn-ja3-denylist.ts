/**
 * JA3 static denylist (WDN-05, WebDecoy tls detector port).
 *
 * An exact-match table of 9 known bot-client JA3 hashes. A match yields
 * one advisory detection with the lab's frozen score 0.8 / confidence
 * 0.9 and the client name. Everything else fails open: an unknown hash,
 * a real browser hash, and empty/null/undefined input all produce no
 * detection. Matching is exact only - no prefix, pattern or fuzzy
 * behaviour.
 *
 * Measured in the WDN Step-0 lab (wdn-lab/wdn05.cjs): known hashes 9/9
 * with the frozen names and scores; the Chrome JA3
 * cd08e31494f9531f560d64c695473da9 does not match; a seeded random
 * 32-hex value asserted absent from the table does not match; empty
 * inputs produce no detection.
 *
 * NO JA4 TABLE IS BUILT. The source ships its JA4 table empty and no
 * JA4 data exists in the lab record, so there is deliberately no JA4
 * lookup here at all - inventing entries would fabricate the signal.
 *
 * Honesty scope: JA3 values are supplied by the host's TLS layer and
 * are client-spoofable - a match says the presented fingerprint equals
 * a known bot client's, not who the caller is. Advisory only
 * (enforcement: "none"), opt-in, never a sole blocking key.
 *
 * Pure computation: no I/O, no state, no runtime dependencies.
 */

/** The frozen 9-entry JA3 table: hash to client name, verbatim from the lab port. */
export const KNOWN_BOT_JA3_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "3b5074b1b5d032e5620f69f9f700ff0e": "Python requests",
  b32309a26951912be7dba376398abc3b: "Python urllib",
  "9e10692f1b7f78228b2d4e424db3a98c": "Go net/http",
  "473cd7cb9faa642487833865d516e578": "curl",
  c12f54a3f91dc7bafd92cb59fe009a35: "Wget",
  "2d1eb5817ece335c24904f516ad5da2f": "Java HttpClient",
  fc54fe03db02a25e1be5bb5a7678b7a4: "Node.js axios",
  "579ccef312d18482fc42e2b822ca2430": "Node.js node-fetch",
  "5d7974c9fe7862e0f9a3eb35a6a5d9c8": "Puppeteer default",
});

export interface Ja3Detection {
  kind: "ja3_detection";
  category: "bot";
  /** Frozen lab values: score 0.8, confidence 0.9 on every table match. */
  score: 0.8;
  confidence: 0.9;
  clientName: string;
  reason: string;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
}

/**
 * Check one host-supplied JA3 hash against the static table. Returns a
 * single detection on an exact match, or null for unknown, browser,
 * empty, null or undefined input (fail open).
 */
export function checkJa3Fingerprint(ja3Hash: string | null | undefined): Ja3Detection | null {
  if (!ja3Hash) return null;
  const clientName = KNOWN_BOT_JA3_HASHES[ja3Hash];
  if (!clientName) return null;
  return {
    kind: "ja3_detection",
    category: "bot",
    score: 0.8,
    confidence: 0.9,
    clientName,
    reason: `TLS fingerprint matches: ${clientName}`,
    enforcement: "none",
  };
}
