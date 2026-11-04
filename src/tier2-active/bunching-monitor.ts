/**
 * Bunching monitor (HARVEST2 candidate C29, BUNCH - lab PASS at the
 * ADVISORY/telemetry ceiling ONLY; see the study lab's
 * C29-DESIGN.md, C29-RESULTS.md, common.cjs, step0.cjs and
 * step1.cjs under the antiRea research tree).
 *
 * SOLE PURPOSE - POPULATION-LEVEL TELEMETRY. When a population of
 * actors has LEARNED a per-identity daily cap C and calibrates
 * against it, its identity-days pile up just below the cap: there
 * is excess mass in the bins under C that a smooth counterfactual
 * fitted away from the cap does not predict. This module is a
 * calibration gauge for the host ("calibration is happening
 * somewhere in the population, roughly this much, near this
 * notch") and a prioritisation input for other channels. It is
 * structurally incapable of saying WHO bunched:
 *
 * - There is NO identity-level API. No `evaluateIdentity`, no
 *   per-identity score, and no output of this module carries a
 *   per-identity verdict field of any kind (a test pins this).
 * - `enforcement: "none"` on every output. Bunching is never
 *   evidence about an identity, by the registration that created
 *   the candidate and by the lab verdict that passed it.
 *
 * THE FROZEN LAB ESTIMATOR, translated without re-invention
 * (C29-DESIGN section 1, common.cjs `excessMass`):
 * - Running variable: the number of NOVEL records per
 *   identity-day (identity-days with novel >= 1), histogrammed
 *   over integer bins v = 1..60.
 * - For a notch n: fit a degree-5 polynomial of log(count) on v
 *   over the whole range OUTSIDE the buffer [n-3, n+2] (bins with
 *   count 0 are dropped, exactly as the lab does), predict the
 *   smooth counterfactual everywhere, rescale it so its total
 *   outside the buffer equals the observed total outside the
 *   buffer, and read the excess mass B = sum over the window
 *   [n-3, n) of (observed - counterfactual).
 * - Standard error by parametric bootstrap (200 replicates:
 *   resample every bin as Poisson from the fitted smooth model -
 *   normal approximation above lambda 30, Knuth below, exactly as
 *   the lab - refit, rescale, recompute B); z = B / SE, with the
 *   population SD of the bootstrap replicates (divide by the
 *   replicate count, as the lab does). z is ONE-SIDED in meaning:
 *   only a large POSITIVE z is bunching; see the deficit warning
 *   below.
 * - The bootstrap stream is the lab's: streamRng(seed,
 *   notch * 1000 + 7, 0) over mulberry32, seed defaulting to the
 *   lab's default 20261140, so the same histogram always yields
 *   the same z.
 *
 * WHAT THE LAB MEASURED (simulation, scripted populations; the
 * cache populations are ~1,200 identities x 90 days):
 * - Placebo notches {10, 20, 25, 50} (round numbers that are NOT
 *   shipped thresholds) on legitimate VALID and SALE populations:
 *   no positive z reached +3 (max +2.17 on the cache; max +1.55
 *   on fresh-seed legit). A placebo z >= +3 would have killed the
 *   candidate - legit traffic does not naturally pile at round
 *   numbers on this substrate.
 * - Positive control: injecting 2% hard calibrators (desired
 *   novel spread 12-28/day, hard-capped at C-1) into VALID gave
 *   z = 36.97 at C = 15; moving the cap to C = 25 MOVED the
 *   excess to the window under 25 with z = 29.47 (migration -
 *   the causal signature that the pile follows the cap, not the
 *   substrate).
 *
 * HARD LIMITS - registered in the lab, restated verbatim in
 * substance, and part of this module's contract:
 * - ADVISORY/TELEMETRY CEILING, locked from the original
 *   registration: bunching NEVER becomes per-identity evidence;
 *   it is only a population-level calibration gauge for the host.
 * - The lab's calibrators are HARD calibration (an absolute cap
 *   at C-1, 2% of the population): the cleanest, strongest signal
 *   possible. Soft real-world calibration (probabilistic
 *   compliance, several overlapping thresholds) is weaker and
 *   was NOT measured.
 * - The estimator is sensitive to the polynomial degree and
 *   buffer choices (degree 5, buffer [n-3, n+2] are the
 *   pre-registered lab choices); that sensitivity was NOT
 *   measured in the lab round.
 * - The counterfactual distorts toward DEFICIT when a large pile
 *   sits in the distribution: negative z down to -5.69 was
 *   measured at a distant notch while a pile sat at 14. A
 *   negative z is NOT an alarm and NOT evidence of anything; the
 *   bunching reading is the positive side only.
 * - A large population is required (the positive control's own
 *   condition is 2% calibrators on ~1,200 identities); small
 *   hosts are out of scope. This module refuses to score below
 *   `minIdentityDays` identity-days (default 2,000 - an SDK
 *   floor, see the option; the lab registered no numeric floor,
 *   only the large-population condition above).
 * - A slow actor who does not know the threshold does not bunch:
 *   out of scope by construction. This gauge only sees actors
 *   who have read the system.
 *
 * FEEDING. Two equivalent lanes, both maintained as the count of
 * novel records per (identity, UTC day):
 * - `observe({ identity, resourceId, ts })`: the module itself
 *   computes novelty - a resource id counts once per identity
 *   per UTC day, however many times it is served that day.
 * - `addDailyNovel(identity, dayStartMs, novelCount)`: for hosts
 *   that already aggregate - ADDS `novelCount` novel records to
 *   that identity's UTC day (the day is floored from
 *   `dayStartMs`). Calling it twice for the same identity-day
 *   accumulates, exactly as serving more novel records would.
 *
 * Pure computation: no I/O, no runtime dependencies. State is a
 * bounded in-memory map of per-identity-day novel counters (plus
 * the served-id sets the observe lane needs for novelty); the
 * oldest identity-days are evicted past `maxIdentityDays`, and
 * an evicted day's histogram contribution is subtracted, so the
 * histogram always describes exactly the tracked population.
 */

/** Histogram support of the lab estimator: novel counts 1..60 per identity-day. */
const MAX_BIN = 60;
/** Polynomial degree of the counterfactual fit (lab, pre-registered). */
const POLY_DEGREE = 5;
/** Buffer (donut) excluded from the fit: [notch - 3, notch + 2] (lab, pre-registered). */
const BUFFER_BELOW = 3;
const BUFFER_ABOVE = 2;
/** Excess-mass window: [notch - 3, notch) (lab, pre-registered). */
const WINDOW_BELOW = 3;
/** Parametric-bootstrap replicates (lab default). */
const BOOTSTRAP_REPS = 200;
/** Bootstrap seed (lab default in common.cjs `excessMass`). */
const BOOTSTRAP_SEED = 20261140;

const DAY_MS = 86_400_000;

const ADVISORY_NOTICE =
  "Advisory telemetry only (enforcement: none): excess mass in the population's daily-novel " +
  "histogram just below a notch, against a degree-5 polynomial counterfactual fitted outside " +
  "the buffer [notch-3, notch+2] (parametric-bootstrap z, positive side only). This is a " +
  "population-level calibration gauge; it attributes nothing to any identity and must never " +
  "be per-identity evidence or the sole basis for any consequence. The lab's calibrators were " +
  "hard calibration; soft calibration is weaker and unmeasured, the counterfactual distorts " +
  "toward deficit (negative z is not an alarm), and actors who do not know a threshold do " +
  "not bunch.";

export interface BunchingEvent {
  /** The authenticated identity the resource was served to. */
  identity: string;
  /** The resource served; novelty is per (identity, UTC day, resource id). */
  resourceId: number | string;
  /** Millisecond timestamp of the serve. */
  ts: number;
}

export interface CreateBunchingMonitorOptions {
  /**
   * Minimum identity-days with novel >= 1 before any notch is
   * scored. The lab registered no numeric floor - only that a
   * large population is required (its populations are ~68k
   * identity-days; its positive control is 2% calibrators on
   * ~1,200 identities). This SDK floor (default 2,000) exists so
   * a small host gets an explicit `insufficient_population`
   * instead of a meaningless z; hosts should raise it toward
   * their own scale, never lower it toward a verdict.
   */
  minIdentityDays?: number;
  /** Parametric-bootstrap replicates per evaluation. Defaults to 200 (the lab's). */
  bootstrapReps?: number;
  /** Bootstrap stream seed. Defaults to 20261140 (the lab's default in `excessMass`). */
  bootstrapSeed?: number;
  /** Maximum identity-days tracked at once (oldest evicted, histogram contribution subtracted). Defaults to 200,000. */
  maxIdentityDays?: number;
}

export interface BunchingObservation {
  /**
   * `"recorded"` - the event entered the population (novel or
   * not); `"duplicate"` - the resource was already counted novel
   * for this identity-day; `"invalid_ts"` - non-finite or
   * out-of-range timestamp, refused before any state was touched.
   */
  status: "recorded" | "duplicate" | "invalid_ts";
  /** Whether this event added a novel record to its identity-day. */
  counted: boolean;
  /** The identity-day's novel total after this event, when recorded. */
  novelTotal?: number;
  /** UTC day start (ms) the event fell into, when recorded. */
  dayStartMs?: number;
}

export interface BunchingDailyObservation {
  status: "recorded";
  /** Whether any novel records were added (novelCount > 0). */
  counted: boolean;
  /** The identity-day's novel total after this call. */
  novelTotal: number;
  /** UTC day start (ms) the records were added to. */
  dayStartMs: number;
}

export interface BunchingResult {
  kind: "bunching";
  /** The notch (candidate cap) evaluated. */
  notch: number;
  /**
   * `"scored"` - the population met the floor and the estimator
   * ran; `"insufficient_population"` - below the identity-day
   * floor, or too few populated bins outside the buffer to fit
   * the counterfactual; nothing was scored.
   */
  status: "scored" | "insufficient_population";
  /** Excess-mass z (B / bootstrap SE), or null when not scored. Positive side only is bunching. */
  z: number | null;
  /** Excess mass B over the window [notch-3, notch), in identity-days, or null when not scored. */
  excessMass: number | null;
  /** Parametric-bootstrap standard error of B, or null when not scored. */
  se: number | null;
  /** Identity-days with novel >= 1 currently tracked. */
  identityDays: number;
  /** Identity-days inside the histogram (novel 1..60). */
  histogramDays: number;
  /** Always `"none"`: this module enforces nothing, about anyone. */
  enforcement: "none";
  notice: string;
}

export interface BunchingSnapshot {
  /** Always `"none"`: this module enforces nothing, about anyone. */
  enforcement: "none";
  minIdentityDays: number;
  bootstrapReps: number;
  /** Identity-days with novel >= 1 currently tracked. */
  identityDays: number;
  /** Identity-days inside the histogram (novel 1..60). */
  histogramDays: number;
  /** Total novel records across tracked identity-days (including days above the histogram cap). */
  novelRecords: number;
  /** Copy of the histogram, index = novel count (index 0 is always 0). */
  histogram: number[];
  counters: {
    /** Events fed through `observe`. */
    observed: number;
    /** Events that added a novel record. */
    novelObserved: number;
    /** Events refused as duplicates of an already-novel resource for the identity-day. */
    duplicateObserved: number;
    /** Events refused for a non-finite or out-of-range timestamp. */
    invalidTs: number;
    /** Calls to `addDailyNovel`. */
    dailyAdded: number;
    /** Identity-days evicted past `maxIdentityDays`. */
    evictedIdentityDays: number;
  };
  notice: string;
}

export interface BunchingMonitorInstance {
  /** Feed one serve event; the module computes novelty per (identity, UTC day). */
  observe(event: BunchingEvent): BunchingObservation;
  /** Add a host-aggregated novel count to one identity's UTC day. Accumulates per identity-day. */
  addDailyNovel(identity: string, dayStartMs: number, novelCount: number): BunchingDailyObservation;
  /** Run the lab bunching estimator at one notch over the population observed so far. */
  evaluate(notch: number): BunchingResult;
  /** Run the estimator at several notches, in the order given. */
  evaluateNotches(notches: number[]): BunchingResult[];
  /** State summary: histogram, population size and feed counters. */
  snapshot(): BunchingSnapshot;
}

/** Named error thrown for every invalid bunching input. */
export class BunchingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BunchingError";
  }
}

const fail = (message: string): never => {
  throw new BunchingError(`createBunchingMonitor: ${message}`);
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

function requireNotch(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < WINDOW_BELOW + 1 || value > MAX_BIN) {
    fail(`notch must be a finite integer between ${WINDOW_BELOW + 1} and ${MAX_BIN} (the histogram support)`);
  }
  return value as number;
}

/* ------------------------------------------------------------------ */
/* The lab's RNG, ported byte-for-byte (harness-v2/lib/rng.cjs        */
/* mulberry32 + streamRng, and common.cjs randn).                      */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function streamRng(baseSeed: number, streamIndex: number, runIdx: number): () => number {
  return mulberry32(
    (baseSeed ^ Math.imul(streamIndex + 1, 0x9e3779b1) ^ Math.imul(runIdx + 1, 0x85ebca6b)) >>> 0,
  );
}

function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------------------------ */
/* The lab's polynomial fit, ported operation-for-operation           */
/* (common.cjs polyFit / polyEval): least squares by Gaussian          */
/* elimination with partial pivoting.                                  */
/* ------------------------------------------------------------------ */

function polyFit(xs: number[], ys: number[], d: number): number[] {
  const m = d + 1;
  const A: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const b = new Array<number>(m).fill(0);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] as number;
    const pw: number[] = [1];
    for (let j = 1; j <= 2 * d; j++) pw.push((pw[j - 1] as number) * x);
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) (A[r] as number[])[c] = ((A[r] as number[])[c] as number) + (pw[r + c] as number);
      b[r] = (b[r] as number) + (pw[r] as number) * (ys[i] as number);
    }
  }
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) {
      if (Math.abs((A[r] as number[])[col] as number) > Math.abs((A[piv] as number[])[col] as number)) piv = r;
    }
    const tmpRow = A[col] as number[];
    A[col] = A[piv] as number[];
    A[piv] = tmpRow;
    const tmpB = b[col] as number;
    b[col] = b[piv] as number;
    b[piv] = tmpB;
    const div = (A[col] as number[])[col] as number;
    for (let c = col; c < m; c++) (A[col] as number[])[c] = ((A[col] as number[])[c] as number) / div;
    b[col] = (b[col] as number) / div;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = (A[r] as number[])[col] as number;
      if (f === 0) continue;
      for (let c = col; c < m; c++) (A[r] as number[])[c] = ((A[r] as number[])[c] as number) - f * ((A[col] as number[])[c] as number);
      b[r] = (b[r] as number) - f * (b[col] as number);
    }
  }
  return b;
}

function polyEval(coef: number[], x: number): number {
  let s = 0;
  let p = 1;
  for (const c of coef) {
    s += c * p;
    p *= x;
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* The lab's excess-mass estimator (common.cjs excessMass), verbatim   */
/* in structure and arithmetic order, over a caller-supplied           */
/* histogram (index = bin v, 1..60).                                   */
/* ------------------------------------------------------------------ */

function excessMass(
  hist: number[],
  notch: number,
  reps: number,
  seed: number,
): { B: number; se: number; z: number } {
  const vs: number[] = [];
  const ys: number[] = [];
  for (let v = 1; v <= MAX_BIN; v++) {
    if (v >= notch - BUFFER_BELOW && v <= notch + BUFFER_ABOVE) continue;
    if ((hist[v] as number) > 0) {
      vs.push(v);
      ys.push(Math.log(hist[v] as number));
    }
  }
  const coef = polyFit(vs, ys, POLY_DEGREE);
  const pred = new Array<number>(MAX_BIN + 1).fill(0);
  for (let v = 1; v <= MAX_BIN; v++) pred[v] = Math.exp(polyEval(coef, v));
  // Rescale the smooth model to the observed total outside the buffer
  // (standard bunching normalization, as the lab).
  let obsOut = 0;
  let predOut = 0;
  for (let v = 1; v <= MAX_BIN; v++) {
    if (v >= notch - BUFFER_BELOW && v <= notch + BUFFER_ABOVE) continue;
    obsOut += hist[v] as number;
    predOut += pred[v] as number;
  }
  const scale = predOut > 0 ? obsOut / predOut : 1;
  for (let v = 1; v <= MAX_BIN; v++) pred[v] = (pred[v] as number) * scale;
  let B = 0;
  for (let v = notch - WINDOW_BELOW; v < notch; v++) B += (hist[v] as number) - (pred[v] as number);
  // Parametric bootstrap (lab): Poisson resampling from the fitted
  // smooth model, refit, rescale, recompute B per replicate.
  const rng = streamRng(seed, notch * 1000 + 7, 0);
  const Bs: number[] = [];
  for (let rep = 0; rep < reps; rep++) {
    const sim = new Array<number>(MAX_BIN + 1).fill(0);
    for (let v = 1; v <= MAX_BIN; v++) {
      const lam = pred[v] as number;
      if (lam <= 0) {
        sim[v] = 0;
        continue;
      }
      if (lam > 30) {
        sim[v] = Math.max(0, Math.round(lam + Math.sqrt(lam) * randn(rng)));
      } else {
        const L = Math.exp(-lam);
        let k = 0;
        let p = 1;
        do {
          k++;
          p *= rng();
        } while (p > L);
        sim[v] = k - 1;
      }
    }
    const vs2: number[] = [];
    const ys2: number[] = [];
    for (let v = 1; v <= MAX_BIN; v++) {
      if (v >= notch - BUFFER_BELOW && v <= notch + BUFFER_ABOVE) continue;
      if ((sim[v] as number) > 0) {
        vs2.push(v);
        ys2.push(Math.log(sim[v] as number));
      }
    }
    try {
      const c2 = polyFit(vs2, ys2, POLY_DEGREE);
      let o2 = 0;
      let p2 = 0;
      const pr2 = new Array<number>(MAX_BIN + 1).fill(0);
      for (let v = 1; v <= MAX_BIN; v++) pr2[v] = Math.exp(polyEval(c2, v));
      for (let v = 1; v <= MAX_BIN; v++) {
        if (v >= notch - BUFFER_BELOW && v <= notch + BUFFER_ABOVE) continue;
        o2 += sim[v] as number;
        p2 += pr2[v] as number;
      }
      const sc2 = p2 > 0 ? o2 / p2 : 1;
      let Bb = 0;
      for (let v = notch - WINDOW_BELOW; v < notch; v++) Bb += (sim[v] as number) - (pr2[v] as number) * sc2;
      Bs.push(Bb);
    } catch {
      /* skip failed fit (the lab's discipline) */
    }
  }
  const mean = Bs.reduce((s, x) => s + x, 0) / Bs.length;
  const sd = Math.sqrt(Bs.reduce((s, x) => s + (x - mean) * (x - mean), 0) / Bs.length);
  return { B, se: sd, z: sd > 0 ? B / sd : 0 };
}

interface IdentityDayState {
  /** Novel records accumulated for this identity-day. */
  total: number;
  /** Resource ids already counted novel by the observe lane (null until the first observe). */
  seen: Set<string> | null;
}

export function createBunchingMonitor(
  options: CreateBunchingMonitorOptions = {},
): BunchingMonitorInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");

  const minIdentityDays = requireIntInRange(options.minIdentityDays ?? 2_000, "minIdentityDays", 1, 10_000_000);
  const bootstrapReps = requireIntInRange(options.bootstrapReps ?? BOOTSTRAP_REPS, "bootstrapReps", 1, 10_000);
  const bootstrapSeedRaw = options.bootstrapSeed ?? BOOTSTRAP_SEED;
  if (typeof bootstrapSeedRaw !== "number" || !Number.isInteger(bootstrapSeedRaw)) {
    fail("bootstrapSeed must be an integer");
  }
  const bootstrapSeed = bootstrapSeedRaw;
  const maxIdentityDays = requireIntInRange(options.maxIdentityDays ?? 200_000, "maxIdentityDays", 1, 10_000_000);

  const hist = new Array<number>(MAX_BIN + 1).fill(0);
  const days = new Map<string, IdentityDayState>();
  const counters = { observed: 0, novelObserved: 0, duplicateObserved: 0, invalidTs: 0, dailyAdded: 0, evictedIdentityDays: 0 };
  let identityDays = 0; // tracked identity-days with total >= 1
  let histogramDays = 0; // tracked identity-days with 1 <= total <= 60
  let novelRecords = 0; // sum of totals over tracked identity-days

  function moveHistogram(before: number, after: number): void {
    if (before >= 1 && before <= MAX_BIN) {
      hist[before] = (hist[before] as number) - 1;
      histogramDays--;
    }
    if (after >= 1 && after <= MAX_BIN) {
      hist[after] = (hist[after] as number) + 1;
      histogramDays++;
    }
  }

  function evictOldest(): void {
    const oldest = days.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    const state = days.get(oldest) as IdentityDayState;
    moveHistogram(state.total, 0);
    if (state.total >= 1) identityDays--;
    novelRecords -= state.total;
    days.delete(oldest);
    counters.evictedIdentityDays++;
  }

  /** Get (creating if needed) the state for one identity-day, evicting past the cap. */
  function dayState(identity: string, dayStartMs: number): IdentityDayState {
    // The day is a pure-digit suffix after the last '#', so this
    // encoding cannot collide between distinct (identity, day)
    // pairs even when an identity itself contains '#'.
    const key = `${identity}#${dayStartMs}`;
    const existing = days.get(key);
    if (existing) {
      // Refresh recency so eviction drops the least recently fed days.
      days.delete(key);
      days.set(key, existing);
      return existing;
    }
    while (days.size >= maxIdentityDays) evictOldest();
    const fresh: IdentityDayState = { total: 0, seen: null };
    days.set(key, fresh);
    return fresh;
  }

  function addNovel(state: IdentityDayState, delta: number): void {
    if (delta <= 0) return;
    const before = state.total;
    state.total += delta;
    moveHistogram(before, state.total);
    if (before === 0) identityDays++;
    novelRecords += delta;
  }

  function observe(event: BunchingEvent): BunchingObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    const identity = requireIdentity(event.identity, "event.identity");
    if (
      (typeof event.resourceId !== "number" || !Number.isFinite(event.resourceId)) &&
      (typeof event.resourceId !== "string" || event.resourceId.length === 0)
    ) {
      fail("event.resourceId must be a finite number or a non-empty string");
    }
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      return { status: "invalid_ts", counted: false };
    }
    counters.observed++;
    const dayStartMs = Math.floor(event.ts / DAY_MS) * DAY_MS;
    const state = dayState(identity, dayStartMs);
    if (state.seen === null) state.seen = new Set<string>();
    const resourceKey = typeof event.resourceId === "number" ? `n:${event.resourceId}` : `s:${event.resourceId}`;
    if (state.seen.has(resourceKey)) {
      counters.duplicateObserved++;
      return { status: "duplicate", counted: false, novelTotal: state.total, dayStartMs };
    }
    state.seen.add(resourceKey);
    addNovel(state, 1);
    counters.novelObserved++;
    return { status: "recorded", counted: true, novelTotal: state.total, dayStartMs };
  }

  function addDailyNovel(identityRaw: string, dayStartMsRaw: number, novelCount: number): BunchingDailyObservation {
    const identity = requireIdentity(identityRaw, "identity");
    if (!isValidTs(dayStartMsRaw)) fail("dayStartMs must be a finite timestamp within the representable range");
    if (typeof novelCount !== "number" || !Number.isInteger(novelCount) || novelCount < 0) {
      fail("novelCount must be a non-negative integer");
    }
    const dayStartMs = Math.floor(dayStartMsRaw / DAY_MS) * DAY_MS;
    counters.dailyAdded++;
    if (novelCount === 0) {
      const existing = days.get(`${identity}#${dayStartMs}`);
      return { status: "recorded", counted: false, novelTotal: existing ? existing.total : 0, dayStartMs };
    }
    const state = dayState(identity, dayStartMs);
    addNovel(state, novelCount);
    return { status: "recorded", counted: true, novelTotal: state.total, dayStartMs };
  }

  function evaluate(notchRaw: number): BunchingResult {
    const notch = requireNotch(notchRaw);
    const base = {
      kind: "bunching" as const,
      notch,
      identityDays,
      histogramDays,
      enforcement: "none" as const,
      notice: ADVISORY_NOTICE,
    };
    // Population support outside the buffer: the degree-5 fit needs
    // populated bins to stand on; below that (or below the
    // identity-day floor) the estimator has nothing honest to say.
    let supportBins = 0;
    for (let v = 1; v <= MAX_BIN; v++) {
      if (v >= notch - BUFFER_BELOW && v <= notch + BUFFER_ABOVE) continue;
      if ((hist[v] as number) > 0) supportBins++;
    }
    if (identityDays < minIdentityDays || supportBins < POLY_DEGREE + 2) {
      return { ...base, status: "insufficient_population", z: null, excessMass: null, se: null };
    }
    const r = excessMass(hist, notch, bootstrapReps, bootstrapSeed);
    return { ...base, status: "scored", z: r.z, excessMass: r.B, se: r.se };
  }

  function evaluateNotches(notches: number[]): BunchingResult[] {
    if (!Array.isArray(notches)) fail("notches must be an array of notches");
    // Validate the whole list first, so a bad notch throws before
    // any (expensive) bootstrap runs.
    const validated = notches.map((n) => requireNotch(n));
    return validated.map((n) => evaluate(n));
  }

  function snapshot(): BunchingSnapshot {
    return {
      enforcement: "none",
      minIdentityDays,
      bootstrapReps,
      identityDays,
      histogramDays,
      novelRecords,
      histogram: hist.slice(),
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  return { observe, addDailyNovel, evaluate, evaluateNotches, snapshot };
}
