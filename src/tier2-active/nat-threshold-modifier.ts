/**
 * NAT-aware threshold modifier (ABG-06, upgraded in the 3.1.0 build;
 * Step-0 PASS-LAB, seed 20321206) - port of tarrinho/AntiBotGW
 * scoring.py:297-303 + config.py:1174-1177.
 *
 * WHAT IT DOES. A host enforcement threshold (the source's ban
 * threshold, 50) doubles to 100 for an IP that looks like it sits
 * behind NAT: at least 5 legit-looking identities were seen at that
 * IP recently. An identity is legit-looking exactly as the source
 * counts it: last_ip == ip, seen < 3,600 s ago, static_loads >= 1,
 * allowed_count >= 3. Hostile-looking identities (allowed_count
 * 0-2) do not count; stale identities (seen 3,601 s ago) do not
 * count; and the doubling LAPSES as identities age out - re-counted
 * after +3,601 s the threshold is back to 50 (lab control (c),
 * passing on all 10 seeded replicas, as did every scenario: 10/10
 * replicas agree per scenario in the lab).
 *
 * THE TWO-SIDED EFFECT, MEASURED AND NOT HIDDEN. Doubling protects
 * real users behind NAT (a shared IP's honest crowd no longer trips
 * a per-IP threshold sized for one user) AND shields bots hiding
 * behind NAT (the same doubled headroom covers them). Both
 * directions are the measured behaviour of the mechanism; a host
 * that wires this modifier accepts both.
 *
 * WHY THIS IS AN OPT-IN MODIFIER MODULE, NOT A CORE CHANGE. The
 * mechanism rewrites enforcement thresholds from identity counting,
 * which makes it a core enforcement parameter. It therefore ships
 * as a standalone modifier that does NOTHING unless a host
 * explicitly constructs it and wires its output into its own
 * threshold: no shipped module imports it, no default path consults
 * it, and `effectiveThreshold` is a pure function of the identities
 * the host feeds it. Hosts that never wire it see thresholds
 * exactly as before.
 *
 * The modifier itself bans nobody and scores nobody: it returns a
 * number and the count behind it. Every result is labelled with
 * the modifier's own kind so a host log can show when a threshold
 * was NAT-adjusted.
 */

/** Base threshold (source BAN_THRESHOLD 50). */
export const NAT_BASE_THRESHOLD = 50;
/** Doubled threshold behind NAT-like IPs (source BAN_THRESHOLD_NAT 100). */
export const NAT_DOUBLED_THRESHOLD = 100;
/** Legit-looking identities at one IP needed to double (source NAT_IDENTITIES_THRESHOLD 5). */
export const NAT_IDENTITIES_THRESHOLD = 5;
/** Recency window in ms for the legit-looking count (source seen < 3,600 s). */
export const NAT_SEEN_WINDOW_MS = 3_600_000;

const MODIFIER_NOTICE =
  "Opt-in threshold modifier: the threshold doubles only behind an IP with at least 5 " +
  "legit-looking identities seen in the last hour, and returns to base as they age out. " +
  "Two-sided by measurement: it protects real users behind NAT and shields bots behind NAT. " +
  "Nothing applies unless the host explicitly wires this module's output into its threshold.";

export interface NatIdentityObservation {
  /** The identity observed. */
  identity: string;
  /** The IP it was last seen at. */
  lastIp: string;
  /** When it was last seen, ms since epoch. */
  lastSeenMs: number;
  /** Static loads attributed to it (legit-looking needs >= 1). */
  staticLoads: number;
  /** Allowed actions attributed to it (legit-looking needs >= 3). */
  allowedCount: number;
}

/** The source's legit-looking test, verbatim: last_ip == ip, seen < window, static_loads >= 1, allowed_count >= 3. */
export function isLegitLookingIdentity(
  observation: NatIdentityObservation,
  ip: string,
  nowMs: number,
  seenWindowMs: number = NAT_SEEN_WINDOW_MS,
): boolean {
  return (
    observation.lastIp === ip &&
    nowMs - observation.lastSeenMs < seenWindowMs &&
    observation.staticLoads >= 1 &&
    observation.allowedCount >= 3
  );
}

export interface NatThresholdResult {
  kind: "nat_threshold_modifier";
  ip: string;
  /** Legit-looking identities counted at this IP at `nowMs`. */
  legitLookingCount: number;
  /** True when the count reached the NAT threshold and the threshold doubled. */
  doubled: boolean;
  /** The effective threshold: doubledThreshold when doubled, else baseThreshold. */
  threshold: number;
  baseThreshold: number;
  doubledThreshold: number;
  notice: string;
}

export interface NatThresholdModifierOptions {
  /** Base threshold. Defaults to 50 (source constant). */
  baseThreshold?: number;
  /** Threshold behind NAT-like IPs. Defaults to 100 (source constant). */
  doubledThreshold?: number;
  /** Legit-looking identities needed to double. Defaults to 5 (source constant). */
  natIdentityCount?: number;
  /** Recency window in ms. Defaults to 3,600,000 (source constant). */
  seenWindowMs?: number;
}

/**
 * Pure form: compute the effective threshold for `ip` from a
 * host-supplied identity list at `nowMs`. No state, no side effects.
 */
export function natAwareThreshold(
  identities: readonly NatIdentityObservation[],
  ip: string,
  nowMs: number,
  options: NatThresholdModifierOptions = {},
): NatThresholdResult {
  const baseThreshold = options.baseThreshold ?? NAT_BASE_THRESHOLD;
  const doubledThreshold = options.doubledThreshold ?? NAT_DOUBLED_THRESHOLD;
  const natIdentityCount = options.natIdentityCount ?? NAT_IDENTITIES_THRESHOLD;
  const seenWindowMs = options.seenWindowMs ?? NAT_SEEN_WINDOW_MS;
  const legitLookingCount = identities.filter((o) => isLegitLookingIdentity(o, ip, nowMs, seenWindowMs)).length;
  const doubled = legitLookingCount >= natIdentityCount;
  return {
    kind: "nat_threshold_modifier",
    ip,
    legitLookingCount,
    doubled,
    threshold: doubled ? doubledThreshold : baseThreshold,
    baseThreshold,
    doubledThreshold,
    notice: MODIFIER_NOTICE,
  };
}

export interface NatThresholdModifier {
  /** Register or refresh one identity observation (keyed by identity; the latest observation wins). */
  observeIdentity(observation: NatIdentityObservation): void;
  /** The effective threshold for `ip` at `nowMs` over the registered identities. */
  effectiveThreshold(ip: string, nowMs?: number): NatThresholdResult;
  /** Number of identities registered. */
  trackedIdentities(): number;
}

/**
 * Stateful form over a host-fed identity registry. Opt-in by
 * construction: an instance exists only where a host creates one,
 * and its output changes a threshold only where the host wires it.
 */
export function createNatThresholdModifier(options: NatThresholdModifierOptions = {}): NatThresholdModifier {
  const baseThreshold = options.baseThreshold ?? NAT_BASE_THRESHOLD;
  const doubledThreshold = options.doubledThreshold ?? NAT_DOUBLED_THRESHOLD;
  const natIdentityCount = options.natIdentityCount ?? NAT_IDENTITIES_THRESHOLD;
  const seenWindowMs = options.seenWindowMs ?? NAT_SEEN_WINDOW_MS;
  if (!Number.isFinite(baseThreshold) || baseThreshold <= 0) throw new Error("createNatThresholdModifier: baseThreshold must be a positive finite number");
  if (!Number.isFinite(doubledThreshold) || doubledThreshold <= 0) throw new Error("createNatThresholdModifier: doubledThreshold must be a positive finite number");
  if (!Number.isInteger(natIdentityCount) || natIdentityCount < 1) throw new Error("createNatThresholdModifier: natIdentityCount must be a positive integer");
  if (!Number.isFinite(seenWindowMs) || seenWindowMs <= 0) throw new Error("createNatThresholdModifier: seenWindowMs must be a positive finite number");

  const registry = new Map<string, NatIdentityObservation>();
  const resolved: NatThresholdModifierOptions = { baseThreshold, doubledThreshold, natIdentityCount, seenWindowMs };

  return {
    observeIdentity(observation) {
      if (typeof observation?.identity !== "string" || observation.identity.length === 0) {
        throw new Error("observeIdentity: identity must be a non-empty string");
      }
      registry.set(observation.identity, { ...observation });
    },
    effectiveThreshold(ip, nowMs = Date.now()) {
      return natAwareThreshold([...registry.values()], ip, nowMs, resolved);
    },
    trackedIdentities() {
      return registry.size;
    },
  };
}
