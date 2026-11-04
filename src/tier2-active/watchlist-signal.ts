/**
 * Watchlist signal (HARVEST2 candidate C30, WATCHLIST, lab PASS -
 * see the study lab's C30-DESIGN.md, C30-RESULTS.md and
 * C30-RESULTS-EVENT.md under the antiRea research tree).
 *
 * WHAT IT MEASURES. A polling bot returns to the same watchlist of
 * resources on a fixed period in days (1-2 days in the lab). At the
 * DAY grain that regularity is extreme: the gaps between an
 * identity's distinct visit days to one resource are all equal, so
 * the coefficient of variation (CV) of the gaps is ~0, while
 * legitimate revisiting is irregular (lab TRAIN median CV 0.746).
 * The statistic is computed EXACTLY as the lab froze it:
 * - per (identity, resource) with at least `minVisitDays` (lab: 5)
 *   DISTINCT visit days: gaps between consecutive sorted visit
 *   days; CV = sd(gaps) / mean(gaps) with the POPULATION sd (the
 *   lab's common.cjs divides by the gap count, not count - 1);
 * - an identity is scored only when at least `minResources`
 *   (lab: 3) of its resources qualify; its statistic is the
 *   lab's median of the per-resource CVs - the value at index
 *   floor(n / 2) of the sorted CVs (the lab's definition, an upper
 *   median for even counts, reproduced verbatim, not "fixed");
 * - flagged iff statistic <= tau. tau defaults to the lab's frozen
 *   Step-0 value, q01 of the TRAIN identity statistics:
 *   0.6130895965797241. (The lab's Step scripts compared with a
 *   strict `< tau`; equality is a measure-zero event for this
 *   continuous statistic, and this module's contract is `<=`.)
 *
 * WHAT THE LAB MEASURED (simulation, scripted harness populations,
 * full 90-day traces): FP VALID 1.33% (16/1,200) and FP SALE 0.83%
 * (10/1,200) at the frozen tau, against a 2% gate; unjittered
 * pollers (period 1 and 2 days) flagged 120/120; pollers with
 * symmetric poll-time jitter up to +-100% of the period still
 * flagged 100% at both periods (median statistic at most 0.352) -
 * at the day grain, symmetric jitter cannot manufacture enough
 * gap variance, and reaching the legitimate CV range requires
 * breaking the period so far that the watch loses timeliness.
 *
 * DECLARED RISK GROUPS - the routine checkers, not the background
 * population, are this statistic's false-positive risk:
 * - HABITUAL checkers (synthetic declared archetype: an identity
 *   checking 1-3 fixed resources near-daily on top of legitimate
 *   activity): FP 4.83% (29/600) - about 3.6x the legitimate
 *   background rate. Their per-resource CV is poller-shaped; only
 *   dilution by their other, irregular resources keeps most of
 *   them above tau.
 * - EVENT checkers (same overlay restricted to one burst of
 *   consecutive days, 7/14/28 days long): FP 4.50% at the gate
 *   cell (27/600) - about 3.8x the background rate of the same
 *   population, essentially flat in burst length: a one-week burst
 *   already carries nearly the full risk of a window-long habit.
 * A host whose users include dashboards, routine checkers or
 * event followers must expect flags concentrated in exactly those
 * users and must not treat a flag as bot evidence on its own.
 *
 * DECLARED BLIND SPOTS (from the lab registration, verbatim in
 * substance):
 * - INTRA-DAY POLLERS ARE INVISIBLE. The statistic lives at the
 *   day grain: every poll inside one day collapses into that one
 *   visit day, so a poller with a period under 1 day leaves no
 *   gap sequence to measure.
 * - EVADER FAMILY OUTSIDE THE REGISTRATION: a poller on
 *   exponential / fully random intervals (no period at all) has a
 *   structurally high gap CV, and its mean staleness tax is 0 BY
 *   THE LOCKED TAX DEFINITION (the lab's tax is the increase in
 *   MEAN realised gap over the nominal period) - but about 13.5%
 *   of its polls land more than 2 periods late (a stale tail the
 *   mean-based tax definition does not catch). That family was
 *   declared, never measured; a re-registration would need a
 *   tail-quantile (p90/p95) tax. Do not read this module as
 *   covering it.
 * - DILUTION BOTH WAYS: an identity that polls few resources
 *   amid much other activity is diluted toward the legitimate
 *   median (registered blind spot), and that same dilution is
 *   what protects the HABITUAL cell.
 * - Identity rotation across resources (each resource watched by
 *   a different identity) thins every per-identity statistic;
 *   declared in the lab registration, out of scope here.
 *
 * LIVE-SERVICE DEVIATION FROM THE LAB (declared, in the code):
 * the lab scored one fixed 90-day window per trace. A live
 * service has no trace end, so this module scores a TRAILING
 * window of `windowDays` (default 90) days ending at the
 * identity's most recent event day: visit days older than
 * `latestDay - windowDays + 1` do not count toward eligibility or
 * CVs. Visit days are UTC days, floor(ts / 86,400,000) on the
 * millisecond timestamp. Everything else - eligibility floors,
 * gap CV, median, tau - is the lab's frozen rule.
 *
 * HARD CONDITIONS - in the code, not just the docs:
 *
 * 1. ADVISORY ONLY. The module emits signal objects
 *    (`enforcement: "none"`, the policy-signals precedent). It has
 *    no blocking decision and attaches no consequence; a flag is
 *    investigation telemetry about one identity's revisit rhythm.
 * 2. OPT-IN. Nothing runs until the host constructs an instance
 *    and feeds it serve events.
 * 3. HOST CALIBRATION IS EXPLICIT. The default tau is the LAB's
 *    value from a scripted population, not a measurement of the
 *    host's users. `fitThreshold` recomputes tau as q01 of the
 *    identity statistics over a host-supplied legitimate
 *    reference population (the lab's own derivation, verbatim);
 *    hosts with routine-checker users should fit on traffic that
 *    includes them, or keep the lab tau only as advisory input.
 * 4. BOUNDED STATE. Identities are capped (`maxIdentities`,
 *    least-recently-seen evicted) and each identity's resources
 *    are capped (`maxResourcesPerIdentity`, least-recently-seen
 *    evicted); an evicted identity/resource restarts from zero
 *    evidence. The caps are declared, not silent.
 * 5. TIMESTAMP DISCIPLINE (the F-21 precedent): an event whose
 *    `ts` is non-finite or outside the representable Date range
 *    (|ts| > 8.64e15) is refused as a structured no-op
 *    (`invalid_ts`) before any state is touched. Other malformed
 *    fields throw `WatchlistSignalError`.
 *
 * Pure computation: no I/O, no runtime dependencies. State is
 * bounded in-memory maps of visit-day sets per (identity,
 * resource).
 */

/** The lab's frozen Step-0 threshold: q01 of the TRAIN identity statistics. */
export const WATCHLIST_LAB_TAU = 0.6130895965797241;

const DAY_MS = 86_400_000;

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): this identity's per-resource revisit rhythm at the " +
  "day grain is at least as regular as the most regular 1% of the lab's legitimate population " +
  "(median gap CV at or below tau). A flag is investigation telemetry, never bot attribution: " +
  "the lab's declared false-positive risk groups are routine checkers (HABITUAL FP 4.83%, " +
  "EVENT-burst checkers 4.50% - roughly 3.6-3.8x the legitimate background rate), and the " +
  "statistic is blind to intra-day pollers and to period-free (exponential-interval) pollers.";

export interface WatchlistEvent {
  /** The authenticated identity the resource was served to. */
  identity: string;
  /** The resource served. */
  resourceId: number | string;
  /** Millisecond timestamp of the serve. */
  ts: number;
}

/** One reference visit-day for `fitThreshold`: a single (identity, resource, UTC day) triple. */
export interface WatchlistReferenceVisit {
  identity: string;
  resourceId: number | string;
  /** UTC day index, floor(ms / 86,400,000). */
  day: number;
}

/** A trace-shaped reference sample for `fitThreshold`: one identity's serve events (millisecond `ts`, or an explicit UTC `day`). */
export interface WatchlistReferenceTrace {
  identity?: string;
  id?: string;
  events: Array<{
    resourceId?: number | string;
    resource?: number | string;
    ts?: number;
    day?: number;
  }>;
}

export type WatchlistReferenceSample = WatchlistReferenceVisit | WatchlistReferenceTrace;

export interface CreateWatchlistSignalOptions {
  /**
   * Flag threshold on the identity statistic (median per-resource
   * gap CV). Defaults to the lab's frozen tau,
   * 0.6130895965797241 (q01 of the lab TRAIN population).
   * `fitThreshold` replaces it with the host's own q01.
   */
  tau?: number;
  /** Distinct visit days a resource needs before its CV counts (the lab floor). Defaults to 5. */
  minVisitDays?: number;
  /** Qualifying resources an identity needs before it is scored (the lab floor). Defaults to 3. */
  minResources?: number;
  /**
   * Trailing window length in days, ending at the identity's most
   * recent event day (the declared live-service deviation from
   * the lab's fixed 90-day trace window). Defaults to 90.
   */
  windowDays?: number;
  /** Maximum identities tracked at once (least-recently-seen evicted). Defaults to 1,000. */
  maxIdentities?: number;
  /** Maximum resources tracked per identity (least-recently-seen evicted). Defaults to 256. */
  maxResourcesPerIdentity?: number;
}

export interface WatchlistObservation {
  /**
   * `"recorded"` - the visit day entered the identity's state;
   * `"invalid_ts"` - non-finite or out-of-range timestamp, refused
   * before any state was touched.
   */
  status: "recorded" | "invalid_ts";
  /** Whether the event was counted. */
  counted: boolean;
  /** The UTC day index recorded, when counted. */
  day?: number;
}

export interface WatchlistEvaluation {
  kind: "watchlist";
  identity: string;
  /**
   * `"scored"` - the identity met both eligibility floors and was
   * compared to tau; `"ineligible"` - tracked, but too few
   * qualifying resources (never flagged); `"unknown_identity"` -
   * never seen (or evicted by the identity cap).
   */
  status: "scored" | "ineligible" | "unknown_identity";
  /** True exactly when scored and the statistic is at or below tau. Always false otherwise. */
  flagged: boolean;
  /** The identity statistic (lab median of per-resource gap CVs), or null when not scored. */
  statistic: number | null;
  /** Resources meeting the visit-day floor inside the trailing window. */
  eligibleResources: number;
  /** The threshold applied. */
  tau: number;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface WatchlistFitResult {
  fitted: boolean;
  /** The new tau: q01 of the reference population's identity statistics (the lab's derivation). */
  tau: number;
  /** Distinct identities present in the reference samples. */
  referenceIdentities: number;
  /** Reference identities that met both eligibility floors and entered the quantile. */
  eligibleIdentities: number;
}

export interface WatchlistSnapshot {
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  tau: number;
  /** True once `fitThreshold` has replaced tau with a host-fitted q01. */
  tauFitted: boolean;
  minVisitDays: number;
  minResources: number;
  windowDays: number;
  maxIdentities: number;
  maxResourcesPerIdentity: number;
  identitiesTracked: number;
  counters: {
    /** Events counted into state. */
    recorded: number;
    /** Events refused for a non-finite or out-of-range timestamp. */
    invalidTs: number;
  };
  notice: string;
}

export interface WatchlistSignalInstance {
  /** Feed one serve event. See {@link WatchlistObservation} for the outcome vocabulary. */
  observe(event: WatchlistEvent): WatchlistObservation;
  /**
   * Fit tau from a legitimate reference population, the lab's own
   * derivation: compute every reference identity's statistic
   * under this instance's eligibility floors and trailing window,
   * then set tau to the q01 of those statistics (sorted index
   * floor(0.01 * n), the lab's quantile). Accepts flat visit-day
   * triples and/or trace-shaped samples. Throws when no reference
   * identity is eligible. This is the HOST's calibration; the
   * default remains the lab tau until a fit succeeds.
   */
  fitThreshold(reference: WatchlistReferenceSample[]): WatchlistFitResult;
  /** Score one identity against the current tau. */
  evaluateIdentity(identity: string): WatchlistEvaluation;
  /** State and calibration summary. */
  snapshot(): WatchlistSnapshot;
}

/** Named error thrown for every invalid watchlist input. */
export class WatchlistSignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchlistSignalError";
  }
}

const fail = (message: string): never => {
  throw new WatchlistSignalError(`createWatchlistSignal: ${message}`);
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

function requireResourceId(value: unknown, field: string): number | string {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) return value;
  return fail(`${field} must be a finite number or a non-empty string`);
}

/** The F-21 timestamp discipline shared with the herd detector: finite and inside the representable Date range. */
function isValidTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8.64e15;
}

/** Resource map key that keeps numeric and string ids in separate lanes. */
function resourceKey(resourceId: number | string): string {
  return `${typeof resourceId}:${String(resourceId)}`;
}

interface ResourceState {
  days: Set<number>;
  lastSeq: number;
}

interface IdentityState {
  resources: Map<string, ResourceState>;
  latestDay: number;
  lastSeen: number;
}

/**
 * The lab statistic over one identity's resource -> visit-days
 * map, inside the trailing window ending at `latestDay`. Returns
 * the qualifying resources' CVs (unsorted).
 */
function qualifyingCvs(
  resources: Map<string, ResourceState>,
  latestDay: number,
  windowDays: number,
  minVisitDays: number,
): number[] {
  const windowStart = latestDay - windowDays + 1;
  const cvs: number[] = [];
  for (const res of resources.values()) {
    const days: number[] = [];
    for (const d of res.days) if (d >= windowStart) days.push(d);
    if (days.length < minVisitDays) continue;
    days.sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < days.length; i++) {
      const prev = days[i - 1] as number;
      gaps.push((days[i] as number) - prev);
    }
    if (gaps.length === 0) continue;
    const mean = gaps.reduce((s, x) => s + x, 0) / gaps.length;
    if (mean <= 0) continue;
    // Population sd, verbatim from the lab (divide by gap count).
    const sd = Math.sqrt(gaps.reduce((s, x) => s + (x - mean) * (x - mean), 0) / gaps.length);
    cvs.push(sd / mean);
  }
  return cvs;
}

/** The lab's median: sorted value at index floor(n / 2). */
function labMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}

/** The lab's quantile: sorted value at index floor(q * n), clamped to the last index. */
function labQuantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

export function createWatchlistSignal(
  options: CreateWatchlistSignalOptions = {},
): WatchlistSignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");

  let tau = options.tau ?? WATCHLIST_LAB_TAU;
  if (typeof tau !== "number" || !Number.isFinite(tau) || tau <= 0 || tau > 10) {
    fail("tau must be a finite number in (0, 10]");
  }
  const minVisitDays = requireIntInRange(options.minVisitDays ?? 5, "minVisitDays", 2, 3650);
  const minResources = requireIntInRange(options.minResources ?? 3, "minResources", 1, 100_000);
  const windowDays = requireIntInRange(options.windowDays ?? 90, "windowDays", 1, 3650);
  const maxIdentities = requireIntInRange(options.maxIdentities ?? 1_000, "maxIdentities", 1, 1_000_000);
  const maxResourcesPerIdentity = requireIntInRange(
    options.maxResourcesPerIdentity ?? 256,
    "maxResourcesPerIdentity",
    1,
    1_000_000,
  );

  const identities = new Map<string, IdentityState>();
  const counters = { recorded: 0, invalidTs: 0 };
  let tauFitted = false;
  let seq = 0;

  function touchIdentity(identity: string): IdentityState {
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
    const fresh: IdentityState = { resources: new Map(), latestDay: -Infinity, lastSeen: seq++ };
    identities.set(identity, fresh);
    return fresh;
  }

  function touchResource(state: IdentityState, key: string): ResourceState {
    const existing = state.resources.get(key);
    if (existing) {
      existing.lastSeq = seq++;
      return existing;
    }
    if (state.resources.size >= maxResourcesPerIdentity) {
      let oldestKey: string | undefined;
      let oldestSeq = Infinity;
      for (const [k, r] of state.resources) {
        if (r.lastSeq < oldestSeq) {
          oldestSeq = r.lastSeq;
          oldestKey = k;
        }
      }
      if (oldestKey !== undefined) state.resources.delete(oldestKey);
    }
    const fresh: ResourceState = { days: new Set(), lastSeq: seq++ };
    state.resources.set(key, fresh);
    return fresh;
  }

  function observe(event: WatchlistEvent): WatchlistObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    const identity = requireIdentity(event.identity, "event.identity");
    const resourceId = requireResourceId(event.resourceId, "event.resourceId");
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      return { status: "invalid_ts", counted: false };
    }
    const day = Math.floor(event.ts / DAY_MS);
    const state = touchIdentity(identity);
    const res = touchResource(state, resourceKey(resourceId));
    res.days.add(day);
    if (day > state.latestDay) state.latestDay = day;
    counters.recorded++;
    return { status: "recorded", counted: true, day };
  }

  function evaluateIdentity(identityInput: string): WatchlistEvaluation {
    const identity = requireIdentity(identityInput, "identity");
    const base = {
      kind: "watchlist" as const,
      identity,
      tau,
      enforcement: "none" as const,
      notice: ADVISORY_NOTICE,
    };
    const state = identities.get(identity);
    if (!state) {
      return { ...base, status: "unknown_identity", flagged: false, statistic: null, eligibleResources: 0 };
    }
    const cvs = qualifyingCvs(state.resources, state.latestDay, windowDays, minVisitDays);
    if (cvs.length < minResources) {
      return { ...base, status: "ineligible", flagged: false, statistic: null, eligibleResources: cvs.length };
    }
    const statistic = labMedian(cvs);
    return {
      ...base,
      status: "scored",
      flagged: statistic <= tau,
      statistic,
      eligibleResources: cvs.length,
    };
  }

  function fitThreshold(reference: WatchlistReferenceSample[]): WatchlistFitResult {
    if (!Array.isArray(reference)) fail("reference must be an array of visit triples or traces");
    // identity -> (resourceKey -> {days, latestDay tracking is per identity})
    const byIdentity = new Map<string, Map<string, ResourceState>>();
    const latestByIdentity = new Map<string, number>();
    const addVisit = (identity: string, resourceId: number | string, day: number, where: string): void => {
      if (!Number.isInteger(day) || Math.abs(day) > 100_000_000) {
        fail(`${where}.day must be an integer UTC day index`);
      }
      let resources = byIdentity.get(identity);
      if (!resources) {
        resources = new Map();
        byIdentity.set(identity, resources);
      }
      const key = resourceKey(resourceId);
      let res = resources.get(key);
      if (!res) {
        res = { days: new Set(), lastSeq: 0 };
        resources.set(key, res);
      }
      res.days.add(day);
      const prevLatest = latestByIdentity.get(identity);
      if (prevLatest === undefined || day > prevLatest) latestByIdentity.set(identity, day);
    };
    reference.forEach((sample, i) => {
      if (typeof sample !== "object" || sample === null) fail(`reference[${i}] must be an object`);
      if (Array.isArray((sample as WatchlistReferenceTrace).events)) {
        const trace = sample as WatchlistReferenceTrace;
        const identity = requireIdentity(trace.identity ?? trace.id, `reference[${i}].identity`);
        trace.events.forEach((ev, j) => {
          if (typeof ev !== "object" || ev === null) fail(`reference[${i}].events[${j}] must be an object`);
          const resourceId = requireResourceId(
            ev.resourceId ?? ev.resource,
            `reference[${i}].events[${j}].resourceId`,
          );
          let day: number;
          if (ev.day !== undefined) {
            if (typeof ev.day !== "number") fail(`reference[${i}].events[${j}].day must be a number`);
            day = ev.day;
          } else if (isValidTs(ev.ts)) {
            day = Math.floor((ev.ts as number) / DAY_MS);
          } else {
            return fail(`reference[${i}].events[${j}] needs a valid ts or an explicit day`);
          }
          addVisit(identity, resourceId, day, `reference[${i}].events[${j}]`);
        });
      } else {
        const visit = sample as WatchlistReferenceVisit;
        const identity = requireIdentity(visit.identity, `reference[${i}].identity`);
        const resourceId = requireResourceId(visit.resourceId, `reference[${i}].resourceId`);
        if (typeof visit.day !== "number") fail(`reference[${i}].day must be a number`);
        addVisit(identity, resourceId, visit.day, `reference[${i}]`);
      }
    });
    const stats: number[] = [];
    for (const [identity, resources] of byIdentity) {
      const latest = latestByIdentity.get(identity) as number;
      const cvs = qualifyingCvs(resources, latest, windowDays, minVisitDays);
      if (cvs.length >= minResources) stats.push(labMedian(cvs));
    }
    if (stats.length === 0) {
      fail(
        `fitThreshold needs at least one eligible reference identity (>= ${minResources} resources ` +
          `with >= ${minVisitDays} visit days inside a ${windowDays}-day window); got 0 of ` +
          `${byIdentity.size} reference identities`,
      );
    }
    tau = labQuantile(stats, 0.01);
    tauFitted = true;
    return { fitted: true, tau, referenceIdentities: byIdentity.size, eligibleIdentities: stats.length };
  }

  function snapshot(): WatchlistSnapshot {
    return {
      enforcement: "none",
      tau,
      tauFitted,
      minVisitDays,
      minResources,
      windowDays,
      maxIdentities,
      maxResourcesPerIdentity,
      identitiesTracked: identities.size,
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  return { observe, fitThreshold, evaluateIdentity, snapshot };
}
