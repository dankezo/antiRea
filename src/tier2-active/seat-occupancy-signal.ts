/**
 * Seat-occupancy signal (live-room candidates CAND-273-1 and
 * CAND-273-2, lab pin roomguard-lab/cand273-lab/REGISTRATION-CAND-
 * 273-1.md and REGISTRATION-CAND-273-2.md, results in
 * CAND273-RESULTS.md).
 *
 * WHAT IT MEASURES. Some room attacks do not attack join SPEED -
 * they attack OCCUPANCY: a fleet of fresh accounts takes the seats
 * of a capacity-limited room (30 karaoke seats, a watch-party cap)
 * and then sits perfectly silent, keeping legitimate users out.
 * The wave-1 roomguard combination (join velocity + newness +
 * inactivity over event windows) missed that shape completely
 * (gate G-B4): its legs peak at different times and none of them
 * reads how long seats stay held. This module reads the state the
 * attack actually changes:
 *
 *   occupancyNewIdle(t) = (seats held at t by identities that were
 *   created less than `newnessWindowMs` before their session's
 *   join AND have emitted zero activity since that join)
 *   / room capacity.
 *
 * A room is flagged when the ratio stays at or above `threshold`
 * continuously for `sustainMs`. Two lab-frozen profiles ship:
 * - FAST (the defaults): threshold 0.50, sustain 10 minutes -
 *   catches a burst squat (30 fresh silent accounts filling a
 *   30-seat room inside 2 minutes).
 * - DRIP (`SEAT_OCCUPANCY_DRIP_PROFILE`): threshold 0.34, sustain
 *   60 minutes - catches the slow variant that takes 1-2 seats
 *   every ~10 minutes for hours. A host that wants both runs two
 *   instances; the profiles were pinned as separate laws.
 *
 * This is a POPULATION signal in the `createBunchingMonitor`
 * family: it describes a room, never an identity. There is no
 * per-identity output and no identity-level API - a seat held by
 * a new silent identity is a room fact, not an accusation (a
 * first-time listener who never chats is legitimate and common;
 * what is not legitimate is half the room being that, sustained).
 *
 * WHAT THE LAB MEASURED (seeded simulation, room-join/session
 * streams; internal validity only - NOT real-traffic performance):
 * - Legitimate karaoke prime time peaked at ratio 0.0667; a
 *   silent-audience cell (60% of seat sessions emitting no
 *   activity at all, including 60% of new users' sessions) peaked
 *   at 0.1333; a 50-user raid into the 100-seat cinema peaked at
 *   0.0200. Neither profile flagged any legitimate cell at any
 *   tick in 7 simulated days (20,161 ticks per cell).
 * - A stress cell beyond the target population (EVERY new user's
 *   sessions silent, signups at 3x the normal rate) peaked at
 *   0.2333 and was still not flagged by either profile - recorded
 *   descriptively in the lab results.
 * - The burst squat flagged under the FAST profile 660 s after
 *   the first bot joined (gate: <= 900 s). The slow drip flagged
 *   under the DRIP profile 5,100 s (85 minutes) before the last
 *   bot took its seat (gate: >= 1,800 s of warning).
 *
 * FEEDING. One instance per room. Feed `join` / `leave` /
 * `activity` events with the identity and a millisecond ts; pass
 * `accountCreatedTs` on joins when the host knows it - otherwise
 * the identity's first observed event stands in for its creation
 * time. `evaluate` reconstructs the ratio exactly: it changes
 * only at event boundaries (a session's newness is fixed at its
 * join; its idle status flips at its first activity), so the
 * sustained-run computation over the stored history is exact,
 * not sampled.
 *
 * HARD LIMITS.
 * - ADVISORY ONLY: `enforcement: "none"` on every output. A flag
 *   is a room state for the host's dashboard / step-up decision
 *   (e.g. step up NEW joins while the room is flagged - the
 *   people already seated are never this module's business).
 * - The estimand trusts the host's capacity and activity feed.
 *   A "seat" the host does not model does not exist here, and an
 *   activity type the host never feeds makes everyone look idle.
 * - Rooms whose legitimate new-user population routinely holds
 *   more than a third of seats silently for a full hour sit
 *   closer to the DRIP threshold than the lab populations did
 *   (the stress cell reached 0.2333 of the 0.34 line); the FAST
 *   profile keeps a wider margin. Both numbers are harness
 *   measurements, not guarantees about a given platform.
 *
 * Pure computation: no I/O, no runtime dependencies. State is a
 * bounded list of sessions (open and closed); past
 * `maxSessions`, the oldest CLOSED sessions are evicted and the
 * sustain history before them is forgotten (counted in the
 * snapshot) - size the bound above a room's weekly session count.
 */

const DAY_MS = 86_400_000;

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_SUSTAIN_MS = 600_000;
const DEFAULT_NEWNESS_WINDOW_MS = DAY_MS;

const ADVISORY_NOTICE =
  "Advisory telemetry only (enforcement: none): population seat-occupancy ratio - the share of a " +
  "room's capacity held by identities created within the newness window before joining that have " +
  "emitted zero activity since joining; the room flags when the ratio stays at or above threshold " +
  "continuously for sustainMs. This is a room state, never an identity verdict: no output names an " +
  "identity. All lab numbers are seeded simulation (CAND-273-1/273-2 pin), not real-traffic " +
  "performance; legitimate rooms whose new users routinely hold a large silent share for a full " +
  "hour sit closer to the drip threshold than the lab populations did.";

export interface SeatOccupancyEvent {
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

export interface CreateSeatOccupancySignalOptions {
  /** Room capacity in seats. Required; the ratio's denominator. */
  capacity: number;
  /** Flag threshold on the new-idle occupancy ratio. Default 0.50 (lab-frozen FAST profile). Must be in (0, 1]. */
  threshold?: number;
  /** How long the ratio must stay at/above threshold, in ms. Default 600,000 (10 min, FAST profile). */
  sustainMs?: number;
  /** An identity counts as new for a session when it was created less than this many ms before the join. Default 86,400,000 (24 h, lab law). */
  newnessWindowMs?: number;
  /** Maximum sessions retained (open + closed). Closed sessions are evicted first; new telemetry is refused if all are open. Default 100,000. */
  maxSessions?: number;
}

export interface SeatOccupancyObservation {
  /** `"recorded"`, or `"invalid_ts"` when the timestamp was refused before any state was touched. */
  status: "recorded" | "invalid_ts" | "capacity_exceeded";
  counted: boolean;
}

export interface SeatOccupancyEvaluateOptions {
  /** Evaluate the room state at this ms timestamp. Defaults to the latest observed event. */
  asOfTs?: number;
}

export interface SeatOccupancyResult {
  kind: "seat-occupancy";
  /** True when the ratio has stayed >= threshold for sustainMs at some point up to asOfTs. */
  flagged: boolean;
  /** True after capacity loss; confirmations are suppressed for incomplete telemetry. */
  saturated: boolean;
  /** When the flag first completed its sustain run (ms), or null when never flagged. */
  firstFlagTs: number | null;
  /** The new-idle occupancy ratio at asOfTs. */
  currentRatio: number;
  /** Seats held by new-and-idle identities at asOfTs. */
  newIdleSeats: number;
  /** All seats held at asOfTs (any identity, any activity). */
  holders: number;
  capacity: number;
  threshold: number;
  sustainMs: number;
  /** Always `"none"`: this module enforces nothing, about anyone. */
  enforcement: "none";
  notice: string;
}

export interface SeatOccupancySnapshot {
  enforcement: "none";
  capacity: number;
  threshold: number;
  sustainMs: number;
  /** Sessions currently retained (open + closed). */
  sessions: number;
  /** Sessions currently open. */
  openSessions: number;
  /** Telemetry loss disables confirmations until a fresh instance is created. */
  saturated: boolean;
  /** First-seen metadata is bounded by retained sessions. */
  trackedIdentities: number;
  /** At most one first activity per retained session. */
  retainedActivityTimestamps: number;
  counters: {
    observed: number;
    invalidTs: number;
    /** Closed sessions evicted past maxSessions (sustain history before them is forgotten). */
    evictedSessions: number;
    /** leave/activity events with no open session to attach to. */
    orphanEvents: number;
    rejectedSessions: number;
  };
  notice: string;
}

export interface SeatOccupancySignalInstance {
  observe(event: SeatOccupancyEvent): SeatOccupancyObservation;
  evaluate(options?: SeatOccupancyEvaluateOptions): SeatOccupancyResult;
  snapshot(): SeatOccupancySnapshot;
}

/** Named error thrown for every invalid seat-occupancy input. */
export class SeatOccupancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeatOccupancyError";
  }
}

/** The lab-frozen FAST profile (CAND-273-1): burst seat squatting. */
export const SEAT_OCCUPANCY_FAST_PROFILE = { threshold: 0.5, sustainMs: 600_000 } as const;
/** The lab-frozen DRIP profile (CAND-273-2): slow seat dripping, 1-2 seats per ~10 minutes. */
export const SEAT_OCCUPANCY_DRIP_PROFILE = { threshold: 0.34, sustainMs: 3_600_000 } as const;

const fail = (message: string): never => {
  throw new SeatOccupancyError(`createSeatOccupancySignal: ${message}`);
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

export function createSeatOccupancySignal(
  options: CreateSeatOccupancySignalOptions,
): SeatOccupancySignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");
  const capacity = requireIntInRange(options.capacity, "capacity", 1, 10_000_000);
  const threshold = requireThreshold(options.threshold ?? DEFAULT_THRESHOLD, "threshold");
  const sustainMs = requirePositiveMs(options.sustainMs ?? DEFAULT_SUSTAIN_MS, "sustainMs");
  const newnessWindowMs = requirePositiveMs(options.newnessWindowMs ?? DEFAULT_NEWNESS_WINDOW_MS, "newnessWindowMs");
  const maxSessions = requireIntInRange(options.maxSessions ?? 100_000, "maxSessions", 1, 10_000_000);

  const sessions: Session[] = [];
  const openByIdentity = new Map<string, Session>();
  const firstSeen = new Map<string, number>();
  const retainedByIdentity = new Map<string, number>();
  const counters = { observed: 0, invalidTs: 0, evictedSessions: 0, orphanEvents: 0, rejectedSessions: 0 };
  let latestTs = -Infinity;

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

  function observe(event: SeatOccupancyEvent): SeatOccupancyObservation {
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
        if (list.length > 1) list.length = 1;
      } else {
        bump("orphanEvents");
      }
    }
    if (event.ts > latestTs) latestTs = event.ts;
    return { status: "recorded", counted: true };
  }

  /** Ratio state at t; "idle" = zero activity in (joinTs, t]. */
  function ratioAt(t: number): { ratio: number; newIdle: number; holders: number } {
    let holders = 0;
    let newIdle = 0;
    for (const s of sessions) {
      if (s.joinTs > t) continue;
      if (s.leaveTs !== null && t >= s.leaveTs) continue;
      holders++;
      if (s.createdTs > s.joinTs || s.joinTs - s.createdTs >= newnessWindowMs) continue;
      let active = false;
      for (const at of s.activityTs) {
        if (at > s.joinTs && at <= t) { active = true; break; }
      }
      if (!active) newIdle++;
    }
    return { ratio: Math.min(1, newIdle / capacity), newIdle, holders };
  }

  function evaluate(evaluateOptions: SeatOccupancyEvaluateOptions = {}): SeatOccupancyResult {
    if (typeof evaluateOptions !== "object" || evaluateOptions === null) {
      fail("evaluate options must be an object");
    }
    const asOfTs = evaluateOptions.asOfTs !== undefined ? evaluateOptions.asOfTs : latestTs;
    if (asOfTs === -Infinity) {
      // No event has been observed yet: same inert result an explicit
      // evaluate on an empty instance returns (the herd-phase /
      // activity-phase / vote-brigading posture). A scheduled evaluator
      // ticking before the first join must be a structured no-op, not
      // an exception.
      return {
        kind: "seat-occupancy",
        flagged: false,
        saturated: counters.rejectedSessions > 0,
        firstFlagTs: null,
        currentRatio: 0,
        newIdleSeats: 0,
        holders: 0,
        capacity,
        threshold,
        sustainMs,
        enforcement: "none",
        notice: ADVISORY_NOTICE,
      };
    }
    if (!isValidTs(asOfTs)) fail("asOfTs must be a finite timestamp within the representable range");

    // The ratio changes only at event boundaries (joins, leaves,
    // first activities), so walk the sorted change points up to
    // asOfTs and track the sustained run exactly.
    const changePoints = new Set<number>();
    for (const s of sessions) {
      if (s.joinTs <= asOfTs) changePoints.add(s.joinTs);
      if (s.leaveTs !== null && s.leaveTs <= asOfTs) changePoints.add(s.leaveTs);
      for (const at of s.activityTs) if (at <= asOfTs) changePoints.add(at);
    }
    const points = [...changePoints].sort((a, b) => a - b);
    let firstFlagTs: number | null = null;
    let runStart: number | null = null;
    for (let i = 0; i <= points.length; i++) {
      const segEnd: number = i < points.length ? (points[i] as number) : asOfTs;
      if (runStart !== null && firstFlagTs === null && segEnd - runStart >= sustainMs) {
        firstFlagTs = runStart + sustainMs;
      }
      if (i === points.length) break;
      const point = points[i] as number;
      const r = ratioAt(point).ratio;
      if (r >= threshold) {
        if (runStart === null) runStart = point;
      } else {
        runStart = null;
      }
    }

    const now = ratioAt(asOfTs);
    return {
      kind: "seat-occupancy",
      flagged: counters.rejectedSessions === 0 && firstFlagTs !== null,
      saturated: counters.rejectedSessions > 0,
      firstFlagTs: counters.rejectedSessions > 0 ? null : firstFlagTs,
      currentRatio: now.ratio,
      newIdleSeats: now.newIdle,
      holders: now.holders,
      capacity,
      threshold,
      sustainMs,
      enforcement: "none",
      notice: ADVISORY_NOTICE,
    };
  }

  function snapshot(): SeatOccupancySnapshot {
    return {
      enforcement: "none",
      capacity,
      threshold,
      sustainMs,
      sessions: sessions.length,
      openSessions: openByIdentity.size,
      saturated: counters.rejectedSessions > 0,
      trackedIdentities: firstSeen.size,
      retainedActivityTimestamps: sessions.reduce((n, s) => n + s.activityTs.length, 0),
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  return { observe, evaluate, snapshot };
}
