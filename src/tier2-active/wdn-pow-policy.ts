/**
 * PoW difficulty policy helper (WDN-07, WebDecoy pow scaling port).
 *
 * A POLICY HELPER for host proof-of-work verifiers: given an IP and its
 * recent hit counts, it returns the difficulty a host challenge issuer
 * should demand, and it evaluates the server-clock too-fast floor for
 * a submitted solve. antiRea does not bundle challenges (the CAP-01
 * conclusion: hosts plug in their own verifiers), so this module is
 * deliberately NOT wired into any enforcement path - it computes
 * values, issues nothing, verifies nothing, blocks nothing.
 *
 * Measured in the WDN Step-0 lab (wdn-lab/wdn07.cjs) on frozen
 * fixtures: difficulty scaling exact - residential/fresh 4,
 * datacenter/fresh 5, residential + 11 hits in 60 s = 5, datacenter +
 * 11 hits = 6, residential + 20 hits (limiter exceeded) = 6 - over the
 * verbatim 45-CIDR datacenter table (104.154.7.7 is inside
 * 104.154.0.0/15; 203.0.113.10 is in none). The too-fast floor reads
 * the SERVER clock only: a real difficulty-4 solve submitted at 900 ms
 * server elapsed is valid AND trips the 0.8 / 0.85 too-fast detection;
 * the same solve at 2500 ms is valid with no detection; the
 * client-reported duration (5000 ms in both) is ignored.
 *
 * Honesty scope: proof-of-work is a cost, not a proof of humanity.
 * The difficulty numbers are the lab's frozen policy values, not a
 * recommendation tuned to any host's traffic.
 *
 * Pure computation: no I/O, no state, no runtime dependencies.
 */

/** The lab's verbatim datacenter CIDR table (45 entries). */
export const DATACENTER_CIDRS: readonly string[] = Object.freeze([
  "3.0.0.0/8", "13.0.0.0/8", "18.0.0.0/8", "34.0.0.0/8", "35.0.0.0/8",
  "52.0.0.0/8", "54.0.0.0/8", "99.0.0.0/8",
  "34.64.0.0/10", "35.184.0.0/13", "104.154.0.0/15", "104.196.0.0/14",
  "13.64.0.0/11", "20.0.0.0/8", "40.64.0.0/10", "52.224.0.0/11",
  "64.225.0.0/16", "68.183.0.0/16", "104.131.0.0/16", "134.209.0.0/16",
  "138.68.0.0/16", "139.59.0.0/16", "142.93.0.0/16", "157.245.0.0/16",
  "45.33.0.0/16", "45.56.0.0/16", "45.79.0.0/16", "139.162.0.0/16",
  "45.32.0.0/16", "45.63.0.0/16", "45.76.0.0/16", "108.61.0.0/16",
  "5.9.0.0/16", "46.4.0.0/14", "78.46.0.0/15", "88.99.0.0/16",
  "95.216.0.0/14", "135.181.0.0/16",
  "51.38.0.0/16", "51.68.0.0/16", "51.75.0.0/16", "137.74.0.0/16",
  "139.99.0.0/16", "144.217.0.0/16", "149.56.0.0/16",
]);

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function ipv4ToLong(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
}

function cidrContains(cidr: string, ip: string): boolean {
  const [range, bitsRaw] = cidr.split("/");
  const bits = parseInt(bitsRaw!, 10);
  const mask = (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(range!) & mask);
}

/** True when the IPv4 address falls inside the lab's datacenter CIDR table. Non-IPv4 input is false. */
export function isDatacenterIp(ip: string): boolean {
  if (!IPV4_RE.test(ip)) return false;
  return DATACENTER_CIDRS.some((c) => cidrContains(c, ip));
}

export interface PowDifficultyInput {
  ip: string;
  /**
   * The caller's hit count inside the current 60 s window as the
   * host's rate limiter reports it at scaling time (the lab's limiter
   * records the current check before the count is read: the frozen
   * "+11 hits" case is 11 pre-loaded hits plus that check, count 12).
   */
  hitCount: number;
  /** Whether the host's limiter reports this caller as over its maximum (20 in the lab). When true, difficulty is 6. */
  limiterExceeded: boolean;
}

/**
 * The lab's scaling law: base 4; datacenter 5; a hit count above 10
 * adds 1 (capped at 6); limiter exceeded forces 6.
 */
export function scalePowDifficulty(input: PowDifficultyInput): number {
  let difficulty = 4;
  if (isDatacenterIp(input.ip)) difficulty = 5;
  if (input.hitCount > 10) difficulty = Math.min(6, difficulty + 1);
  if (input.limiterExceeded) difficulty = 6;
  return difficulty;
}

export interface PowTooFastResult {
  /** True when the server-measured elapsed time is under the floor. */
  tooFast: boolean;
  /** The frozen detection values when tooFast, else null. */
  detection: { category: "bot"; score: 0.8; confidence: 0.85; reason: string } | null;
}

/**
 * The server-clock too-fast floor: a solve whose SERVER-measured
 * elapsed time is under 1500 ms trips the 0.8 / 0.85 detection.
 * Client-reported durations are never read - the caller passes only
 * the server-measured value (issued-at and submitted-at on the server
 * clock), which is the whole point of the floor.
 */
export function evaluatePowTooFast(serverElapsedMs: number): PowTooFastResult {
  if (Number.isFinite(serverElapsedMs) && serverElapsedMs < 1500) {
    return {
      tooFast: true,
      detection: {
        category: "bot",
        score: 0.8,
        confidence: 0.85,
        reason: `Challenge solved too fast (${serverElapsedMs}ms server-side)`,
      },
    };
  }
  return { tooFast: false, detection: null };
}
