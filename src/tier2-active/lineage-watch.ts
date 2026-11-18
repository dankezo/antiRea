/**
 * Lineage watch (HARVEST2 candidate R14-v2b, phylogeny line;
 * lab PASS, SDK port RECHECK-FAIL, upgraded under the frozen
 * registration in docs/lab-notes/R14-V2B-UPGRADE-REGISTRATION.md).
 *
 * WHAT IT MEASURES. Identities minted from one tool / template /
 * infrastructure lineage resemble each other in their trait
 * vectors more than unrelated identities do. Given ONE population
 * of trait vectors, this module (a) clusters it with UPGMA
 * average-linkage clustering cut at a threshold h_b, and (b)
 * derives h_b by SELF-CALIBRATION on flat null populations
 * instead of tuning it for sensitivity - the exact move that
 * saved the candidate in the lab: v1 cut at h* = 0.44 tuned on
 * structured populations and died at the honest-flat gate
 * (false-merge 2.968% against a 2% bar); v2b froze h_b = 0.32
 * from flat-null calibration alone and passed. The output is a
 * set of candidate lineage clusters - investigation telemetry.
 * A cluster is NOT a maliciousness label: shared tooling, a
 * shared template or a shared vendor produce the same shape,
 * and this module attaches no consequence to membership.
 *
 * THE LAB MECHANISM, translated without re-invention (verbatim
 * from the study lab's r14-lab/common.cjs and v2b.cjs):
 * - TRAIT VECTOR. 12 traits per leaf: 8 categorical traits
 *   (values 0..3) followed by 4 numeric traits (0..100). A
 *   member's `traits` array carries the same encoding by
 *   default: the first `categoricalTraitCount` traits are
 *   categorical (default 8), the remaining traits are numeric
 *   on the `numericScale` (default 100).
 * - DISTANCE (lab dist(), verbatim):
 *     d(a, b) = ( #{categorical traits with a != b}
 *                 + sum_numeric |a - b| / numericScale ) / traits
 *   generalised only in the divisor (the trait count) and in
 *   the categorical / numeric split, both of which collapse to
 *   the lab's constants on a 12-trait vector. A host using a
 *   different trait layout may instead supply `distanceFn`.
 * - CLUSTERING (lab clusterAt(D, h, "average"), verbatim):
 *   UPGMA - start from singletons, repeatedly merge the pair of
 *   clusters with the smallest average linkage (the mean of all
 *   cross-pair distances; first pair wins ties, scanning in
 *   cluster order), and stop as soon as the smallest average
 *   linkage exceeds h.
 * - CALIBRATION GRID (lab v2b, verbatim): h in
 *   {0.08, 0.12, ..., 0.56}, step 0.04. h_b is the LARGEST grid
 *   value whose calibration false-merge rate is at most 1%
 *   (the lab's frozen calibration target: half the 2% gate).
 * - FALSE-MERGE RATE on a flat null: every member is its own
 *   lineage, so FMR at h is (sum over clusters of C(size, 2))
 *   divided by n*(n-1)/2, read off each null's merge sequence.
 *
 * THE UPGRADE (the only change against the rechecked port;
 * registration docs/lab-notes/R14-V2B-UPGRADE-REGISTRATION.md):
 * the rechecked port built its calibration nulls by permuting
 * the observed population's columns and FAILED the locked
 * recheck (CLEAN ARI 0.622 against 0.75, EV-SWITCH 0.439
 * against 0.50). The measured cause: on a structured
 * population the categorical marginals are lumpy (mass on the
 * lineage roots), so permuted rows collide on categorical
 * traits with probability sum(p^2), larger than the flat
 * null's uniform rate; calibration FMR is inflated at every h
 * and the selection rule picks h_b = 0.24 to 0.28 instead of
 * 0.32. Rank-flattening the marginals (CALNULL branch A) could
 * not repair this - midrank equality is exactly value
 * equality, so sum(p^2) survives it - and branch A failed too
 * (CLEAN 0.702, EV-SWITCH 0.458). This module's null is the
 * UNIFORMIZED-MARGINAL flat null (UM-null):
 * - categorical traits: each null column is drawn i.i.d.
 *   uniform over the trait's OBSERVED DISTINCT VALUES (the
 *   support is kept, the lumpy frequencies are not);
 * - numeric traits: branch A's procedure - midrank-flatten
 *   the column, rescale to u * numericScale, then permute the
 *   flattened column with Fisher-Yates;
 * - one mulberry32 stream seeded by populationSeed(raw rows);
 *   per null, traits are consumed in ascending order (a
 *   categorical trait consumes n uniform draws, a numeric
 *   trait consumes n-1 permutation draws).
 * The lab's h_b = 0.32 is a PRODUCT of calibration on the lab
 * substrate - it is NOT hard-coded anywhere in this module.
 *
 * HARD CONDITIONS - in the code, not just the docs:
 * 1. ADVISORY ONLY. Results carry `enforcement: "none"`. The
 *    module emits candidate clusters and calibration
 *    statistics; it has no blocking decision, attaches no
 *    consequence, and never labels a cluster or a member
 *    malicious.
 * 2. NO INVENTED THRESHOLD. If no grid h reaches the
 *    calibration target on this population's nulls, the result
 *    is `status: "uncalibratable"` with `h_b: null` and NO
 *    clusters - the module never falls back to the smallest
 *    grid value or to any hard-coded constant.
 * 3. OPT-IN AND PURE. Nothing runs until the host constructs
 *    an instance and hands it a whole population. The module
 *    holds no state between calls: the calibration seed is a
 *    pure function of the population's trait values (FNV-1a
 *    over the IEEE-754 bits, in input order), so the same
 *    population always yields the same nulls, the same h_b
 *    and the same clusters, bit for bit.
 *
 * HONEST LIMITS:
 * - THE LINEAGES ARE SYNTHETIC, WITH GROUND TRUTH; THERE IS NO
 *   REAL BOT POPULATION ANYWHERE IN THIS EVIDENCE. The results
 *   say only that the tree method beats flat clustering on
 *   data of this shape. Mapping synthetic "configuration
 *   traits" onto real bot tooling / infrastructure
 *   fingerprints is a deployment assumption that has never
 *   been measured.
 * - UNIFORM-OVER-SUPPORT matches the lab generator, whose flat
 *   categorical marginals are uniform. A genuinely flat real
 *   population with a naturally skewed categorical marginal
 *   would be UNDER-calibrated by this null (h_b too high,
 *   flat false-merge risk). That skew is unmeasured; the
 *   honest-flat lab cell guards only the generator's world.
 * - CHIMERAS ARE MOSTLY ISOLATED, NOT MISIDENTIFIED. At
 *   h_b = 0.32 in the lab, 57.9% of chimera leaves landed in
 *   no true lineage's cluster at all: the tighter cut moves
 *   the error from "wrongly identified" to "not identified".
 *   A member in NO cluster is not thereby cleared.
 * - TRAITS AND DISTANCE ARE HOST-DEFINED IN DEPLOYMENT. The
 *   lab distance is meaningful only for the lab's trait
 *   encoding. A host that feeds traits on another encoding
 *   must declare `categoricalTraitCount` / `numericScale` or
 *   supply `distanceFn`; the host is responsible for its
 *   traits carrying lineage signal at all. If `distanceFn` is
 *   supplied it is applied to the hybrid null rows exactly as
 *   to observed rows, and the UM construction still assumes
 *   the first `categoricalTraitCount` traits are categorical.
 * - Whole-population batch statistic: cost is dominated by
 *   the B = 40 calibration nulls, each an O(n^2) distance
 *   matrix plus a merge sequence over it. There is no
 *   streaming or per-event mode, by design.
 *
 * Pure computation: no I/O, no runtime dependencies, no state.
 */

/** The calibration grid, verbatim from the lab (v2b.cjs): 0.08 to 0.56 in steps of 0.04. */
const GRID: number[] = (() => {
  const grid: number[] = [];
  for (let t = 0.08; t <= 0.561; t += 0.04) grid.push(Math.round(t * 100) / 100);
  return grid;
})();

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): candidate lineage clusters from UPGMA average-linkage " +
  "clustering cut at a threshold self-calibrated on uniformized-marginal flat nulls of this same " +
  "population (largest grid h with calibration false-merge rate <= 1%). A cluster is investigation " +
  "telemetry about shared traits, never a maliciousness label and never attribution of intent; it " +
  "must never be the sole evidence for any consequence. Known limits: the lab evidence is synthetic " +
  "lineages only (no real bot population was measured), and chimera identities are mostly left " +
  "isolated (about 58% in the lab) rather than identified - absence from a cluster clears nobody.";

/** Named error thrown for every invalid lineage-watch input. */
export class LineageWatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineageWatchError";
  }
}

const fail = (message: string): never => {
  throw new LineageWatchError("createLineageWatch: " + message);
};

function requireIntInRange(value: number, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(field + " must be an integer between " + min + " and " + max);
  }
  return value;
}

/* ---------------- seeded PRNG + population seed (determinism) ---------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedView = new DataView(new ArrayBuffer(8));

function mixSeed(h: number, word: number): number {
  h ^= word >>> 0;
  h = Math.imul(h, 0x01000193) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** FNV-1a over n, the trait length, and the IEEE-754 bits of every trait value, in input order. */
function populationSeed(traits: readonly (readonly number[])[]): number {
  let h = 0x811c9dc5;
  h = mixSeed(h, traits.length);
  h = mixSeed(h, traits[0]!.length);
  for (const row of traits) {
    for (const value of row) {
      seedView.setFloat64(0, value);
      h = mixSeed(h, seedView.getUint32(0));
      h = mixSeed(h, seedView.getUint32(4));
    }
  }
  return h >>> 0;
}

/* ---------------- distance + clustering (lab verbatim) ---------------- */

export type LineageDistanceFn = (a: readonly number[], b: readonly number[]) => number;

function labDistance(categoricalTraitCount: number, numericScale: number): LineageDistanceFn {
  return (a, b) => {
    let s = 0;
    for (let t = 0; t < a.length; t++) {
      if (t < categoricalTraitCount) s += a[t] === b[t] ? 0 : 1;
      else s += Math.abs(a[t]! - b[t]!) / numericScale;
    }
    return s / a.length;
  };
}

function distMatrix(
  rows: readonly (readonly number[])[],
  distance: LineageDistanceFn,
): number[][] {
  const n = rows.length;
  const D: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = distance(rows[i]!, rows[j]!);
      if (typeof d !== "number" || !Number.isFinite(d) || d < 0) {
        fail("distanceFn must return a finite, non-negative number for every pair");
      }
      D[i]![j] = d;
      D[j]![i] = d;
    }
  }
  return D;
}

/** Average linkage between two clusters, computed exactly as the lab's clusterAt does. */
function clusterDistance(D: readonly (readonly number[])[], A: readonly number[], B: readonly number[]): number {
  let s = 0;
  let c = 0;
  for (const a of A) {
    for (const b of B) {
      s += D[a]![b]!;
      c++;
    }
  }
  return s / c;
}

interface MergeStep {
  distance: number;
  leftSize: number;
  rightSize: number;
}

/**
 * The full UPGMA merge sequence for a distance matrix. The greedy
 * choice at each step does not depend on the cut threshold, so
 * the partition clusterAt(D, h) returns is exactly the prefix of
 * this sequence up to (and excluding) the first step whose
 * distance exceeds h - which is what makes one sequence per
 * calibration null enough for the whole grid.
 */
function mergeSequence(D: readonly (readonly number[])[]): MergeStep[] {
  const n = D.length;
  let clusters: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const steps: MergeStep[] = [];
  for (;;) {
    if (clusters.length <= 1) break;
    let best: [number, number] | null = null;
    let bd = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = clusterDistance(D, clusters[i]!, clusters[j]!);
        if (d < bd) {
          bd = d;
          best = [i, j];
        }
      }
    }
    if (best === null) break;
    const [i, j] = best;
    steps.push({ distance: bd, leftSize: clusters[i]!.length, rightSize: clusters[j]!.length });
    clusters[i] = clusters[i]!.concat(clusters[j]!);
    clusters.splice(j, 1);
  }
  return steps;
}

/** The lab's clusterAt(D, thresh, "average"), returning clusters of member indices. */
function clusterAt(D: readonly (readonly number[])[], thresh: number): number[][] {
  let clusters: number[][] = Array.from({ length: D.length }, (_, i) => [i]);
  for (;;) {
    let best: [number, number] | null = null;
    let bd = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = clusterDistance(D, clusters[i]!, clusters[j]!);
        if (d < bd) {
          bd = d;
          best = [i, j];
        }
      }
    }
    if (best === null || bd > thresh) break;
    const [i, j] = best;
    clusters[i] = clusters[i]!.concat(clusters[j]!);
    clusters.splice(j, 1);
  }
  return clusters;
}

/* ---------------- the UM-null construction (the upgrade) ---------------- */

/**
 * Rank-flattened copy of the population (CALNULL branch A): every
 * trait value v is replaced by its midrank quantile u = (#{< v} +
 * 0.5 * #{= v}) / n within its own column. Categorical coordinates
 * keep u (u-equality is exactly value-equality); numeric
 * coordinates are rescaled to u * numericScale so distances in the
 * calibration nulls are in the same units as the raw population.
 */
function flattenedRows(
  rows: readonly (readonly number[])[],
  categoricalTraitCount: number,
  numericScale: number,
): number[][] {
  const n = rows.length;
  const traits = rows[0]!.length;
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(traits).fill(0));
  for (let t = 0; t < traits; t++) {
    const sorted = rows.map((r) => r[t]!).sort((a, b) => a - b);
    for (let i = 0; i < n; i++) {
      const v = rows[i]![t]!;
      let less = 0;
      let equal = 0;
      for (const s of sorted) {
        if (s < v) less++;
        else if (s === v) equal++;
      }
      const u = (less + 0.5 * equal) / n;
      out[i]![t] = t < categoricalTraitCount ? u : u * numericScale;
    }
  }
  return out;
}

/**
 * One UM-null population. Traits are consumed in ascending order
 * from the shared rng stream: a categorical trait consumes n
 * i.i.d. uniform draws over the trait's observed distinct values;
 * a numeric trait consumes an (n-1)-draw Fisher-Yates permutation
 * of the flattened column. The result is a hybrid row set: drawn
 * support values in the categorical coordinates, flattened
 * permuted values in the numeric coordinates.
 */
function uniformizedNullRows(
  rows: readonly (readonly number[])[],
  flat: readonly (readonly number[])[],
  supports: readonly (readonly number[])[],
  categoricalTraitCount: number,
  rng: () => number,
): number[][] {
  const n = rows.length;
  const traits = rows[0]!.length;
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(traits).fill(0));
  for (let t = 0; t < traits; t++) {
    if (t < categoricalTraitCount) {
      const support = supports[t]!;
      for (let i = 0; i < n; i++) {
        out[i]![t] = support[Math.floor(rng() * support.length)]!;
      }
    } else {
      const column = new Array<number>(n);
      for (let i = 0; i < n; i++) column[i] = flat[i]![t]!;
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = column[i]!;
        column[i] = column[j]!;
        column[j] = tmp;
      }
      for (let i = 0; i < n; i++) out[i]![t] = column[i]!;
    }
  }
  return out;
}

/* ---------------- public API ---------------- */

export interface LineageWatchMember {
  id: string;
  traits: readonly number[];
}

export interface LineageWatchOptions {
  /** How many leading traits are categorical. Default: min(8, trait length). */
  categoricalTraitCount?: number;
  /** Divisor for numeric trait differences. Default 100 (the lab layout). */
  numericScale?: number;
  /** Host distance over trait rows; replaces the lab distance. See the header caveat. */
  distanceFn?: LineageDistanceFn;
  /** Calibration nulls per evaluation (B). Default 40 (the lab value). */
  calibrationNulls?: number;
  /** Calibration target FMR. Default 0.01 (the lab's frozen target). */
  calibrationTargetFmr?: number;
  /** Fixed calibration seed; default derives it from the population (populationSeed). */
  calibrationSeed?: number;
}

export interface LineageWatchCalibration {
  nulls: number;
  targetFmr: number;
  grid: number[];
  fmrByH: { h: number; fmr: number }[];
  seed: number;
}

export interface LineageWatchResult {
  kind: "lineage_watch";
  status: "scored" | "uncalibratable";
  h_b: number | null;
  clusters: { memberIds: string[] }[];
  stats: {
    populationSize: number;
    clusterCount: number;
    singletonCount: number;
    calibration: LineageWatchCalibration;
  };
  enforcement: "none";
  notice: string;
}

export function createLineageWatch(options: LineageWatchOptions = {}): {
  evaluatePopulation: (members: readonly LineageWatchMember[]) => LineageWatchResult;
} {
  if (typeof options !== "object" || options === null) fail("options must be an object");
  const categoricalTraitCountOption =
    options.categoricalTraitCount === undefined
      ? undefined
      : requireIntInRange(options.categoricalTraitCount, "categoricalTraitCount", 0, 1_000_000);
  const numericScale = options.numericScale ?? 100;
  if (typeof numericScale !== "number" || !Number.isFinite(numericScale) || numericScale <= 0) {
    fail("numericScale must be a finite number > 0");
  }
  if (options.distanceFn !== undefined && typeof options.distanceFn !== "function") {
    fail("distanceFn must be a function");
  }
  const calibrationNulls = requireIntInRange(options.calibrationNulls ?? 40, "calibrationNulls", 1, 10_000);
  const calibrationTargetFmr = options.calibrationTargetFmr ?? 0.01;
  if (
    typeof calibrationTargetFmr !== "number" ||
    !Number.isFinite(calibrationTargetFmr) ||
    calibrationTargetFmr <= 0 ||
    calibrationTargetFmr > 0.5
  ) {
    fail("calibrationTargetFmr must be a finite number in (0, 0.5]");
  }
  const calibrationSeedOption =
    options.calibrationSeed === undefined
      ? undefined
      : requireIntInRange(options.calibrationSeed, "calibrationSeed", 0, 0xffffffff);
  const distanceFn = options.distanceFn;

  function evaluatePopulation(members: readonly LineageWatchMember[]): LineageWatchResult {
    if (!Array.isArray(members)) fail("members must be an array");
    if (members.length < 2) fail("members must contain at least 2 members");
    const seenIds = new Set<string>();
    let traitLength = -1;
    const rows: number[][] = [];
    members.forEach((member, i) => {
      if (typeof member !== "object" || member === null) fail("members[" + i + "] must be an object");
      if (typeof member.id !== "string" || member.id.length === 0) {
        fail("members[" + i + "].id must be a non-empty string");
      }
      if (seenIds.has(member.id)) {
        fail("members[" + i + "].id " + JSON.stringify(member.id) + " is duplicated");
      }
      seenIds.add(member.id);
      if (!Array.isArray(member.traits) || member.traits.length === 0) {
        fail("members[" + i + "].traits must be a non-empty array of finite numbers");
      }
      if (traitLength === -1) traitLength = member.traits.length;
      else if (member.traits.length !== traitLength) {
        fail(
          "members[" + i + "].traits has length " + member.traits.length + ", expected " + traitLength +
            " (all trait vectors in one population must share one length)",
        );
      }
      member.traits.forEach((value, t) => {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          fail("members[" + i + "].traits[" + t + "] must be a finite number");
        }
      });
      rows.push(member.traits.slice());
    });
    const n = rows.length;
    const categoricalTraitCount = categoricalTraitCountOption ?? Math.min(8, traitLength);
    if (categoricalTraitCount > traitLength) {
      fail(
        "categoricalTraitCount (" + categoricalTraitCount + ") exceeds the trait length (" + traitLength + ")",
      );
    }
    const distance: LineageDistanceFn = distanceFn ?? labDistance(categoricalTraitCount, numericScale);

    /* --- self-calibration on UM-nulls of THIS population --- */
    const flat = flattenedRows(rows, categoricalTraitCount, numericScale);
    const supports: number[][] = [];
    for (let t = 0; t < categoricalTraitCount; t++) {
      const distinct = new Set<number>();
      for (const row of rows) distinct.add(row[t]!);
      supports.push([...distinct].sort((a, b) => a - b));
    }
    const seed = calibrationSeedOption ?? populationSeed(rows);
    const rng = mulberry32(seed);
    const totalPairs = (n * (n - 1)) / 2;
    const nullState: { steps: MergeStep[]; cursor: number; mergedPairs: number }[] = [];
    for (let b = 0; b < calibrationNulls; b++) {
      const nullRows = uniformizedNullRows(rows, flat, supports, categoricalTraitCount, rng);
      const nullD = distMatrix(nullRows, distance);
      nullState.push({ steps: mergeSequence(nullD), cursor: 0, mergedPairs: 0 });
    }
    const fmrByH: { h: number; fmr: number }[] = [];
    let hB: number | null = null;
    for (const h of GRID) {
      let fmrSum = 0;
      for (const state of nullState) {
        while (state.cursor < state.steps.length && state.steps[state.cursor]!.distance <= h) {
          const step = state.steps[state.cursor]!;
          state.mergedPairs += step.leftSize * step.rightSize;
          state.cursor++;
        }
        fmrSum += totalPairs > 0 ? state.mergedPairs / totalPairs : 0;
      }
      const fmr = fmrSum / calibrationNulls;
      fmrByH.push({ h, fmr });
      if (fmr <= calibrationTargetFmr) hB = h; // keep the LARGEST qualifying h (lab rule)
    }
    const calibration: LineageWatchCalibration = {
      nulls: calibrationNulls,
      targetFmr: calibrationTargetFmr,
      grid: [...GRID],
      fmrByH,
      seed,
    };
    if (hB === null) {
      return {
        kind: "lineage_watch",
        status: "uncalibratable",
        h_b: null,
        clusters: [],
        stats: { populationSize: n, clusterCount: 0, singletonCount: n, calibration },
        enforcement: "none",
        notice: ADVISORY_NOTICE,
      };
    }

    /* --- cut the observed population at h_b --- */
    const D = distMatrix(rows, distance);
    const cut = clusterAt(D, hB);
    const clusters: { memberIds: string[] }[] = [];
    let singletonCount = 0;
    for (const cluster of cut) {
      if (cluster.length === 1) singletonCount++;
      else clusters.push({ memberIds: cluster.map((idx) => members[idx]!.id) });
    }
    return {
      kind: "lineage_watch",
      status: "scored",
      h_b: hB,
      clusters,
      stats: { populationSize: n, clusterCount: clusters.length, singletonCount, calibration },
      enforcement: "none",
      notice: ADVISORY_NOTICE,
    };
  }

  return { evaluatePopulation };
}
