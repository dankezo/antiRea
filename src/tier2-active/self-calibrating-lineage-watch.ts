/**
 * Self-calibrating lineage watch (HARVEST2 candidate R14
 * branch C, CALNULL-C; lab verdict ADVISORY-CONTINUE, upgraded
 * under the frozen registration in
 * docs/lab-notes/R14-C-UPGRADE-REGISTRATION.md).
 *
 * WHAT IT IS. The branch-C form of the R14 lineage watch: the
 * host supplies NO reference population. The module collects
 * its own bootstrap-window traffic into a reference population
 * R, freezes R when the window closes, calibrates a clustering
 * threshold h_b from R exactly once, and then scores later
 * populations at that frozen h_b with the same UPGMA
 * average-linkage cut as `createLineageWatch`. Output is
 * candidate lineage clusters - investigation telemetry, never
 * a maliciousness label and never a consequence by itself.
 *
 * WINDOW (frozen in the branch-C registration): the window
 * closes when BOTH (a) at least 7 days have passed since the
 * module was enabled (minBootstrapWindowMs, default
 * 604800000 ms, read through the injectable `now` clock) AND
 * (b) at least 500 identities have been admitted to R
 * (minBootstrapMembers, default 500). R freezes at close;
 * there are no online updates afterwards (a late update path
 * would let late arrivals poison the reference). The second
 * registered admission leg - admit only identities that
 * touched no other signal during the window - is a host-side
 * production control: the host enforces it by choosing what
 * to feed `observeBootstrap`. It was NOT measured in the lab
 * and no number here claims it.
 *
 * CALIBRATION (branch C verbatim except the trim, below):
 * rank-flatten the trimmed reference (midrank quantiles;
 * numeric traits rescaled to u * numericScale), build B = 40
 * trait-permutation nulls of the trimmed reference, and pick
 * h_b as the LARGEST grid h in {0.08, ..., 0.56} step 0.04
 * whose mean calibration false-merge rate is at most 1%.
 * The null seed is populationSeed(trimmed R raw rows), so the
 * same R always calibrates to the same h_b, bit for bit.
 *
 * THE UPGRADE (the only change against branch C as measured;
 * registration docs/lab-notes/R14-C-UPGRADE-REGISTRATION.md):
 * branch C trimmed the 10% of R farthest from its medoid.
 * Its own trim audit showed that trim is blind to flat
 * contamination: of 53 dropped rows only 11 were bot rows
 * (20.8%, the base rate), and the 20% contamination cell
 * FAILED (h_b flipped 0.40 to 0.44 on a calibration-FMR dip
 * of about 0.0005 across the 1% line; flat FMR 2.948%
 * against the 2% bar; tolerance bracket later measured at
 * [5%, 10%)). This module trims by LOCAL ISOLATION instead:
 * isolation(row) is the mean lab distance to its 5 nearest
 * other rows in R, and the Math.round(0.25 * |R|) most
 * isolated rows are dropped (boundary ties: lower original
 * index dropped first). An independent flat row has no
 * lineage siblings - its nearest neighbours sit near the
 * independent-pair distance (about 0.6 on the lab metric) -
 * while a structured row has siblings at about 0.2 to 0.3.
 * Medoid distance cannot see that difference; local
 * isolation is built from it. The 25% fraction (the
 * registered 20% contamination level plus 5 points of slack)
 * and the neighbour count 5 are frozen mechanism constants,
 * not options.
 *
 * WHAT THE LAB MEASURED for branch C with the OLD trim
 * (simulation, synthetic lineages, harness-v2 substrate;
 * R14-RESULTS-BRANCH-C.md): main gates CLEAN ARI 0.907,
 * FLAT FMR 1.837%, EV-MERGE 0.704, EV-SWITCH 0.668 at
 * h_b = 0.40; the 20% cell failed as described above. The
 * upgraded trim's numbers are the ones reported with this
 * build's recheck (docs/lab-notes/); the lab numbers above
 * are the pre-upgrade record, not a claim about this module.
 *
 * HARD CONDITIONS - in the code, not just the docs:
 * 1. ADVISORY ONLY. Results carry `enforcement: "none"`, at
 *    every lifecycle stage.
 * 2. NO CLUSTERS BEFORE CALIBRATION. Evaluating while the
 *    window is open returns status "bootstrap_open" with no
 *    clusters; if no grid h earns the calibration target the
 *    status is "uncalibratable" with h_b null and no
 *    clusters. The module never invents a threshold.
 * 3. FROZEN REFERENCE. After close, observeBootstrap throws;
 *    the calibration never moves inside an instance.
 * 4. Scored populations must share the bootstrap trait
 *    length: h_b is a property of R's trait space, and
 *    applying it to another space would be meaningless.
 *
 * HONEST LIMITS:
 * - All lab evidence is synthetic lineages with ground
 *   truth; no real bot population was measured, and nothing
 *   here is a real-traffic rate.
 * - Trimming 25% of a CLEAN reference removes its most
 *   isolated legitimate rows and biases calibration toward
 *   structure: conservative for the flat gate, paid for in
 *   sensitivity. Real warm-up traffic mixes structured
 *   lineages with independent legitimate users, whose rows
 *   are locally isolated by nature; they are trimmed out of
 *   a CALIBRATION reference only (no consequence attaches),
 *   but the reference is then not a sample of real traffic.
 * - The 7-day window leg and the signal-free admission leg
 *   are production parameters the lab cannot measure.
 * - Cost: closing runs B = 40 null merge sequences over the
 *   trimmed reference (O(|R'|^2) distance work per null);
 *   scoring is one O(n^2) cut per population.
 *
 * Pure computation apart from the injectable clock read: no
 * I/O, no runtime dependencies.
 */

/** The calibration grid, verbatim from the lab: 0.08 to 0.56 in steps of 0.04. */
const GRID: number[] = (() => {
  const grid: number[] = [];
  for (let t = 0.08; t <= 0.561; t += 0.04) grid.push(Math.round(t * 100) / 100);
  return grid;
})();

/** Frozen mechanism constants (registration section 2): not options. */
const TRIM_FRACTION = 0.25;
const TRIM_NEIGHBOURS = 5;

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): candidate lineage clusters from UPGMA average-linkage " +
  "clustering cut at a threshold calibrated once from this deployment's own frozen bootstrap-window " +
  "reference (isolation-trimmed, rank-flattened permutation nulls; largest grid h with calibration " +
  "false-merge rate <= 1%). A cluster is investigation telemetry about shared traits, never a " +
  "maliciousness label and never attribution of intent; it must never be the sole evidence for any " +
  "consequence. Known limits: the lab evidence is synthetic lineages only (no real bot population " +
  "was measured), the bootstrap reference is trimmed toward structure, and absence from a cluster " +
  "clears nobody.";

/** Named error thrown for every invalid self-calibrating lineage-watch input or state. */
export class SelfCalibratingLineageWatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfCalibratingLineageWatchError";
  }
}

const fail = (message: string): never => {
  throw new SelfCalibratingLineageWatchError("createSelfCalibratingLineageWatch: " + message);
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

export type SelfCalibratingDistanceFn = (a: readonly number[], b: readonly number[]) => number;

function labDistance(categoricalTraitCount: number, numericScale: number): SelfCalibratingDistanceFn {
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
  distance: SelfCalibratingDistanceFn,
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

/**
 * One trait-permutation null population: every trait coordinate
 * is shuffled independently across members (Fisher-Yates, rng
 * consumed trait by trait in order), preserving each trait's
 * marginal distribution exactly and destroying joint structure.
 */
function permutedRows(rows: readonly (readonly number[])[], rng: () => number): number[][] {
  const n = rows.length;
  const traits = rows[0]!.length;
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(traits).fill(0));
  for (let t = 0; t < traits; t++) {
    const column = new Array<number>(n);
    for (let i = 0; i < n; i++) column[i] = rows[i]![t]!;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = column[i]!;
      column[i] = column[j]!;
      column[j] = tmp;
    }
    for (let i = 0; i < n; i++) out[i]![t] = column[i]!;
  }
  return out;
}

/**
 * Rank-flattened copy of the reference (branch A procedure):
 * every trait value v is replaced by its midrank quantile
 * u = (#{< v} + 0.5 * #{= v}) / n within its own column.
 * Categorical coordinates keep u; numeric coordinates are
 * rescaled to u * numericScale.
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

/* ---------------- the isolation trim (the upgrade) ---------------- */

export interface IsolationTrimResult {
  /** Indices into the input rows that are kept, ascending (original order). */
  keptIndices: number[];
  /** Indices into the input rows that are dropped, ascending. */
  droppedIndices: number[];
  /** Mean distance to the 5 nearest other rows, per input row. */
  isolation: number[];
}

/**
 * The module's reference trim, exported for auditability: drop
 * the Math.round(0.25 * n) rows with the largest isolation
 * (mean distance to the 5 nearest other rows, lab distance by
 * default). Boundary ties: lower original index dropped first.
 * Pure: the same rows always trim the same way.
 */
export function isolationTrimReference(
  rows: readonly (readonly number[])[],
  options: {
    categoricalTraitCount?: number;
    numericScale?: number;
    distanceFn?: SelfCalibratingDistanceFn;
  } = {},
): IsolationTrimResult {
  if (!Array.isArray(rows) || rows.length < 2) {
    fail("isolationTrimReference: rows must contain at least 2 rows");
  }
  const traitLength = rows[0]!.length;
  const categoricalTraitCount = options.categoricalTraitCount ?? Math.min(8, traitLength);
  const numericScale = options.numericScale ?? 100;
  const distance: SelfCalibratingDistanceFn =
    options.distanceFn ?? labDistance(categoricalTraitCount, numericScale);
  const n = rows.length;
  const D = distMatrix(rows, distance);
  const k = Math.min(TRIM_NEIGHBOURS, n - 1);
  const isolation: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const dists: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j !== i) dists.push(D[i]![j]!);
    }
    dists.sort((a, b) => a - b);
    let s = 0;
    for (let m = 0; m < k; m++) s += dists[m]!;
    isolation[i] = s / k;
  }
  const drop = Math.round(TRIM_FRACTION * n);
  const order = rows
    .map((_, i) => i)
    .sort((a, b) => {
      const d = isolation[a]! - isolation[b]!;
      return d !== 0 ? (d > 0 ? -1 : 1) : a - b; // most isolated first; ties: lower index first
    });
  const dropSet = new Set(order.slice(0, drop));
  const keptIndices: number[] = [];
  const droppedIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (dropSet.has(i)) droppedIndices.push(i);
    else keptIndices.push(i);
  }
  return { keptIndices, droppedIndices, isolation };
}

/* ---------------- public API ---------------- */

export interface SelfCalibratingLineageWatchMember {
  id: string;
  traits: readonly number[];
}

export interface SelfCalibratingLineageWatchOptions {
  /** How many leading traits are categorical. Default: min(8, trait length). */
  categoricalTraitCount?: number;
  /** Divisor for numeric trait differences. Default 100 (the lab layout). */
  numericScale?: number;
  /** Host distance over trait rows; replaces the lab distance. */
  distanceFn?: SelfCalibratingDistanceFn;
  /** Calibration nulls at close (B). Default 40 (the lab value). */
  calibrationNulls?: number;
  /** Calibration target FMR. Default 0.01 (the lab's frozen target). */
  calibrationTargetFmr?: number;
  /** Window leg (b): identities required before close. Default 500 (registration). */
  minBootstrapMembers?: number;
  /** Window leg (a): milliseconds since enable required before close. Default 604800000 (7 days). */
  minBootstrapWindowMs?: number;
  /** Clock read for the window leg. Default Date.now. */
  now?: () => number;
}

export interface SelfCalibratingCalibration {
  nulls: number;
  targetFmr: number;
  grid: number[];
  fmrByH: { h: number; fmr: number }[];
  seed: number;
  referenceSize: number;
  trimmedSize: number;
  droppedCount: number;
}

export type SelfCalibratingCloseResult =
  | {
      status: "ready";
      h_b: number;
      calibration: SelfCalibratingCalibration;
    }
  | {
      status: "uncalibratable";
      h_b: null;
      calibration: SelfCalibratingCalibration;
    }
  | {
      status: "open";
      reason: "insufficient_members" | "window_too_short";
      bootstrapCount: number;
      remainingMembers: number;
      remainingMs: number;
    };

export interface SelfCalibratingResult {
  kind: "self_calibrating_lineage_watch";
  status: "scored" | "uncalibratable" | "bootstrap_open";
  h_b: number | null;
  clusters: { memberIds: string[] }[];
  stats: {
    populationSize: number;
    clusterCount: number;
    singletonCount: number;
    bootstrapCount: number;
    calibration: SelfCalibratingCalibration | null;
  };
  enforcement: "none";
  notice: string;
}

export interface SelfCalibratingSnapshot {
  status: "collecting" | "ready" | "uncalibratable";
  bootstrapCount: number;
  firstObservedAtMs: number | null;
  h_b: number | null;
  calibration: SelfCalibratingCalibration | null;
}

export function createSelfCalibratingLineageWatch(
  options: SelfCalibratingLineageWatchOptions = {},
): {
  observeBootstrap: (member: SelfCalibratingLineageWatchMember) => number;
  observeBootstrapBatch: (members: readonly SelfCalibratingLineageWatchMember[]) => number;
  closeBootstrap: () => SelfCalibratingCloseResult;
  evaluatePopulation: (members: readonly SelfCalibratingLineageWatchMember[]) => SelfCalibratingResult;
  snapshot: () => SelfCalibratingSnapshot;
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
  const minBootstrapMembers = requireIntInRange(
    options.minBootstrapMembers ?? 500,
    "minBootstrapMembers",
    2,
    10_000_000,
  );
  const minBootstrapWindowMs = options.minBootstrapWindowMs ?? 604_800_000;
  if (
    typeof minBootstrapWindowMs !== "number" ||
    !Number.isFinite(minBootstrapWindowMs) ||
    minBootstrapWindowMs < 0
  ) {
    fail("minBootstrapWindowMs must be a finite number >= 0");
  }
  const now = options.now ?? Date.now;
  if (typeof now !== "function") fail("now must be a function");
  const distanceFn = options.distanceFn;

  const bootstrapRows: number[][] = [];
  const bootstrapIds = new Set<string>();
  let traitLength = -1;
  let firstObservedAtMs: number | null = null;
  let closed: SelfCalibratingCloseResult | null = null;
  let calibration: SelfCalibratingCalibration | null = null;
  let hB: number | null = null;

  function categoricalTraitCount(): number {
    return categoricalTraitCountOption ?? Math.min(8, traitLength);
  }

  function validateMember(member: SelfCalibratingLineageWatchMember, i: number, where: string): number[] {
    if (typeof member !== "object" || member === null) fail(where + "[" + i + "] must be an object");
    if (typeof member.id !== "string" || member.id.length === 0) {
      fail(where + "[" + i + "].id must be a non-empty string");
    }
    if (!Array.isArray(member.traits) || member.traits.length === 0) {
      fail(where + "[" + i + "].traits must be a non-empty array of finite numbers");
    }
    member.traits.forEach((value, t) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(where + "[" + i + "].traits[" + t + "] must be a finite number");
      }
    });
    return member.traits.slice();
  }

  function observeBootstrap(member: SelfCalibratingLineageWatchMember): number {
    if (closed !== null) fail("bootstrap window is closed; the reference is frozen");
    const row = validateMember(member, bootstrapRows.length, "bootstrap");
    if (bootstrapIds.has(member.id)) {
      fail("bootstrap id " + JSON.stringify(member.id) + " is duplicated");
    }
    if (traitLength === -1) {
      traitLength = row.length;
      if (categoricalTraitCount() > traitLength) {
        fail(
          "categoricalTraitCount (" + categoricalTraitCount() + ") exceeds the trait length (" + traitLength + ")",
        );
      }
    } else if (row.length !== traitLength) {
      fail(
        "bootstrap traits have length " + row.length + ", expected " + traitLength +
          " (all bootstrap trait vectors must share one length)",
      );
    }
    if (firstObservedAtMs === null) {
      const t = now();
      firstObservedAtMs = typeof t === "number" && Number.isFinite(t) ? t : 0;
    }
    bootstrapIds.add(member.id);
    bootstrapRows.push(row);
    return bootstrapRows.length;
  }

  function observeBootstrapBatch(members: readonly SelfCalibratingLineageWatchMember[]): number {
    if (!Array.isArray(members)) fail("members must be an array");
    let count = bootstrapRows.length;
    for (const member of members) count = observeBootstrap(member);
    return count;
  }

  function closeBootstrap(): SelfCalibratingCloseResult {
    if (closed !== null) return closed;
    const count = bootstrapRows.length;
    if (count < minBootstrapMembers) {
      return {
        status: "open",
        reason: "insufficient_members",
        bootstrapCount: count,
        remainingMembers: minBootstrapMembers - count,
        remainingMs:
          firstObservedAtMs === null
            ? minBootstrapWindowMs
            : Math.max(0, minBootstrapWindowMs - (now() - firstObservedAtMs)),
      };
    }
    const elapsed = firstObservedAtMs === null ? 0 : now() - firstObservedAtMs;
    if (elapsed < minBootstrapWindowMs) {
      return {
        status: "open",
        reason: "window_too_short",
        bootstrapCount: count,
        remainingMembers: 0,
        remainingMs: minBootstrapWindowMs - elapsed,
      };
    }
    const distance: SelfCalibratingDistanceFn =
      distanceFn ?? labDistance(categoricalTraitCount(), numericScale);
    const trim = isolationTrimReference(bootstrapRows, {
      categoricalTraitCount: categoricalTraitCount(),
      numericScale,
      distanceFn,
    });
    const trimmed = trim.keptIndices.map((idx) => bootstrapRows[idx]!);
    const flat = flattenedRows(trimmed, categoricalTraitCount(), numericScale);
    const seed = populationSeed(trimmed);
    const rng = mulberry32(seed);
    const n = trimmed.length;
    const totalPairs = (n * (n - 1)) / 2;
    const nullState: { steps: MergeStep[]; cursor: number; mergedPairs: number }[] = [];
    for (let b = 0; b < calibrationNulls; b++) {
      const nullRows = permutedRows(flat, rng);
      const nullD = distMatrix(nullRows, distance);
      nullState.push({ steps: mergeSequence(nullD), cursor: 0, mergedPairs: 0 });
    }
    const fmrByH: { h: number; fmr: number }[] = [];
    let selected: number | null = null;
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
      if (fmr <= calibrationTargetFmr) selected = h;
    }
    calibration = {
      nulls: calibrationNulls,
      targetFmr: calibrationTargetFmr,
      grid: [...GRID],
      fmrByH,
      seed,
      referenceSize: count,
      trimmedSize: n,
      droppedCount: trim.droppedIndices.length,
    };
    hB = selected;
    closed =
      selected === null
        ? { status: "uncalibratable", h_b: null, calibration }
        : { status: "ready", h_b: selected, calibration };
    return closed;
  }

  function evaluatePopulation(
    members: readonly SelfCalibratingLineageWatchMember[],
  ): SelfCalibratingResult {
    if (!Array.isArray(members)) fail("members must be an array");
    if (members.length < 2) fail("members must contain at least 2 members");
    const seenIds = new Set<string>();
    const rows: number[][] = [];
    members.forEach((member, i) => {
      const row = validateMember(member, i, "members");
      if (seenIds.has(member.id)) {
        fail("members[" + i + "].id " + JSON.stringify(member.id) + " is duplicated");
      }
      seenIds.add(member.id);
      if (traitLength !== -1 && row.length !== traitLength) {
        fail(
          "members[" + i + "].traits has length " + row.length + ", expected the bootstrap trait length " +
            traitLength + " (h_b is a property of the bootstrap trait space)",
        );
      }
      rows.push(row);
    });
    const n = rows.length;
    const baseStats = {
      populationSize: n,
      clusterCount: 0,
      singletonCount: n,
      bootstrapCount: bootstrapRows.length,
      calibration,
    };
    if (closed === null) {
      return {
        kind: "self_calibrating_lineage_watch",
        status: "bootstrap_open",
        h_b: null,
        clusters: [],
        stats: baseStats,
        enforcement: "none",
        notice: ADVISORY_NOTICE,
      };
    }
    if (hB === null) {
      return {
        kind: "self_calibrating_lineage_watch",
        status: "uncalibratable",
        h_b: null,
        clusters: [],
        stats: baseStats,
        enforcement: "none",
        notice: ADVISORY_NOTICE,
      };
    }
    const distance: SelfCalibratingDistanceFn =
      distanceFn ?? labDistance(categoricalTraitCount(), numericScale);
    const D = distMatrix(rows, distance);
    const cut = clusterAt(D, hB);
    const clusters: { memberIds: string[] }[] = [];
    let singletonCount = 0;
    for (const cluster of cut) {
      if (cluster.length === 1) singletonCount++;
      else clusters.push({ memberIds: cluster.map((idx) => members[idx]!.id) });
    }
    return {
      kind: "self_calibrating_lineage_watch",
      status: "scored",
      h_b: hB,
      clusters,
      stats: { ...baseStats, clusterCount: clusters.length, singletonCount },
      enforcement: "none",
      notice: ADVISORY_NOTICE,
    };
  }

  function snapshot(): SelfCalibratingSnapshot {
    return {
      status: closed === null ? "collecting" : closed.status === "ready" ? "ready" : "uncalibratable",
      bootstrapCount: bootstrapRows.length,
      firstObservedAtMs,
      h_b: hB,
      calibration,
    };
  }

  return { observeBootstrap, observeBootstrapBatch, closeBootstrap, evaluatePopulation, snapshot };
}
