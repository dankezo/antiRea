/**
 * AC-18 - JND threshold result for the visual channel (PASS-LAB).
 *
 * This is a measured parameter, not a module with a mechanism.
 * Lab record (ac-batch1-lab, RESULTS-AC-BATCH1-STEP0.md,
 * ac18-results.json, seed 20322305): per-session micro-jitter at
 * amplitude a, measured as capture-to-capture mean diff D in JND
 * units and the tax ratio R against the noise floor:
 *   a = 0     D = 0.169  R = 1.000
 *   a = 0.4   D = 0.315  R = 1.859
 *   a = 0.7   D = 0.489  R = 2.886   (the gated level L2)
 *   a = 1.0   D = 0.677  R = 4.001
 * Gate: R at 0.7 JND = 2.886 against a 2.0 gate - passes.
 *
 * THE WEAKER STATEMENT ONLY, encoded as the claim: D at L2 (0.489)
 * sits just BELOW the modelled 0.5 JND convergence band. Only the
 * 1.0 JND level (0.677) exceeds that band. So the measured claim is
 * "likeness ceiling lowered about 3x relative to the noise floor",
 * NOT "convergence made impossible". The constants below pin the
 * weaker claim: convergenceClaimed is false by construction, and
 * any future visual-channel threshold built on this parameter must
 * start from these numbers, not from the stronger statement.
 * No human visual confirmation exists at Step 0 (a numeric JND
 * model was substituted, as registered).
 */

export interface VisualChannelJndLevel {
  amplitudeJnd: number;
  /** Capture-to-capture mean diff, in JND units. */
  meanDiff: number;
  /** Tax ratio against the noise floor (a = 0). */
  taxRatio: number;
}

/** Lab-measured JND levels (AC-18), rounded to the record's 3 decimals. */
export const AC18_JND_LEVELS: readonly VisualChannelJndLevel[] = [
  { amplitudeJnd: 0, meanDiff: 0.169, taxRatio: 1 },
  { amplitudeJnd: 0.4, meanDiff: 0.315, taxRatio: 1.859 },
  { amplitudeJnd: 0.7, meanDiff: 0.489, taxRatio: 2.886 },
  { amplitudeJnd: 1, meanDiff: 0.677, taxRatio: 4.001 },
];

/** The gated level: 0.7 JND. */
export const AC18_GATED_AMPLITUDE_JND = 0.7;
/** R at the gated level, lab-measured. */
export const AC18_R_AT_GATED_LEVEL = 2.886;
/** The gate R had to clear. */
export const AC18_R_GATE = 2.0;
/** D at the gated level, lab-measured: 0.489. */
export const AC18_D_AT_GATED_LEVEL = 0.489;
/** The modelled convergence band D would have to reach: 0.5. */
export const AC18_CONVERGENCE_BAND = 0.5;

export interface VisualChannelClaim {
  amplitudeJnd: number;
  taxRatio: number;
  taxGate: number;
  taxGatePassed: boolean;
  meanDiff: number;
  convergenceBand: number;
  /** Always false: D at the gated level is below the band, so convergence is NOT claimed impossible. */
  convergenceClaimed: false;
  /** The only statement the measurement supports. */
  statement: "likeness ceiling lowered relative to the noise floor";
}

/** The AC-18 claim, in its weaker (measured) form only. */
export function visualChannelClaim(): VisualChannelClaim {
  return {
    amplitudeJnd: AC18_GATED_AMPLITUDE_JND,
    taxRatio: AC18_R_AT_GATED_LEVEL,
    taxGate: AC18_R_GATE,
    taxGatePassed: AC18_R_AT_GATED_LEVEL >= AC18_R_GATE,
    meanDiff: AC18_D_AT_GATED_LEVEL,
    convergenceBand: AC18_CONVERGENCE_BAND,
    convergenceClaimed: false,
    statement: "likeness ceiling lowered relative to the noise floor",
  };
}
