/**
 * Allowlist CIDR short-circuit (NHS-15, antiRea 3.1.0).
 *
 * HIGHEST BLAST RADIUS CLASS - READ BEFORE WIRING. An allowlist
 * short-circuit is an exemption path inside scoring: a wiring error
 * here silently zeroes scores for traffic that was never meant to
 * be exempt. This module is therefore behind explicit opt-in (it
 * does nothing unless a host constructs it with its own CIDR list
 * and calls score()), it is a pure function of its inputs (no state,
 * no I/O), and the one interaction that makes it survivable is
 * encoded exactly as measured and cannot be configured away:
 *
 *   A FEED BAN STILL WINS OVER THE ALLOWLIST, SCORING EXACTLY 100.
 *
 * THE RULE (frozen in the NHS Step-0 lab, nhs-lab/nhs15.cjs,
 * RESULTS-NHS-STEP0.md; mechanism source sentinel_score.c subset):
 * - known-good UA AND no CrowdSec hit AND no FCrDNS spoof -> 0;
 * - allowlisted IP AND no CrowdSec hit -> 0;
 * - otherwise the weighted sum: bot 30, plus a CrowdSec hit at
 *   100 x tier (ban 1.00 / captcha 0.40 / throttle 0.65).
 * The ban-wins case follows from the rule's structure: a CrowdSec
 * hit disables BOTH short-circuits, so an allowlisted, banned IP
 * scores the full 100 (its bot weight, if any, is not in that
 * fixture because the hit replaces the bot-only path in the lab
 * row - see the test: the R3 row carries no bot flag; a banned AND
 * bot-flagged input scores 130 under the same sum, which the suite
 * also pins so the arithmetic is never a surprise).
 *
 * Scope: IPv4 CIDRs, as in the lab. A non-IPv4 input IP is never
 * allowlisted by this module (it falls through to the weighted
 * sum); IPv6 allowlisting is a gap, not a silent pass.
 *
 * LAB EVIDENCE (Step-0, synthetic and frozen). Allowlisted IPs
 * score 0 including both CIDR edge addresses; allowlist + ban
 * scores exactly 100; outside and one-bit-outside score the normal
 * bot weight 30; an empty allowlist zeroes nothing.
 */

export type AllowlistCrowdsecTier = "ban" | "captcha" | "throttle";

export const ALLOWLIST_TIER_WEIGHTS: Readonly<Record<AllowlistCrowdsecTier, number>> = Object.freeze({
  ban: 1.0,
  captcha: 0.4,
  throttle: 0.65,
});
export const ALLOWLIST_BOT_WEIGHT = 30;
export const ALLOWLIST_CROWDSEC_BASE = 100;

function ipv4ToInt(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = ((v << 8) | n) >>> 0;
  }
  return v;
}

function cidrContains(cidr: string, ipInt: number): boolean {
  const slash = cidr.lastIndexOf("/");
  if (slash < 0) return false;
  const base = ipv4ToInt(cidr.slice(0, slash));
  const len = Number(cidr.slice(slash + 1));
  if (base === null || !Number.isInteger(len) || len < 0 || len > 32) return false;
  if (len === 0) return true;
  const mask = (0xffffffff << (32 - len)) >>> 0;
  return (base & mask) === (ipInt & mask);
}

export interface AllowlistScoreInput {
  ip: string;
  bot?: boolean;
  /** The CrowdSec tier hit for this IP, when a feed lookup hit. */
  crowdsec?: AllowlistCrowdsecTier | null;
  /** Host-asserted known-good UA lane (the score.c known_good input). */
  knownGood?: boolean;
  /** True when FCrDNS proved a spoof for this IP (BS-01 spoofed fact). */
  fcrdnsSpoofed?: boolean;
}

export interface AllowlistScoreResult {
  kind: "allowlist_score";
  score: number;
  allowlisted: boolean;
  /** Which short-circuit fired, or null when the weighted sum ran. */
  shortCircuit: "known_good" | "allowlist" | null;
  /** Always true when a CrowdSec hit disabled the short-circuits. */
  crowdsecOverrides: boolean;
}

/**
 * Create the allowlist scorer over a host-declared IPv4 CIDR list.
 * Explicit opt-in: constructing this with a list IS the opt-in, and
 * the ban-wins interaction is not configurable. Invalid CIDR
 * entries throw at construction - a silently dropped allowlist
 * entry would widen the exemption without anyone noticing.
 */
export function createAllowlistScorer(options: { allowlist: readonly string[] }): {
  score(input: AllowlistScoreInput): AllowlistScoreResult;
} {
  const list = [...(options?.allowlist ?? [])];
  for (const c of list) {
    const slash = typeof c === "string" ? c.lastIndexOf("/") : -1;
    const base = slash >= 0 ? ipv4ToInt(c.slice(0, slash)) : null;
    const len = slash >= 0 ? Number(c.slice(slash + 1)) : NaN;
    if (base === null || !Number.isInteger(len) || len < 0 || len > 32) {
      throw new TypeError(`allowlist scoring: invalid IPv4 CIDR entry ${JSON.stringify(c)}`);
    }
  }
  function score(input: AllowlistScoreInput): AllowlistScoreResult {
    const crowdsecHit = input.crowdsec != null;
    const ipInt = ipv4ToInt(input.ip);
    const allowlisted = ipInt !== null && list.some((c) => cidrContains(c, ipInt));
    if (input.knownGood === true && !crowdsecHit && input.fcrdnsSpoofed !== true) {
      return { kind: "allowlist_score", score: 0, allowlisted, shortCircuit: "known_good", crowdsecOverrides: false };
    }
    if (allowlisted && !crowdsecHit) {
      return { kind: "allowlist_score", score: 0, allowlisted, shortCircuit: "allowlist", crowdsecOverrides: false };
    }
    const total =
      (input.bot ? ALLOWLIST_BOT_WEIGHT : 0) +
      (crowdsecHit ? ALLOWLIST_CROWDSEC_BASE * (ALLOWLIST_TIER_WEIGHTS[input.crowdsec as AllowlistCrowdsecTier] as number) : 0);
    return { kind: "allowlist_score", score: total, allowlisted, shortCircuit: null, crowdsecOverrides: crowdsecHit };
  }
  return { score };
}
