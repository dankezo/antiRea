/**
 * Evidentiary roles (KT-01 EvidentiaryRoles, lab pin
 * kt01-lab/REGISTRATION-KT-01-STEP0.md, results in
 * KT01-RESULTS.md).
 *
 * THE PROBLEM. antiRea's signals do not carry equal evidentiary
 * weight, and a host composing them into consequences needs that
 * weight written down as law, not vibes. KT-01 assigns every
 * evidence channel a role under one graduation rule:
 *
 *   CONVICTING    - the channel has its OWN passed lab gates for
 *                   the claim it makes; a fired CONVICTING item
 *                   can ground a consequence (with the tier rules
 *                   below).
 *   CORROBORATING - the channel supports, never grounds: a pack
 *                   whose fired items are all CORROBORATING is
 *                   mechanically INELIGIBLE for consequences,
 *                   however many of them fire.
 *
 * The one conditional row is the BS-01 verification fact: a
 * spoofed fact (proven identity forgery) is CONVICTING; every
 * other verification state is CORROBORATING at best - verified
 * identity is not innocence and unverified is not guilt
 * (BS-01's delta is 0 in both directions).
 *
 * This release's table adds `room-guard` to the shipped-signal
 * rows: it graduated under the same law (its own frozen gates,
 * RECOMB-06: FP and detection 6/6) and is CONVICTING on the
 * population claim it makes - a room state, never an identity.
 *
 * WHAT THE LAB MEASURED (deterministic conformance; K2 drove
 * the REAL shipped factories and decorated their actual
 * evaluate() outputs): table completeness over all shipped
 * kinds and pin channels; decoration fidelity (role + CS-02
 * config digest + fired predicate) on every kind; the audit
 * invariant exact on 10/10 frozen packs (corroborating-only
 * fired packs ineligible, a mis-claimed role invalid, an
 * unknown channel invalid); the tier restatement covering
 * tiers 0-3 with tier 3 forbidden for inferred evidence.
 *
 * The tier restatement (C27+C35 law, unchanged):
 * - tier 0 observe: no evidence requirement.
 * - tier 1 step_up: at least 1 CONVICTING item fired.
 * - tier 2 soft step-down (floor 500): CONVICTING fired +
 *   2-window persistence + failed step-up + at least 1
 *   CORROBORATING item from an independent channel.
 * - tier 3: FORBIDDEN for inferred evidence at any role
 *   composition.
 *
 * Pure computation: no I/O, no runtime dependencies.
 */

export type EvidentiaryRole = "CONVICTING" | "CORROBORATING";

/** The BS-01 channel key: the table's one conditional row. */
export const VERIFICATION_FACT_CHANNEL = "bs01-verification-fact";

/**
 * The frozen role table. Signal rows are keyed by the signal's
 * result `kind`; pin channels and future candidates are keyed
 * by their registered channel names.
 */
export const EVIDENTIARY_ROLE_TABLE: Readonly<Record<string, EvidentiaryRole>> = {
  // Shipped signals - each CONVICTING on its own passed gates.
  "herd-phase": "CONVICTING",
  "activity-phase": "CONVICTING",
  "seat-occupancy": "CONVICTING",
  "vote-brigading": "CONVICTING",
  "room-hop": "CONVICTING",
  "reconnect-storm": "CONVICTING",
  "herd-tightness": "CONVICTING",
  "room-guard": "CONVICTING",
  // Pin C27+C35 channels.
  "c27-budget-flag": "CONVICTING",
  "c35-decoy-touch": "CONVICTING",
  "pin-cohort-union": "CORROBORATING",
  "pin-other-signal": "CORROBORATING",
  "pin-repeat": "CORROBORATING",
  // Lab candidates (roles assigned at registration; they ground
  // nothing until they ship under their own gates).
  "cs01-fleet-coherence": "CORROBORATING",
  "cs03-prefix-crowding": "CORROBORATING",
  "recomb08-header-coherence": "CORROBORATING",
  "an01-exculpatory": "CORROBORATING",
};

export interface EvidentiaryItemLike {
  /** A signal result kind or a registered channel name. */
  channel: string;
  /** BS-01 facts carry their state; only "spoofed" is CONVICTING. */
  state?: string;
}

/**
 * The role of one evidence item, or undefined for an unknown
 * channel (an audit must treat undefined as INVALID, never as
 * corroborating-by-default).
 */
export function evidentiaryRoleOf(item: EvidentiaryItemLike): EvidentiaryRole | undefined {
  if (typeof item !== "object" || item === null || typeof item.channel !== "string") return undefined;
  if (item.channel === VERIFICATION_FACT_CHANNEL) {
    return item.state === "spoofed" ? "CONVICTING" : "CORROBORATING";
  }
  return EVIDENTIARY_ROLE_TABLE[item.channel];
}

export interface EvidencePackItem extends EvidentiaryItemLike {
  /** Whether the item's claim actually fired. */
  fired: boolean;
  /** A role the pack CLAIMS for this item; audited against the table when present. */
  claimedRole?: EvidentiaryRole;
}

export interface EvidencePackAudit {
  /** False when any item names an unknown channel or claims a role the table denies. */
  valid: boolean;
  /** True exactly when valid AND at least one CONVICTING item fired. */
  eligible: boolean;
}

/**
 * Audit an evidence pack against the role table: validity is
 * mechanical (unknown channel or mis-claimed role = invalid),
 * and eligibility requires a fired CONVICTING item - a pack of
 * fired CORROBORATING items only is never eligible.
 */
export function auditEvidencePack(items: readonly EvidencePackItem[]): EvidencePackAudit {
  let valid = true;
  for (const item of items) {
    const role = evidentiaryRoleOf(item);
    if (role === undefined) valid = false;
    else if (item.claimedRole !== undefined && item.claimedRole !== role) valid = false;
  }
  const eligible = valid && items.some((i) => evidentiaryRoleOf(i) === "CONVICTING" && i.fired === true);
  return { valid, eligible };
}

/**
 * The fired predicate per shipped signal kind, as pinned by the
 * KT-01 conformance (room-guard follows its siblings: its
 * boolean `flagged`).
 */
export const SIGNAL_FIRED_PREDICATES: Readonly<Record<string, (result: never) => boolean>> = {
  "herd-phase": (r: { confirmed?: unknown }) => r.confirmed === true,
  "activity-phase": (r: { confirmed?: unknown }) => r.confirmed === true,
  "seat-occupancy": (r: { flagged?: unknown }) => r.flagged === true,
  "vote-brigading": (r: { flagged?: unknown }) => r.flagged === true,
  "room-hop": (r: { flagged?: unknown }) => Array.isArray(r.flagged) && r.flagged.length > 0,
  "reconnect-storm": (r: { flagged?: unknown }) => Array.isArray(r.flagged) && r.flagged.length > 0,
  "herd-tightness": (r: { tight?: unknown }) => r.tight === true,
  "room-guard": (r: { flagged?: unknown }) => r.flagged === true,
};

export interface DecoratedSignalResult<T> {
  result: T;
  /** The result kind's role from the table (undefined for unknown kinds). */
  role: EvidentiaryRole | undefined;
  /** CS-02 provenance hash of the producing instance's effective config. */
  configHash: string | null;
  /** Whether the result fired, by the kind's frozen predicate. */
  fired: boolean;
}

/**
 * Decorate a signal evaluate() result with its evidentiary
 * role, its config's CS-02 hash, and its fired state - the
 * KT-01 K2 decoration. Unknown kinds decorate with role
 * undefined and fired false (never guessed).
 */
export function decorateSignalResult<T extends { kind: string }>(
  result: T,
  options?: { configHash?: string },
): DecoratedSignalResult<T> {
  const predicate = SIGNAL_FIRED_PREDICATES[result.kind] as ((r: T) => boolean) | undefined;
  return {
    result,
    role: EVIDENTIARY_ROLE_TABLE[result.kind],
    configHash: options && typeof options.configHash === "string" ? options.configHash : null,
    fired: predicate ? predicate(result as never) : false,
  };
}

export interface EnforcementTierRule {
  tier: 0 | 1 | 2 | 3;
  rule: string;
  forbidden?: boolean;
}

/** The C27+C35 tier law restated as evidence requirements. */
export const ENFORCEMENT_TIER_EVIDENCE_RULES: readonly EnforcementTierRule[] = [
  { tier: 0, rule: "observe - no evidence requirement" },
  { tier: 1, rule: "step_up - at least 1 CONVICTING item fired" },
  {
    tier: 2,
    rule:
      "soft step-down (floor 500) - CONVICTING fired + 2-window persistence + failed step-up + " +
      "at least 1 CORROBORATING item from an independent channel",
  },
  { tier: 3, rule: "FORBIDDEN for inferred evidence at any role composition", forbidden: true },
];
