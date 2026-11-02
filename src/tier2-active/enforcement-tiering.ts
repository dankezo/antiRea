/**
 * The cohort enforcement tiering law, as code.
 *
 * Origin: lab round 5 (02/11/2026). A prototype wired a real price
 * (budget override + cold-fetch multiplier) onto the herd detector's
 * `graduated_only` band; the detector's IP-grouping swept a simulated
 * 3-seat compliance team into the flagged cohort and the price hard-cut
 * them at 551/1,200 legitimately-served records (46%). The tripwire
 * itself never fired on the controls.
 *
 * REVISION (Danny, 09:44 02/11/2026 - the current law): the v1 law
 * defaulted inferred cohorts to observation because the one measured
 * systematic-review team is rare in practice and, in real
 * organizations, a DECLARED activity (audits are scheduled, pentests
 * run under rules of engagement). The default therefore flips:
 * enforcement is ON at the friction tier unless the host declares the
 * cohort protected (see `protected-cohorts.ts`); the heavy
 * consequences stay declaration-gated. Concretely:
 *
 * 1. **Inferred cohorts receive friction by default.** A cohort the
 *    SDK inferred from behavior (herd detector band, CUSUM crossing
 *    past the consequence floor) is AUTO-ENROLLED into the friction
 *    tier: step-up (host-side session expiry / dwell) plus a SOFT
 *    budget step-down - member budgets may be lowered, but never
 *    below `SOFT_BUDGET_FLOOR_RECORDS`. No host opt-in is required
 *    for this tier; it is the shipped default.
 * 2. **Hard consequences stay forbidden in code for inferred
 *    cohorts.** A hard ceiling (budget to 0 / refusal), a thorough
 *    budget cut below the soft floor, and cold pricing are refused
 *    by `clampEnforcement` / `softBudgetStepDown` /
 *    `validateHerdResponseConfig` even when configuration demands
 *    them. They open only for a host-declared cohort, or when the
 *    evidence is backed by a calibration manifest at the `ceiling`
 *    tier (manifest-tier evidence quality is the second sanctioned
 *    path, CHATGPT-R8 reconciliation).
 * 3. **The herd `graduated_only` band carries zero price.** No
 *    per-record price or channel multiplier may be attached to that
 *    band; `validateHerdResponseConfig` rejects such configurations
 *    so the R5 wiring mistake fails loudly at startup. The band's
 *    default consequence flows through `defaultHerdBandResponse`
 *    (friction with the soft floor), never through a raw override
 *    hung on the band.
 *
 * The soft floor's derivation (not a round number picked for looks):
 * 500 distinct records is the disclosure ledger's shipped per-subject
 * reservation bound (`maxReservedRecordsPerSubject` default in
 * `disclosure-ledger.ts`) - the largest single bulk unit the SDK
 * already lets one subject hold. A stepped-down member therefore
 * keeps exactly one maximal legitimate bulk operation of headroom:
 * friction, never strangulation. It is also the numeric value the R5
 * prototype used as its graduated budget override; what made R5
 * lethal was not the 500 but the 5x cold-fetch multiplier stacked on
 * top of it (effective ~185 records per seat) - the multiplier is
 * precisely what rule 3 keeps forbidden.
 *
 * Hosts and SDK modules call `clampEnforcement` before applying any
 * consequence: it returns the requested action when lawful, or the
 * highest lawful action below it with the reason it was clamped.
 */

import type { CalibrationTier } from "./calibration-manifest";
import type { HerdResponseBand } from "./herd-detector";

export type CohortOrigin = "host_declared" | "inferred";

export type EnforcementAction = "observe" | "step_up" | "budget_step_down" | "hard_ceiling" | "deny";

const ACTION_RANK: Record<EnforcementAction, number> = {
  observe: 0,
  step_up: 1,
  budget_step_down: 2,
  hard_ceiling: 3,
  deny: 4,
};

export function enforcementActionRank(action: EnforcementAction): number {
  return ACTION_RANK[action];
}

/**
 * The soft budget floor for inferred cohorts, in distinct records:
 * a friction-tier step-down may land a member's budget AT this floor
 * but never below it. Derivation in the module header (binds to the
 * disclosure ledger's per-subject reservation bound, 500).
 */
export const SOFT_BUDGET_FLOOR_RECORDS = 500;

export interface EnforcementContext {
  origin: CohortOrigin;
  /** From `evaluateCalibrationManifest`; "audit_only" when uncalibrated. */
  calibrationTier: CalibrationTier;
  /**
   * True only when a gated SDK signal actually fired on this cohort:
   * a CUSUM crossing past the consequence floor, or a herd flag past
   * its coverage/score floors. Required before an inferred cohort
   * receives even friction - a bare score that never crossed a gate
   * carries no consequence.
   */
  tripwireGated?: boolean;
}

/** The highest consequence the tiering law allows in this context. */
export function maxEnforcementAction(context: EnforcementContext): EnforcementAction {
  if (context.origin === "host_declared") {
    return context.calibrationTier === "ceiling" ? "deny" : "hard_ceiling";
  }
  // Inferred cohort: manifest-tier evidence is the only path to a hard ceiling.
  if (context.calibrationTier === "ceiling") return "hard_ceiling";
  // The friction tier - step-up plus a SOFT budget step-down bounded
  // by SOFT_BUDGET_FLOOR_RECORDS - is the default cap (09:44 law).
  return context.tripwireGated ? "budget_step_down" : "observe";
}

export interface ClampEnforcementResult {
  /** The action that may actually be applied. */
  action: EnforcementAction;
  clamped: boolean;
  max: EnforcementAction;
  /**
   * Present when `action` is `budget_step_down` for an inferred
   * cohort: the floor (distinct records) the step-down may not cross.
   * A step-down that respects this floor is friction; one that
   * ignores it is the forbidden hard cut wearing a softer name.
   */
  budgetFloorRecords?: number;
  reason: string;
}

export function clampEnforcement(
  requested: EnforcementAction,
  context: EnforcementContext,
): ClampEnforcementResult {
  const max = maxEnforcementAction(context);
  const floorField =
    context.origin === "inferred" ? { budgetFloorRecords: SOFT_BUDGET_FLOOR_RECORDS } : {};
  if (ACTION_RANK[requested] <= ACTION_RANK[max]) {
    return {
      action: requested,
      clamped: false,
      max,
      ...(requested === "budget_step_down" ? floorField : {}),
      reason: "requested action is within the tiering law",
    };
  }
  const reason =
    context.origin === "inferred"
      ? `inferred cohorts are capped at ${max}: hard consequences require a host-declared cohort or ceiling-tier calibrated evidence (tiering law, 09:44 revision)`
      : `host-declared cohorts are capped at ${max} at calibration tier ${context.calibrationTier}`;
  return {
    action: max,
    clamped: true,
    max,
    ...(max === "budget_step_down" ? floorField : {}),
    reason,
  };
}

export interface SoftBudgetStepDownResult {
  /** The budget limit that may lawfully be applied. */
  limit: number;
  /** True when the limit actually moved down. */
  applied: boolean;
  /** True when the soft floor (not the request) determined the limit. */
  floored: boolean;
  reason: string;
}

/**
 * Compute the lawful result of stepping a member's budget down to
 * `targetLimit`. For an inferred cohort the result can never fall
 * below `SOFT_BUDGET_FLOOR_RECORDS` and never reaches 0 - a request
 * for a thorough cut comes back as a step-down to the floor. A limit
 * that is already lower (e.g. a direct-evidence taint ceiling) is
 * never raised. When the context does not permit a step-down at all,
 * the current limit is returned unchanged.
 */
export function softBudgetStepDown(
  currentLimit: number,
  targetLimit: number,
  context: EnforcementContext,
): SoftBudgetStepDownResult {
  const clamp = clampEnforcement("budget_step_down", context);
  const current = Math.max(0, Math.floor(currentLimit));
  if (clamp.action !== "budget_step_down") {
    return {
      limit: current,
      applied: false,
      floored: false,
      reason: `budget step-down is not available in this context: ${clamp.reason}`,
    };
  }
  const floor = context.origin === "inferred" ? SOFT_BUDGET_FLOOR_RECORDS : 0;
  const desired = Math.max(0, Math.floor(targetLimit));
  const limit = Math.min(Math.max(desired, floor), current);
  return {
    limit,
    applied: limit < current,
    floored: desired < floor && limit === floor,
    reason:
      limit === current
        ? "no step-down applied: the current limit is already at or below the requested target/floor"
        : desired < floor
          ? `stepped down to the soft floor ${floor}: inferred cohorts are never cut below it (tiering law, 09:44 revision)`
          : "stepped down within the tiering law",
  };
}

export interface HerdBandResponse {
  band: HerdResponseBand;
  /** Step-up friction applies to members by default. */
  stepUp: boolean;
  /**
   * When non-null, member budgets may be stepped down but never
   * below this floor (distinct records). Null when the response is
   * the ladder instead of a step-down.
   */
  budgetStepDownFloorRecords: number | null;
  /**
   * True when the response flows through `applyHerdLadder` (the deep
   * group cut). Only lawful for a host-declared cohort or
   * ceiling-tier calibrated evidence; an inferred cohort on
   * uncalibrated evidence gets friction instead, even on the
   * `budget_cut_supported` band.
   */
  ladder: boolean;
  /** Always 0: no band ever carries a per-record price. */
  pricePerRecord: 0;
  reason: string;
}

/**
 * The shipped default response to a herd flag. This is where the
 * 09:44 law lives for the herd path: `graduated_only` maps to
 * friction (step-up + soft step-down) for every origin - the band's
 * measured legitimate occupant discipline does not depend on who
 * declared the cohort - and `budget_cut_supported` maps to friction
 * too unless the heavy path is lawful (host-declared cohort or
 * ceiling-tier manifest), in which case the ladder applies.
 */
export function defaultHerdBandResponse(
  band: HerdResponseBand,
  context: EnforcementContext,
): HerdBandResponse {
  if (band === "graduated_only") {
    return {
      band,
      stepUp: true,
      budgetStepDownFloorRecords: SOFT_BUDGET_FLOOR_RECORDS,
      ladder: false,
      pricePerRecord: 0,
      reason:
        "graduated_only band: default response is friction (step-up + soft budget step-down to the floor); the band never carries a price or a deep cut (R5 lesson)",
    };
  }
  const heavyLawful = context.origin === "host_declared" || context.calibrationTier === "ceiling";
  if (heavyLawful) {
    return {
      band,
      stepUp: false,
      budgetStepDownFloorRecords: null,
      ladder: true,
      pricePerRecord: 0,
      reason:
        "budget_cut_supported band on a host-declared cohort or ceiling-tier calibrated evidence: the response ladder's group cut is lawful",
    };
  }
  return {
    band,
    stepUp: true,
    budgetStepDownFloorRecords: SOFT_BUDGET_FLOOR_RECORDS,
    ladder: false,
    pricePerRecord: 0,
    reason:
      "budget_cut_supported band on an inferred cohort: the default is still friction (step-up + soft budget step-down) - the ladder's deep cut requires a host-declared cohort or ceiling-tier calibrated evidence (tiering law, 09:44 revision)",
  };
}

/**
 * The price carried by a herd response band. Always 0 for
 * `graduated_only` - that band is telemetry, not a price tag - and 0
 * for `budget_cut_supported` too: the cut band's consequence is a
 * budget override flowing through `applyHerdLadder` and the tiering
 * clamp, never a per-record price invented at the band.
 */
export function herdBandPrice(band: HerdResponseBand): number {
  void band;
  return 0;
}

export interface HerdResponseConfig {
  band: HerdResponseBand;
  /** Per-record price attached to the band. Must be 0 / absent. */
  pricePerRecord?: number;
  /** Budget override attached directly to the band. Forbidden on graduated_only. */
  budgetOverride?: number;
  /** Channel price multiplier attached to the band. Must be <= 1 / absent. */
  coldFetchMultiplier?: number;
}

/**
 * Startup-time guard against the R5 wiring mistake: attaching ANY price
 * (per-record price, direct budget override, or channel multiplier) to
 * the `graduated_only` band is a configuration error, reported loudly
 * instead of discovered when a legitimate team is cut. (A budget
 * step-down for that band is lawful only through
 * `defaultHerdBandResponse` + `softBudgetStepDown`, where the soft
 * floor is enforced - never as a raw override on the band.)
 */
export function validateHerdResponseConfig(config: HerdResponseConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (config.band === "graduated_only") {
    if (config.pricePerRecord !== undefined && config.pricePerRecord > 0) {
      errors.push("graduated_only band carries zero price: pricePerRecord must be 0 (R5 tiering law)");
    }
    if (config.budgetOverride !== undefined) {
      errors.push(
        "graduated_only band must not carry a budget override: route consequences through clampEnforcement instead (R5 tiering law)",
      );
    }
    if (config.coldFetchMultiplier !== undefined && config.coldFetchMultiplier > 1) {
      errors.push("graduated_only band must not carry a cold-fetch price multiplier above 1 (R5 tiering law)");
    }
  }
  return { valid: errors.length === 0, errors };
}
