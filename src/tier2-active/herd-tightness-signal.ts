/**
 * Herd-tightness signal (HARVEST candidate H7-11 - persistent
 * homology / TDA line, candidate-level PASS in the lab at cycle
 * C148; see the study lab's h7-11-lab/H7-11-STEP1-REGISTRATION.md,
 * H7-11-CANDIDATE-REREGISTRATION.md and H7-11-CANDIDATE-RUN-RESULTS.md).
 *
 * WHAT IT MEASURES. Take one homogeneous event stream per identity
 * (session starts, room joins - the same feeding as
 * `createHerdPhaseSignal`). Each identity with at least `minEvents`
 * events becomes ONE point on the phase plane: the mean resultant
 * vector of its event phases on a `periodSec` grid (default 900 s,
 * the only lab-validated period), i.e. the point
 * (R_i * cos(meanPhase_i), R_i * sin(meanPhase_i)). A herd driven
 * by ONE shared scheduler lands on nearly the SAME point of that
 * plane - same grid offset, high resultant - so its cloud is
 * internally TIGHT. Ordinary users (low resultant, points scattered
 * near the origin) and office-hours groups behind one NAT (each
 * person on their own rhythm) form SPREAD clouds. The binding
 * statistic is the cloud's H0 d0max: the longest edge of the
 * minimum spanning tree over the standardised points - the scale
 * at which the cloud becomes one connected component. Tight cloud,
 * small d0max; spread cloud, large d0max.
 *
 * THE FROZEN LAB LAW, translated without re-invention:
 * - phase of an event at ts (ms): 2*pi * ((ts mod period) / period),
 *   period = periodSec * 1000 ms; T = 900 s is the ONLY validated
 *   period (inherited from the H7-01 line).
 * - an identity is scored only with >= 8 events (lab floor), and a
 *   cloud is scored only with >= 8 scored identities (the lab's
 *   N_cloud >= 8 VOID floor, kept as `minIdentities`).
 * - standardisation is per-axis z = (x - median) / (1.4826 * MAD)
 *   with the constants taken from a REFERENCE population of
 *   known-legitimate identities - in the lab that was the draw's
 *   LEGIT cohort; here the host feeds its own established
 *   legitimate population through `observeReference`. Fallbacks
 *   follow the lab: MAD = 0 falls back to IQR / 1.349; if both are
 *   0 the axis is degenerate (scale 1, flagged on the result).
 * - NO winsorize, no filter, no cap on the points (candidate
 *   registration v2, cycle C147: the v1 winsorize filter emptied
 *   the very cloud it was meant to protect - the statistic reads
 *   INTERNAL spread, so a tight cloud sitting far from the centre
 *   is the signal, not junk).
 * - classification is a single bar on the standardised d0max:
 *   tight iff d0max < bar. The default bar 0.805436 is the lab's
 *   C148 calibration midpoint (S_max 0.645374, L_min 0.965498 on
 *   the calibration draw). A host whose reference population
 *   differs materially from the lab's should recalibrate and pass
 *   `tightnessBar` - the bar is a property of the standardisation,
 *   not a universal constant.
 *
 * WHAT THE LAB MEASURED (all simulation, seeded harness-v2
 * populations; internal validity only - NOT real-traffic
 * performance): calibration separated (SHARED bootstrap max
 * 0.645374 < LEGIT bootstrap min 0.965498); on TWO held-out fresh
 * draws the single-bar detector classified every binding cell
 * correctly (SHARED test d0max 0.277097 / 0.255697, both below the
 * 0.805436 bar; LEGIT 1.094551 / 1.364422 and NAT-GROUP 1.722341 /
 * 1.394056, all above it); smallest relative margin 35.9%; no
 * leave-one-out point flip on any binding cloud on any draw;
 * independent verifier 14/14 checks PASS; two runs byte-identical.
 *
 * HARD LIMITS - registered in the labs, restated as contract:
 * - ADVISORY ONLY: `enforcement: "none"` on every output. The
 *   statistic is a property of a WHOLE cloud: it can say a cohort
 *   looks like one shared scheduler, it can NEVER name or score
 *   an individual identity, and it must never be the sole basis
 *   for any consequence.
 * - SHARED SCHEDULER ONLY. A herd whose members each run their
 *   own grid offset (the lab's HERD-INDEP shape) forms a RING on
 *   the phase plane and reads a LARGE d0max - it is not flagged,
 *   by design: this detector refuses to trade the office-group
 *   false-positive protection for that coverage. (The companion
 *   `createHerdPhaseSignal` carries the complementary cohort
 *   statistic R_cohort on the same feeding.)
 * - NO REFERENCE, NO VERDICT. Without a scored reference
 *   population the module reports the raw (unstandardised) d0max
 *   with status `"uncalibrated"` and `tight: null`. The raw
 *   number has no lab bar and must not be classified on.
 * - ONE scheduler period: 900 s is the only validated grid.
 *   Changing `periodSec` leaves the lab record behind.
 * - The lab's legitimate populations are one generator family
 *   (harness-v2): real legitimate groups with their own tight
 *   shared machine rhythm (a corporate fleet whose devices all
 *   poll on the same schedule, a class of students starting a
 *   synced lab exercise) are NOT in those pools, so the
 *   false-positive rate on such groups is unmeasured.
 * - Evaluate cost is O(n^2) in the number of scored identities
 *   (exact MST). `maxIdentities` therefore defaults to 4,096;
 *   the statistic was validated on clouds of 9-16 points and is
 *   a small-cohort instrument, not a fleet-wide scan.
 *
 * Pure computation: no I/O, no runtime dependencies. State is two
 * bounded in-memory maps (cohort stream, reference stream) of
 * per-identity event timestamps, with the same eviction and
 * truncation discipline as the herd-phase signal.
 */

/** Default scheduler period: 900 s, the only lab-validated grid. */
const DEFAULT_PERIOD_SEC = 900;
/** Lab scoring floor: an identity needs at least this many events. */
const DEFAULT_MIN_EVENTS = 8;
/** Lab cloud floor: a cloud needs at least this many scored identities. */
const DEFAULT_MIN_IDENTITIES = 8;
/** Lab C148 calibration bar on standardised d0max (midpoint of 0.645374 / 0.965498). */
const DEFAULT_TIGHTNESS_BAR = 0.805436;

const ADVISORY_NOTICE =
  "Advisory telemetry only (enforcement: none): H0 d0max (longest minimum-spanning-tree " +
  "edge) of the cohort's phase-plane cloud, standardised by the host-fed reference " +
  "population - a cohort is reported tight only when its standardised d0max falls below " +
  "the bar (lab default 0.805436, calibrated on seeded harness-v2 simulation at cycle " +
  "C148, where it separated a shared-scheduler herd from ordinary users and from an " +
  "office-hours NAT group on two held-out draws, smallest margin 35.9%). The statistic " +
  "describes a whole cohort and never names an identity; herds on per-identity grid " +
  "offsets read spread by design; without a scored reference population no verdict is " +
  "issued. Never use this signal as the sole basis for any consequence.";

export interface HerdTightnessEvent {
  /** The authenticated identity the event belongs to. */
  identity: string;
  /** Millisecond timestamp of the event (one homogeneous stream: session starts, joins, ...). */
  ts: number;
}

export interface CreateHerdTightnessSignalOptions {
  /**
   * Scheduler grid period in seconds. Default 900 - the ONLY
   * period with a lab record behind it. Changing it leaves the
   * frozen lab law behind; the bar does not transfer automatically.
   */
  periodSec?: number;
  /** Events an identity needs before it is scored. Default 8 (lab floor). */
  minEvents?: number;
  /** Scored identities a cloud needs before it is read. Default 8 (lab N_cloud floor). */
  minIdentities?: number;
  /**
   * Classification bar on standardised d0max: tight iff d0max < bar.
   * Default 0.805436 (lab C148 calibration midpoint). Recalibrate
   * against your own reference population if it differs materially
   * from the lab's harness-v2 LEGIT cohort; the bar is a property
   * of the standardisation, not a universal constant.
   */
  tightnessBar?: number;
  /** Maximum identities tracked per stream (least recently fed evicted). Defaults to 4,096 (evaluate is O(n^2)). */
  maxIdentities?: number;
  /** Maximum event timestamps kept per identity (oldest dropped). Defaults to 4,096; must be >= minEvents. */
  maxEventsPerIdentity?: number;
}

export interface HerdTightnessObservation {
  /**
   * `"recorded"` - the event entered the identity's stream;
   * `"invalid_ts"` - non-finite or out-of-range timestamp,
   * refused before any state was touched.
   */
  status: "recorded" | "invalid_ts";
  /** Whether the event was stored. */
  counted: boolean;
  /** The identity's stored event total in that stream after this call, when recorded. */
  eventsTotal?: number;
}

export interface HerdTightnessEvaluateOptions {
  /**
   * Only cohort events with ts <= asOfTs are scored. Defaults to
   * no cutoff (every stored cohort event). The reference stream
   * is a historical baseline and is always read in full.
   */
  asOfTs?: number;
}

export interface HerdTightnessResult {
  kind: "herd-tightness";
  /**
   * `"scored"` - the cloud was read against the bar;
   * `"insufficient_population"` - the cohort cloud is below
   * `minIdentities` scored identities, so nothing was read;
   * `"uncalibrated"` - the cohort cloud is large enough but the
   * reference cloud is below `minIdentities`, so the raw d0max
   * is reported with NO classification (`tight: null`).
   */
  status: "scored" | "insufficient_population" | "uncalibrated";
  /** True iff standardised d0max < bar. Null unless status is `"scored"`. */
  tight: boolean | null;
  /** Standardised d0max (the binding statistic), or null when uncalibrated / insufficient. */
  d0max: number | null;
  /** Unstandardised d0max on the raw phase-plane points (descriptive; no lab bar exists for it). */
  d0maxRaw: number | null;
  /** The bar the classification ran against (echoed for audit). */
  bar: number;
  /** (bar - d0max) / bar when scored: positive headroom means tight-side clearance. Null unless scored. */
  marginRel: number | null;
  /** Identities in the cohort stream (before the event floor). */
  cohortIdentities: number;
  /** Cohort identities that met the minEvents floor and formed the cloud. */
  scoredIdentities: number;
  /** Reference identities that met the minEvents floor and formed the reference cloud. */
  referenceIdentities: number;
  /** Reference axes whose MAD and IQR were both 0 (scale fell back to 1). Descriptive. */
  degenerateAxes: string[];
  /** The grid period the statistics ran on, in seconds. */
  periodSec: number;
  /** Always `"none"`: this module enforces nothing, about anyone. */
  enforcement: "none";
  notice: string;
}

export interface HerdTightnessSnapshot {
  /** Always `"none"`: this module enforces nothing, about anyone. */
  enforcement: "none";
  periodSec: number;
  minEvents: number;
  minIdentities: number;
  bar: number;
  /** Identities currently tracked in the cohort stream. */
  identities: number;
  /** Event timestamps currently stored in the cohort stream. */
  events: number;
  /** Identities currently tracked in the reference stream. */
  referenceIdentitiesTracked: number;
  /** Event timestamps currently stored in the reference stream. */
  referenceEvents: number;
  counters: {
    /** Cohort events fed through `observe`. */
    observed: number;
    /** Reference events fed through `observeReference`. */
    referenceObserved: number;
    /** Events (either stream) refused for a non-finite or out-of-range timestamp. */
    invalidTs: number;
    /** Identities evicted past `maxIdentities` (both streams). */
    evictedIdentities: number;
    /** Stored events dropped past `maxEventsPerIdentity` (per identity, oldest first). */
    truncatedEvents: number;
  };
  notice: string;
}

export interface HerdTightnessSignalInstance {
  /** Feed one cohort event timestamp for one identity. */
  observe(event: HerdTightnessEvent): HerdTightnessObservation;
  /** Feed one reference (known-legitimate) event timestamp for one identity. */
  observeReference(event: HerdTightnessEvent): HerdTightnessObservation;
  /** Run the frozen herd-tightness law over the cohort observed so far. */
  evaluate(options?: HerdTightnessEvaluateOptions): HerdTightnessResult;
  /** State summary: population sizes, feed counters, configuration. */
  snapshot(): HerdTightnessSnapshot;
}

/** Named error thrown for every invalid herd-tightness input. */
export class HerdTightnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdTightnessError";
  }
}

const fail = (message: string): never => {
  throw new HerdTightnessError(`createHerdTightnessSignal: ${message}`);
};

function requireIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value as string;
}

/** The F-21 timestamp discipline shared across the tier-2 modules: finite and inside the representable Date range. */
function isValidTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8.64e15;
}

/**
 * The phase-plane point of one identity: the mean resultant vector
 * (R_i * cos(meanPhase), R_i * sin(meanPhase)) of its event phases
 * on the `periodSec` grid. Pure helper, exported for hosts (and
 * tests) that build points from their own stored streams.
 */
export function phasePlanePoint(timestamps: number[], periodSec: number = DEFAULT_PERIOD_SEC): [number, number] {
  const periodMs = periodSec * 1000;
  let re = 0;
  let im = 0;
  let n = 0;
  for (const ts of timestamps) {
    if (!isValidTs(ts)) continue;
    const phase = 2 * Math.PI * ((((ts % periodMs) + periodMs) % periodMs) / periodMs);
    re += Math.cos(phase);
    im += Math.sin(phase);
    n++;
  }
  if (n === 0) return [0, 0];
  return [re / n, im / n];
}

/**
 * H0 d0max of a 2-D point cloud: the longest edge of the minimum
 * spanning tree (Prim's algorithm, exact), i.e. the scale at which
 * the cloud becomes one connected component. A cloud of 0 or 1
 * points has d0max 0. Duplicate points never change the value
 * (zero-length edges join first) - the lab's V5 property.
 */
export function phaseCloudD0max(points: Array<readonly [number, number]>): number {
  const n = points.length;
  if (n < 2) return 0;
  const inTree = new Array<boolean>(n).fill(false);
  const dist = new Array<number>(n).fill(Infinity);
  dist[0] = 0;
  let longest = 0;
  for (let iter = 0; iter < n; iter++) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const di = dist[i] as number;
      if (!inTree[i] && di < best) {
        best = di;
        u = i;
      }
    }
    if (u === -1) break;
    inTree[u] = true;
    if (best > longest && best !== Infinity) longest = best;
    const [ux, uy] = points[u] as [number, number];
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue;
      const [vx, vy] = points[v] as [number, number];
      const d = Math.hypot(ux - vx, uy - vy);
      if (d < (dist[v] as number)) dist[v] = d;
    }
  }
  return longest;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] as number;
  const frac = idx - lo;
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac;
}

/** Lab standardisation constants for one axis: 1.4826*MAD, IQR/1.349 fallback, else degenerate scale 1. */
function axisScale(values: number[]): { center: number; scale: number; degenerate: boolean } {
  const sorted = [...values].sort((a, b) => a - b);
  const center = median(sorted);
  const absDev = values.map((v) => Math.abs(v - center)).sort((a, b) => a - b);
  const mad = median(absDev);
  if (mad > 0) return { center, scale: 1.4826 * mad, degenerate: false };
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  if (iqr > 0) return { center, scale: iqr / 1.349, degenerate: false };
  return { center, scale: 1, degenerate: true };
}

export function createHerdTightnessSignal(
  options: CreateHerdTightnessSignalOptions = {},
): HerdTightnessSignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");

  const periodSec = requireIntInRange(options.periodSec ?? DEFAULT_PERIOD_SEC, "periodSec", 1, 7 * 24 * 3600);
  const minEvents = requireIntInRange(options.minEvents ?? DEFAULT_MIN_EVENTS, "minEvents", 2, 100_000);
  const minIdentities = requireIntInRange(
    options.minIdentities ?? DEFAULT_MIN_IDENTITIES,
    "minIdentities",
    2,
    1_000_000,
  );
  const bar = options.tightnessBar ?? DEFAULT_TIGHTNESS_BAR;
  if (typeof bar !== "number" || !Number.isFinite(bar) || bar <= 0) {
    fail("tightnessBar must be a positive finite number");
  }
  const maxIdentities = requireIntInRange(options.maxIdentities ?? 4_096, "maxIdentities", 1, 1_000_000);
  const maxEventsPerIdentity = requireIntInRange(
    options.maxEventsPerIdentity ?? 4_096,
    "maxEventsPerIdentity",
    minEvents,
    1_000_000,
  );

  const cohort = new Map<string, number[]>();
  const reference = new Map<string, number[]>();
  const counters = { observed: 0, referenceObserved: 0, invalidTs: 0, evictedIdentities: 0, truncatedEvents: 0 };
  let cohortEvents = 0;
  let referenceEvents = 0;

  function feed(
    stream: Map<string, number[]>,
    event: HerdTightnessEvent,
    isReference: boolean,
  ): HerdTightnessObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    const identity = requireIdentity(event.identity, "event.identity");
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      return { status: "invalid_ts", counted: false };
    }
    if (isReference) counters.referenceObserved++;
    else counters.observed++;
    let list = stream.get(identity);
    if (list) {
      // Refresh recency so eviction drops the least recently fed identities.
      stream.delete(identity);
      stream.set(identity, list);
    } else {
      while (stream.size >= maxIdentities) {
        const oldest = stream.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const dropped = (stream.get(oldest) as number[]).length;
        if (isReference) referenceEvents -= dropped;
        else cohortEvents -= dropped;
        stream.delete(oldest);
        counters.evictedIdentities++;
      }
      list = [];
      stream.set(identity, list);
    }
    list.push(event.ts);
    if (isReference) referenceEvents++;
    else cohortEvents++;
    if (list.length > maxEventsPerIdentity) {
      const excess = list.length - maxEventsPerIdentity;
      list.splice(0, excess);
      if (isReference) referenceEvents -= excess;
      else cohortEvents -= excess;
      counters.truncatedEvents += excess;
    }
    return { status: "recorded", counted: true, eventsTotal: list.length };
  }

  function cloudOf(stream: Map<string, number[]>, asOfTs?: number): Array<[number, number]> {
    const points: Array<[number, number]> = [];
    for (const stored of stream.values()) {
      const inScope = asOfTs === undefined ? stored : stored.filter((ts) => ts <= asOfTs);
      if (inScope.length < minEvents) continue;
      points.push(phasePlanePoint(inScope, periodSec));
    }
    return points;
  }

  function evaluate(evaluateOptions: HerdTightnessEvaluateOptions = {}): HerdTightnessResult {
    if (typeof evaluateOptions !== "object" || evaluateOptions === null) {
      fail("evaluate options must be an object");
    }
    const asOfTs = evaluateOptions.asOfTs;
    if (asOfTs !== undefined && !isValidTs(asOfTs)) {
      fail("asOfTs must be a finite timestamp within the representable range");
    }
    const base = {
      kind: "herd-tightness" as const,
      bar,
      periodSec,
      enforcement: "none" as const,
      notice: ADVISORY_NOTICE,
    };
    const cohortPoints = cloudOf(cohort, asOfTs);
    const referencePoints = cloudOf(reference);
    const d0maxRaw = cohortPoints.length >= 2 ? phaseCloudD0max(cohortPoints) : null;

    if (cohortPoints.length < minIdentities) {
      return {
        ...base,
        status: "insufficient_population",
        tight: null,
        d0max: null,
        d0maxRaw,
        marginRel: null,
        cohortIdentities: cohort.size,
        scoredIdentities: cohortPoints.length,
        referenceIdentities: referencePoints.length,
        degenerateAxes: [],
      };
    }
    if (referencePoints.length < minIdentities) {
      return {
        ...base,
        status: "uncalibrated",
        tight: null,
        d0max: null,
        d0maxRaw,
        marginRel: null,
        cohortIdentities: cohort.size,
        scoredIdentities: cohortPoints.length,
        referenceIdentities: referencePoints.length,
        degenerateAxes: [],
      };
    }
    const xs = axisScale(referencePoints.map((p) => p[0]));
    const ys = axisScale(referencePoints.map((p) => p[1]));
    const degenerateAxes: string[] = [];
    if (xs.degenerate) degenerateAxes.push("res_x");
    if (ys.degenerate) degenerateAxes.push("res_y");
    const standardised: Array<[number, number]> = cohortPoints.map(([x, y]) => [
      (x - xs.center) / xs.scale,
      (y - ys.center) / ys.scale,
    ]);
    const d0max = phaseCloudD0max(standardised);
    return {
      ...base,
      status: "scored",
      tight: d0max < bar,
      d0max,
      d0maxRaw,
      marginRel: (bar - d0max) / bar,
      cohortIdentities: cohort.size,
      scoredIdentities: cohortPoints.length,
      referenceIdentities: referencePoints.length,
      degenerateAxes,
    };
  }

  function snapshot(): HerdTightnessSnapshot {
    return {
      enforcement: "none",
      periodSec,
      minEvents,
      minIdentities,
      bar,
      identities: cohort.size,
      events: cohortEvents,
      referenceIdentitiesTracked: reference.size,
      referenceEvents,
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  return {
    observe: (event) => feed(cohort, event, false),
    observeReference: (event) => feed(reference, event, true),
    evaluate,
    snapshot,
  };
}
