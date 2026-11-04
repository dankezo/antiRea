/**
 * Shrink-slope signal (HARVEST2 candidate C27, SHRINK-SLOPE, lab
 * PASS - see the study lab's C27-DESIGN.md, C27-RESULTS.md,
 * step0.cjs / step1.cjs and common.cjs under the antiRea research
 * tree, overnight-2026-11-02/c27-lab).
 *
 * WHAT IT MEASURES. A slow, patient extractor keeps pulling NEW
 * records long after a legitimate reader's novelty has saturated.
 * Per identity, the estimand is the late-window novelty rate
 *
 *   theta_i = mean daily NEW records over observation days 31-90
 *
 * (day 1 = the UTC day of the identity's first observed event; the
 * window is days 31-90 in that per-identity observation clock,
 * i.e. (C(90) - C(30)) / 60 of the cumulative coverage curve).
 * The observation model is y_i(d) ~ Normal(theta_i, sigma_i^2) over
 * the 60 late days, with sigma_i^2 taken from the identity's OWN
 * day-to-day variance inside the late window, and the score is an
 * empirical-Bayes normal-normal partial-pooling posterior under a
 * robust mixture prior, computed PER STRATUM:
 *
 *   prior:  0.9 * N(m, tau^2) + 0.1 * N(m, (3*tau)^2)
 *   (m, tau) estimated from the reference population by
 *   median / IQR (contamination-robust), with tau^2 reduced by the
 *   median measurement noise: tau^2 = max(0.05, (IQR/1.349)^2 -
 *   median(se^2)) - the lab's step0/common formula, verbatim.
 *
 * STRATIFICATION (frozen lab rule). Strata are the TERCILES of the
 * identity's own total REQUEST volume over observation days 1-30,
 * taken over the reference population. Prior AND threshold are
 * fitted per stratum: c_s = q99 of the raw theta-hat values of the
 * reference identities in stratum s. An identity is flagged iff
 *
 *   P(theta_i > c_s | y_i) >= 0.975
 *
 * under its stratum's mixture posterior. The posterior is computed
 * in LOG SPACE (log-sum-exp over the mixture components): the lab's
 * first Step-0 run died of density underflow on far-tail
 * observations (a sustained theta = 50 against a legit prior at
 * m ~ 2.4 drove both component densities to exactly 0 and the
 * plateau cell read 0/200); the log-space form is the lab's fix,
 * pinned here by self-checks (theta = 50 -> posterior 1.0000,
 * theta = 2.4 -> 0.0000).
 *
 * WHAT THE LAB MEASURED (simulation, scripted populations only):
 * FP 0/1,200 on held-out VALID and 0/1,200 on SALE in both lab
 * steps; sustained plateaus at K = 7 / 20 / 50 new records per day
 * flagged 100%; a 7 -> 20/day linear ramp flagged 100%; prior
 * contamination at 5% and 15% (plateau identities injected into
 * the reference fit) left FP at 0.00%; scoring cost ~0.15
 * ms/identity. See the honest limits below before reading any of
 * that as real-traffic performance.
 *
 * HOW THE HOST FITS (the ONE fit path this module ships).
 * `fitFromDailySeries(series)` on the SAME instance that will be
 * evaluated: the host supplies its reference population as daily
 * aggregates - one `{ dailyNovel, earlyRequests }` entry per
 * reference identity, where `dailyNovel` is the identity's daily
 * NEW-record counts over its own observation days 1-90 and
 * `earlyRequests` is its total request count over days 1-30. The
 * fitted constants (tercile cuts, per-stratum m / tau / c) are
 * stored inside the instance and exposed read-only via
 * `snapshot().calibration`. There is deliberately no second fit
 * path and no calibration-injection option: one way in, so the
 * constants an instance scores with are exactly the constants its
 * own fit produced from the series it was handed.
 *
 * FEEDING. `observe({ identity, resourceId, ts })` is the live
 * path: the module itself derives novelty (the first time THIS
 * identity is served THIS resource) and the per-day request
 * totals, on the identity's own observation clock (UTC days;
 * day 1 = the UTC day of its first event). Timestamps are
 * milliseconds since the epoch. A non-finite / out-of-range `ts`
 * is a structured no-op (`invalid_ts`); a malformed identity or
 * resourceId throws `ShrinkSlopeError`.
 *
 * THE HOST CLOCK. The module holds no wall clock of its own, so
 * an identity's age is the span of its own events - an identity
 * that goes quiet would never age past its last event.
 * `evaluateIdentity(identity, asOfTs)` therefore accepts the
 * host's "now": when a valid `asOfTs` is supplied, the identity's
 * age is measured up to that UTC day and its silent days count as
 * zero-count days, which is exactly the lab's fixed-window
 * semantics (the lab scored every identity on a full 90-day
 * array, activity or not). Hosts evaluating on a schedule should
 * pass their current time; without it, only identities whose own
 * events span 90 days can be scored.
 *
 * HARD CONDITIONS - in the code, not just the docs:
 *
 * 1. ADVISORY ONLY. The module emits signal objects
 *    (`enforcement: "none"`). It has no blocking decision and
 *    attaches no consequence; a flag is per-identity investigation
 *    telemetry.
 * 2. OPT-IN. Nothing runs until the host constructs an instance,
 *    fits a reference population, and feeds it events.
 * 3. NO SCORE BEFORE DAY 90. The estimand is a 60-day late
 *    window; an identity with fewer than 90 observation days is
 *    `insufficient_history` and is NEVER flagged - cold start is
 *    structural, not a tuning choice (see limits).
 * 4. NO SCORE BEFORE A FIT. An unfitted instance reports
 *    `unfitted` for every identity and flags nothing.
 *
 * KNOWN LIMITS - measured or declared in the lab, pinned by tests:
 *
 * - THE ABSOLUTE SEPARATION IS A PROPERTY OF THE LAB GENERATOR:
 *   its legitimate population saturates novelty HARD (late-window
 *   median ~2.4 new/day, q99 ~3.7). A real human who reads
 *   systematically - >= 7 NEW pages/day sustained over the whole
 *   60-day late window - is an UNMEASURED false-positive risk.
 *   The lab PASS is valid only inside that substrate; it is not a
 *   real-traffic performance claim.
 * - LAUNCH / COLD START: an identity younger than 60 days can
 *   never be flagged by construction (this module requires 90
 *   observation days before it scores at all). The first two
 *   months of an identity's life are the record budget's and the
 *   CUSUM channels' ground, not this statistic's.
 * - EV-FRONTLOAD IS STRUCTURALLY BLIND: an extractor that pulls
 *   50/day for the first 30 days and then drops to ~3/day has a
 *   late-window theta of ~3 and is NOT flagged (lab: 0/300) - that
 *   is the estimand working as designed; its price is exposing
 *   50/day for 30 days to the budget / CUSUM layer.
 * - STRATA ARE A VOLUME PROXY, NOT ARCHETYPES: the lab harness
 *   exposes no archetype labels, so stratification is by early
 *   request-volume tercile only. A host whose legitimate archetypes
 *   differ in late novelty at equal early volume is not separated
 *   by this proxy.
 * - The lab's plateau cells are synthetic daily-novel series
 *   (c25 form, jitter +/-10%), not full session walkers; they are
 *   equivalent at this estimand's input (a daily novel series).
 *
 * Pure computation: no I/O, no runtime dependencies. State is
 * bounded in-memory maps (per identity: two fixed 90-day count
 * arrays plus the set of resources that identity has seen; the
 * seen set is the novelty ledger and grows with the identity's
 * distinct coverage, the quantity this statistic meters).
 */

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90;
const LATE_LO = 30; // observation-day index 30 = day 31
const LATE_N = 60; // days 31..90 inclusive
const POSTERIOR_THRESHOLD = 0.975;
const MIXTURE_WEIGHT = 0.9;

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): this identity's late-window (observation days 31-90) " +
  "daily new-record rate is, under a per-stratum empirical-Bayes mixture posterior fitted on the " +
  "host's reference population, above the stratum's q99 reference rate with posterior probability " +
  ">= 0.975. A flag is investigation telemetry, never proof of extraction, and must never be the " +
  "sole evidence for any consequence. Known limits: identities under 90 observation days are never " +
  "scored, front-loaded extraction that goes quiet in the late window is invisible by construction, " +
  "strata are an early-volume proxy (not archetypes), and the lab separation was measured on a " +
  "generator whose legitimate novelty saturates hard - a real sustained systematic reader " +
  "(>= 7 new pages/day for 60 days) is an unmeasured false-positive risk.";

export interface ShrinkSlopeEvent {
  /** The authenticated identity the resource was served to. */
  identity: string;
  /** The resource served; novelty is tracked per (identity, resourceId). */
  resourceId: number | string;
  /** Millisecond timestamp of the serve (UTC days define the observation clock). */
  ts: number;
}

/** One reference identity's daily aggregates, for {@link ShrinkSlopeSignalInstance.fitFromDailySeries}. */
export interface ShrinkSlopeDailySeries {
  /**
   * Daily NEW-record counts over the identity's own observation
   * days 1-90 (index 0 = day 1). Must carry at least 90 entries;
   * entries past day 90 are ignored.
   */
  dailyNovel: number[];
  /** Total requests over the identity's observation days 1-30 (the stratum key). */
  earlyRequests: number;
}

/** Fitted constants for one stratum. */
export interface ShrinkSlopeStratumParams {
  /** Reference identities in this stratum. */
  n: number;
  /** Robust prior location: median of the stratum's raw theta-hat values. */
  m: number;
  /** Robust prior scale: sqrt(max(0.05, (IQR/1.349)^2 - median(se^2))). */
  tau: number;
  /** Decision threshold c_s: q99 of the stratum's raw theta-hat values. */
  c: number;
}

/** The fitted calibration: tercile cuts plus per-stratum prior + threshold. */
export interface ShrinkSlopeCalibration {
  /** [q1/3, q2/3] of the reference population's early (days 1-30) request volumes. */
  cuts: [number, number];
  /** Exactly three strata, in tercile order. */
  strata: [ShrinkSlopeStratumParams, ShrinkSlopeStratumParams, ShrinkSlopeStratumParams];
}

export interface CreateShrinkSlopeSignalOptions {
  /** Posterior flag threshold P(theta > c_s | y). Defaults to 0.975 (the lab's frozen level). */
  posteriorThreshold?: number;
  /** Minimum reference identities a fit call must supply. Defaults to 30. */
  minTrainIdentities?: number;
  /** Maximum identities tracked at once (least-recently-seen evicted). Defaults to 10,000. */
  maxIdentities?: number;
}

export interface ShrinkSlopeObservation {
  /**
   * `"recorded"` - the event entered the identity's series;
   * `"invalid_ts"` - non-finite or out-of-range timestamp, refused
   * before any state was touched.
   */
  status: "recorded" | "invalid_ts";
  /** Whether the event was counted into the identity's series. */
  counted: boolean;
  /** Whether this serve was the identity's first sight of the resource (null when not recorded). */
  novel: boolean | null;
  /** Observation-day index (0-based) the event landed on, or null when not recorded. */
  dayIndex: number | null;
}

export interface ShrinkSlopeFitResult {
  fitted: boolean;
  status: "fitted";
  /** Reference identities consumed by the fit. */
  identities: number;
  calibration: ShrinkSlopeCalibration;
}

export interface ShrinkSlopeSignal {
  kind: "shrink_slope";
  identity: string;
  /**
   * `"scored"` - 90 observation days and a fitted calibration;
   * `"insufficient_history"` - fewer than 90 observation days;
   * `"unfitted"` - no calibration fitted on this instance;
   * `"unknown_identity"` - the identity was never observed.
   */
  status: "scored" | "insufficient_history" | "unfitted" | "unknown_identity";
  /** True exactly when scored and the posterior crossed the flag threshold. */
  flagged: boolean;
  /** Raw late-window mean daily novel rate, or null when not scored. */
  thetaHat: number | null;
  /** Posterior P(theta > c_s | y) under the stratum mixture prior, or null when not scored. */
  posterior: number | null;
  /** The identity's stratum (early-volume tercile 0 | 1 | 2), or null when not scored. */
  stratum: 0 | 1 | 2 | null;
  /** Observation days of history: the span of the identity's events, extended to the host's `asOfTs` day when one was supplied (0 for an unknown identity). */
  daysObserved: number;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface ShrinkSlopeSnapshot {
  fitted: boolean;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  posteriorThreshold: number;
  identitiesTracked: number;
  /** The fitted constants, or null before a fit. */
  calibration: ShrinkSlopeCalibration | null;
  counters: {
    /** Events counted into an identity's series. */
    recorded: number;
    /** Events refused for a non-finite or out-of-range timestamp. */
    invalidTs: number;
  };
  notice: string;
}

export interface ShrinkSlopeSignalInstance {
  /**
   * Feed one serve event. The module derives novelty and daily
   * totals itself. See {@link ShrinkSlopeObservation}.
   */
  observe(event: ShrinkSlopeEvent): ShrinkSlopeObservation;
  /**
   * THE fit path: fit tercile cuts + per-stratum robust priors +
   * q99 thresholds from the host's reference population, supplied
   * as daily aggregates (see {@link ShrinkSlopeDailySeries}), and
   * store the constants inside this instance for `evaluateIdentity`.
   * Throws `ShrinkSlopeError` on malformed series, on fewer than
   * `minTrainIdentities` entries, or when a stratum ends up empty.
   */
  fitFromDailySeries(series: ShrinkSlopeDailySeries[]): ShrinkSlopeFitResult;
  /**
   * Score one identity's observed series against the fitted
   * calibration. `asOfTs` is the host's optional "now" (ms): when
   * supplied and valid, the identity's age is measured up to that
   * UTC day (silent days count as zeros - the lab's fixed-window
   * semantics); when omitted, age is the span of its own events.
   * An invalid `asOfTs` is ignored, never an error.
   */
  evaluateIdentity(identity: string, asOfTs?: number): ShrinkSlopeSignal;
  /** State and calibration summary. */
  snapshot(): ShrinkSlopeSnapshot;
}

/** Named error thrown for every invalid shrink-slope input. */
export class ShrinkSlopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShrinkSlopeError";
  }
}

const fail = (message: string): never => {
  throw new ShrinkSlopeError(`createShrinkSlopeSignal: ${message}`);
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

/* ------------------------------------------------------------------ */
/* The lab's estimators, translated verbatim from c27-lab/common.cjs.  */
/* ------------------------------------------------------------------ */

/** Lab quantile: sorted copy, index min(n-1, floor(q * n)). */
function quantile(values: readonly number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  const v = s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return v as number;
}

function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

/** Raw late-window estimate: mean of dailyNovel[30..89] and its standard error (sample sd / sqrt(60)). */
function thetaHat(dailyNovel: readonly number[]): { theta: number; se: number } {
  let sum = 0;
  for (let d = LATE_LO; d < WINDOW_DAYS; d++) sum += dailyNovel[d] as number;
  const mean = sum / LATE_N;
  let ss = 0;
  for (let d = LATE_LO; d < WINDOW_DAYS; d++) {
    const diff = (dailyNovel[d] as number) - mean;
    ss += diff * diff;
  }
  const sd = Math.sqrt(ss / (LATE_N - 1));
  return { theta: mean, se: sd / Math.sqrt(LATE_N) };
}

/** Abramowitz-Stegun 7.1.26 normal CDF, as in the lab. */
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - (Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? p : 1 - p;
}

/**
 * Posterior P(theta > c | y) under the robust mixture prior
 * 0.9 * N(m, tau^2) + 0.1 * N(m, (3*tau)^2), with the observation
 * thetaHat ~ N(theta, se^2) - the lab's posterior, computed in LOG
 * SPACE (log-sum-exp over component weights) so far-tail
 * observations cannot underflow both densities to zero. Exported
 * for calibration tooling and for the log-space self-checks pinned
 * in the tests (theta = 50 -> 1.0000, theta = 2.4 -> 0.0000 under
 * the lab's stratum-0 constants).
 */
export function shrinkSlopePosteriorExceed(
  theta: number,
  se: number,
  par: { m: number; tau: number; c: number },
): number {
  if (!(se > 0) || !Number.isFinite(se)) {
    // Degenerate observation (a perfectly constant late series):
    // the posterior collapses onto the observed rate itself.
    return theta > par.c ? 1 : 0;
  }
  const comps = [
    { w: MIXTURE_WEIGHT, tau2: par.tau * par.tau },
    { w: 1 - MIXTURE_WEIGHT, tau2: 9 * par.tau * par.tau },
  ];
  let maxLog = -Infinity;
  const rows = comps.map((cp) => {
    const postVar = 1 / (1 / cp.tau2 + 1 / (se * se));
    const postMean = postVar * (par.m / cp.tau2 + theta / (se * se));
    const pv = cp.tau2 + se * se;
    const logw =
      Math.log(cp.w) - 0.5 * Math.log(2 * Math.PI * pv) - (0.5 * (theta - par.m) * (theta - par.m)) / pv;
    if (logw > maxLog) maxLog = logw;
    return { logw, exceed: 1 - normCdf((par.c - postMean) / Math.sqrt(postVar)) };
  });
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const cw = Math.exp(r.logw - maxLog);
    den += cw;
    num += cw * r.exceed;
  }
  return den > 0 ? num / den : 0;
}

/** The lab's stratum rule: tercile of early request volume against the fitted cuts. */
function stratumOf(calibration: ShrinkSlopeCalibration, earlyVolume: number): 0 | 1 | 2 {
  if (earlyVolume <= calibration.cuts[0]) return 0;
  if (earlyVolume <= calibration.cuts[1]) return 1;
  return 2;
}

interface IdentityState {
  /** UTC day number (floor(ts / DAY_MS)) of the earliest event seen so far. */
  anchorDay: number;
  /** Largest observation-day index seen so far (can exceed 89; it is the history clock). */
  maxDayIndex: number;
  /** Daily NEW-record counts, observation days 0..89. */
  dailyNovel: number[];
  /** Daily total request counts, observation days 0..89 (only days 0..29 feed the stratum key). */
  dailyTotal: number[];
  /** Novelty ledger: resource keys this identity has ever been served. */
  seen: Set<string>;
  lastSeen: number;
}

export function createShrinkSlopeSignal(
  options: CreateShrinkSlopeSignalOptions = {},
): ShrinkSlopeSignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");

  const posteriorThreshold = options.posteriorThreshold ?? POSTERIOR_THRESHOLD;
  if (
    typeof posteriorThreshold !== "number" ||
    !Number.isFinite(posteriorThreshold) ||
    posteriorThreshold <= 0.5 ||
    posteriorThreshold >= 1
  ) {
    fail("posteriorThreshold must be a finite number in (0.5, 1)");
  }
  const minTrainIdentities = requireIntInRange(options.minTrainIdentities ?? 30, "minTrainIdentities", 3, 1_000_000);
  const maxIdentities = requireIntInRange(options.maxIdentities ?? 10_000, "maxIdentities", 1, 1_000_000);

  let calibration: ShrinkSlopeCalibration | null = null;
  const identities = new Map<string, IdentityState>();
  const counters = { recorded: 0, invalidTs: 0 };
  let seq = 0;

  function touchIdentity(identity: string, anchorDay: number): IdentityState {
    const existing = identities.get(identity);
    if (existing) {
      existing.lastSeen = seq++;
      identities.delete(identity);
      identities.set(identity, existing);
      return existing;
    }
    if (identities.size >= maxIdentities) {
      const oldest = identities.keys().next().value as string | undefined;
      if (oldest !== undefined) identities.delete(oldest);
    }
    const fresh: IdentityState = {
      anchorDay,
      maxDayIndex: 0,
      dailyNovel: new Array<number>(WINDOW_DAYS).fill(0),
      dailyTotal: new Array<number>(WINDOW_DAYS).fill(0),
      seen: new Set<string>(),
      lastSeen: seq++,
    };
    identities.set(identity, fresh);
    return fresh;
  }

  function observe(event: ShrinkSlopeEvent): ShrinkSlopeObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    requireIdentity(event.identity, "event.identity");
    if (
      (typeof event.resourceId !== "number" || !Number.isFinite(event.resourceId)) &&
      (typeof event.resourceId !== "string" || event.resourceId.length === 0)
    ) {
      fail("event.resourceId must be a finite number or a non-empty string");
    }
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      return { status: "invalid_ts", counted: false, novel: null, dayIndex: null };
    }

    const dayNumber = Math.floor(event.ts / DAY_MS);
    const state = touchIdentity(event.identity, dayNumber);
    if (dayNumber < state.anchorDay) {
      // An earlier first day arrived out of order: re-anchor the
      // observation clock (day 1 = first event day) by shifting
      // both daily series right; counts that fall past day 90
      // leave the estimand window, exactly as a longer history
      // would place them outside days 1-90.
      const shift = state.anchorDay - dayNumber;
      for (const arr of [state.dailyNovel, state.dailyTotal]) {
        const copy = [...arr];
        arr.fill(0);
        for (let d = 0; d < WINDOW_DAYS; d++) {
          if (d + shift < WINDOW_DAYS) arr[d + shift] = copy[d] as number;
        }
      }
      state.maxDayIndex += shift;
      state.anchorDay = dayNumber;
    }
    const dayIndex = dayNumber - state.anchorDay;
    if (dayIndex > state.maxDayIndex) state.maxDayIndex = dayIndex;

    const key = typeof event.resourceId === "number" ? `n:${event.resourceId}` : `s:${event.resourceId}`;
    const novel = !state.seen.has(key);
    if (novel) state.seen.add(key);
    if (dayIndex < WINDOW_DAYS) {
      state.dailyTotal[dayIndex] = (state.dailyTotal[dayIndex] as number) + 1;
      if (novel) state.dailyNovel[dayIndex] = (state.dailyNovel[dayIndex] as number) + 1;
    }
    counters.recorded++;
    return { status: "recorded", counted: true, novel, dayIndex };
  }

  function fitFromDailySeries(series: ShrinkSlopeDailySeries[]): ShrinkSlopeFitResult {
    if (!Array.isArray(series)) fail("series must be an array of { dailyNovel, earlyRequests }");
    if (series.length < minTrainIdentities) {
      fail(
        `fitFromDailySeries needs at least ${minTrainIdentities} reference identities; got ${series.length}`,
      );
    }
    const entries = series.map((entry, i) => {
      if (typeof entry !== "object" || entry === null) fail(`series[${i}] must be an object`);
      if (!Array.isArray(entry.dailyNovel) || entry.dailyNovel.length < WINDOW_DAYS) {
        fail(`series[${i}].dailyNovel must be an array of at least ${WINDOW_DAYS} daily counts`);
      }
      for (let d = 0; d < WINDOW_DAYS; d++) {
        const v = entry.dailyNovel[d];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
          fail(`series[${i}].dailyNovel[${d}] must be a finite non-negative number`);
        }
      }
      if (typeof entry.earlyRequests !== "number" || !Number.isFinite(entry.earlyRequests) || entry.earlyRequests < 0) {
        fail(`series[${i}].earlyRequests must be a finite non-negative number`);
      }
      const t = thetaHat(entry.dailyNovel);
      return { theta: t.theta, se: t.se, earlyVolume: entry.earlyRequests };
    });

    // Lab fitTrain, verbatim: tercile cuts over early volume, then
    // per stratum m = median(theta), tau from IQR/1.349 with the
    // median measurement noise removed and floored, c = q99(theta).
    const vols = entries.map((e) => e.earlyVolume);
    const cuts: [number, number] = [quantile(vols, 1 / 3), quantile(vols, 2 / 3)];
    const probe: ShrinkSlopeCalibration = {
      cuts,
      strata: [
        { n: 0, m: 0, tau: 0, c: 0 },
        { n: 0, m: 0, tau: 0, c: 0 },
        { n: 0, m: 0, tau: 0, c: 0 },
      ],
    };
    const buckets: { theta: number; se: number }[][] = [[], [], []];
    for (const e of entries) {
      const bucket = buckets[stratumOf(probe, e.earlyVolume)];
      if (bucket) bucket.push({ theta: e.theta, se: e.se });
    }
    const strata = buckets.map((arr, s) => {
      if (arr.length === 0) {
        fail(
          `fitFromDailySeries produced an empty stratum ${s}: the reference population's early ` +
            `request volumes do not span the tercile cuts [${cuts[0]}, ${cuts[1]}]`,
        );
      }
      const thetas = arr.map((t) => t.theta);
      const m = median(thetas);
      const iqr = quantile(thetas, 0.75) - quantile(thetas, 0.25);
      const tauRaw = iqr / 1.349;
      const medSE2 = median(arr.map((t) => t.se * t.se));
      const tau2 = Math.max(0.05, tauRaw * tauRaw - medSE2);
      return { n: arr.length, m, tau: Math.sqrt(tau2), c: quantile(thetas, 0.99) };
    });
    const fitted: ShrinkSlopeCalibration = {
      cuts,
      strata: [strata[0] as ShrinkSlopeStratumParams, strata[1] as ShrinkSlopeStratumParams, strata[2] as ShrinkSlopeStratumParams],
    };
    calibration = fitted;
    return { fitted: true, status: "fitted", identities: entries.length, calibration: fitted };
  }

  function evaluateIdentity(identity: string, asOfTs?: number): ShrinkSlopeSignal {
    requireIdentity(identity, "identity");
    const state = identities.get(identity);
    const base = {
      kind: "shrink_slope" as const,
      identity,
      enforcement: "none" as const,
      notice: ADVISORY_NOTICE,
    };
    if (!state) {
      return {
        ...base,
        status: "unknown_identity",
        flagged: false,
        thetaHat: null,
        posterior: null,
        stratum: null,
        daysObserved: 0,
      };
    }
    let daysObserved = state.maxDayIndex + 1;
    if (isValidTs(asOfTs)) {
      // Host clock: age up to the as-of UTC day, silent days
      // counting as zeros (the lab's fixed-window semantics). An
      // as-of earlier than the observed span never un-ages the
      // identity below what its own events already prove.
      const asOfAge = Math.floor(asOfTs / DAY_MS) - state.anchorDay + 1;
      if (asOfAge > daysObserved) daysObserved = asOfAge;
    }
    if (!calibration) {
      return {
        ...base,
        status: "unfitted",
        flagged: false,
        thetaHat: null,
        posterior: null,
        stratum: null,
        daysObserved,
      };
    }
    if (daysObserved < WINDOW_DAYS) {
      return {
        ...base,
        status: "insufficient_history",
        flagged: false,
        thetaHat: null,
        posterior: null,
        stratum: null,
        daysObserved,
      };
    }
    let earlyVolume = 0;
    for (let d = 0; d < LATE_LO; d++) earlyVolume += state.dailyTotal[d] as number;
    const stratum = stratumOf(calibration, earlyVolume);
    const par = calibration.strata[stratum];
    const t = thetaHat(state.dailyNovel);
    const posterior = shrinkSlopePosteriorExceed(t.theta, t.se, par);
    return {
      ...base,
      status: "scored",
      flagged: posterior >= posteriorThreshold,
      thetaHat: t.theta,
      posterior,
      stratum,
      daysObserved,
    };
  }

  function snapshot(): ShrinkSlopeSnapshot {
    return {
      fitted: calibration !== null,
      enforcement: "none",
      posteriorThreshold,
      identitiesTracked: identities.size,
      calibration: calibration
        ? {
            cuts: [...calibration.cuts] as [number, number],
            strata: calibration.strata.map((s) => ({ ...s })) as ShrinkSlopeCalibration["strata"],
          }
        : null,
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  return { observe, fitFromDailySeries, evaluateIdentity, snapshot };
}
