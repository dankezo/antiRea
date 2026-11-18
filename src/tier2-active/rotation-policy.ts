/**
 * AC-26 - Rotation clone-breakage measurement (PASS-LAB).
 *
 * Lab record (ac-batch1-lab, RESULTS-AC-BATCH1-STEP0.md,
 * ac26-results.json, seed 20322308): rotating an internal API
 * envelope's names breaks a static clone built against rotation 0:
 *   rotation 1: clone breakage 0.380, suite failure 0.833
 *   rotation 2: clone breakage 0.375, suite failure 0.833
 *   rotation 3: clone breakage 0.395, suite failure 0.833
 *   rotation 4: clone breakage 0.185, suite failure 0.417  (the dip)
 *   rotation 5: clone breakage 0.390, suite failure 0.833
 *   rotation 6: clone breakage 0.435, suite failure 0.833
 * The mapping client fails 0 operations at every rotation 0..6.
 *
 * THE DIP IS THE DESIGN FINDING, encoded here: at rotation 4 the
 * 4-name cycle completes and auxiliary names return to their
 * cycle-0 values, so a short name cycle re-synchronizes with the
 * clone built against it. The rotation pool must be long or
 * non-cyclic for the tax to persist. Partner-ecosystem cost on
 * public APIs is the harvest's registered warning and was not
 * measured; the candidate's scope is internal APIs.
 *
 * This module is a policy input only: it reports the measured curve
 * and flags re-synchronization risk. It rotates nothing by itself.
 * Opt-in.
 */

export interface RotationBreakageCell {
  rotation: number;
  cloneBreakage: number;
  suiteFailure: number;
  /** The mapping client failed 0 operations at every measured rotation. */
  mappingFailures: 0;
}

/** Lab-measured rotation curve (AC-26). Rotations outside 0..6 were not measured. */
export const AC26_ROTATION_CURVE: readonly RotationBreakageCell[] = [
  { rotation: 0, cloneBreakage: 0, suiteFailure: 0, mappingFailures: 0 },
  { rotation: 1, cloneBreakage: 0.38, suiteFailure: 0.833, mappingFailures: 0 },
  { rotation: 2, cloneBreakage: 0.375, suiteFailure: 0.833, mappingFailures: 0 },
  { rotation: 3, cloneBreakage: 0.395, suiteFailure: 0.833, mappingFailures: 0 },
  { rotation: 4, cloneBreakage: 0.185, suiteFailure: 0.417, mappingFailures: 0 },
  { rotation: 5, cloneBreakage: 0.39, suiteFailure: 0.833, mappingFailures: 0 },
  { rotation: 6, cloneBreakage: 0.435, suiteFailure: 0.833, mappingFailures: 0 },
];

export interface RotationPolicyAssessment {
  rotation: number;
  /** Measured cell, or null when this rotation was not measured. */
  cell: RotationBreakageCell | null;
  measured: boolean;
  /**
   * True when the rotation completes a cycle of the given pool
   * length, the re-synchronization shape the lab measured at
   * rotation 4 with a 4-name cycle.
   */
  resynchronizes: boolean;
  /** Policy guidance drawn from the measured dip. */
  recommendation: "avoid-cycle-completion" | "measured" | "unmeasured";
}

/**
 * Assess a planned rotation against the measured curve. A rotation
 * that is a positive multiple of the pool's cycle length returns
 * names to their cycle-0 values and is flagged, whatever the curve
 * says about other rotations.
 */
export function assessRotation(rotation: number, cycleLength?: number): RotationPolicyAssessment {
  const r = Math.floor(rotation);
  const cell = AC26_ROTATION_CURVE.find(c => c.rotation === r) ?? null;
  const resync =
    typeof cycleLength === "number" && cycleLength > 0 && r > 0 && r % Math.floor(cycleLength) === 0;
  return {
    rotation: r,
    cell,
    measured: cell !== null,
    resynchronizes: resync,
    recommendation: resync ? "avoid-cycle-completion" : cell ? "measured" : "unmeasured",
  };
}
