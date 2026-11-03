/**
 * Lifecycle cohort signal (HARVEST2 candidate C23, lab PASS for
 * the cohort channel only - see the study lab's C23-STEP0.md,
 * C23-DESIGN.md and C23-RESULTS.md under the antiRea research
 * tree).
 *
 * WHAT IT MEASURES. The bust-out shape: accounts are aged with
 * ordinary-looking history, left dormant, then activated together
 * for one extraction burst. The lab's registered design does NOT
 * try to catch the aging phase; the gate sits at the burst and at
 * the staging that precedes it. All statistics are whole-life
 * ratios (no windowed estimation - the lab's estimator-noise death
 * family, C7/C12/C16/C21, is dodged by construction):
 *
 * - A RETURN POINT is an event whose gap from the identity's
 *   previous event is >= 7 days.
 * - At a return point: rho, the dormancy ratio = the silence just
 *   ended / the identity's observed age at the return; and nu, the
 *   burst velocity = novel output in the 72h after the return /
 *   the identity's own mean 72h novel output over its active
 *   history before the return (undefined - and counted as
 *   excluded - when the identity had no novel output before).
 * - A member FIRES at a return point when ALL THREE hold: it
 *   touched the host-declared STAGING band within 24h of the
 *   return (the lab's proxy: the site's rarest resource band -
 *   first-time feature enablement has no page-view shape of its
 *   own, so the band is a declared proxy, stated as such); nu >=
 *   4 at that return point; and the novel output in the 72h after
 *   the return concentrates in one host-declared topic with share
 *   >= 0.5 (the shared funnel).
 * - A COHORT is flagged when at least `minFiringMembers`
 *   (default 6 - the lab's 6 of 24) distinct members fire on the
 *   same calendar day, the day being that of each member's first
 *   staging touch inside its return window.
 *
 * WHAT THE LAB MEASURED (simulation, scripted populations):
 * cohort FP 0/210 across launch cohorts (a legitimate launch
 * pulling old users back en masse, WITH a synchronized
 * morning-of staging touch injected - the conjunction's burst
 * and funnel terms are what legit returns do not carry), valid
 * cohorts and sale cohorts; bust cohorts flagged 18/18.
 *
 * THE IDENTITY FEATURE IS DESCRIPTIVE ONLY - this is a hard
 * condition in the code, not a docs promise. The lab's identity
 * region (rho >= 0.5 AND nu >= 4) was re-checked on fresh seeds
 * and FAILED its registered bar: 58/2,000 = 2.9% of legitimate
 * returners land in the region, above the 2% line. Per the law
 * locked in C23-DESIGN before the re-check ran, the identity
 * feature was demoted to descriptive-only, and this module
 * implements exactly that verdict: `evaluateIdentity` returns
 * per-return-point scores (rho, nu, region membership, the firing
 * conjunction's components) and NO flag, verdict or decision
 * field exists at identity level. It has teeth (lab bust-solo
 * attackers landed in the region 300/300) - it is demoted for
 * false positives, not for blindness, and a host that reads the
 * scores as flags re-creates the measured 2.9% FP.
 *
 * MEASURED BLIND SPOTS - declared, and pinned by tests:
 * - DESYNC: staging placed 4-6 days BEFORE the burst's return
 *   point is fully blind (lab 0/45): the early staging touch
 *   becomes its own harmless return point and breaks the burst
 *   day's anchor. (1-3 day offsets were still caught 36/51; 7-14
 *   day offsets were caught at cohort level only through the
 *   separate self-staging leak below.)
 * - SLOW BURST: a burst spread over ~14 days sits at nu ~ 1.5
 *   and is invisible (lab 0/300, as registered). That shape is
 *   the record budget's and CUSUM's ground, not this module's.
 * - THE STAGING CONJUNCT LEAKS. A 320-novel burst touches the
 *   staging band by itself within its first 24h in ~37% of
 *   members, so cohorts WITHOUT injected staging were still
 *   flagged 8/9 in the lab. The conjunction's separating power
 *   in practice lives in burst AND funnel AND synchrony; a host
 *   with a legitimate heavy-extraction team (a declared audit
 *   cohort) can walk through this gate - declared cohorts are
 *   the existing protected-cohort registry's ground.
 *
 * HARD CONDITIONS:
 *
 * 1. HOST DECLARES THE STAGING BAND AND THE TOPIC MAP. The
 *    cohort channel needs both (`isStagingResource` /
 *    `stagingResourceIds`, and `topicOf`). Without either,
 *    `evaluateCohort` reports status `"undeclared"` and never
 *    flags. Identity scores (rho/nu) need neither and remain
 *    available.
 * 2. ADVISORY ONLY at cohort level too: signals carry
 *    `enforcement: "none"`, no blocking decision exists, and a
 *    cohort flag is investigation telemetry.
 * 3. OPT-IN. Nothing runs until the host constructs an instance
 *    and feeds it events; cohort membership comes from the
 *    host's own `cohortId` tags.
 *
 * State notes: analysis needs each identity's event history, so
 * state is per-identity event lists (capped by
 * `maxEventsPerIdentity`, oldest dropped by arrival, truncation
 * reported on the scores) inside an LRU identity map. Observed
 * age is left-censored by first sight: an identity older than
 * the host's feed has a younger measured age and a smaller rho -
 * the lab's declared censoring caveat, inherited.
 *
 * Pure computation: no I/O, no runtime dependencies.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): cohort members returning from dormancy fired the " +
  "burst-and-funnel-and-staging conjunction on one calendar day. A flag is cohort-level " +
  "investigation telemetry and attributes no single member. Measured blind spots: staging " +
  "desynchronized 4-6 days ahead of the burst, and slow bursts at nu ~ 1.5, are invisible here.";

const IDENTITY_NOTICE =
  "Descriptive scores only: this identity-level output carries no flag and no verdict. The " +
  "lab re-check measured 2.9% of legitimate returners inside the rho >= 0.5 and nu >= 4 region " +
  "(bar 2%), so the region is reported as a score, never as a decision.";

export type LifecycleResourceId = number | string;

export interface LifecycleEvent {
  /** The authenticated identity the resource was served to. */
  identity: string;
  /** The resource served. Novelty, staging and topic are computed from it. */
  resourceId: LifecycleResourceId;
  /** Millisecond timestamp of the serve. */
  ts: number;
  /** Optional host-declared cohort the identity belongs to for this event. */
  cohortId?: string;
}

export interface CreateLifecycleCohortSignalOptions {
  /**
   * Host predicate marking the staging band (rare resources whose
   * first touch reads as feature enablement / staging). A throwing
   * predicate is treated as returning false for that resource.
   */
  isStagingResource?: (resourceId: LifecycleResourceId) => boolean;
  /** Alternative or additional staging declaration: an explicit resource-id set. */
  stagingResourceIds?: LifecycleResourceId[];
  /**
   * Host topic map for the funnel term: resource id -> topic key.
   * A throwing map makes the funnel term uncomputable (null) for
   * the affected return point.
   */
  topicOf?: (resourceId: LifecycleResourceId) => string | number;
  /** Minimum silence that makes a return point. Defaults to 7 days (the lab's gap). */
  returnGapMs?: number;
  /** Window after a return point in which a staging touch counts. Defaults to 24h. */
  stagingWindowMs?: number;
  /** Window after a return point over which burst velocity and funnel are read. Defaults to 72h. */
  burstWindowMs?: number;
  /** Burst-velocity threshold nu of the firing conjunction and the descriptive region. Defaults to 4. */
  burstVelocityMin?: number;
  /** Dormancy-ratio threshold rho of the descriptive identity region. Defaults to 0.5. */
  dormancyRatioMin?: number;
  /** Dominant-topic share of the funnel term. Defaults to 0.5. */
  funnelShareMin?: number;
  /** Distinct members that must fire on one calendar day to flag a cohort. Defaults to 6 (the lab's 6 of 24). */
  minFiringMembers?: number;
  /** Maximum identities tracked at once (least-recently-seen evicted). Defaults to 10,000. */
  maxIdentities?: number;
  /** Maximum cohorts tracked at once (least-recently-seen evicted). Defaults to 2,000. */
  maxCohorts?: number;
  /** Maximum events retained per identity (oldest dropped by arrival; truncation is reported). Defaults to 100,000. */
  maxEventsPerIdentity?: number;
}

export interface LifecycleObservation {
  /**
   * `"recorded"` - the event entered the identity's history;
   * `"invalid_ts"` - non-finite or out-of-range timestamp,
   * refused before any state was touched.
   */
  status: "recorded" | "invalid_ts";
  /** Whether the event was counted. */
  counted: boolean;
  /** Total events retained for the identity after this event. */
  events: number;
}

/** Descriptive scores for one return point. There is deliberately no flag or verdict here. */
export interface LifecycleReturnPoint {
  /** Timestamp of the return event. */
  ts: number;
  /** The silence that ended at this return, in ms. */
  gapMs: number;
  /** rho: dormancy ratio = gap / observed age at the return. */
  dormancyRatio: number;
  /**
   * nu: burst velocity = novel output in the burst window after
   * the return / the identity's own mean per-window novel output
   * over its prior history. Null when the identity had no novel
   * output before the return (the lab's excluded case, counted in
   * `returnPointsExcluded`).
   */
  burstVelocity: number | null;
  /** Novel events before the return (ts <= previous event). */
  novelBefore: number;
  /** Novel events inside the burst window after the return. */
  novelAfter: number;
  /** Whether a staging-band touch exists inside the staging window; null when no staging band is declared. */
  stagingPresent: boolean | null;
  /** First staging touch inside the staging window, or null. */
  stagingFirstTs: number | null;
  /** Aligned UTC day index of that first staging touch, or null. */
  stagingDayIndex: number | null;
  /** Dominant-topic share of the burst window's novel output; null when no topic map is declared or the window is empty. */
  funnelShare: number | null;
  /** Descriptive region membership: rho >= dormancyRatioMin AND nu >= burstVelocityMin. NOT a flag. */
  inRegion: boolean;
  /**
   * Whether the full firing conjunction (staging AND nu AND
   * funnel) holds at this return point. Descriptive at identity
   * level; it becomes evidence only through the cohort's
   * same-day synchrony rule.
   */
  fires: boolean;
}

export interface LifecycleIdentityScores {
  kind: "lifecycle_identity_scores";
  identity: string;
  /** `"scored"` - history analysed; `"unknown"` - no events retained for this identity. */
  status: "scored" | "unknown";
  /** Events retained for the identity. */
  events: number;
  /** Every return point found, in time order. */
  returnPoints: LifecycleReturnPoint[];
  /** Return points excluded from nu (no novel output before them). */
  returnPointsExcluded: number;
  /** How many return points sit inside the descriptive region. NOT a flag count. */
  regionHits: number;
  /** Whether the retention cap dropped older events (scores are computed over the retained prefix-truncated history). */
  truncated: boolean;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface LifecycleCohortSignal {
  kind: "lifecycle_cohort";
  cohortId: string;
  /**
   * `"scored"` - the cohort rule ran; `"undeclared"` - the
   * staging band or the topic map was not declared, so the
   * cohort channel is off; `"insufficient_data"` - the cohort
   * has no known members.
   */
  status: "scored" | "undeclared" | "insufficient_data";
  /** True exactly when scored and some calendar day reached `minFiringMembers` distinct firing members. */
  flagged: boolean;
  /** Distinct member identities known in the cohort. */
  members: number;
  /** Members with at least one return point analysed. */
  membersWithReturnPoints: number;
  /** Largest same-day firing-member count found (0 when none fired). */
  maxFiringMembers: number;
  /** Aligned UTC day index of that largest firing day, or null. */
  firingDayIndex: number | null;
  /** Start (ms) of that day, or null. */
  firingDayStartMs: number | null;
  /** The firing members of that day (empty when none fired). */
  firingMembers: string[];
  /** The configured same-day threshold. */
  minFiringMembers: number;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface LifecycleSnapshot {
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  /** Whether the staging band is declared (predicate or id set). */
  stagingDeclared: boolean;
  /** Whether the topic map is declared. */
  topicDeclared: boolean;
  /** Whether the cohort channel can flag at all (both declarations present). */
  cohortChannelEnabled: boolean;
  identitiesTracked: number;
  cohortsTracked: number;
  counters: {
    /** Events accepted into an identity history. */
    recorded: number;
    /** Events refused for a non-finite or out-of-range timestamp. */
    invalidTs: number;
    /** Events dropped by per-identity retention caps. */
    droppedByCap: number;
  };
  notice: string;
}

export interface LifecycleCohortSignalInstance {
  /** Feed one serve event. */
  observe(event: LifecycleEvent): LifecycleObservation;
  /** Descriptive per-return-point scores for one identity. Never a flag. */
  evaluateIdentity(identity: string): LifecycleIdentityScores;
  /** The cohort synchrony signal for one host-declared cohort. */
  evaluateCohort(cohortId: string): LifecycleCohortSignal;
  /** State and declaration summary. */
  snapshot(): LifecycleSnapshot;
}

/** Named error thrown for every invalid lifecycle input. */
export class LifecycleCohortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleCohortError";
  }
}

const fail = (message: string): never => {
  throw new LifecycleCohortError(`createLifecycleCohortSignal: ${message}`);
};

function requireIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requirePositiveMs(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 8.64e15) {
    fail(`${field} must be a finite positive duration in ms`);
  }
  return value as number;
}

function requireShare(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    fail(`${field} must be a finite number in (0, 1]`);
  }
  return value as number;
}

function requireName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value as string;
}

function isValidTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8.64e15;
}

function isResourceId(value: unknown): value is LifecycleResourceId {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length > 0)
  );
}

/* ---------------- binary search over sorted ms arrays ---------------- */

function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ---------------- runtime state ---------------- */

interface RawEvent {
  ts: number;
  resourceId: LifecycleResourceId;
}

interface IdentityState {
  events: RawEvent[];
  dirty: boolean;
  truncated: boolean;
  analysis: LifecycleReturnPoint[] | null;
  excluded: number;
  lastSeen: number;
}

export function createLifecycleCohortSignal(
  options: CreateLifecycleCohortSignalOptions = {},
): LifecycleCohortSignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");

  const returnGapMs = requirePositiveMs(options.returnGapMs ?? 7 * DAY_MS, "returnGapMs");
  const stagingWindowMs = requirePositiveMs(options.stagingWindowMs ?? DAY_MS, "stagingWindowMs");
  const burstWindowMs = requirePositiveMs(options.burstWindowMs ?? 3 * DAY_MS, "burstWindowMs");
  const burstVelocityMin = options.burstVelocityMin ?? 4;
  if (typeof burstVelocityMin !== "number" || !Number.isFinite(burstVelocityMin) || burstVelocityMin <= 0) {
    fail("burstVelocityMin must be a finite number > 0");
  }
  const dormancyRatioMin = requireShare(options.dormancyRatioMin ?? 0.5, "dormancyRatioMin");
  const funnelShareMin = requireShare(options.funnelShareMin ?? 0.5, "funnelShareMin");
  const minFiringMembers = requireIntInRange(options.minFiringMembers ?? 6, "minFiringMembers", 1, 1_000_000);
  const maxIdentities = requireIntInRange(options.maxIdentities ?? 10_000, "maxIdentities", 1, 10_000_000);
  const maxCohorts = requireIntInRange(options.maxCohorts ?? 2_000, "maxCohorts", 1, 10_000_000);
  const maxEventsPerIdentity = requireIntInRange(
    options.maxEventsPerIdentity ?? 100_000,
    "maxEventsPerIdentity",
    1,
    100_000_000,
  );

  if (options.isStagingResource !== undefined && typeof options.isStagingResource !== "function") {
    fail("isStagingResource must be a function");
  }
  if (options.topicOf !== undefined && typeof options.topicOf !== "function") {
    fail("topicOf must be a function");
  }
  const stagingIds = new Set<LifecycleResourceId>();
  if (options.stagingResourceIds !== undefined) {
    if (!Array.isArray(options.stagingResourceIds)) fail("stagingResourceIds must be an array");
    for (const id of options.stagingResourceIds) {
      if (!isResourceId(id)) fail("stagingResourceIds entries must be finite numbers or non-empty strings");
      stagingIds.add(id);
    }
  }
  const stagingDeclared = options.isStagingResource !== undefined || stagingIds.size > 0;
  const topicDeclared = options.topicOf !== undefined;
  const cohortChannelEnabled = stagingDeclared && topicDeclared;

  const isStaging = (resourceId: LifecycleResourceId): boolean => {
    if (stagingIds.has(resourceId)) return true;
    if (options.isStagingResource) {
      try {
        return options.isStagingResource(resourceId) === true;
      } catch {
        return false; // A throwing host predicate reads as "not staging" (callback discipline).
      }
    }
    return false;
  };

  const identities = new Map<string, IdentityState>();
  const cohortMembers = new Map<string, Set<string>>();
  const cohortLastSeen = new Map<string, number>();
  const counters = { recorded: 0, invalidTs: 0, droppedByCap: 0 };
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
    const fresh: IdentityState = {
      events: [],
      dirty: true,
      truncated: false,
      analysis: null,
      excluded: 0,
      lastSeen: seq++,
    };
    identities.set(identity, fresh);
    return fresh;
  }

  function touchCohort(cohortId: string): Set<string> {
    const existing = cohortMembers.get(cohortId);
    if (existing) {
      cohortLastSeen.set(cohortId, seq++);
      cohortMembers.delete(cohortId);
      cohortMembers.set(cohortId, existing);
      return existing;
    }
    if (cohortMembers.size >= maxCohorts) {
      const oldest = cohortMembers.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        cohortMembers.delete(oldest);
        cohortLastSeen.delete(oldest);
      }
    }
    const fresh = new Set<string>();
    cohortMembers.set(cohortId, fresh);
    cohortLastSeen.set(cohortId, seq++);
    return fresh;
  }

  function observe(event: LifecycleEvent): LifecycleObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    requireName(event.identity, "event.identity");
    if (!isResourceId(event.resourceId)) {
      fail("event.resourceId must be a finite number or a non-empty string");
    }
    if (event.cohortId !== undefined) requireName(event.cohortId, "event.cohortId");
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      const state = identities.get(event.identity);
      return { status: "invalid_ts", counted: false, events: state ? state.events.length : 0 };
    }
    const state = touchIdentity(event.identity);
    state.events.push({ ts: event.ts, resourceId: event.resourceId });
    if (state.events.length > maxEventsPerIdentity) {
      state.events.splice(0, state.events.length - maxEventsPerIdentity);
      state.truncated = true;
      counters.droppedByCap++;
    }
    state.dirty = true;
    if (event.cohortId !== undefined) {
      touchCohort(event.cohortId).add(event.identity);
    }
    counters.recorded++;
    return { status: "recorded", counted: true, events: state.events.length };
  }

  /**
   * The frozen per-identity analysis (C23-STEP0 section 1): sort
   * the history, mark novel events, find return points, and read
   * rho / nu / staging / funnel at each.
   */
  function analyze(state: IdentityState): LifecycleReturnPoint[] {
    if (!state.dirty && state.analysis !== null) return state.analysis;
    const events = [...state.events].sort((a, b) => a.ts - b.ts);
    const n = events.length;
    const novelTs: number[] = [];
    const novelResources: LifecycleResourceId[] = [];
    const stagingTs: number[] = [];
    const seen = new Set<LifecycleResourceId>();
    for (const e of events) {
      if (!seen.has(e.resourceId)) {
        seen.add(e.resourceId);
        novelTs.push(e.ts);
        novelResources.push(e.resourceId);
      }
      if (stagingDeclared && isStaging(e.resourceId)) stagingTs.push(e.ts);
    }
    const points: LifecycleReturnPoint[] = [];
    let excluded = 0;
    if (n > 0) {
      const firstTs = events[0]!.ts;
      for (let k = 1; k < n; k++) {
        const tsK = events[k]!.ts;
        const tsPrev = events[k - 1]!.ts;
        const gap = tsK - tsPrev;
        if (gap < returnGapMs) continue;
        const novelBefore = upperBound(novelTs, tsPrev);
        const afterLo = lowerBound(novelTs, tsK);
        const afterHi = lowerBound(novelTs, tsK + burstWindowMs);
        const novelAfter = afterHi - afterLo;
        let burstVelocity: number | null = null;
        if (novelBefore === 0) {
          excluded++;
        } else {
          const spanBefore = tsPrev - firstTs;
          const baseline = novelBefore / Math.max(1, spanBefore / burstWindowMs);
          burstVelocity = novelAfter / baseline;
        }
        // Staging: first staging touch inside [tsK, tsK + stagingWindow).
        let stagingPresent: boolean | null = null;
        let stagingFirstTs: number | null = null;
        let stagingDayIndex: number | null = null;
        if (stagingDeclared) {
          const sLo = lowerBound(stagingTs, tsK);
          if (sLo < stagingTs.length && stagingTs[sLo]! < tsK + stagingWindowMs) {
            stagingPresent = true;
            stagingFirstTs = stagingTs[sLo]!;
            stagingDayIndex = Math.floor(stagingFirstTs / DAY_MS);
          } else {
            stagingPresent = false;
          }
        }
        // Funnel: dominant topic share of the burst window's novel output.
        let funnelShare: number | null = null;
        if (topicDeclared && novelAfter > 0) {
          const counts = new Map<string | number, number>();
          let degraded = false;
          for (let i = afterLo; i < afterHi; i++) {
            let topic: string | number;
            try {
              topic = options.topicOf!(novelResources[i]!);
            } catch {
              degraded = true;
              break;
            }
            counts.set(topic, (counts.get(topic) ?? 0) + 1);
          }
          if (!degraded) {
            let max = 0;
            for (const c of counts.values()) if (c > max) max = c;
            funnelShare = max / novelAfter;
          }
        }
        const inRegion =
          burstVelocity !== null &&
          gap / (tsK - firstTs) >= dormancyRatioMin &&
          burstVelocity >= burstVelocityMin;
        const fires =
          stagingPresent === true &&
          burstVelocity !== null &&
          burstVelocity >= burstVelocityMin &&
          funnelShare !== null &&
          funnelShare >= funnelShareMin;
        points.push({
          ts: tsK,
          gapMs: gap,
          dormancyRatio: gap / (tsK - firstTs),
          burstVelocity,
          novelBefore,
          novelAfter,
          stagingPresent,
          stagingFirstTs,
          stagingDayIndex,
          funnelShare,
          inRegion,
          fires,
        });
      }
    }
    state.analysis = points;
    state.excluded = excluded;
    state.dirty = false;
    return points;
  }

  function evaluateIdentity(identity: string): LifecycleIdentityScores {
    requireName(identity, "identity");
    const state = identities.get(identity);
    if (!state) {
      return {
        kind: "lifecycle_identity_scores",
        identity,
        status: "unknown",
        events: 0,
        returnPoints: [],
        returnPointsExcluded: 0,
        regionHits: 0,
        truncated: false,
        enforcement: "none",
        notice: IDENTITY_NOTICE,
      };
    }
    const points = analyze(state);
    return {
      kind: "lifecycle_identity_scores",
      identity,
      status: "scored",
      events: state.events.length,
      returnPoints: points,
      returnPointsExcluded: state.excluded,
      regionHits: points.filter((p) => p.inRegion).length,
      truncated: state.truncated,
      enforcement: "none",
      notice: IDENTITY_NOTICE,
    };
  }

  function evaluateCohort(cohortId: string): LifecycleCohortSignal {
    requireName(cohortId, "cohortId");
    const members = cohortMembers.get(cohortId);
    const base = {
      kind: "lifecycle_cohort" as const,
      cohortId,
      minFiringMembers,
      enforcement: "none" as const,
      notice: ADVISORY_NOTICE,
    };
    if (!members || members.size === 0) {
      return {
        ...base,
        status: "insufficient_data",
        flagged: false,
        members: 0,
        membersWithReturnPoints: 0,
        maxFiringMembers: 0,
        firingDayIndex: null,
        firingDayStartMs: null,
        firingMembers: [],
      };
    }
    if (!cohortChannelEnabled) {
      return {
        ...base,
        status: "undeclared",
        flagged: false,
        members: members.size,
        membersWithReturnPoints: 0,
        maxFiringMembers: 0,
        firingDayIndex: null,
        firingDayStartMs: null,
        firingMembers: [],
        notice:
          "Cohort channel off: the staging band and the topic map must both be host-declared " +
          "before the cohort rule can fire (hard condition 1). Identity scores remain available.",
      };
    }
    const byDay = new Map<number, Set<string>>();
    let membersWithReturnPoints = 0;
    for (const member of members) {
      const state = identities.get(member);
      if (!state) continue;
      const points = analyze(state);
      if (points.length > 0) membersWithReturnPoints++;
      for (const point of points) {
        if (!point.fires || point.stagingDayIndex === null) continue;
        let set = byDay.get(point.stagingDayIndex);
        if (!set) {
          set = new Set();
          byDay.set(point.stagingDayIndex, set);
        }
        set.add(member);
      }
    }
    let bestDay: number | null = null;
    let bestSet: Set<string> = new Set();
    for (const [day, set] of byDay) {
      if (set.size > bestSet.size) {
        bestDay = day;
        bestSet = set;
      }
    }
    return {
      ...base,
      status: "scored",
      flagged: bestSet.size >= minFiringMembers,
      members: members.size,
      membersWithReturnPoints,
      maxFiringMembers: bestSet.size,
      firingDayIndex: bestDay,
      firingDayStartMs: bestDay === null ? null : bestDay * DAY_MS,
      firingMembers: [...bestSet].sort(),
    };
  }

  function snapshot(): LifecycleSnapshot {
    return {
      enforcement: "none",
      stagingDeclared,
      topicDeclared,
      cohortChannelEnabled,
      identitiesTracked: identities.size,
      cohortsTracked: cohortMembers.size,
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  return { observe, evaluateIdentity, evaluateCohort, snapshot };
}
