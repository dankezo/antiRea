/**
 * Cohort box signal (HARVEST2 candidate C19, BLS-COHORT, lab PASS -
 * see the study lab's C19-STEP0.md, C19-DESIGN.md and
 * C19-RESULTS.md under the antiRea research tree).
 *
 * WHAT IT MEASURES. A herd that extracts in rotating shifts is
 * invisible member by member, but on the cohort's POOLED event
 * rate its duty cycle is a BOX: a periodic interval of elevated
 * rate. This module bins a host-declared cohort's pooled events
 * into 30-minute bins over a trailing 14-day window (L = 672),
 * fits the best box template with the BLS statistic of Kovacs,
 * Zucker & Mazeh (2002) over a fixed period grid (6h to 168h,
 * multiplicative step 1.04; phase profile per period; box shares
 * q in {0.03, 0.05, 0.08, 0.12, 0.18, 0.25, 0.35}), deflates the
 * best SNR by the red-noise factor beta of Pont, Zucker & Queloz
 * (2006) measured from the residuals at the winning box's own
 * time scale, and reads the false-alarm probability from 199
 * day-block bootstrap replicas (whole days resampled with
 * replacement, so the circadian phase survives in the null while
 * multi-day structure is destroyed). A cohort is flagged when
 * p <= alpha (0.01). The detector is the lab's frozen Step-0/1
 * statistic, translated without re-invention; the bootstrap seed
 * is derived from the binned series itself, so the same data
 * always yields the same p.
 *
 * WHAT THE LAB MEASURED (simulation, scripted populations):
 * legitimate cohorts 0/150 flagged (the family where the
 * phase-folding candidate C15 died at 9.8% FP), sale cohorts 0/50,
 * shift herds on a 36h rotation flagged 9/9 and on 48h 8/9 (the
 * one miss is beta self-cancellation: the herd's own residuals
 * stay correlated at box scale and beta spikes to 4.27), every
 * registered evader variant (per-member phase jitter, triangular
 * in-shift rate, memoryless in-shift gaps) flagged 9/9 at ~0
 * measured extra cost, evaluation cost p99 22.4 ms per
 * identity-checkpoint against a 50 ms bar.
 *
 * STRUCTURAL BLIND SPOTS - declared up front, reproduced in the
 * lab, and pinned by this module's tests:
 * - DAY-ALIGNED BOXES ARE THE NULL'S OWN SHAPE. The day-block
 *   bootstrap preserves circadian phase, so a 24h-periodic box
 *   aligned to the day (a 24h shift rotation - and equally a
 *   legitimate sale/launch that runs on a daily rhythm) is
 *   indistinguishable from the null: lab SHIFT-24 flagged 0/9
 *   (p 0.015-0.865). This module CANNOT separate a day-rhythm
 *   herd from day-rhythm legitimate operations on this statistic.
 *   The mitigation is DECLARED STRATIFICATION (hard condition 1),
 *   not a threshold.
 * - COVERAGE-GEOMETRY HERDS ARE INVISIBLE. A herd that
 *   coordinates in WHICH resources it covers rather than WHEN it
 *   is active produces no box on the pooled rate: lab 0/54. That
 *   shape belongs to the coverage channels (herd detector, C6).
 * - POOLED RATE ERASES MEMBERSHIP. The signal is a property of a
 *   cohort, never of any member; it cannot attribute an identity.
 *
 * HARD CONDITIONS - in the code, not just the docs:
 *
 * 1. DECLARED STRATIFICATION. The host may declare strata for its
 *    known legitimate scheduled operations (declared shift teams,
 *    sale/launch campaigns) via `declaredStrata`, and tag cohorts
 *    with a stratum. A cohort whose stratum is declared is NEVER
 *    flagged: its statistics are still computed and reported, with
 *    status `"declared_stratum"`, so the declaration is auditable
 *    rather than a silent skip. Given the day-rhythm blind spot
 *    above, a host that runs legitimate day-rhythm operations
 *    MUST declare them; an undeclared day-rhythm legitimate cohort
 *    is exactly the shape this statistic cannot acquit on its
 *    own... and also cannot convict (it sits inside the null) -
 *    the declaration exists so the host's other channels, not
 *    this one, carry those cohorts.
 * 2. ADVISORY ONLY. The module emits signal objects
 *    (`enforcement: "none"`). It has no blocking decision and
 *    attaches no consequence; a flag is cohort-level
 *    investigation telemetry.
 * 3. OPT-IN. Nothing runs until the host constructs an instance
 *    and feeds it cohort-tagged events. Cohorts are host-declared
 *    groupings (an event's `cohortId`); the module invents no
 *    grouping of its own.
 * 4. NO FITTED CALIBRATION. Unlike the conformal modules, this
 *    detector's significance is self-contained (bootstrap FAP);
 *    there is no training pool and no host traffic fit. The price
 *    is compute: one evaluation runs the BLS search 200 times
 *    (observed + 199 replicas).
 *
 * Pure computation: no I/O, no runtime dependencies. State is
 * bounded in-memory maps (per cohort: a sorted timestamp list,
 * capped, plus a member set).
 */

const BIN_MS = 1_800_000; // 30 minutes, the lab's bin width.
const DAY_BINS = 48;
const PERIOD_MIN_H = 6;
const PERIOD_MAX_H = 168;
const PERIOD_STEP = 1.04;
const Q_LIST = [0.03, 0.05, 0.08, 0.12, 0.18, 0.25, 0.35] as const;

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): a periodic box shape on this cohort's pooled event " +
  "rate (BLS fit, red-noise deflated, day-block bootstrap FAP). A flag is cohort-level " +
  "investigation telemetry; it attributes no member and must never be the sole evidence for any " +
  "consequence. Structural blind spots: day-aligned (24h) boxes sit inside the bootstrap null, " +
  "and herds coordinating in coverage geometry rather than time are invisible to this statistic.";

export interface CohortBoxEvent {
  /** The authenticated identity the event was served to. */
  identity: string;
  /** Host-declared cohort this event pools into. */
  cohortId: string;
  /** Millisecond timestamp of the event. */
  ts: number;
  /**
   * Optional host-declared stratum for the cohort (e.g. a declared
   * shift team or a sale campaign). The first stratum declared for
   * a cohort wins; later conflicting declarations are ignored and
   * counted in the snapshot.
   */
  stratum?: string;
}

export interface CreateCohortBoxSignalOptions {
  /** Trailing evaluation window in days. Defaults to 14 (the lab's window; L = 672 bins). */
  windowDays?: number;
  /** Bootstrap FAP level: flag iff p <= alpha. Defaults to 0.01 (the lab's alpha). */
  alpha?: number;
  /** Day-block bootstrap replicas. Defaults to 199 (the lab's replica count; p resolution 1/200). */
  bootstrapReplicas?: number;
  /**
   * Host-declared legitimate strata. A cohort tagged with one of
   * these is never flagged (hard condition 1); its statistics are
   * still reported with status `"declared_stratum"`.
   */
  declaredStrata?: string[];
  /** Minimum in-window events before a cohort is scored. Defaults to 100. */
  minCohortEvents?: number;
  /** Maximum cohorts tracked at once (least-recently-seen evicted). Defaults to 2,000. */
  maxCohorts?: number;
  /** Maximum event timestamps retained per cohort (oldest dropped). Defaults to 1,000,000. */
  maxEventsPerCohort?: number;
}

export interface CohortBoxObservation {
  /**
   * `"recorded"` - pooled into the cohort; `"invalid_ts"` -
   * non-finite or out-of-range timestamp, refused before any
   * state was touched.
   */
  status: "recorded" | "invalid_ts";
  /** Whether the event was counted. */
  counted: boolean;
  /** Total events retained for the cohort after this event. */
  events: number;
}

export interface CohortBoxSignal {
  kind: "cohort_box";
  cohortId: string;
  /**
   * `"scored"` - the full detector ran; `"declared_stratum"` -
   * the cohort's stratum is host-declared legitimate: statistics
   * computed and reported, never flagged; `"insufficient_data"` -
   * too few in-window events, or a constant series (no rate
   * variance to fit a box against).
   */
  status: "scored" | "declared_stratum" | "insufficient_data";
  /** True exactly when scored (not declared) and the bootstrap p crossed alpha. */
  flagged: boolean;
  /** Bootstrap false-alarm probability (1 + #{replica S_beta >= observed S_beta}) / (replicas + 1), or null when not scored. */
  pValue: number | null;
  /** Best-box SNR before red-noise deflation, or null when not scored. */
  scoreS: number | null;
  /** Red-noise-deflated statistic S / beta - the quantity the bootstrap calibrates - or null when not scored. */
  scoreSBeta: number | null;
  /** Pont red-noise factor beta at the winning box's scale (>= 1), or null when not scored. */
  beta: number | null;
  /** Winning box period in hours, or null when not scored. */
  bestPeriodHours: number | null;
  /** Winning box share q of the period, or null when not scored. */
  bestBoxShare: number | null;
  /** Events inside the trailing window (the scored series' total). */
  eventsInWindow: number;
  /** Events retained for the cohort overall. */
  eventsRetained: number;
  /** Distinct member identities seen in the cohort. */
  members: number;
  /** Window start (ms) of the scored series. */
  windowStartMs: number | null;
  /** Window end (ms) of the scored series: the cohort's latest event. */
  windowEndMs: number | null;
  /** The cohort's declared stratum, when one was declared for it. */
  stratum: string | null;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface CohortBoxSnapshot {
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  windowDays: number;
  bins: number;
  alpha: number;
  bootstrapReplicas: number;
  declaredStrata: string[];
  cohortsTracked: number;
  counters: {
    /** Events pooled into a cohort. */
    recorded: number;
    /** Events refused for a non-finite or out-of-range timestamp. */
    invalidTs: number;
    /** Events dropped by the per-cohort retention cap. */
    droppedByCap: number;
    /** Conflicting later stratum declarations ignored (first declaration wins). */
    stratumConflicts: number;
    /** Full detector evaluations run. */
    evaluations: number;
  };
  notice: string;
}

export interface CohortBoxSignalInstance {
  /** Feed one cohort-tagged event. */
  observe(event: CohortBoxEvent): CohortBoxObservation;
  /** Run the frozen detector over one cohort's trailing window. Deterministic for identical retained data. */
  evaluateCohort(cohortId: string): CohortBoxSignal;
  /** State summary. */
  snapshot(): CohortBoxSnapshot;
}

/** Named error thrown for every invalid cohort-box input. */
export class CohortBoxSignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CohortBoxSignalError";
  }
}

const fail = (message: string): never => {
  throw new CohortBoxSignalError(`createCohortBoxSignal: ${message}`);
};

function requireIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requireName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value as string;
}

/** The F-21 timestamp discipline shared with the herd detector: finite and inside the representable Date range. */
function isValidTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8.64e15;
}

/* ---------------- seeded PRNG + series hash (determinism) ---------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the binned series: the bootstrap seed is a pure function of the data evaluated. */
function seriesSeed(x: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < x.length; i++) {
    h ^= (x[i]! + 0x9e3779b9) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/* ---------------- the frozen BLS + beta statistic ---------------- */

interface PeriodMap {
  periodHours: number;
  /** Phase-bin count M for this period. */
  m: number;
  /** phaseBinOfBin[j] = phase bin of time bin j. */
  phaseBinOfBin: Uint16Array;
}

function buildPeriodMaps(bins: number): PeriodMap[] {
  const maps: PeriodMap[] = [];
  for (let p = PERIOD_MIN_H; p <= PERIOD_MAX_H * (1 + 1e-9); p *= PERIOD_STEP) {
    const m = Math.min(240, Math.max(24, Math.round(p / 0.5)));
    const phaseBinOfBin = new Uint16Array(bins);
    for (let j = 0; j < bins; j++) {
      const phi = (((j + 0.5) * 0.5) % p) / p;
      phaseBinOfBin[j] = Math.min(m - 1, Math.floor(phi * m));
    }
    maps.push({ periodHours: p, m, phaseBinOfBin });
  }
  return maps;
}

interface BlsBest {
  s: number;
  periodHours: number;
  q: number;
  /** Phase-bin index of the winning box's first bin, and its width in phase bins. */
  boxStart: number;
  boxWidth: number;
  phaseBins: number;
  inMean: number;
  outMean: number;
}

/** Best-box SNR over the frozen grid; null when the series has no variance. */
function blsBest(x: Float64Array, maps: PeriodMap[]): BlsBest | null {
  const L = x.length;
  let mean = 0;
  for (let j = 0; j < L; j++) mean += x[j]!;
  mean /= L;
  let varSum = 0;
  for (let j = 0; j < L; j++) {
    const d = x[j]! - mean;
    varSum += d * d;
  }
  const sigma = Math.sqrt(varSum / L); // population std, as registered.
  if (sigma === 0) return null;

  let best: BlsBest | null = null;
  const y = new Float64Array(240);
  const c = new Float64Array(240);
  const prefY = new Float64Array(2 * 240 + 1);
  const prefC = new Float64Array(2 * 240 + 1);

  for (const map of maps) {
    const M = map.m;
    y.fill(0, 0, M);
    c.fill(0, 0, M);
    for (let j = 0; j < L; j++) {
      const m = map.phaseBinOfBin[j]!;
      y[m] = y[m]! + x[j]!;
      c[m] = c[m]! + 1;
    }
    let totalY = 0;
    for (let m = 0; m < M; m++) {
      totalY += y[m]!;
      prefY[m + 1] = prefY[m]! + y[m]!;
      prefC[m + 1] = prefC[m]! + c[m]!;
    }
    for (let m = 0; m < M; m++) {
      prefY[M + m + 1] = prefY[M + m]! + y[m]!;
      prefC[M + m + 1] = prefC[M + m]! + c[m]!;
    }
    for (const q of Q_LIST) {
      let d = Math.max(1, Math.round(q * M));
      if (d > M / 2) d = Math.floor(M / 2);
      if (d < 1) continue;
      for (let s = 0; s < M; s++) {
        const inC = prefC[s + d]! - prefC[s]!;
        if (inC === 0 || inC === L) continue;
        const inY = prefY[s + d]! - prefY[s]!;
        const inMean = inY / inC;
        const outMean = (totalY - inY) / (L - inC);
        const depth = inMean - outMean;
        if (depth <= 0) continue;
        const snr = depth / (sigma * Math.sqrt(1 / inC + 1 / (L - inC)));
        if (best === null || snr > best.s) {
          best = {
            s: snr,
            periodHours: map.periodHours,
            q,
            boxStart: s,
            boxWidth: d,
            phaseBins: M,
            inMean,
            outMean,
          };
        }
      }
    }
  }
  return best;
}

function sampleStd(values: ArrayLike<number>, mean: number): number {
  const n = values.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i]! - mean;
    sum += d * d;
  }
  return Math.sqrt(sum / (n - 1));
}

/** Pont red-noise factor at the winning box's scale, exactly as registered in C19-STEP0 section 2. */
function pontBeta(x: Float64Array, maps: PeriodMap[], best: BlsBest): number {
  const L = x.length;
  const map = maps.find((entry) => entry.periodHours === best.periodHours);
  if (!map) return 1;
  const inBox = (phaseBin: number): boolean => {
    const rel = (phaseBin - best.boxStart + best.phaseBins) % best.phaseBins;
    return rel < best.boxWidth;
  };
  const r = new Float64Array(L);
  let rMean = 0;
  for (let j = 0; j < L; j++) {
    r[j] = x[j]! - (inBox(map.phaseBinOfBin[j]!) ? best.inMean : best.outMean);
    rMean += r[j]!;
  }
  rMean /= L;
  let nb = Math.max(1, Math.round((best.q * best.periodHours) / 0.5));
  const maxNb = Math.floor(L / 4);
  if (nb > maxNb) nb = maxNb;
  if (nb < 1) return 1;
  const groups = Math.floor(L / nb);
  if (groups < 2) return 1;
  const groupMeans = new Float64Array(groups);
  for (let g = 0; g < groups; g++) {
    let sum = 0;
    for (let j = 0; j < nb; j++) sum += r[g * nb + j]!;
    groupMeans[g] = sum / nb;
  }
  let gm = 0;
  for (let g = 0; g < groups; g++) gm += groupMeans[g]!;
  gm /= groups;
  const sigmaR = sampleStd(groupMeans, gm);
  const sigmaW = sampleStd(r, rMean) / Math.sqrt(nb);
  if (sigmaW === 0) return 1;
  return Math.max(1, sigmaR / sigmaW);
}

function sBeta(x: Float64Array, maps: PeriodMap[]): { sBeta: number; best: BlsBest | null; beta: number } {
  const best = blsBest(x, maps);
  if (best === null || best.s === 0) return { sBeta: 0, best, beta: 1 };
  const beta = pontBeta(x, maps, best);
  return { sBeta: best.s / beta, best, beta };
}

/* ---------------- runtime state ---------------- */

interface CohortState {
  /** Event timestamps (ms), kept sorted ascending. */
  times: number[];
  members: Set<string>;
  stratum: string | null;
  lastSeen: number;
}

export function createCohortBoxSignal(options: CreateCohortBoxSignalOptions = {}): CohortBoxSignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");

  const windowDays = requireIntInRange(options.windowDays ?? 14, "windowDays", 1, 28);
  const alpha = options.alpha ?? 0.01;
  if (typeof alpha !== "number" || !Number.isFinite(alpha) || alpha <= 0 || alpha > 0.5) {
    fail("alpha must be a finite number in (0, 0.5]");
  }
  const bootstrapReplicas = requireIntInRange(options.bootstrapReplicas ?? 199, "bootstrapReplicas", 19, 999);
  const minCohortEvents = requireIntInRange(options.minCohortEvents ?? 100, "minCohortEvents", 1, 10_000_000);
  const maxCohorts = requireIntInRange(options.maxCohorts ?? 2_000, "maxCohorts", 1, 10_000_000);
  const maxEventsPerCohort = requireIntInRange(
    options.maxEventsPerCohort ?? 1_000_000,
    "maxEventsPerCohort",
    1,
    100_000_000,
  );
  const declaredStrata: string[] = [];
  if (options.declaredStrata !== undefined) {
    if (!Array.isArray(options.declaredStrata)) fail("declaredStrata must be an array of stratum names");
    for (const name of options.declaredStrata) {
      const valid = requireName(name, "declaredStrata entry");
      if (!declaredStrata.includes(valid)) declaredStrata.push(valid);
    }
  }
  const declaredSet = new Set(declaredStrata);

  // Evaluation is anchored on the cohort's own latest event (the
  // trailing window ends there), never on the wall clock, so the
  // same retained data always evaluates identically.
  const bins = windowDays * DAY_BINS;
  const windowMs = windowDays * DAY_BINS * BIN_MS;
  const maps = buildPeriodMaps(bins);

  const cohorts = new Map<string, CohortState>();
  const counters = { recorded: 0, invalidTs: 0, droppedByCap: 0, stratumConflicts: 0, evaluations: 0 };
  let seq = 0;

  function touchCohort(cohortId: string): CohortState {
    const existing = cohorts.get(cohortId);
    if (existing) {
      existing.lastSeen = seq++;
      cohorts.delete(cohortId);
      cohorts.set(cohortId, existing);
      return existing;
    }
    if (cohorts.size >= maxCohorts) {
      const oldest = cohorts.keys().next().value as string | undefined;
      if (oldest !== undefined) cohorts.delete(oldest);
    }
    const fresh: CohortState = { times: [], members: new Set(), stratum: null, lastSeen: seq++ };
    cohorts.set(cohortId, fresh);
    return fresh;
  }

  function observe(event: CohortBoxEvent): CohortBoxObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    requireName(event.identity, "event.identity");
    requireName(event.cohortId, "event.cohortId");
    if (event.stratum !== undefined) requireName(event.stratum, "event.stratum");
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      const state = cohorts.get(event.cohortId);
      return { status: "invalid_ts", counted: false, events: state ? state.times.length : 0 };
    }
    const state = touchCohort(event.cohortId);
    // Insert keeping the timestamp list sorted (arrival order is not assumed).
    let lo = 0;
    let hi = state.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (state.times[mid]! <= event.ts) lo = mid + 1;
      else hi = mid;
    }
    state.times.splice(lo, 0, event.ts);
    if (state.times.length > maxEventsPerCohort) {
      state.times.splice(0, state.times.length - maxEventsPerCohort);
      counters.droppedByCap++;
    }
    state.members.add(event.identity);
    if (event.stratum !== undefined) {
      if (state.stratum === null) state.stratum = event.stratum;
      else if (state.stratum !== event.stratum) counters.stratumConflicts++;
    }
    counters.recorded++;
    return { status: "recorded", counted: true, events: state.times.length };
  }

  function evaluateCohort(cohortId: string): CohortBoxSignal {
    requireName(cohortId, "cohortId");
    const state = cohorts.get(cohortId);
    const base = {
      kind: "cohort_box" as const,
      cohortId,
      enforcement: "none" as const,
      notice: ADVISORY_NOTICE,
    };
    if (!state || state.times.length === 0) {
      return {
        ...base,
        status: "insufficient_data",
        flagged: false,
        pValue: null,
        scoreS: null,
        scoreSBeta: null,
        beta: null,
        bestPeriodHours: null,
        bestBoxShare: null,
        eventsInWindow: 0,
        eventsRetained: 0,
        members: 0,
        windowStartMs: null,
        windowEndMs: null,
        stratum: state ? state.stratum : null,
      };
    }
    const end = state.times[state.times.length - 1]!;
    const start = end - windowMs;
    const x = new Float64Array(bins);
    let eventsInWindow = 0;
    for (const ts of state.times) {
      if (ts < start) continue;
      let bin = Math.floor((ts - start) / BIN_MS);
      if (bin >= bins) bin = bins - 1; // The final instant belongs to the last bin.
      x[bin] = x[bin]! + 1;
      eventsInWindow++;
    }
    const declared = state.stratum !== null && declaredSet.has(state.stratum);
    const common = {
      eventsInWindow,
      eventsRetained: state.times.length,
      members: state.members.size,
      windowStartMs: start,
      windowEndMs: end,
      stratum: state.stratum,
    };
    if (eventsInWindow < minCohortEvents) {
      return {
        ...base,
        ...common,
        status: "insufficient_data",
        flagged: false,
        pValue: null,
        scoreS: null,
        scoreSBeta: null,
        beta: null,
        bestPeriodHours: null,
        bestBoxShare: null,
      };
    }
    counters.evaluations++;
    const observed = sBeta(x, maps);
    if (observed.best === null) {
      return {
        ...base,
        ...common,
        status: "insufficient_data",
        flagged: false,
        pValue: null,
        scoreS: null,
        scoreSBeta: null,
        beta: null,
        bestPeriodHours: null,
        bestBoxShare: null,
      };
    }
    // Day-block bootstrap: whole days resampled with replacement,
    // order inside a day preserved - the circadian phase survives
    // in the null, multi-day structure does not.
    const rng = mulberry32(seriesSeed(x));
    const replica = new Float64Array(bins);
    let ge = 0;
    for (let b = 0; b < bootstrapReplicas; b++) {
      for (let d = 0; d < windowDays; d++) {
        const srcDay = Math.floor(rng() * windowDays);
        const srcBase = srcDay * DAY_BINS;
        const dstBase = d * DAY_BINS;
        for (let j = 0; j < DAY_BINS; j++) replica[dstBase + j] = x[srcBase + j]!;
      }
      if (sBeta(replica, maps).sBeta >= observed.sBeta) ge++;
    }
    const pValue = (1 + ge) / (bootstrapReplicas + 1);
    return {
      ...base,
      ...common,
      status: declared ? "declared_stratum" : "scored",
      flagged: !declared && pValue <= alpha,
      pValue,
      scoreS: observed.best.s,
      scoreSBeta: observed.sBeta,
      beta: observed.beta,
      bestPeriodHours: observed.best.periodHours,
      bestBoxShare: observed.best.q,
    };
  }

  function snapshot(): CohortBoxSnapshot {
    return {
      enforcement: "none",
      windowDays,
      bins,
      alpha,
      bootstrapReplicas,
      declaredStrata: [...declaredStrata],
      cohortsTracked: cohorts.size,
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  return { observe, evaluateCohort, snapshot };
}
