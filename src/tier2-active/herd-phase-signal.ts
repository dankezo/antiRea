/**
 * Herd-phase signal (HARVEST candidate H7-01 KURAMOTO PHASE-LOCK,
 * lab PASS at Step 1 - see the study lab's H7-01-STEP1-REGISTRATION.md
 * and H7-01-STEP1-RESULTS.md - plus the live-room adaptation pin,
 * roomguard-lab/REGISTRATION-ROOMGUARD.md and ROOMGUARD-RESULTS.md,
 * which re-validated the same law on room-JOIN event streams).
 *
 * WHAT IT MEASURES. A fleet of bots driven by ONE scheduler does not
 * just act often - it acts IN PHASE. Feed this module one kind of
 * repeated event timestamp per identity (session starts, room joins,
 * reconnects: one homogeneous stream). For each identity with at
 * least `minEvents` events it computes the Kuramoto mean resultant
 * R_i of the event phases on a `periodSec` grid (default 900 s, the
 * only lab-validated period). R_i alone only proves an identity is
 * locked to SOME grid - Step 0 of the lab showed an independent herd
 * (each member on its OWN grid offset) separates from ordinary users
 * exactly as cleanly as a shared-grid herd does. The cohort statistic
 * is therefore mandatory, not decoration: R_cohort is the mean
 * resultant of the per-identity MEAN PHASES over every scored
 * identity in the cohort, and the cohort is confirmed as one shared
 * scheduler iff at least `minMembers` identities are members
 * (R_i >= memberThreshold) AND R_cohort >= cohortThreshold.
 *
 * THE FROZEN LAB LAW, translated without re-invention:
 * - phase of an event at ts (ms): 2*pi * ((ts mod period) / period),
 *   period = periodSec * 1000 ms; T = 900 s is the ONLY period the
 *   lab validated (T = 3600 was forbidden as a gate at Step 0).
 * - an identity is scored only with >= 8 events (lab floor).
 * - member iff R_i >= tau_R = 0.90 (Step 0 gap: legit p99 0.6495,
 *   shared-herd p05 0.9616 - 0.90 sits inside the measured gap).
 * - cohort confirmed iff members >= 10 AND R_cohort >= tau_C = 0.80
 *   (analytic expectations locked before the Step 1 run: shared
 *   herd ~0.98, independent/legit ~0.10).
 * - members are NAMED only when their cohort is confirmed. An
 *   unconfirmed cohort reports a member COUNT (descriptive) and an
 *   empty member list: grid-locked individuals are not evidence
 *   about anyone until the shared-offset test passes.
 *
 * WHAT THE LABS MEASURED (all simulation, seeded harness streams;
 * internal validity only - NOT real-traffic performance):
 * - H7-01 Step 1 (harness-v2 session starts, fresh seeds): shared
 *   herd confirmed - 86/86 members, recall 1.000, R_cohort 0.9977;
 *   independent herd NOT confirmed (88 members by R_i, R_cohort
 *   0.0794 - the cohort leg is what saves it); false-positive member
 *   rate 0/86 (VALID), 0/96 (SALE burst), 0/85 (NAT-GROUP-DIRECT,
 *   the hard office-hours null) against the locked 1% budget;
 *   bootstrap separation B1 overlap 0.0000 against the 0.50 bar.
 * - Roomguard pin (seeded room-join streams, cohort scoped to
 *   identities first seen within 24 h of evaluation): a 60-bot
 *   rejoin herd on a shared 900 s grid confirmed (60/60 members,
 *   R_cohort 0.9978); the same herd on per-identity grid offsets
 *   NOT confirmed (R_cohort 0.0421); four legitimate room cells
 *   (steady viewing, a 50-user raid after an external link drop, a
 *   60-user scheduled showtime join, karaoke prime time) produced
 *   no confirmation and no scored scoped identities at all.
 *
 * HARD LIMITS - registered in the labs, restated as contract:
 * - ADVISORY ONLY: `enforcement: "none"` on every output. A
 *   confirmed cohort is evidence for the host's accumulator /
 *   step-up decisions, never a block list by itself.
 * - ONE scheduler period: 900 s is the only validated grid.
 *   Schedulers on 60 s / 3,600 s / daily cron are unmeasured; a
 *   host that changes `periodSec` leaves the lab record behind.
 * - The lab's legitimate populations are ONE generator family
 *   (harness-v2) plus the roomguard sim: real legitimate
 *   subpopulations with their own fixed machine schedules
 *   (personal cron jobs, scheduled polls, office fleets starting
 *   on the hour) are NOT in those pools, so the false-positive
 *   rate on such groups is unmeasured. That is exactly why the
 *   cohort leg and the members-only-on-confirmation rule exist.
 * - An adaptive herd that randomises its grid offset per identity
 *   (the INDEP shape) is invisible to the confirmation law BY
 *   DESIGN: the module refuses to trade the false-flag protection
 *   for that coverage.
 * - The statistic needs repetition: an identity with fewer than
 *   `minEvents` events is never scored, so one-shot floods (each
 *   bot acts once) are structurally out of scope - that shape
 *   belongs to metering / budget layers, not to this signal.
 *
 * FEEDING AND SCOPING. `observe({ identity, ts })` records one
 * event timestamp. The COHORT is the population the host chooses
 * to evaluate together: run one instance per room / per surface,
 * or pass `cohortWindowMs` to `evaluate` to score only identities
 * first seen within a trailing window before `asOfTs` (the
 * roomguard pin's validated scoping for room joins: 24 h). Mixing
 * unrelated populations into one cohort dilutes R_cohort and is
 * the host's error to avoid - the module cannot know the host's
 * cohort semantics.
 *
 * Pure computation: no I/O, no runtime dependencies. State is a
 * bounded in-memory map of per-identity event timestamps: the
 * least recently fed identities are evicted past `maxIdentities`,
 * and each identity keeps at most `maxEventsPerIdentity` events
 * (oldest dropped), both counters reported in the snapshot.
 */

const DAY_MS = 86_400_000;

/** Default scheduler period: 900 s, the only lab-validated grid. */
const DEFAULT_PERIOD_SEC = 900;
/** Lab member threshold tau_R (H7-01 Step 1, frozen from Step 0 numbers). */
const DEFAULT_MEMBER_THRESHOLD = 0.9;
/** Lab cohort threshold tau_C (H7-01 Step 1, frozen analytic gap). */
const DEFAULT_COHORT_THRESHOLD = 0.8;
/** Lab scoring floor: an identity needs at least this many events. */
const DEFAULT_MIN_EVENTS = 8;
/** Lab confirmation floor: at least this many members. */
const DEFAULT_MIN_MEMBERS = 10;

const ADVISORY_NOTICE =
  "Advisory telemetry only (enforcement: none): Kuramoto phase-lock statistics over one " +
  "homogeneous event stream per identity - a cohort is confirmed as sharing one scheduler " +
  "only when at least minMembers identities are grid-locked members (R_i >= memberThreshold) " +
  "AND the cohort mean-phase resultant R_cohort >= cohortThreshold; members are named only " +
  "on confirmation. Grid-lock alone (an independent herd, a personal cron) is not evidence. " +
  "All lab numbers are seeded simulation (H7-01 Step 1; roomguard room-join pin), the only " +
  "validated scheduler period is 900 s, and legitimate groups with their own fixed machine " +
  "schedules were not in the lab populations - never use this signal as the sole basis for " +
  "any consequence.";

export interface HerdPhaseEvent {
  /** The authenticated identity the event belongs to. */
  identity: string;
  /** Millisecond timestamp of the event (one homogeneous stream: joins, session starts, ...). */
  ts: number;
}

export interface CreateHerdPhaseSignalOptions {
  /**
   * Scheduler grid period in seconds. Default 900 - the ONLY
   * period with a lab record behind it (H7-01 Step 0 forbade
   * 3,600 s as a gate; other periods are unmeasured). Changing it
   * leaves the frozen lab law behind; the thresholds do not
   * transfer automatically.
   */
  periodSec?: number;
  /** Member threshold tau_R on R_i. Default 0.90 (lab-frozen). Must be in (0, 1]. */
  memberThreshold?: number;
  /** Cohort threshold tau_C on R_cohort. Default 0.80 (lab-frozen). Must be in (0, 1]. */
  cohortThreshold?: number;
  /** Events an identity needs before it is scored. Default 8 (lab floor). */
  minEvents?: number;
  /** Members a cohort needs before it can confirm. Default 10 (lab law). */
  minMembers?: number;
  /** Maximum identities tracked at once (least recently fed evicted). Defaults to 100,000. */
  maxIdentities?: number;
  /** Maximum event timestamps kept per identity (oldest dropped). Defaults to 4,096; must be >= minEvents. */
  maxEventsPerIdentity?: number;
}

export interface HerdPhaseObservation {
  /**
   * `"recorded"` - the event entered the identity's stream;
   * `"invalid_ts"` - non-finite or out-of-range timestamp,
   * refused before any state was touched.
   */
  status: "recorded" | "invalid_ts";
  /** Whether the event was stored. */
  counted: boolean;
  /** The identity's stored event total after this call, when recorded. */
  eventsTotal?: number;
}

export interface HerdPhaseEvaluateOptions {
  /**
   * Only events with ts <= asOfTs are scored, and identity first
   * sight is measured on those events. Defaults to no cutoff
   * (every stored event).
   */
  asOfTs?: number;
  /**
   * Cohort scoping: score only identities whose first event (at
   * or before the reference point) is within this many ms before
   * the reference point (asOfTs when given, else the latest
   * stored event). The roomguard pin validated 24 h
   * (86,400,000 ms) for room joins. Defaults to no scoping -
   * every tracked identity is in the cohort (the H7-01 form).
   */
  cohortWindowMs?: number;
}

export interface HerdPhaseResult {
  kind: "herd-phase";
  /**
   * `"scored"` - at least one identity in the cohort met the
   * event floor and the statistics ran; `"insufficient_population"`
   * - no identity in scope met the floor, so nothing was scored.
   */
  status: "scored" | "insufficient_population";
  /** True iff members >= minMembers AND R_cohort >= cohortThreshold. */
  confirmed: boolean;
  /** Identities in the cohort scope (after cohortWindowMs, when given). */
  cohortIdentities: number;
  /** Identities that met the minEvents floor and were scored. */
  scoredIdentities: number;
  /** Scored identities with R_i >= memberThreshold (descriptive count, confirmed or not). */
  memberCount: number;
  /**
   * The member identities, named ONLY when the cohort is
   * confirmed (the lab law: no flagged members without a
   * confirmed cohort). Empty whenever `confirmed` is false.
   * Sorted, so evaluation is a deterministic function of state.
   */
  members: string[];
  /** Mean resultant of the scored identities' mean phases, or null when nothing was scored. */
  cohortR: number | null;
  /** The cohort's mean phase in radians (-pi, pi], or null when nothing was scored. Descriptive. */
  meanPhaseRad: number | null;
  /** The grid period the statistics ran on, in seconds. */
  periodSec: number;
  /** Always `"none"`: this module enforces nothing, about anyone. */
  enforcement: "none";
  notice: string;
}

export interface HerdPhaseSnapshot {
  /** Always `"none"`: this module enforces nothing, about anyone. */
  enforcement: "none";
  periodSec: number;
  memberThreshold: number;
  cohortThreshold: number;
  minEvents: number;
  minMembers: number;
  /** Identities currently tracked. */
  identities: number;
  /** Event timestamps currently stored across all identities. */
  events: number;
  counters: {
    /** Events fed through `observe`. */
    observed: number;
    /** Events refused for a non-finite or out-of-range timestamp. */
    invalidTs: number;
    /** Identities evicted past `maxIdentities`. */
    evictedIdentities: number;
    /** Stored events dropped past `maxEventsPerIdentity` (per identity, oldest first). */
    truncatedEvents: number;
  };
  notice: string;
}

export interface HerdPhaseSignalInstance {
  /** Feed one event timestamp for one identity. */
  observe(event: HerdPhaseEvent): HerdPhaseObservation;
  /** Run the frozen herd-phase law over the cohort observed so far. */
  evaluate(options?: HerdPhaseEvaluateOptions): HerdPhaseResult;
  /** State summary: population size, feed counters, configuration. */
  snapshot(): HerdPhaseSnapshot;
}

/** Named error thrown for every invalid herd-phase input. */
export class HerdPhaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdPhaseError";
  }
}

const fail = (message: string): never => {
  throw new HerdPhaseError(`createHerdPhaseSignal: ${message}`);
};

function requireIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requireThreshold(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    fail(`${field} must be a finite number in (0, 1]`);
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

export function createHerdPhaseSignal(
  options: CreateHerdPhaseSignalOptions = {},
): HerdPhaseSignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");

  const periodSec = requireIntInRange(options.periodSec ?? DEFAULT_PERIOD_SEC, "periodSec", 1, 7 * 24 * 3600);
  const memberThreshold = requireThreshold(options.memberThreshold ?? DEFAULT_MEMBER_THRESHOLD, "memberThreshold");
  const cohortThreshold = requireThreshold(options.cohortThreshold ?? DEFAULT_COHORT_THRESHOLD, "cohortThreshold");
  const minEvents = requireIntInRange(options.minEvents ?? DEFAULT_MIN_EVENTS, "minEvents", 2, 100_000);
  const minMembers = requireIntInRange(options.minMembers ?? DEFAULT_MIN_MEMBERS, "minMembers", 1, 1_000_000);
  const maxIdentities = requireIntInRange(options.maxIdentities ?? 100_000, "maxIdentities", 1, 10_000_000);
  const maxEventsPerIdentity = requireIntInRange(
    options.maxEventsPerIdentity ?? 4_096,
    "maxEventsPerIdentity",
    minEvents,
    1_000_000,
  );

  const periodMs = periodSec * 1000;
  const streams = new Map<string, number[]>();
  const counters = { observed: 0, invalidTs: 0, evictedIdentities: 0, truncatedEvents: 0 };
  let totalEvents = 0;
  let latestTs = -Infinity;

  function evictOldest(): void {
    const oldest = streams.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    totalEvents -= (streams.get(oldest) as number[]).length;
    streams.delete(oldest);
    counters.evictedIdentities++;
  }

  function observe(event: HerdPhaseEvent): HerdPhaseObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    const identity = requireIdentity(event.identity, "event.identity");
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      return { status: "invalid_ts", counted: false };
    }
    counters.observed++;
    let list = streams.get(identity);
    if (list) {
      // Refresh recency so eviction drops the least recently fed identities.
      streams.delete(identity);
      streams.set(identity, list);
    } else {
      while (streams.size >= maxIdentities) evictOldest();
      list = [];
      streams.set(identity, list);
    }
    list.push(event.ts);
    totalEvents++;
    if (event.ts > latestTs) latestTs = event.ts;
    if (list.length > maxEventsPerIdentity) {
      const excess = list.length - maxEventsPerIdentity;
      list.splice(0, excess);
      totalEvents -= excess;
      counters.truncatedEvents += excess;
    }
    return { status: "recorded", counted: true, eventsTotal: list.length };
  }

  function evaluate(evaluateOptions: HerdPhaseEvaluateOptions = {}): HerdPhaseResult {
    if (typeof evaluateOptions !== "object" || evaluateOptions === null) {
      fail("evaluate options must be an object");
    }
    const asOfTs = evaluateOptions.asOfTs;
    if (asOfTs !== undefined && !isValidTs(asOfTs)) {
      fail("asOfTs must be a finite timestamp within the representable range");
    }
    const cohortWindowMs = evaluateOptions.cohortWindowMs;
    if (
      cohortWindowMs !== undefined &&
      (typeof cohortWindowMs !== "number" || !Number.isFinite(cohortWindowMs) || cohortWindowMs <= 0)
    ) {
      fail("cohortWindowMs must be a positive finite number of milliseconds");
    }
    const referenceTs = asOfTs !== undefined ? asOfTs : latestTs;
    const base = {
      kind: "herd-phase" as const,
      periodSec,
      enforcement: "none" as const,
      notice: ADVISORY_NOTICE,
    };

    let cohortIdentities = 0;
    let scoredIdentities = 0;
    let memberCount = 0;
    const memberIds: string[] = [];
    let sumRe = 0;
    let sumIm = 0;

    for (const [identity, stored] of streams) {
      // Events in scope: stored, and at or before asOfTs when given.
      let firstSeen = Infinity;
      let count = 0;
      let re = 0;
      let im = 0;
      for (const ts of stored) {
        if (asOfTs !== undefined && ts > asOfTs) continue;
        if (ts < firstSeen) firstSeen = ts;
        count++;
        const phase = 2 * Math.PI * ((((ts % periodMs) + periodMs) % periodMs) / periodMs);
        re += Math.cos(phase);
        im += Math.sin(phase);
      }
      if (count === 0) continue;
      if (cohortWindowMs !== undefined && referenceTs - firstSeen >= cohortWindowMs) continue;
      cohortIdentities++;
      if (count < minEvents) continue;
      scoredIdentities++;
      const ri = Math.hypot(re, im) / count;
      // The lab's R_cohort averages UNIT vectors at each identity's
      // mean phase - explicitly NOT weighted by R_i and NOT weighted
      // by event count (H7-01 Step 1 registration, section 1).
      const phiBar = Math.atan2(im, re);
      sumRe += Math.cos(phiBar);
      sumIm += Math.sin(phiBar);
      if (ri >= memberThreshold) {
        memberCount++;
        memberIds.push(identity);
      }
    }

    if (scoredIdentities === 0) {
      return {
        ...base,
        status: "insufficient_population",
        confirmed: false,
        cohortIdentities,
        scoredIdentities: 0,
        memberCount: 0,
        members: [],
        cohortR: null,
        meanPhaseRad: null,
      };
    }
    const cohortR = Math.hypot(sumRe, sumIm) / scoredIdentities;
    const meanPhaseRad = Math.atan2(sumIm, sumRe);
    const confirmed = memberCount >= minMembers && cohortR >= cohortThreshold;
    return {
      ...base,
      status: "scored",
      confirmed,
      cohortIdentities,
      scoredIdentities,
      memberCount,
      members: confirmed ? memberIds.sort() : [],
      cohortR,
      meanPhaseRad,
    };
  }

  function snapshot(): HerdPhaseSnapshot {
    return {
      enforcement: "none",
      periodSec,
      memberThreshold,
      cohortThreshold,
      minEvents,
      minMembers,
      identities: streams.size,
      events: totalEvents,
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  return { observe, evaluate, snapshot };
}

/** The roomguard pin's validated cohort window for room joins: 24 h in ms. */
export const HERD_PHASE_ROOM_COHORT_WINDOW_MS = DAY_MS;
