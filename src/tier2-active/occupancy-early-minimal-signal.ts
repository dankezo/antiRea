/**
 * Early-minimal seat-occupancy signal (candidate A1-COUNTER-D2,
 * lab registration attack-a1-lab/REGISTRATION-A1-COUNTER-D2.md,
 * measured cycle C448, results in attack-a1-lab/RESULTS-D2.md,
 * verdict PASS-lab on the frozen registered seeds).
 *
 * WHY THIS MODULE EXISTS. The shipped seat-occupancy laws
 * (createSeatOccupancySignal, CAND-273-1/273-2) read seats held by
 * new identities that have emitted ZERO activity. Attack A1
 * (measured C446, verdict XUYEN) showed the evasion: a squatter
 * that emits just 1-2 activity events escapes both shipped laws,
 * because the first activity ends its "idle" status long before
 * either sustain can complete. The first counter, D1
 * (occupancyNewMinimal: new identities with at most 2 activities
 * so far, regardless of timing), caught every squat shape in C447
 * but ALSO flagged a legitimate population of quiet new users
 * (verdict ADVISORY): a new lurker who posts once or twice and
 * then just holds a seat is indistinguishable from a squatter
 * under D1's estimand. D2 is the patch: it keeps D1's 1-2 activity
 * band and adds the one axis that separated the two populations
 * in the lab - WHERE in the session the activities land. A
 * squatter's activities are early by necessity (their purpose is
 * to break new-idle before the shipped laws' sustain completes);
 * a lurker's are spread with no deadline.
 *
 * WHAT IT MEASURES (the frozen estimand, ported from the lab
 * runner, not re-invented):
 *
 *   occupancyNewEarlyMinimal(t) = (sessions holding a seat at t
 *   whose identity was created less than `newnessWindowMs`
 *   (default 24 h) before the session's join, whose activity
 *   count SO FAR is in [1, 2], AND whose every activity so far
 *   happened within `earlyWindowMs` (default 300 s) after join)
 *   / room capacity.
 *
 * Per session the counting interval is exactly the runner's:
 * [firstActivityTs, min(leaveTs, 3rd-activity-ts,
 * first-activity-ts-after-join+earlyWindow)). A session with 0
 * activities never counts (the shipped laws own that shape); a
 * session whose first activity is late never counts; an activity
 * stamped exactly at join + earlyWindow counts as early (the
 * registration's <= boundary). Activities are read on the
 * (join, t] convention, as in the lab.
 *
 * LAWS (frozen geometry, mirroring the shipped profiles - only
 * the estimand changed): a law flags when the ratio stays at or
 * above its threshold continuously for its sustainMs.
 * - FAST (default law "fast"): threshold 0.50, sustain 600 s.
 * - DRIP (default law "drip"): threshold 0.34, sustain 3,600 s.
 * One instance computes both laws over one event store; a host
 * may configure a different law set via `laws`.
 *
 * WHAT THE LAB MEASURED (seeded simulation, karaoke capacity 30,
 * cycle C448; internal validity only - NOT real-traffic
 * performance):
 * - CT-FAST-1 and CT-FAST-2 (30 fresh squatters, 1-2 activities
 *   inside 60 s) flagged by the FAST law 690 s after bot start;
 *   CT-DELAY-300 (first activity exactly at join+300 s) flagged
 *   at 960 s; CT-DRIP-1 (1 join per 60 s, 1 activity at join+60 s)
 *   flagged by the FAST law at 1,440 s. All inside their frozen
 *   gates (P-G1, P-G2).
 * - Legitimate twins (karaoke prime time, silent-audience cell,
 *   50-user raid into the 100-seat main room) never flagged over
 *   7 simulated days; their early-minimal ratio peaked at 0.10 /
 *   0.10 / 0.02 (P-G3).
 * - The decision gate P-G4: the legitimate new-lurker population
 *   (30 new identities joining 1 per 60 s, 0-2 activities spread
 *   uniformly over their first 600 s, seats held 7,200 s) was
 *   flagged by NEITHER law.
 * - CT-ADAPT-3 (3 quick activities) reached a transient ratio of
 *   0.90 but never sustained it - the sustain requirement is
 *   load-bearing; a naive max-ratio check would false-positive
 *   there.
 *
 * HONEST LIMITS (from RESULTS-D2.md - do not soften these):
 * - THIN MARGIN ON THE LURKER GATE. P-G4 passed with exactly ONE
 *   session of headroom: the lurker population's ratio peaked at
 *   0.3333 (10 of 30 seats) against the DRIP threshold 0.34, and
 *   sat at or above 0.30 for 5,460 s continuously. PASS-lab is
 *   the verdict under the frozen binary rule on THESE seeds; on
 *   another seed draw one more early lurker session would flip
 *   the verdict to ADVISORY. The margin is measured, and it is
 *   thin - it is not a robust separation claim.
 * - KNOWN RESIDUAL GAP BY DESIGN. A squat whose first activity
 *   lands in the delay band (300 s, ~630 s) after joining evades
 *   BOTH D2 laws: the measured cells CT-DELAY-450 and
 *   CT-DELAY-600 evaded every shipped law and both D2 laws. (In
 *   the lab the D1 estimand covered that band, but D1 is the
 *   ADVISORY candidate that flags lurkers - it is not shipped
 *   here.) This signal COMPLEMENTS the shipped seat-occupancy
 *   laws; it does not replace them, and the pair still leaves
 *   the (300 s, ~630 s) band open.
 * - KNOWN CEILING. A squat emitting 3 quick activities
 *   (CT-ADAPT-3) evades by construction: the session leaves the
 *   numerator at its 3rd activity. That is the estimand's known
 *   ceiling, declared in the registration before measurement.
 * - ADVISORY ONLY: `enforcement: "none"` on every output, and
 *   `onEvidence` is a notification, never a consequence basis.
 *   This is a POPULATION signal in the createSeatOccupancySignal
 *   family: it describes a room, never an identity. There is no
 *   per-identity output and no identity-level API.
 *
 * FEEDING. One instance per room. Feed `join` / `leave` /
 * `activity` events with the identity and a millisecond ts; pass
 * `accountCreatedTs` on joins when the host knows it - otherwise
 * the identity's first observed event stands in for its creation
 * time. `evaluate` reconstructs the ratio exactly: it changes
 * only at event boundaries (a session's counting interval starts
 * and ends at activity or leave timestamps), so the sustained-run
 * computation over the stored history is exact, not sampled. (The
 * lab runner computed the same ratio on a 30 s tick grid; the
 * boundary-exact form here is the same port the shipped
 * seat-occupancy signal uses.) `onEvidence` fires from
 * `evaluate` - once per law, when that law's flag is first
 * observed complete - so hosts should evaluate on their room
 * tick, exactly as with createSeatOccupancySignal.
 *
 * Pure computation: no I/O, no runtime dependencies. State is a
 * bounded list of sessions (open and closed); past `maxSessions`,
 * the oldest CLOSED sessions are evicted and the sustain history
 * before them is forgotten (counted in the snapshot). If all retained
 * sessions are open, new joins are refused as telemetry capacity
 * exhaustion, never as an access-control decision. Only the three
 * earliest post-join activities are retained per session. First-seen
 * metadata is retained only while an identity has retained sessions.
 */

const DAY_MS = 86_400_000;

const DEFAULT_EARLY_WINDOW_MS = 300_000;
const DEFAULT_NEWNESS_WINDOW_MS = DAY_MS;

const ADVISORY_NOTICE =
  "Advisory telemetry only (enforcement: none): population early-minimal seat-occupancy ratio - " +
  "the share of a room's capacity held by sessions of identities created within the newness " +
  "window (24 h by default) before joining that have emitted 1-2 activities so far, every one " +
  "of them within the early window (300 s by default) after joining; each law flags when the " +
  "ratio stays at or above its threshold continuously for its sustainMs. This is a room state, " +
  "never an identity verdict: no output names an identity, and a flag is never an enforcement " +
  "basis by itself. PASS-lab on the frozen registered seeds (A1-COUNTER-D2, cycle C448) came " +
  "with exactly ONE session of headroom on the lurker gate: the legitimate new-lurker " +
  "population peaked at ratio 0.3333 (10 of 30 seats) against the drip threshold 0.34, so on " +
  "another seed draw the verdict would degrade to ADVISORY. Known residual gap by design: a " +
  "squat whose first activity lands in the delay band (300 s, ~630 s) after joining evades " +
  "both laws (measured cells CT-DELAY-450 and CT-DELAY-600); this signal complements the " +
  "shipped seat-occupancy laws, it does not replace them. A squat emitting 3 quick activities " +
  "(CT-ADAPT-3) evades by construction - the estimand's known ceiling. All lab numbers are " +
  "seeded simulation, not real-traffic performance.";

export interface OccupancyEarlyMinimalEvent {
  type: "join" | "leave" | "activity";
  /** The authenticated identity the event belongs to. */
  identity: string;
  /** Millisecond timestamp of the event. */
  ts: number;
  /**
   * Account creation time (ms), when the host knows it. Used on
   * `join` events; without it, the identity's first observed event
   * stands in for creation time.
   */
  accountCreatedTs?: number;
}

export interface OccupancyEarlyMinimalLawOptions {
  /** Law name, reported on results and evidence. Defaults to "fast" / "drip" for the shipped pair, else "law-N". */
  name?: string;
  /** Flag threshold on the early-minimal occupancy ratio. Must be in (0, 1]. */
  threshold?: number;
  /** How long the ratio must stay at/above threshold, in ms. */
  sustainMs?: number;
}

export interface CreateOccupancyEarlyMinimalSignalOptions {
  /** Room capacity in seats. Required; the ratio's denominator. */
  capacity: number;
  /**
   * Laws to evaluate over the shared estimand. Default: the two
   * lab-frozen laws (FAST 0.50 / 600 s and DRIP 0.34 / 3,600 s).
   * Names must be unique within the instance.
   */
  laws?: readonly OccupancyEarlyMinimalLawOptions[];
  /** An activity counts as early when it lands at most this many ms after the join. Default 300,000 (300 s, lab-frozen EARLY_WINDOW). */
  earlyWindowMs?: number;
  /** An identity counts as new for a session when it was created less than this many ms before the join. Default 86,400,000 (24 h, lab law). */
  newnessWindowMs?: number;
  /** Maximum sessions retained (open + closed). Evict closed sessions first; refuse new telemetry if all are open. Default 100,000. */
  maxSessions?: number;
  /** Fired once per law when `evaluate` first observes that law's flag complete. Errors are swallowed. */
  onEvidence?: (event: OccupancyEarlyMinimalEvidenceEvent) => Promise<void> | void;
}

export interface OccupancyEarlyMinimalObservation {
  /** Telemetry acceptance only; capacity exhaustion never blocks a host request. */
  status: "recorded" | "invalid_ts" | "capacity_exceeded";
  counted: boolean;
}

export interface OccupancyEarlyMinimalEvaluateOptions {
  /** Evaluate the room state at this ms timestamp. Defaults to the latest observed event. */
  asOfTs?: number;
}

export interface OccupancyEarlyMinimalLawResult {
  name: string;
  threshold: number;
  sustainMs: number;
  /** True when the ratio has stayed >= threshold for sustainMs at some point up to asOfTs. */
  flagged: boolean;
  /** When the flag first completed its sustain run (ms), or null when never flagged. */
  firstFlagTs: number | null;
}

export interface OccupancyEarlyMinimalResult {
  kind: "occupancy-early-minimal";
  /** True after capacity loss; confirmations are suppressed until reset. */
  saturated: boolean;
  /** True when any configured law has flagged. */
  flagged: boolean;
  /** Per-law outcomes, in configuration order. */
  laws: OccupancyEarlyMinimalLawResult[];
  /** The early-minimal occupancy ratio at asOfTs. */
  currentRatio: number;
  /** Seats held at asOfTs by sessions inside their counting interval. */
  earlyMinimalSeats: number;
  /** All seats held at asOfTs (any identity, any activity). */
  holders: number;
  capacity: number;
  earlyWindowMs: number;
  /** Always `"none"`: this module enforces nothing, about anyone. */
  enforcement: "none";
  notice: string;
}

export interface OccupancyEarlyMinimalEvidenceEvent {
  /** The law that flagged ("fast" / "drip" for the shipped pair). */
  law: string;
  threshold: number;
  sustainMs: number;
  /** When the flag completed its sustain run (ms). */
  firstFlagTs: number;
  /** The early-minimal occupancy ratio at the evaluating asOfTs. */
  currentRatio: number;
  earlyMinimalSeats: number;
  capacity: number;
  /** ISO time derived from firstFlagTs. */
  timestamp: string;
}

export interface OccupancyEarlyMinimalSnapshot {
  enforcement: "none";
  capacity: number;
  earlyWindowMs: number;
  laws: { name: string; threshold: number; sustainMs: number }[];
  /** Sessions currently retained (open + closed). */
  sessions: number;
  /** Sessions currently open. */
  openSessions: number;
  saturated: boolean;
  trackedIdentities: number;
  /** Total stored activity timestamps, bounded by three per retained session. */
  retainedActivityTimestamps: number;
  counters: {
    observed: number;
    invalidTs: number;
    /** Closed sessions evicted past maxSessions (sustain history before them is forgotten). */
    evictedSessions: number;
    /** leave/activity events with no open session to attach to. */
    orphanEvents: number;
    /** Joins refused because the bounded telemetry store contained only open sessions. */
    rejectedSessions: number;
  };
  notice: string;
}

export interface OccupancyEarlyMinimalSignalInstance {
  observe(event: OccupancyEarlyMinimalEvent): OccupancyEarlyMinimalObservation;
  evaluate(options?: OccupancyEarlyMinimalEvaluateOptions): OccupancyEarlyMinimalResult;
  snapshot(): OccupancyEarlyMinimalSnapshot;
  /** Drop all session state and re-arm every law's evidence transition. */
  reset(): void;
}

/** Named error thrown for every invalid early-minimal input. */
export class OccupancyEarlyMinimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OccupancyEarlyMinimalError";
  }
}

/** The lab-frozen EARLY_WINDOW (registration section 2): 300 s after join. */
export const OCCUPANCY_EARLY_MINIMAL_EARLY_WINDOW_MS = DEFAULT_EARLY_WINDOW_MS;
/** The lab-frozen newness window: identity created less than 24 h before the join. */
export const OCCUPANCY_EARLY_MINIMAL_NEWNESS_WINDOW_MS = DEFAULT_NEWNESS_WINDOW_MS;
/** The lab-frozen D2-FAST law (A1-COUNTER-D2): ratio >= 0.50 sustained 600 s. */
export const OCCUPANCY_EARLY_MINIMAL_FAST_PROFILE = {
  name: "fast",
  threshold: 0.5,
  sustainMs: 600_000,
  earlyWindowMs: DEFAULT_EARLY_WINDOW_MS,
} as const;
/** The lab-frozen D2-DRIP law (A1-COUNTER-D2): ratio >= 0.34 sustained 3,600 s. */
export const OCCUPANCY_EARLY_MINIMAL_DRIP_PROFILE = {
  name: "drip",
  threshold: 0.34,
  sustainMs: 3_600_000,
  earlyWindowMs: DEFAULT_EARLY_WINDOW_MS,
} as const;

const fail = (message: string): never => {
  throw new OccupancyEarlyMinimalError(`createOccupancyEarlyMinimalSignal: ${message}`);
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

function requirePositiveMs(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${field} must be a positive finite number of milliseconds`);
  }
  return value as number;
}

function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1024) {
    fail(`${field} must be a non-empty string of at most 1024 characters`);
  }
  return value as string;
}

function isValidTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8.64e15;
}

interface Session {
  identity: string;
  joinTs: number;
  leaveTs: number | null;
  createdTs: number;
  /** Activity timestamps inside this session, ascending. */
  activityTs: number[];
}

interface Law {
  name: string;
  threshold: number;
  sustainMs: number;
}

export function createOccupancyEarlyMinimalSignal(
  options: CreateOccupancyEarlyMinimalSignalOptions,
): OccupancyEarlyMinimalSignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");
  const capacity = requireIntInRange(options.capacity, "capacity", 1, 10_000_000);
  const earlyWindowMs = requirePositiveMs(
    options.earlyWindowMs ?? DEFAULT_EARLY_WINDOW_MS,
    "earlyWindowMs",
  );
  const newnessWindowMs = requirePositiveMs(
    options.newnessWindowMs ?? DEFAULT_NEWNESS_WINDOW_MS,
    "newnessWindowMs",
  );
  const maxSessions = requireIntInRange(options.maxSessions ?? 100_000, "maxSessions", 1, 10_000_000);

  const lawInputs: readonly OccupancyEarlyMinimalLawOptions[] =
    options.laws ??
    ([
      { name: "fast", threshold: 0.5, sustainMs: 600_000 },
      { name: "drip", threshold: 0.34, sustainMs: 3_600_000 },
    ] as const);
  if (!Array.isArray(lawInputs) || lawInputs.length === 0 || lawInputs.length > 32) {
    fail("laws must contain between 1 and 32 entries when provided");
  }
  const laws: Law[] = lawInputs.map((input, i) => {
    if (typeof input !== "object" || input === null) fail(`laws[${i}] must be an object`);
    const name =
      input.name !== undefined ? requireIdentity(input.name, `laws[${i}].name`) : `law-${i + 1}`;
    return {
      name,
      threshold: requireThreshold(input.threshold, `laws[${i}].threshold`),
      sustainMs: requirePositiveMs(input.sustainMs, `laws[${i}].sustainMs`),
    };
  });
  const seenNames = new Set<string>();
  for (const law of laws) {
    if (seenNames.has(law.name)) fail(`law names must be unique (duplicate "${law.name}")`);
    seenNames.add(law.name);
  }
  const onEvidence = options.onEvidence;
  if (onEvidence !== undefined && typeof onEvidence !== "function") {
    fail("onEvidence must be a function when provided");
  }

  let sessions: Session[] = [];
  let openByIdentity = new Map<string, Session>();
  let firstSeen = new Map<string, number>();
  let retainedByIdentity = new Map<string, number>();
  let counters = { observed: 0, invalidTs: 0, evictedSessions: 0, orphanEvents: 0, rejectedSessions: 0 };
  let latestTs = -Infinity;
  const evidenceFired = new Set<string>();

  function bump(name: keyof typeof counters): void {
    counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + 1);
  }

  function makeRoom(): boolean {
    while (sessions.length >= maxSessions) {
      const idx = sessions.findIndex((s) => s.leaveTs !== null);
      if (idx === -1) return false;
      const removed = sessions[idx] as Session;
      sessions.splice(idx, 1);
      const remaining = (retainedByIdentity.get(removed.identity) ?? 1) - 1;
      if (remaining === 0) {
        retainedByIdentity.delete(removed.identity);
        firstSeen.delete(removed.identity);
      } else retainedByIdentity.set(removed.identity, remaining);
      bump("evictedSessions");
    }
    return true;
  }

  function observe(event: OccupancyEarlyMinimalEvent): OccupancyEarlyMinimalObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    if (event.type !== "join" && event.type !== "leave" && event.type !== "activity") {
      fail('event.type must be "join", "leave" or "activity"');
    }
    const identity = requireIdentity(event.identity, "event.identity");
    if (!isValidTs(event.ts)) {
      bump("invalidTs");
      return { status: "invalid_ts", counted: false };
    }
    if (event.accountCreatedTs !== undefined && !isValidTs(event.accountCreatedTs)) {
      fail("event.accountCreatedTs must be a finite timestamp within the representable range");
    }
    bump("observed");
    if (event.type === "join") {
      const prior = openByIdentity.get(identity);
      if (prior && event.ts < prior.joinTs) {
        bump("orphanEvents");
        return { status: "recorded", counted: false };
      }
      if (prior && prior.leaveTs === null) prior.leaveTs = event.ts; // a re-join closes the prior session
      if (!makeRoom()) {
        bump("rejectedSessions");
        return { status: "capacity_exceeded", counted: false };
      }
      if (!firstSeen.has(identity) || event.ts < (firstSeen.get(identity) as number)) firstSeen.set(identity, event.ts);
      const session: Session = {
        identity,
        joinTs: event.ts,
        leaveTs: null,
        createdTs: event.accountCreatedTs !== undefined ? event.accountCreatedTs : (firstSeen.get(identity) as number),
        activityTs: [],
      };
      sessions.push(session);
      openByIdentity.set(identity, session);
      retainedByIdentity.set(identity, (retainedByIdentity.get(identity) ?? 0) + 1);
    } else if (event.type === "leave") {
      const open = openByIdentity.get(identity);
      if (open && open.leaveTs === null && event.ts >= open.joinTs) {
        open.leaveTs = event.ts;
        openByIdentity.delete(identity);
      } else {
        bump("orphanEvents");
      }
    } else {
      const open = openByIdentity.get(identity);
      if (open && open.leaveTs === null && event.ts > open.joinTs) {
        // Keep the per-session list ascending even if the host feeds
        // slightly out of order; the interval scan assumes it.
        const list = open.activityTs;
        let i = list.length;
        while (i > 0 && (list[i - 1] as number) > event.ts) i--;
        list.splice(i, 0, event.ts);
        if (list.length > 3) list.length = 3;
      } else {
        bump("orphanEvents");
      }
    }
    if (event.ts > latestTs) latestTs = event.ts;
    return { status: "recorded", counted: true };
  }

  /**
   * The runner's counting interval for one session:
   * [firstActivityTs, min(leaveTs, 3rd-activity-ts,
   * first-activity-ts-after-join+earlyWindow)), or null when the
   * session never counts (old identity, 0 activities, or a first
   * activity later than join + earlyWindow).
   */
  function countingInterval(s: Session): { start: number; drop: number } | null {
    if (s.createdTs > s.joinTs || s.joinTs - s.createdTs >= newnessWindowMs) return null;
    let first: number | null = null;
    let third: number | null = null;
    let firstLate: number | null = null;
    let cnt = 0;
    for (const ts of s.activityTs) {
      if (ts <= s.joinTs) continue; // (join, t] convention, same as the lab
      if (s.leaveTs !== null && ts > s.leaveTs) continue;
      cnt++;
      if (cnt === 1) first = ts;
      if (ts > s.joinTs + earlyWindowMs && firstLate === null) firstLate = ts;
      if (cnt === 3) {
        third = ts;
        break;
      }
    }
    if (first === null || first > s.joinTs + earlyWindowMs) return null;
    const end = s.leaveTs === null ? Infinity : s.leaveTs;
    const drop = Math.min(end, third ?? Infinity, firstLate ?? Infinity);
    if (drop <= first) return null;
    return { start: first, drop };
  }

  /** Ratio state at t: counting = t inside the session's interval. */
  function ratioAt(
    intervals: ({ start: number; drop: number } | null)[],
    t: number,
  ): { ratio: number; earlyMinimal: number; holders: number } {
    let holders = 0;
    let earlyMinimal = 0;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i] as Session;
      if (s.joinTs > t) continue;
      if (s.leaveTs !== null && t >= s.leaveTs) continue;
      holders++;
      const iv = intervals[i];
      if (iv !== null && iv !== undefined && t >= iv.start && t < iv.drop) earlyMinimal++;
    }
    return { ratio: Math.min(1, earlyMinimal / capacity), earlyMinimal, holders };
  }

  function evaluate(
    evaluateOptions: OccupancyEarlyMinimalEvaluateOptions = {},
  ): OccupancyEarlyMinimalResult {
    if (typeof evaluateOptions !== "object" || evaluateOptions === null) {
      fail("evaluate options must be an object");
    }
    const asOfTs = evaluateOptions.asOfTs !== undefined ? evaluateOptions.asOfTs : latestTs;
    if (asOfTs === -Infinity) {
      // No event has been observed yet: a structured inert result,
      // the same posture as createSeatOccupancySignal. A scheduled
      // evaluator ticking before the first join must be a no-op,
      // not an exception.
      return {
        kind: "occupancy-early-minimal",
        saturated: counters.rejectedSessions > 0,
        flagged: false,
        laws: laws.map((law) => ({
          name: law.name,
          threshold: law.threshold,
          sustainMs: law.sustainMs,
          flagged: false,
          firstFlagTs: null,
        })),
        currentRatio: 0,
        earlyMinimalSeats: 0,
        holders: 0,
        capacity,
        earlyWindowMs,
        enforcement: "none",
        notice: ADVISORY_NOTICE,
      };
    }
    if (!isValidTs(asOfTs)) fail("asOfTs must be a finite timestamp within the representable range");

    const intervals = sessions.map(countingInterval);

    // The ratio changes only at interval boundaries (first
    // activities, drops, leaves) - all of them activity or leave
    // timestamps - so walk the sorted change points up to asOfTs
    // and track each law's sustained run exactly.
    const deltas = new Map<number, number>();
    for (const iv of intervals) {
      if (!iv || iv.start > asOfTs) continue;
      deltas.set(iv.start, (deltas.get(iv.start) ?? 0) + 1);
      if (iv.drop <= asOfTs) deltas.set(iv.drop, (deltas.get(iv.drop) ?? 0) - 1);
    }
    const points = [...deltas.keys()].sort((a, b) => a - b);

    const lawResults: OccupancyEarlyMinimalLawResult[] = laws.map((law) => {
      let firstFlagTs: number | null = null;
      let runStart: number | null = null;
      let counting = 0;
      for (let i = 0; i <= points.length; i++) {
        const segEnd: number = i < points.length ? (points[i] as number) : asOfTs;
        if (runStart !== null && firstFlagTs === null && segEnd - runStart >= law.sustainMs) {
          firstFlagTs = runStart + law.sustainMs;
        }
        if (i === points.length) break;
        const point = points[i] as number;
        counting += deltas.get(point) ?? 0;
        const r = Math.min(1, counting / capacity);
        if (r >= law.threshold) {
          if (runStart === null) runStart = point;
        } else {
          runStart = null;
        }
      }
      return {
        name: law.name,
        threshold: law.threshold,
        sustainMs: law.sustainMs,
        flagged: counters.rejectedSessions === 0 && firstFlagTs !== null,
        firstFlagTs: counters.rejectedSessions > 0 ? null : firstFlagTs,
      };
    });

    const now = ratioAt(intervals, asOfTs);
    const result: OccupancyEarlyMinimalResult = {
      kind: "occupancy-early-minimal",
      saturated: counters.rejectedSessions > 0,
      flagged: lawResults.some((l) => l.flagged),
      laws: lawResults,
      currentRatio: now.ratio,
      earlyMinimalSeats: now.earlyMinimal,
      holders: now.holders,
      capacity,
      earlyWindowMs,
      enforcement: "none",
      notice: ADVISORY_NOTICE,
    };

    if (onEvidence) {
      for (const lawResult of lawResults) {
        if (!lawResult.flagged || lawResult.firstFlagTs === null) continue;
        if (evidenceFired.has(lawResult.name)) continue;
        evidenceFired.add(lawResult.name);
        try {
          void Promise.resolve(onEvidence({
            law: lawResult.name,
            threshold: lawResult.threshold,
            sustainMs: lawResult.sustainMs,
            firstFlagTs: lawResult.firstFlagTs,
            currentRatio: result.currentRatio,
            earlyMinimalSeats: result.earlyMinimalSeats,
            capacity,
            timestamp: new Date(lawResult.firstFlagTs).toISOString(),
          })).catch(() => undefined);
        } catch {
          /* operator logging must never break request handling */
        }
      }
    }

    return result;
  }

  function snapshot(): OccupancyEarlyMinimalSnapshot {
    return {
      enforcement: "none",
      capacity,
      earlyWindowMs,
      laws: laws.map((law) => ({
        name: law.name,
        threshold: law.threshold,
        sustainMs: law.sustainMs,
      })),
      sessions: sessions.length,
      openSessions: openByIdentity.size,
      saturated: counters.rejectedSessions > 0,
      trackedIdentities: firstSeen.size,
      retainedActivityTimestamps: sessions.reduce((n, s) => n + s.activityTs.length, 0),
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  function reset(): void {
    sessions = [];
    openByIdentity = new Map<string, Session>();
    firstSeen = new Map<string, number>();
    retainedByIdentity = new Map<string, number>();
    counters = { observed: 0, invalidTs: 0, evictedSessions: 0, orphanEvents: 0, rejectedSessions: 0 };
    latestTs = -Infinity;
    evidenceFired.clear();
  }

  return { observe, evaluate, snapshot, reset };
}
