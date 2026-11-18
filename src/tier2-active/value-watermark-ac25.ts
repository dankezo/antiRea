/**
 * AC-25 - Verbatim-confirm watermark re-measurement (PASS-LAB).
 *
 * A parameter confirmation for the shipped C39 watermark family
 * (createValueWatermark in value-watermark.ts), not a new
 * mechanism. Lab record (ac-batch1-lab, RESULTS-AC-BATCH1-STEP0.md,
 * ac25-results.json, seed 20322307): at E = 80 pooled editions
 * (tau = 0.5204):
 *   verbatim copy confirms        200/200 = 1.000
 *   recomputed control confirms     1/200 = 0.005
 *   clean control confirms          0/200 = 0.000
 * and confirmation is already 1.000 at E = 20 and E = 40 for the
 * verbatim arm, with controls at 0.010. The cost line does NOT
 * trip: 2-decimal re-rounding does not wash the mark at these
 * magnitudes (the re-rounded arm confirms 200/200 at every E).
 * Achieved perturbation: median 0.376%, p99 2.57%.
 *
 * Scope note from the lab, kept: the sim's verbatim arm has no
 * channel noise between serving and copying, so 1.000 is the
 * noiseless ceiling; the dossier's 0.90 at 80 editions remains the
 * field-shaped number. Both agree on the verdict: the mechanism
 * confirms copies and does not confirm non-copies.
 *
 * This module pins those parameters beside the shipped family and
 * offers the opt-in E = 80 pooled-confirmation variant: a thin
 * wrapper over createValueWatermark whose pooled LOW status is
 * read only after the host has verified the registered number of
 * editions. The wrapper adds no new marking or statistics.
 */

import { createValueWatermark, type ValueWatermarkInstance } from "./value-watermark";

/** Pooled editions at the re-measured operating point. */
export const AC25_POOLED_EDITIONS = 80;
/** The lab's tau at E = 80. */
export const AC25_TAU_AT_E80 = 0.5204;

/** Lab re-measurement outcomes at E = 80 (verbatim / recomputed / clean, out of 200 each). */
export const AC25_REMEASUREMENT = {
  editions: 80,
  verbatimConfirmed: 200,
  verbatimTotal: 200,
  recomputedConfirmed: 1,
  recomputedTotal: 200,
  cleanConfirmed: 0,
  cleanTotal: 200,
  reroundedConfirmed: 200,
  reroundedTotal: 200,
  perturbationMedianPct: 0.376,
  perturbationP99Pct: 2.57,
} as const;

export interface Ac25PooledWatermark {
  /** The wrapped shipped instance (all marking / verification is C39's). */
  readonly watermark: ValueWatermarkInstance;
  /** Editions the host must verify before reading the pooled confirmation at the AC-25 operating point. */
  readonly pooledEditions: number;
  /** True once at least AC25_POOLED_EDITIONS editions contributed LOW-tier records. */
  pooledPointReached(): boolean;
}

/**
 * Opt-in variant: create the shipped C39 watermark and track
 * whether the AC-25 pooled operating point (E = 80 editions with
 * LOW-tier records) has been reached.
 */
export function createAc25PooledWatermark(options: { key: string }): Ac25PooledWatermark {
  const watermark = createValueWatermark(options);
  return {
    watermark,
    pooledEditions: AC25_POOLED_EDITIONS,
    pooledPointReached(): boolean {
      return watermark.pooledLowStatus().editions >= AC25_POOLED_EDITIONS;
    },
  };
}
