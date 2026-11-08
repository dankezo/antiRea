/**
 * Room guard (RECOMB-06 ROOMGUARD-2, lab pin
 * roomguard-lab/REGISTRATION-RECOMB-06-ROOMGUARD-2.md, results in
 * RECOMB06-RESULTS.md; the three original pressure paths and their
 * gates come from REGISTRATION-ROOMGUARD.md, the occupancy leg from
 * CAND-273-1 / CAND-273-2 via createSeatOccupancySignal).
 *
 * WHAT IT MEASURES. A capacity-limited room (a 100-seat cinema, a
 * 30-seat karaoke room) can be attacked on four different shapes,
 * and no single statistic sees all of them:
 *
 * - FLOOD: hundreds of fresh accounts join inside seconds.
 * - DRIP: fresh accounts trickle in over an hour and stay.
 * - CHURN: fresh accounts join, leave within seconds, rejoin.
 * - SQUAT: fresh accounts take the seats and sit silent, holding
 *   them. This shape has NO rate signature at all - the wave-1
 *   pressure combination (velocity / newness / inactivity over
 *   event windows) never fired on it at any tick in 7 simulated
 *   days (gate G-B4 of the original pin). What it changes is
 *   OCCUPANCY sustained over time, which is why this module adds
 *   the seat-occupancy leg the original registration forbade
 *   adding after the fact; the leg is declared here, in a new
 *   registration, with its own gates.
 *
 * THE COMBINATION (lab-frozen, the only flagging verdict):
 * pressure is high at a 30 s evaluation tick when ANY path fires:
 * - burst:     joins60 >= 20 AND joins60 >= 8 x baseline (joins
 *              per minute over [t-24h, t-10min], floored at 0.5)
 *              AND newFrac(10 min) >= 0.70 AND
 *              inactiveFrac(10 min) >= 0.80;
 * - sustained: joins(30 min) >= 30 AND newFrac(30 min) >= 0.70
 *              AND inactiveFrac(30 min) >= 0.80;
 * - churn:     joins(10 min) >= 20 AND churnRatio >= 0.50
 *              (churnRatio = share of settled joiners - left, or
 *              present >= 10 s - who left with dwell < 10 s);
 * - occupancy: occupancyNewIdle (seats held by identities created
 *              < 24 h before joining with zero activity since,
 *              over host-declared capacity) sustains >= 0.50 for
 *              600 s (FAST law) or >= 0.34 for 3,600 s (DRIP law).
 * newFrac(W) = share of joiners in (t-W, t] whose account was
 * created less than `newnessWindowMs` before that join;
 * inactiveFrac(W) = share of joiners in (t-W, t] present for
 * >= 60 s who emitted zero activity since joining.
 *
 * `recommendStepUpForNewJoins` is true exactly while pressure is
 * high at the latest tick. Members already in the room NEVER
 * receive a consequence from this design - the module has no
 * per-identity output at all; it describes a room.
 *
 * WHAT THE LAB MEASURED (seeded simulation, 30 s ticks x 7 days
 * = 20,161 ticks per cell; internal validity only - NOT
 * real-traffic performance):
 * - Legitimate cells (steady cinema, a 50-user raid of EXISTING
 *   accounts, a 60-user scheduled showtime, karaoke prime time,
 *   and a silent karaoke audience with 60% of seat sessions -
 *   old and new - emitting no activity at all): pressure NEVER
 *   high at any tick. Legit occupancy peaked at 0.02-0.10
 *   against the 0.34 DRIP threshold (a 3.4x margin on the
 *   heaviest cell).
 * - FLOOD flagged at +60 s (gate 120 s); DRIP at +1,950 s
 *   (gate 45 min); CHURN at +30 s (gate 15 min) - all via the
 *   original paths.
 * - SQUAT flagged at +690 s (gate 900 s, taken verbatim from
 *   CAND-273-1 for this statistic: its physical floor is
 *   ~660-720 s of seat-fill plus sustain) via the occupancy
 *   FAST law; the original three paths stayed silent.
 * - SQUAT-DRIP flagged by the occupancy DRIP law 5,100 s before
 *   the last bot took its seat (gate: >= 1,800 s of warning).
 *
 * HARD LIMITS.
 * - ADVISORY ONLY: `enforcement: "none"` on every output.
 * - KNOWN HOLE (attacker line A1, declared in the
 *   registration): a squatting bot that chats even 1-2 messages
 *   leaves the zero-activity definition of the occupancy leg,
 *   and slow squats below the rate paths stay invisible to the
 *   other three. This module does NOT close A1; activity
 *   QUALITY is a separate candidate's job.
 * - The estimand trusts the host's capacity and activity feed,
 *   exactly as in createSeatOccupancySignal. Rooms whose
 *   legitimate new users routinely hold more than a third of
 *   seats silently for a full hour sit closer to the DRIP
 *   threshold than the lab populations did.
 *
 * Pure computation: no I/O, no runtime dependencies. One
 * instance per room. State is a bounded list of sessions;
 * past `maxSessions` the oldest CLOSED sessions are evicted
 * and history before them is forgotten (counted in the
 * snapshot) - size the bound above a room's weekly session
 * count. Evaluation replays ticks of `tickMs` from the first
 * observed event, exactly as the lab evaluated; on very long
 * histories evaluate with a recent asOfTs or a larger tick.
 */

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_NEWNESS_WINDOW_MS = DAY_MS;
const MAX_TICKS = 2_000_000;

// Lab-frozen path constants (REGISTRATION-ROOMGUARD section 4).
export const ROOM_GUARD_LAW = {
  velocityMinJoins60: 20,
  velocityBaselineMultiplier: 8,
  velocityBaselineFloorPerMin: 0.5,
  burstNewFrac: 0.7,
  burstInactiveFrac: 0.8,
  sustainedMinJoins30Min: 30,
  sustainedNewFrac: 0.7,
  sustainedInactiveFrac: 0.8,
  churnMinJoins10Min: 20,
  churnRatio: 0.5,
  occupancyFast: { threshold: 0.5, sustainMs: 600_000 },
  occupancyDrip: { threshold: 0.34, sustainMs: 3_600_000 },
} as const;

const ADVISORY_NOTICE =
  "Advisory telemetry only (enforcement: none): room pressure from four frozen paths - burst, " +
  "sustained, churn (join-window velocity/newness/inactivity/churn ratios) and occupancy (new-idle " +
  "seat share sustained under the FAST/DRIP laws). Pressure recommends step-up for NEW joins only; " +
  "members already seated never receive a consequence, and no output names an identity. All lab " +
  "numbers are seeded simulation (RECOMB-06 pin), not real-traffic performance; a squatting bot " +
  "that chats even 1-2 messages escapes the occupancy leg's zero-activity definition (hole A1, " +
  "declared open).";

export interface RoomGuardEvent {
  type: "join" | "leave" | "activity";
  /** The authenticated identity the event belongs to. */
  identity: string;
  /** Millisecond timestamp of the event. */
  ts: number;
  /**
   * Account creation time (ms), when the host knows it. Used on
   * `join` events; without it, the identity's first observed event
   * stands in for its creation time.
   */
  accountCreatedTs?: number;
}

export interface CreateRoomGuardOptions {
  /** Room capacity in seats. Required; the occupancy ratio's denominator. */
  capacity: number;
  /** Evaluation tick in ms. Default 30,000 (the lab tick). */
  tickMs?: number;
  /** An identity counts as new for a session when it was created less than this many ms before the join. Default 86,400,000 (24 h, lab law). */
  newnessWindowMs?: number;
  /** Maximum sessions retained (open + closed). Oldest closed sessions are evicted past it. Defaults to 100,000. */
  maxSessions?: number;
}

export interface RoomGuardObservation {
  /** `"recorded"`, or `"invalid_ts"` when the timestamp was refused before any state was touched. */
  status: "recorded" | "invalid_ts";
  counted: boolean;
}

export interface RoomGuardEvaluateOptions {
  /** Evaluate the room state at this ms timestamp. Defaults to the latest observed event. */
  asOfTs?: number;
}

export interface RoomGuardPathState {
  burst: boolean;
  sustained: boolean;
  churn: boolean;
  occupancy: boolean;
}

export interface RoomGuardCurrent {
  joins60: number;
  velocityBaselinePerMin: number;
  velocityFires: boolean;
  joins10Min: number;
  newFrac10Min: number;
  inactiveFrac10Min: number;
  churnRatio: number;
  joins30Min: number;
  newFrac30Min: number;
  inactiveFrac30Min: number;
  /** New-idle occupancy ratio at the latest tick. */
  occupancyRatio: number;
  newIdleSeats: number;
  holders: number;
}

export interface RoomGuardResult {
  kind: "room-guard";
  /** True when pressure has been high at any tick up to asOfTs. */
  flagged: boolean;
  /** When pressure first went high (ms), or null when never flagged. */
  firstFlagTs: number | null;
  /** True when pressure is high at the latest tick <= asOfTs. */
  pressureHighNow: boolean;
  /** Step up NEW joins exactly while pressureHighNow. Seated members are never affected. */
  recommendStepUpForNewJoins: boolean;
  /** Paths that have fired at any tick up to asOfTs. */
  paths: RoomGuardPathState;
  /** First tick each path fired (ms), or null per path. */
  firstPathTs: {
    burst: number | null;
    sustained: number | null;
    churn: number | null;
    occupancy: number | null;
  };
  /** Component values at the latest tick <= asOfTs. */
  current: RoomGuardCurrent;
  capacity: number;
  tickMs: number;
  /** Always `"none"`: this module enforces nothing, about anyone. */
  enforcement: "none";
  notice: string;
}

export interface RoomGuardSnapshot {
  enforcement: "none";
  capacity: number;
  tickMs: number;
  /** Sessions currently retained (open + closed). */
  sessions: number;
  /** Sessions currently open. */
  openSessions: number;
  counters: {
    observed: number;
    invalidTs: number;
    /** Closed sessions evicted past maxSessions (history before them is forgotten). */
    evictedSessions: number;
    /** leave/activity events with no open session to attach to. */
    orphanEvents: number;
  };
  notice: string;
}

export interface RoomGuardInstance {
  observe(event: RoomGuardEvent): RoomGuardObservation;
  evaluate(options?: RoomGuardEvaluateOptions): RoomGuardResult;
  snapshot(): RoomGuardSnapshot;
}

/** Named error thrown for every invalid room-guard input. */
export class RoomGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomGuardError";
  }
}

const fail = (message: string): never => {
  throw new RoomGuardError(`createRoomGuard: ${message}`);
};

function requireIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
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
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
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

export function createRoomGuard(options: CreateRoomGuardOptions): RoomGuardInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");
  const capacity = requireIntInRange(options.capacity, "capacity", 1, 10_000_000);
  const tickMs = requirePositiveMs(options.tickMs ?? DEFAULT_TICK_MS, "tickMs");
  const newnessWindowMs = requirePositiveMs(options.newnessWindowMs ?? DEFAULT_NEWNESS_WINDOW_MS, "newnessWindowMs");
  const maxSessions = requireIntInRange(options.maxSessions ?? 100_000, "maxSessions", 1, 10_000_000);

  const sessions: Session[] = [];
  const openByIdentity = new Map<string, Session>();
  const firstSeen = new Map<string, number>();
  const counters = { observed: 0, invalidTs: 0, evictedSessions: 0, orphanEvents: 0 };
  let latestTs = -Infinity;
  let earliestTs = Infinity;

  function evictClosed(): void {
    while (sessions.length > maxSessions) {
      const idx = sessions.findIndex((s) => s.leaveTs !== null);
      if (idx === -1) return;
      sessions.splice(idx, 1);
      counters.evictedSessions++;
    }
  }

  function observe(event: RoomGuardEvent): RoomGuardObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    if (event.type !== "join" && event.type !== "leave" && event.type !== "activity") {
      fail('event.type must be "join", "leave" or "activity"');
    }
    const identity = requireIdentity(event.identity, "event.identity");
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      return { status: "invalid_ts", counted: false };
    }
    if (event.accountCreatedTs !== undefined && !isValidTs(event.accountCreatedTs)) {
      fail("event.accountCreatedTs must be a finite timestamp within the representable range");
    }
    counters.observed++;
    if (event.ts > latestTs) latestTs = event.ts;
    if (event.ts < earliestTs) earliestTs = event.ts;
    if (!firstSeen.has(identity) || event.ts < (firstSeen.get(identity) as number)) {
      firstSeen.set(identity, event.ts);
    }
    if (event.type === "join") {
      const prior = openByIdentity.get(identity);
      if (prior && prior.leaveTs === null) prior.leaveTs = event.ts;
      const session: Session = {
        identity,
        joinTs: event.ts,
        leaveTs: null,
        createdTs: event.accountCreatedTs !== undefined ? event.accountCreatedTs : (firstSeen.get(identity) as number),
        activityTs: [],
      };
      sessions.push(session);
      openByIdentity.set(identity, session);
      evictClosed();
    } else if (event.type === "leave") {
      const open = openByIdentity.get(identity);
      if (open && open.leaveTs === null) {
        open.leaveTs = event.ts;
        openByIdentity.delete(identity);
      } else {
        counters.orphanEvents++;
      }
    } else {
      const open = openByIdentity.get(identity);
      if (open && open.leaveTs === null) open.activityTs.push(event.ts);
      else counters.orphanEvents++;
    }
    return { status: "recorded", counted: true };
  }

  function hasActivity(s: Session, t: number): boolean {
    for (const at of s.activityTs) {
      if (at > s.joinTs && at <= t) return true;
    }
    return false;
  }

  interface WindowStats {
    n: number;
    newFrac: number;
    inactiveFrac: number;
    churnRatio: number;
  }

  /** Join-window statistics over (t-W, t], the lab's window law. */
  function windowStats(t: number, windowMs: number): WindowStats {
    const lo = t - windowMs;
    let n = 0;
    let newCount = 0;
    let elig = 0;
    let inact = 0;
    let resolved = 0;
    let churned = 0;
    for (const s of sessions) {
      if (s.joinTs <= lo || s.joinTs > t) continue;
      n++;
      if (s.joinTs - s.createdTs < newnessWindowMs) newCount++;
      if (t - s.joinTs >= MIN_MS) {
        elig++;
        if (!hasActivity(s, t)) inact++;
      }
      const left = s.leaveTs !== null && s.leaveTs <= t;
      const presentLong = t - s.joinTs >= 10_000;
      if (left || presentLong) {
        resolved++;
        if (left && (s.leaveTs as number) - s.joinTs < 10_000) churned++;
      }
    }
    return {
      n,
      newFrac: n ? newCount / n : 0,
      inactiveFrac: elig ? inact / elig : 0,
      churnRatio: resolved ? churned / resolved : 0,
    };
  }

  function occupancyAt(t: number): { ratio: number; newIdle: number; holders: number } {
    let holders = 0;
    let newIdle = 0;
    for (const s of sessions) {
      if (s.joinTs > t) continue;
      if (s.leaveTs !== null && t >= s.leaveTs) continue;
      holders++;
      if (s.joinTs - s.createdTs >= newnessWindowMs) continue;
      if (!hasActivity(s, t)) newIdle++;
    }
    return { ratio: newIdle / capacity, newIdle, holders };
  }

  interface TickState {
    paths: RoomGuardPathState;
    current: RoomGuardCurrent;
  }

  function emptyCurrent(): RoomGuardCurrent {
    return {
      joins60: 0,
      velocityBaselinePerMin: 0,
      velocityFires: false,
      joins10Min: 0,
      newFrac10Min: 0,
      inactiveFrac10Min: 0,
      churnRatio: 0,
      joins30Min: 0,
      newFrac30Min: 0,
      inactiveFrac30Min: 0,
      occupancyRatio: 0,
      newIdleSeats: 0,
      holders: 0,
    };
  }

  function evaluate(evaluateOptions: RoomGuardEvaluateOptions = {}): RoomGuardResult {
    if (typeof evaluateOptions !== "object" || evaluateOptions === null) {
      fail("evaluate options must be an object");
    }
    const asOfTs = evaluateOptions.asOfTs !== undefined ? evaluateOptions.asOfTs : latestTs;
    if (asOfTs === -Infinity) {
      // No event observed yet: inert result, the sibling signals'
      // posture - a scheduled evaluator ticking before the first
      // join is a structured no-op, not an exception.
      return {
        kind: "room-guard",
        flagged: false,
        firstFlagTs: null,
        pressureHighNow: false,
        recommendStepUpForNewJoins: false,
        paths: { burst: false, sustained: false, churn: false, occupancy: false },
        firstPathTs: { burst: null, sustained: null, churn: null, occupancy: null },
        current: emptyCurrent(),
        capacity,
        tickMs,
        enforcement: "none",
        notice: ADVISORY_NOTICE,
      };
    }
    if (!isValidTs(asOfTs)) fail("asOfTs must be a finite timestamp within the representable range");

    const joinsSorted = [...sessions].sort((a, b) => a.joinTs - b.joinTs);
    const firstTick = Math.floor(Math.min(earliestTs, asOfTs) / tickMs) * tickMs;
    const tickCount = Math.floor((asOfTs - firstTick) / tickMs) + 1;
    if (tickCount > MAX_TICKS) {
      fail(`evaluation span covers ${tickCount} ticks (max ${MAX_TICKS}); evaluate a more recent asOfTs or use a larger tickMs`);
    }

    const paths: RoomGuardPathState = { burst: false, sustained: false, churn: false, occupancy: false };
    const firstPathTs: RoomGuardResult["firstPathTs"] = { burst: null, sustained: null, churn: null, occupancy: null };
    let firstFlagTs: number | null = null;
    let nowState: TickState = { paths: { burst: false, sustained: false, churn: false, occupancy: false }, current: emptyCurrent() };
    let fastRunStart: number | null = null;
    let dripRunStart: number | null = null;

    const mark = (path: keyof RoomGuardPathState, t: number): void => {
      if (!paths[path]) {
        paths[path] = true;
        firstPathTs[path] = t;
      }
      if (firstFlagTs === null) firstFlagTs = t;
    };

    for (let t = firstTick; t <= asOfTs; t += tickMs) {
      // Velocity: joins in (t-60s, t] against the per-minute
      // baseline over [t-24h, t-10min].
      let joins60 = 0;
      let baselineCount = 0;
      const baseLo = t - DAY_MS;
      const baseHi = t - 600_000;
      for (const s of joinsSorted) {
        if (s.joinTs > t - MIN_MS && s.joinTs <= t) joins60++;
        if (s.joinTs >= baseLo && s.joinTs <= baseHi) baselineCount++;
      }
      const baselineWindowMs = baseHi - baseLo;
      const baseline = baselineWindowMs > 0 ? baselineCount / (baselineWindowMs / MIN_MS) : 0;
      const velocityFires =
        joins60 >= ROOM_GUARD_LAW.velocityMinJoins60 &&
        joins60 >= ROOM_GUARD_LAW.velocityBaselineMultiplier * Math.max(baseline, ROOM_GUARD_LAW.velocityBaselineFloorPerMin);

      const w10 = windowStats(t, 600_000);
      const w30 = windowStats(t, 1_800_000);

      const burst = velocityFires && w10.newFrac >= ROOM_GUARD_LAW.burstNewFrac && w10.inactiveFrac >= ROOM_GUARD_LAW.burstInactiveFrac;
      const sustained =
        w30.n >= ROOM_GUARD_LAW.sustainedMinJoins30Min &&
        w30.newFrac >= ROOM_GUARD_LAW.sustainedNewFrac &&
        w30.inactiveFrac >= ROOM_GUARD_LAW.sustainedInactiveFrac;
      const churnPath = w10.n >= ROOM_GUARD_LAW.churnMinJoins10Min && w10.churnRatio >= ROOM_GUARD_LAW.churnRatio;

      // Occupancy leg: tick runs under the FAST and DRIP laws.
      const occ = occupancyAt(t);
      if (occ.ratio >= ROOM_GUARD_LAW.occupancyFast.threshold) {
        if (fastRunStart === null) fastRunStart = t;
      } else fastRunStart = null;
      if (occ.ratio >= ROOM_GUARD_LAW.occupancyDrip.threshold) {
        if (dripRunStart === null) dripRunStart = t;
      } else dripRunStart = null;
      const occupancy =
        (fastRunStart !== null && t - fastRunStart >= ROOM_GUARD_LAW.occupancyFast.sustainMs) ||
        (dripRunStart !== null && t - dripRunStart >= ROOM_GUARD_LAW.occupancyDrip.sustainMs);

      if (burst) mark("burst", t);
      if (sustained) mark("sustained", t);
      if (churnPath) mark("churn", t);
      if (occupancy) mark("occupancy", t);

      nowState = {
        paths: { burst, sustained, churn: churnPath, occupancy },
        current: {
          joins60,
          velocityBaselinePerMin: baseline,
          velocityFires,
          joins10Min: w10.n,
          newFrac10Min: w10.newFrac,
          inactiveFrac10Min: w10.inactiveFrac,
          churnRatio: w10.churnRatio,
          joins30Min: w30.n,
          newFrac30Min: w30.newFrac,
          inactiveFrac30Min: w30.inactiveFrac,
          occupancyRatio: occ.ratio,
          newIdleSeats: occ.newIdle,
          holders: occ.holders,
        },
      };
    }

    const pressureHighNow =
      nowState.paths.burst || nowState.paths.sustained || nowState.paths.churn || nowState.paths.occupancy;
    return {
      kind: "room-guard",
      flagged: firstFlagTs !== null,
      firstFlagTs,
      pressureHighNow,
      recommendStepUpForNewJoins: pressureHighNow,
      paths,
      firstPathTs,
      current: nowState.current,
      capacity,
      tickMs,
      enforcement: "none",
      notice: ADVISORY_NOTICE,
    };
  }

  function snapshot(): RoomGuardSnapshot {
    return {
      enforcement: "none",
      capacity,
      tickMs,
      sessions: sessions.length,
      openSessions: openByIdentity.size,
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  return { observe, evaluate, snapshot };
}
