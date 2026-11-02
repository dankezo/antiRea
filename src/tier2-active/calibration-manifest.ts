/**
 * Calibration manifests and tiered enforcement quality.
 *
 * From the overnight SDK contract review (CHATGPT-R8, 02/11/2026): a
 * boolean "calibrated: yes/no" gate is unenforceable theatre - anyone
 * can flip it. A manifest instead makes calibration an auditable,
 * named, expiring artifact: which model version, fitted on how many
 * legit and attack samples, with what held-out false-positive /
 * false-negative rates, by what method, attested by whom, valid until
 * when. Enforcement is then TIERED by manifest quality:
 *
 * - no manifest, an incomplete manifest, or an expired manifest:
 *   `audit_only` - evidence may be logged and reported, never enforced;
 * - a complete, in-date manifest: `step_down` - graduated budget
 *   step-downs are permitted;
 * - a manifest that also meets stricter error floors and sample-size
 *   minimums: `ceiling` - hard ceilings and denies become permitted
 *   (still subject to the cohort tiering law in
 *   `enforcement-tiering.ts`).
 *
 * The SDK's bundled default weights ship marked
 * `"uncalibrated - audit only"` (see `UNCALIBRATED_AUDIT_ONLY_NOTICE`
 * and the CUSUM tripwire's bundled `r6-calib-1` tables): until a host
 * fits tables on its own traffic and produces a manifest, the honest
 * enforcement tier is audit-only. A manifest can be fabricated, of
 * course - the point is that fabrication is now a signed, expiring
 * claim an operator can be asked to defend, not a silent boolean.
 */

export const UNCALIBRATED_AUDIT_ONLY_NOTICE = "uncalibrated - audit only";

export interface CalibrationManifest {
  /** Version of the detection model / rule set the tables belong to. */
  modelVersion: string;
  /** Version of the fitted calibration tables (e.g. "r6-calib-1"). */
  calibrationVersion: string;
  sampleSizes: {
    /** Held-out legitimate traces used to measure the FP rate. */
    legit: number;
    /** Held-out attack traces used to measure the FN rate. */
    attack: number;
  };
  holdout: {
    falsePositiveRate: number;
    falseNegativeRate: number;
  };
  /** Fitting method, in words (e.g. "trace-fitted LLR tables, LOAFO"). */
  method: string;
  /** Who attests to this manifest (a name, team or process id). */
  attestedBy: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export type CalibrationTier = "audit_only" | "step_down" | "ceiling";

export interface CalibrationEvaluation {
  tier: CalibrationTier;
  /** True only when a complete, in-date manifest backs the tier. */
  calibrated: boolean;
  /** Human-readable reasons, including every defect that capped the tier. */
  reasons: string[];
}

export interface CalibrationGateOptions {
  now?: number;
  /** FP ceiling for the top tier. Default 0.01. */
  ceilingMaxFalsePositiveRate?: number;
  /** FN ceiling for the top tier. Default 0.50. */
  ceilingMaxFalseNegativeRate?: number;
  /** Minimum held-out legit samples for the top tier. Default 100. */
  ceilingMinLegitSamples?: number;
  /** Minimum held-out attack samples for the top tier. Default 30. */
  ceilingMinAttackSamples?: number;
}

const isRate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Evaluate a manifest into an enforcement tier. Every structural defect
 * (missing fields, out-of-range rates, inverted or expired validity)
 * drops the tier to `audit_only` with the defect named in `reasons` -
 * evaluation never throws, so a malformed manifest can only ever weaken
 * enforcement, never break the request path.
 */
export function evaluateCalibrationManifest(
  manifest: CalibrationManifest | null | undefined,
  options: CalibrationGateOptions = {},
): CalibrationEvaluation {
  const now = options.now ?? Date.now();
  if (!manifest) {
    return { tier: "audit_only", calibrated: false, reasons: ["no calibration manifest supplied"] };
  }
  const reasons: string[] = [];
  if (!manifest.modelVersion) reasons.push("manifest has no modelVersion");
  if (!manifest.calibrationVersion) reasons.push("manifest has no calibrationVersion");
  if (!manifest.method) reasons.push("manifest has no fitting method");
  if (!manifest.attestedBy) reasons.push("manifest has no attester");
  if (!isCount(manifest.sampleSizes?.legit)) reasons.push("manifest legit sample size missing or invalid");
  if (!isCount(manifest.sampleSizes?.attack)) reasons.push("manifest attack sample size missing or invalid");
  if (!isRate(manifest.holdout?.falsePositiveRate)) reasons.push("manifest holdout falsePositiveRate missing or out of range");
  if (!isRate(manifest.holdout?.falseNegativeRate)) reasons.push("manifest holdout falseNegativeRate missing or out of range");
  if (!Number.isFinite(manifest.issuedAtMs) || !Number.isFinite(manifest.expiresAtMs)) {
    reasons.push("manifest validity window missing");
  } else if (manifest.expiresAtMs <= manifest.issuedAtMs) {
    reasons.push("manifest validity window is inverted (expiresAtMs <= issuedAtMs)");
  } else if (now >= manifest.expiresAtMs) {
    reasons.push("manifest has expired");
  } else if (now < manifest.issuedAtMs) {
    reasons.push("manifest is not yet in force");
  }
  if (reasons.length > 0) return { tier: "audit_only", calibrated: false, reasons };

  const fpFloor = options.ceilingMaxFalsePositiveRate ?? 0.01;
  const fnFloor = options.ceilingMaxFalseNegativeRate ?? 0.5;
  const minLegit = options.ceilingMinLegitSamples ?? 100;
  const minAttack = options.ceilingMinAttackSamples ?? 30;
  const topTier: string[] = [];
  if (manifest.holdout.falsePositiveRate > fpFloor) {
    topTier.push(`holdout FP rate ${manifest.holdout.falsePositiveRate} exceeds the ceiling-tier floor ${fpFloor}`);
  }
  if (manifest.holdout.falseNegativeRate > fnFloor) {
    topTier.push(`holdout FN rate ${manifest.holdout.falseNegativeRate} exceeds the ceiling-tier floor ${fnFloor}`);
  }
  if (manifest.sampleSizes.legit < minLegit) {
    topTier.push(`legit holdout samples ${manifest.sampleSizes.legit} below the ceiling-tier minimum ${minLegit}`);
  }
  if (manifest.sampleSizes.attack < minAttack) {
    topTier.push(`attack holdout samples ${manifest.sampleSizes.attack} below the ceiling-tier minimum ${minAttack}`);
  }
  if (topTier.length === 0) {
    return { tier: "ceiling", calibrated: true, reasons: ["manifest complete, in date, and meets the ceiling-tier floors"] };
  }
  return {
    tier: "step_down",
    calibrated: true,
    reasons: ["manifest complete and in date (step-down permitted)", ...topTier],
  };
}
