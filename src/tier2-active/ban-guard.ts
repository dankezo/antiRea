/**
 * Ban guard (ABS-03): a ban must not be frameable against an
 * unproven identity.
 *
 * The neighbour failure, measured in abs-lab (RESULTS-ABS-STEP0):
 * ONE spoofed request (a forwarding header naming the victim, a
 * selenium user agent) banned the victim for 600 s; the attacker's
 * own next request was served normally. The ban keyed on an
 * identity the request merely CLAIMED.
 *
 * antiRea ships no ban surface of its own - consequences have
 * always been the host's - so this module is the opt-in guard a
 * host wraps its ban issuance in. Two modes:
 *
 * - Default (legacy): `issueBan` bans the identity it is given.
 *   This is exactly the frameable behavior above, kept so existing
 *   host flows do not change silently; the guard reports its mode
 *   (`strictProvenIdentity`) so the choice is auditable.
 * - Strict (`strictProvenIdentity: true`): a ban issues ONLY when
 *   the caller presents a proof bound to the very identity being
 *   banned - the connection identity itself (the server observed
 *   this peer), an authenticated session identity, a verified
 *   step-up proof, or an issued nonce - with `verified: true` as
 *   attested by the host's own verification. A claim about an
 *   identity (a header value, a fingerprint, a self-declared id,
 *   the `claimedBy` field) is never proof, and a proof bound to a
 *   different identity bans nothing.
 *
 * Ban durations run on the monotonic clock; `expiresAt` is the
 * wall-clock rendering of the same instant. In-memory, single
 * process, zero runtime dependencies.
 */

import { resolveIntervalClock } from "../internal/mono-clock";

/** How a ban-target identity was proven. The host attests `verified` after its own check. */
export type BanProofKind = "connection" | "authenticated" | "step-up-proof" | "issued-nonce";

export interface BanIdentityProof {
  kind: BanProofKind;
  /** The identity this proof is bound to. Must equal the ban target in strict mode. */
  boundTo: string;
  /** True only when the host's own verification of this proof passed. */
  verified: boolean;
}

export interface BanGuardOptions {
  /**
   * Opt-in strict mode (ABS-03): bans require a verified proof
   * bound to the target identity. Default false (legacy behavior,
   * frameable - see the header).
   */
  strictProvenIdentity?: boolean;
  /** Ban length in milliseconds. Default 600,000 (the neighbour's measured 600 s). */
  banDurationMs?: number;
  /**
   * Opt-in challenge release valve (ABS-10): when true, a banned
   * identity that presents a verified challenge proof bound to
   * itself (`releaseViaChallenge`) is released immediately. Default
   * false - the neighbour's measured dead end: a banned client
   * passed the challenge verify, received its cookie, and was still
   * refused until the ban expired, because nothing connected the
   * successful verify to the ban.
   */
  challengeRelease?: boolean;
  /**
   * Opt-in subnet escalation with a collateral bound (ABS-11).
   * When at least `threshold` distinct identities in one IPv4 /24
   * hold PROVEN bans (see ABS-03 - unproven issuances never count,
   * so framed bans cannot escalate), the whole /24 is banned for
   * `subnetBanMs`, hard-capped at 900,000 ms whatever is configured.
   * Identities the host declares known-good (`markKnownGood`) are
   * exempt from the subnet ban. Default: no escalation at all.
   */
  subnetEscalation?: { threshold?: number; subnetBanMs?: number };
  /** Wall clock override, mainly for tests. */
  now?: () => number;
  /** Monotonic clock override: ban durations run on this clock. */
  monoNow?: () => number;
}

export type BanIssueResult =
  | { issued: true; expiresAt: number }
  | { issued: false; reason: "unproven_identity" | "invalid_identity" };

export interface BanState {
  banned: boolean;
  scope?: "identity" | "subnet";
  expiresAt?: number;
  remainingMs?: number;
}

export interface BanGuard {
  /** The mode this guard was built with (auditable at runtime). */
  readonly strictProvenIdentity: boolean;
  /**
   * Issue a ban against `identity`. In strict mode, `opts.proof`
   * must be a verified proof bound to `identity`; `opts.claimedBy`
   * records who asked and is never treated as evidence.
   */
  issueBan(identity: string, opts?: { proof?: BanIdentityProof; claimedBy?: string }): BanIssueResult;
  /** Current ban state for an identity (expired bans report `banned: false`). */
  isBanned(identity: string): BanState;
  /** Host-side lift of an active identity ban. True when one was lifted. */
  liftBan(identity: string): boolean;
  /**
   * ABS-10 release valve: lift `identity`'s ban when the guard was
   * built with `challengeRelease: true` and `proof` is a verified
   * proof bound to `identity` (the host verifies its step-up proof
   * first, then calls this). Without the opt-in, or with a proof
   * bound elsewhere or unverified, nothing is released.
   */
  releaseViaChallenge(
    identity: string,
    proof: BanIdentityProof,
  ): { released: boolean; reason?: "release_valve_disabled" | "not_banned" | "unproven_identity" };
  /**
   * ABS-11: the active subnet ban covering this identity's /24, or
   * null when no escalation is configured, the identity is not an
   * IPv4 address, or no subnet ban is active. This reports the
   * subnet record itself; known-good exemption is applied by
   * `isBanned`, not here.
   */
  subnetBanFor(identity: string): { subnet: string; expiresAt: number } | null;
  /** ABS-11: declare an identity known-good: exempt from subnet bans (never from its own ban). */
  markKnownGood(identity: string): void;
}

/** Hard cap on any subnet ban, in milliseconds: the neighbour's measured 900 s (ABS-11). */
export const MAX_SUBNET_BAN_MS = 900_000;

/** Named error thrown for invalid ban-guard options. */
export class BanGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BanGuardError";
  }
}

const PROOF_KINDS = new Set<string>(["connection", "authenticated", "step-up-proof", "issued-nonce"]);

export function createBanGuard(options: BanGuardOptions = {}): BanGuard {
  const strict = options.strictProvenIdentity === true;
  const duration = Math.floor(options.banDurationMs ?? 600_000);
  if (!Number.isFinite(duration) || duration < 1) {
    throw new BanGuardError("createBanGuard: banDurationMs must be a positive integer");
  }
  const { wall, mono } = resolveIntervalClock(options);
  const challengeRelease = options.challengeRelease === true;
  const subnetConfig = options.subnetEscalation
    ? {
        threshold: Math.max(1, Math.floor(options.subnetEscalation.threshold ?? 3) || 3),
        // Collateral bound (ABS-11): the subnet ban never outlives
        // the measured 900 s, whatever the host configured.
        subnetBanMs: Math.min(
          MAX_SUBNET_BAN_MS,
          Math.max(1, Math.floor(options.subnetEscalation.subnetBanMs ?? MAX_SUBNET_BAN_MS) || MAX_SUBNET_BAN_MS),
        ),
      }
    : null;
  const bans = new Map<string, { expiresAtWall: number; expiresAtMono: number }>();
  const subnetBans = new Map<string, { expiresAtWall: number; expiresAtMono: number }>();
  const provenBySubnet = new Map<string, Set<string>>();
  const knownGood = new Set<string>();

  /** IPv4 /24 key for an identity, or null for non-IPv4 identities (they never join a subnet). */
  const subnetKeyOf = (identity: string): string | null => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(identity);
    if (!m) return null;
    if (m.slice(1).some((octet) => Number(octet) > 255)) return null;
    return `${m[1]}.${m[2]}.${m[3]}.0/24`;
  };

  const activeSubnetBan = (identity: string): { subnet: string; expiresAtWall: number; remainingMs: number } | null => {
    if (!subnetConfig) return null;
    const key = subnetKeyOf(identity);
    if (!key) return null;
    const record = subnetBans.get(key);
    if (!record) return null;
    const remainingMs = record.expiresAtMono - mono();
    if (remainingMs <= 0) {
      subnetBans.delete(key);
      return null;
    }
    return { subnet: key, expiresAtWall: record.expiresAtWall, remainingMs };
  };

  const proofBinds = (identity: string, proof?: BanIdentityProof): boolean =>
    !!proof &&
    PROOF_KINDS.has(proof.kind) &&
    proof.verified === true &&
    proof.boundTo === identity;

  const guard: BanGuard = {
    strictProvenIdentity: strict,
    issueBan(identity, opts = {}) {
      if (typeof identity !== "string" || identity.length === 0) {
        return { issued: false, reason: "invalid_identity" };
      }
      if (strict && !proofBinds(identity, opts.proof)) {
        return { issued: false, reason: "unproven_identity" };
      }
      const record = { expiresAtWall: wall() + duration, expiresAtMono: mono() + duration };
      bans.set(identity, record);
      // ABS-11 escalation accounting: only a PROVEN issuance counts
      // toward the subnet threshold. In strict mode every issuance
      // is proven by construction; in legacy mode an issuance with
      // no bound proof is unproven and counts for nothing, so
      // framed bans can never escalate a subnet.
      if (subnetConfig && proofBinds(identity, opts.proof)) {
        const key = subnetKeyOf(identity);
        if (key) {
          let set = provenBySubnet.get(key);
          if (!set) {
            set = new Set();
            provenBySubnet.set(key, set);
          }
          set.add(identity);
          if (set.size >= subnetConfig.threshold && !activeSubnetBan(identity)) {
            subnetBans.set(key, {
              expiresAtWall: wall() + subnetConfig.subnetBanMs,
              expiresAtMono: mono() + subnetConfig.subnetBanMs,
            });
          }
        }
      }
      return { issued: true, expiresAt: record.expiresAtWall };
    },
    isBanned(identity) {
      const record = bans.get(identity);
      if (record) {
        const remainingMs = record.expiresAtMono - mono();
        if (remainingMs > 0) {
          return { banned: true, scope: "identity", expiresAt: record.expiresAtWall, remainingMs };
        }
        bans.delete(identity);
      }
      // Subnet fallback (ABS-11): an escalated /24 bans its other
      // members, except host-declared known-good identities.
      const subnet = activeSubnetBan(identity);
      if (subnet && !knownGood.has(identity)) {
        return { banned: true, scope: "subnet", expiresAt: subnet.expiresAtWall, remainingMs: subnet.remainingMs };
      }
      return { banned: false };
    },
    liftBan(identity) {
      return bans.delete(identity);
    },
    releaseViaChallenge(identity, proof) {
      if (!challengeRelease) return { released: false, reason: "release_valve_disabled" };
      // The valve releases the identity's OWN ban record. A
      // subnet-only ban (ABS-11) is not an identity ban and is not
      // lifted here - it expires on its own capped clock.
      const own = bans.get(identity);
      if (!own || own.expiresAtMono - mono() <= 0) return { released: false, reason: "not_banned" };
      if (!proofBinds(identity, proof)) return { released: false, reason: "unproven_identity" };
      bans.delete(identity);
      return { released: true };
    },
    subnetBanFor(identity) {
      const subnet = activeSubnetBan(identity);
      return subnet ? { subnet: subnet.subnet, expiresAt: subnet.expiresAtWall } : null;
    },
    markKnownGood(identity) {
      if (typeof identity === "string" && identity.length > 0) knownGood.add(identity);
    },
  };
  return guard;
}
