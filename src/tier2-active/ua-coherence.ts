/**
 * UA coherence check (NHS-05, antiRea 3.1.0), beside
 * header-coherence.ts (UAS-01). The two modules measure different
 * things and must not be conflated: UAS-01 is a weighted multi-signal
 * score over browser claims; this one is the Sentinel coherence rule
 * (sentinel_coherence.c) - a boolean flag when a browser-claiming UA
 * is missing ANY expected request component.
 *
 * THE RULE (frozen in the NHS Step-0 lab, nhs-lab/nhs05.cjs,
 * RESULTS-NHS-STEP0.md, reading R-NHS-4 - the corrected reading:
 * flag on ANY missing component, not "any present clears"):
 * - SCOPE: the UA must contain one of Chrome/ Firefox/ Safari/ Edg/
 *   Gecko/ (case-SENSITIVE substring, as in the source). Any other
 *   UA - curl, empty, absent - is out of scope and never flags.
 * - FLAG iff any of: no non-empty Accept; no non-empty
 *   Accept-Language; Accept-Encoding contains neither "gzip" nor
 *   "br"; or the HTTP version is below 1.1.
 * - The gzip/br substring test is case-SENSITIVE in the source code
 *   (its comment claims case-insensitivity the code does not
 *   implement); this port follows the code, as the lab did.
 *
 * Advisory only (enforcement: "none"): a coherence flag says the
 * request shape does not match its UA claim, nothing more. It must
 * never be a sole blocking key.
 *
 * LAB EVIDENCE (Step-0, synthetic and frozen). Flag stratum 6/6
 * (each single missing component flags, including missing-all);
 * clean stratum 0/2 (complete Chrome and Firefox shapes); scope
 * stratum 0/4 (curl with or without the shape, empty UA, absent UA
 * never flag). The strata are small: no field FP rate is claimed.
 */

const SCOPE_SUBSTRINGS: readonly string[] = Object.freeze(["Chrome/", "Firefox/", "Safari/", "Edg/", "Gecko/"]);

export type UaCoherenceMissing = "accept" | "accept_language" | "accept_encoding_compression" | "http_version";

export interface UaCoherenceRequest {
  /** Raw User-Agent; null or absent means out of scope. */
  userAgent?: string | null;
  /** Request headers; names matched case-insensitively, values must be non-empty to count. */
  headers: Record<string, string | undefined>;
  /** HTTP version as a number (1.0, 1.1, 2). Default 1.1. */
  httpVersion?: number;
}

export interface UaCoherenceResult {
  kind: "ua_coherence";
  /** True when the UA carries a browser-claim substring and the check ran. */
  inScope: boolean;
  /** Missing components, in the source's evaluation order. Empty when clean or out of scope. */
  missing: UaCoherenceMissing[];
  /** inScope AND at least one component missing. */
  flagged: boolean;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
}

/** Run the NHS-05 coherence check on one request. Pure, no state. */
export function analyzeUaCoherence(request: UaCoherenceRequest): UaCoherenceResult {
  const ua = request.userAgent ?? null;
  const inScope = typeof ua === "string" && SCOPE_SUBSTRINGS.some((s) => ua.includes(s));
  const missing: UaCoherenceMissing[] = [];
  if (inScope) {
    const h: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (typeof value === "string") h[name.toLowerCase()] = value;
    }
    const version = request.httpVersion ?? 1.1;
    if (!h["accept"]) missing.push("accept");
    if (!h["accept-language"]) missing.push("accept_language");
    const ae = h["accept-encoding"] ?? "";
    if (!(ae.includes("gzip") || ae.includes("br"))) missing.push("accept_encoding_compression");
    if (!(version >= 1.1)) missing.push("http_version");
  }
  return {
    kind: "ua_coherence",
    inScope,
    missing,
    flagged: inScope && missing.length > 0,
    enforcement: "none",
  };
}
