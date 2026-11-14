/**
 * EMP-MIX calibration-set composition - choosing a clustering
 * threshold from a 50/50 mixed calibration set (RECOMB-05 CONTAM-EMP,
 * PASS-lab; registration recomb05-lab/
 * REGISTRATION-RECOMB-05-CONTAM-EMP.md section EMP-MIX, results
 * recomb05-lab/RESULTS.md).
 *
 * The failure this answers, measured in the lab's R14 branch-C frame:
 * a clustering threshold selected from a NULL-ONLY calibration set
 * (permutations of a structured reference population) is fragile to
 * contamination of that reference. When 10% of the reference rows
 * were replaced by flat, unstructured rows, the null-only selection
 * flipped the chosen threshold from h = 0.40 to h = 0.44, and the
 * flat-population false-merge rate at the flipped threshold breached
 * its gate (2.773% against a 2% bar). The reference population a host
 * calibrates from is never guaranteed clean, so a selection law that
 * breaks at 10% contamination is a trap.
 *
 * FROZEN LAW (the only change EMP-MIX makes; everything else in the
 * branch - distance, grid, linkage, gates - is untouched):
 * - The calibration set is a 50/50 mix BY SAMPLE COUNT of
 *   (a) null-permutation FMR samples and
 *   (b) flat empirical population FMR samples.
 * - Mixed FMR at grid point h = (sum of BOTH components' FMR values
 *   at h) / (total sample count) - equivalently the mean of the two
 *   component means when the counts are equal, as they were in the
 *   lab (40 + 40).
 * - Choose the LARGEST grid h whose mixed FMR <= target
 *   (lab target 0.01, the default here).
 * - If no grid point qualifies, the threshold is null: the cell is
 *   UNCALIBRATABLE and the caller falls back to the branch-C
 *   convention (all-singleton partition). This function returns the
 *   null; what the caller does with it is the caller's law.
 *
 * WHAT THE LAB MEASURED (inside the R14 branch-C lab frame only):
 * the mixed set held the selection at h = 0.36 at EVERY contamination
 * level from 0% to 30%, while the null-only set flipped at 10%. At
 * h = 0.36 the component means were null 0.00410 and flat 0.01095
 * (mixed 0.00753 <= 0.01); the next grid point 0.40 already breached
 * (mixed 0.01239). The price, recorded in the same results: at 0%
 * contamination the mixed set's conservative anchor cost clean-set
 * ARI (0.864 vs the null-only 0.915) - EMP-MIX trades a little
 * clean-case quality for a selection that does not flip when the
 * reference is dirty.
 *
 * HONESTY SCOPE:
 * - This is a CALIBRATION-SET COMPOSITION LAW, not a detector. It
 *   says how to compose the set a threshold is selected from; it
 *   detects nothing, flags nothing and blocks nothing.
 * - It was measured ONLY inside the R14 branch-C lab frame
 *   (UPGMA average-linkage clustering over the lab's trait distance,
 *   grid step 0.04, B = 40 samples per component). Nothing here
 *   claims the same composition holds for another clustering method,
 *   another grid or real traffic.
 * - The FMR samples themselves (permutations, flat-population
 *   generation, false-merge-rate computation) are host/lab-side;
 *   this module is the pure arithmetic of the mix and the selection.
 */

export interface EmpMixInput {
  /** Candidate thresholds, ascending in the lab (any order is accepted; the largest qualifying value wins). */
  grid: readonly number[];
  /** nullFmr[i] = per-sample FMR values of the null-permutation component at grid[i]. */
  nullFmr: readonly (readonly number[])[];
  /** flatFmr[i] = per-sample FMR values of the flat empirical component at grid[i]. */
  flatFmr: readonly (readonly number[])[];
  /** Target mixed FMR. Default 0.01 (the frozen lab target). */
  targetFmr?: number;
}

export interface EmpMixResult {
  /** Largest grid value with mixed FMR <= target, or null when none qualifies (uncalibratable). */
  threshold: number | null;
  /** Mixed FMR per grid point, aligned with `grid`. */
  mixedFmr: number[];
  /** Null-component mean FMR per grid point, aligned with `grid`. */
  nullMean: number[];
  /** Flat-component mean FMR per grid point, aligned with `grid`. */
  flatMean: number[];
}

function meanOf(samples: readonly number[]): number {
  let sum = 0;
  for (const v of samples) sum += v;
  return sum / samples.length;
}

function checkSamples(name: string, samples: readonly number[]): void {
  if (samples.length === 0) {
    throw new RangeError(name + " must contain at least one sample");
  }
  for (const v of samples) {
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new RangeError(name + " must contain finite FMR values in [0, 1]");
    }
  }
}

/**
 * Mixed FMR of one grid point: the pooled mean over both components,
 * (sum of all values) / (total count). With equal component counts
 * this is exactly the mean of the two component means (the lab form).
 * Throws RangeError when both components together hold no samples.
 */
export function mixedFmrAt(nullSamples: readonly number[], flatSamples: readonly number[]): number {
  if (nullSamples.length + flatSamples.length === 0) {
    throw new RangeError("mixedFmrAt needs at least one sample across both components");
  }
  if (nullSamples.length + flatSamples.length > 100_000) {
    throw new RangeError("mixedFmrAt accepts at most 100000 samples");
  }
  let sum = 0;
  for (const v of nullSamples) {
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError("nullSamples FMR must be in [0, 1]");
    sum += v;
  }
  for (const v of flatSamples) {
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError("flatSamples FMR must be in [0, 1]");
    sum += v;
  }
  return sum / (nullSamples.length + flatSamples.length);
}

/**
 * Select the clustering threshold under the EMP-MIX law.
 *
 * Validation: the grid must be non-empty and both FMR arrays must be
 * aligned with it (one sample array per grid point, each non-empty);
 * any misalignment throws RangeError rather than silently selecting
 * from a malformed set.
 */
export function selectEmpMixThreshold(input: EmpMixInput): EmpMixResult {
  const grid = input.grid;
  const target = input.targetFmr ?? 0.01;
  if (grid.length === 0) {
    throw new RangeError("grid must be non-empty");
  }
  if (grid.length > 10_000) throw new RangeError("grid accepts at most 10000 points");
  if (input.nullFmr.length !== grid.length) {
    throw new RangeError(
      "nullFmr is misaligned with grid: " + input.nullFmr.length + " entries for " + grid.length + " grid points",
    );
  }
  if (input.flatFmr.length !== grid.length) {
    throw new RangeError(
      "flatFmr is misaligned with grid: " + input.flatFmr.length + " entries for " + grid.length + " grid points",
    );
  }
  if (!Number.isFinite(target) || target < 0 || target > 1) {
    throw new RangeError("targetFmr must be a finite number in [0, 1], got " + target);
  }

  let sampleCount = 0;
  for (let i = 0; i < grid.length; i++) {
    sampleCount += input.nullFmr[i]!.length + input.flatFmr[i]!.length;
    if (sampleCount > 100_000) throw new RangeError("calibration accepts at most 100000 samples");
  }

  const mixedFmr: number[] = [];
  const nullMean: number[] = [];
  const flatMean: number[] = [];
  let threshold: number | null = null;

  for (let i = 0; i < grid.length; i++) {
    const h = grid[i]!;
    if (!Number.isFinite(h)) {
      throw new RangeError("grid[" + i + "] is not finite");
    }
    const nullSamples = input.nullFmr[i]!;
    const flatSamples = input.flatFmr[i]!;
    checkSamples("nullFmr[" + i + "]", nullSamples);
    checkSamples("flatFmr[" + i + "]", flatSamples);
    const nm = meanOf(nullSamples);
    const fm = meanOf(flatSamples);
    const mixed = mixedFmrAt(nullSamples, flatSamples);
    nullMean.push(nm);
    flatMean.push(fm);
    mixedFmr.push(mixed);
    if (mixed <= target && (threshold === null || h > threshold)) {
      threshold = h;
    }
  }

  return { threshold, mixedFmr, nullMean, flatMean };
}
