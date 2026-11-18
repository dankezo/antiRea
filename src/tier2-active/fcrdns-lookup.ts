/**
 * FCrDNS lookup with cache, TTL and pending semantics (NHS-03,
 * antiRea 3.1.0), feeding the shipped BS-01 verification facts
 * (verification-fact.ts).
 *
 * WHAT IT IS. Forward-confirmed reverse DNS for a claimant IP: the
 * host supplies an async resolver (this module performs no DNS
 * itself and adds no dependency); the lookup reverse-resolves the
 * IP, checks the PTR host against the host's allowed suffixes, then
 * forward-confirms that the host resolves back to the IP. Outcomes
 * map onto BS-01 facts through classifyHostVerificationFact:
 * VERIFIED is "forward-confirmed match" (evidence delta 0), FAILED
 * is "contradiction" (the only FCrDNS outcome that carries
 * evidence), PENDING is "lookup failure" (delta 0).
 *
 * SEMANTICS (frozen in the NHS Step-0 lab, nhs-lab/nhs03.cjs,
 * RESULTS-NHS-STEP0.md; mechanism source sentinel_fcrdns.c):
 * - Only positive disproof is cached: a PTR whose suffix does not
 *   match, or whose forward lookup does not contain the IP, caches
 *   FAILED; a confirmed match caches VERIFIED. No-PTR and transient
 *   resolver errors cache NOTHING and re-resolve on the next request.
 * - Cache TTL is 3600 s by default: a within-TTL repeat costs zero
 *   resolver calls; after expiry the next request re-resolves.
 * - PENDING SEMANTICS / THE KNOWN WINDOW (recorded, not hidden):
 *   resolution completes between requests, so the FIRST request
 *   from an unknown IP is served under the legacy short-circuit
 *   while its state is PENDING - the suppress only bites from the
 *   second request on. Every caller can see this in the result:
 *   a PENDING result is the window, printed.
 * - WIRING MEASURED IN THE LAB: under the same scanner input, a
 *   spoofed (FAILED) wiring scores 50 while a VERIFIED wiring
 *   scores 0 - because VERIFIED and PENDING short-circuit and
 *   FAILED does not. scoreUnderFcrdnsState() below is that exact
 *   wiring, exported so hosts reproduce it rather than reinvent it.
 *
 * LAB EVIDENCE (Step-0, synthetic resolver fixtures; no real DNS).
 * 2 VERIFIED, 2 FAILED (wrong suffix; forward mismatch), 2
 * PENDING-uncached (no-PTR and transient error, 2 resolver calls
 * each across 2 requests); within-TTL repeat 0 extra calls,
 * post-TTL exactly 1 re-resolve.
 */

import { classifyHostVerificationFact, type VerificationFact } from "./verification-fact";

export type FcrdnsState = "VERIFIED" | "FAILED" | "PENDING";

export type FcrdnsResolverResult =
  | { type: "ptr"; host: string; forward: readonly string[] }
  | { type: "noptr" }
  | { type: "error" };

/** Host-supplied resolver: one reverse + forward resolution for an IP. May be sync or async. */
export type FcrdnsResolver = (ip: string) => FcrdnsResolverResult | Promise<FcrdnsResolverResult>;

export interface FcrdnsLookupOptions {
  resolve: FcrdnsResolver;
  /** Allowed PTR suffixes, e.g. [".googlebot.com"]. A PTR host must end with one of them. */
  suffixes: readonly string[];
  /** Cache TTL in milliseconds. Default 3_600_000 (3600 s, the lab value). */
  ttlMs?: number;
  /** Clock override, milliseconds. Default Date.now. */
  now?: () => number;
}

export interface FcrdnsLookupResult {
  kind: "fcrdns";
  ip: string;
  /** The state THIS request is served under (PENDING for a first, uncached request). */
  state: FcrdnsState;
  /** True when the state came from the cache (zero resolver calls). */
  cached: boolean;
  /** The BS-01 fact for the served state (delta 0 unless FAILED). */
  fact: VerificationFact;
}

export function fcrdnsFactForState(state: FcrdnsState): VerificationFact {
  if (state === "VERIFIED") return classifyHostVerificationFact("fcrdns", "forward-confirmed match");
  if (state === "FAILED") return classifyHostVerificationFact("fcrdns", "contradiction");
  return classifyHostVerificationFact("fcrdns", "lookup failure");
}

/**
 * The lab's measured score wiring: VERIFIED and PENDING short-circuit
 * (score 0); FAILED does not, so a scanner input scores exactly 50.
 */
export function scoreUnderFcrdnsState(state: FcrdnsState, scannerInput: boolean): number {
  const shortCircuit = state === "VERIFIED" || state === "PENDING";
  return shortCircuit ? 0 : scannerInput ? 50 : 0;
}

/** Create an FCrDNS lookup with the frozen cache/TTL/pending semantics. Opt-in utility. */
export function createFcrdnsLookup(options: FcrdnsLookupOptions): {
  lookup(ip: string): Promise<FcrdnsLookupResult>;
  cacheSize(): number;
} {
  if (typeof options?.resolve !== "function") {
    throw new TypeError("fcrdns lookup: a host-supplied resolve function is required");
  }
  const ttlMs = options.ttlMs ?? 3_600_000;
  const now = options.now ?? Date.now;
  const suffixes = [...options.suffixes];
  const cache = new Map<string, { state: "VERIFIED" | "FAILED"; expires: number }>();

  async function lookup(ip: string): Promise<FcrdnsLookupResult> {
    const t = now();
    const c = cache.get(ip);
    if (c && t < c.expires) {
      return { kind: "fcrdns", ip, state: c.state, cached: true, fact: fcrdnsFactForState(c.state) };
    }
    let r: FcrdnsResolverResult;
    try {
      r = await options.resolve(ip);
    } catch {
      r = { type: "error" };
    }
    let verdict: "VERIFIED" | "FAILED" | null = null;
    if (r && r.type === "ptr") {
      const suffixOk = suffixes.some((s) => r.host.endsWith(s));
      verdict = suffixOk && r.forward.includes(ip) ? "VERIFIED" : "FAILED";
    }
    if (verdict) cache.set(ip, { state: verdict, expires: t + ttlMs });
    // The resolving request itself is always served PENDING (the known window).
    return { kind: "fcrdns", ip, state: "PENDING", cached: false, fact: fcrdnsFactForState("PENDING") };
  }

  return { lookup, cacheSize: () => cache.size };
}
