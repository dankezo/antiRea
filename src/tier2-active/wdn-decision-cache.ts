/**
 * Decision-cache policy (WDN-12, WebDecoy decision-cache port) - an
 * opt-in cache wrapper module.
 *
 * The policy, encoded structurally rather than by documentation:
 * - cache NETWORK decisions only: a decision whose origin is "rule"
 *   is refused by set() whatever its conclusion, so a tripwire DENY is
 *   reported on every request and never absorbed by the cache;
 * - cache DENY (and CHALLENGE) conclusions only: an ALLOW is never
 *   stored, so the next request always re-derives it;
 * - entries live exactly the TTL (default 60,000 ms): a get at +61 s
 *   misses and the network is called again;
 * - capacity is capped (default 10,000) with oldest-first eviction:
 *   10,001 inserts leave the cache at 10,000 with the oldest key gone
 *   and the newest present.
 * The companion decider preserves the lab's ordering: rules run FIRST
 * on every request (so a rate limiter sees every request, even cache
 * hits), the cache is consulted only after rules produce no decision,
 * and only the network path can store. Cache hits restate every rule
 * result CACHED (WDN-09 taxonomy), so a served-from-cache decision
 * never impersonates a fresh run and never denies via deniedBy.
 *
 * Measured in the WDN Step-0 lab (wdn-lab/wdn12.cjs) on frozen
 * fixtures with an injected clock: DENY stored and re-served with
 * network calls still 1 while rule evaluations increment 1 to 2; +61 s
 * TTL miss with a second network call; ALLOW never stored; a rule DENY
 * requested twice reports the violation twice with 0 network calls and
 * cache size 0; eviction exact at 10,001 inserts.
 *
 * Opt-in: nothing in the SDK consults this cache implicitly. The clock
 * is injectable for tests; the default is Date.now.
 */

import { asCachedRuleDecision, type RuleOutcome } from "./wdn-rule-state";

export interface CacheableDecision {
  conclusion: "ALLOW" | "DENY" | "CHALLENGE";
  /** Where the decision came from. Rule-origin decisions are never cached. */
  origin: "network" | "rule";
  results?: RuleOutcome[];
  [key: string]: unknown;
}

export interface DecisionCacheOptions {
  /** Entry lifetime in milliseconds. Default 60,000 (lab-frozen). */
  ttlMs?: number;
  /** Capacity cap with oldest-first eviction. Default 10,000 (lab-frozen). */
  maxEntries?: number;
  /** Clock override (ms since epoch), mainly for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface DecisionCache {
  /** The stored decision for `key`, or undefined on a miss or after expiry (expired entries are dropped). */
  get(key: string): CacheableDecision | undefined;
  /**
   * Store a decision under `key`. Returns false - storing nothing -
   * for ALLOW conclusions, for rule-origin decisions, and when the
   * TTL is not positive.
   */
  set(key: string, decision: CacheableDecision): boolean;
  readonly size: number;
  readonly ttlMs: number;
}

/** Create a decision cache with the lab's policy defaults. */
export function createDecisionCache(options: DecisionCacheOptions = {}): DecisionCache {
  const ttlMs = options.ttlMs ?? 60_000;
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 10_000) || 10_000);
  const clock = options.now ?? (() => Date.now());
  const entries = new Map<string, { decision: CacheableDecision; expiresAt: number }>();

  return {
    get(key: string) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= clock()) {
        entries.delete(key);
        return undefined;
      }
      return entry.decision;
    },
    set(key: string, decision: CacheableDecision) {
      if (decision.conclusion !== "DENY" && decision.conclusion !== "CHALLENGE") return false;
      if (decision.origin !== "network") return false;
      if (ttlMs <= 0) return false;
      entries.delete(key);
      entries.set(key, { decision, expiresAt: clock() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return true;
    },
    get size() {
      return entries.size;
    },
    get ttlMs() {
      return ttlMs;
    },
  };
}

export interface CachedDecider {
  /**
   * Decide one request under the lab ordering: `runRules` runs first
   * on EVERY request; a rule decision is returned as-is and never
   * cached. Otherwise a cache hit is served restated CACHED; on a miss
   * `fetchNetwork` runs and its decision is offered to the cache
   * (stored only when the policy admits it).
   */
  decide(
    key: string,
    runRules: () => CacheableDecision | null,
    fetchNetwork: () => CacheableDecision,
  ): { decision: CacheableDecision; source: "rule" | "cache" | "network" };
}

/** Create the ordering-preserving decider over a decision cache. */
export function createCachedDecider(cache: DecisionCache): CachedDecider {
  return {
    decide(key, runRules, fetchNetwork) {
      const ruleDecision = runRules();
      if (ruleDecision) return { decision: ruleDecision, source: "rule" };
      const cached = cache.get(key);
      if (cached) {
        const restated = cached.results ? asCachedRuleDecision(cached as { results: RuleOutcome[] }) : cached;
        return { decision: restated as CacheableDecision, source: "cache" };
      }
      const decision = fetchNetwork();
      cache.set(key, decision);
      return { decision, source: "network" };
    },
  };
}
