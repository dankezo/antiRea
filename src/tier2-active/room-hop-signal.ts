/**
 * Room-hop fan-out signal (live-room candidate CAND-273-5, lab
 * pin roomguard-lab/cand273-lab/REGISTRATION-CAND-273-5.md,
 * results in CAND273-RESULTS.md).
 *
 * WHAT IT MEASURES. A scraper or mapper does not attack one
 * room - it ENUMERATES the platform: join every room briefly,
 * read the member list / now-playing / song queue, move on. The
 * per-identity shape is breadth: how many DISTINCT rooms does one
 * identity join inside a trailing window? This module flags an
 * identity whose distinct-room count in any trailing
 * `windowMs` (default 1 h) reaches `threshold` (default 16).
 *
 * The threshold's margin was the whole lab question. Real people
 * room-surf to FIND something to watch: in the pin's baseline,
 * 15% of users surfed 3-5 rooms per evening (max distinct in an
 * hour: 6); in a deliberately heavy cell (25% heavy surfers,
 * 7-10 rooms per evening) the maximum was 11. The mapper cell -
 * 20 fresh accounts sweeping all 40 rooms of the platform in
 * sequences of 55 joins - was flagged 20/20 within the first
 * hour. 16 sits above the heavy legit maximum with margin,
 * below the sweep's floor. A platform with many more rooms, or
 * a much surfier culture, must re-derive its threshold from its
 * own legit distribution - the number is a property of the
 * population, not of the attack.
 *
 * SELF-DISARM (C35 pattern, registered for this module): if more
 * than `disarmShare` (default 25%) of tracked identities would be
 * flagged in one evaluation, the evaluation names NOBODY and
 * reports `disarmed: true`. That shape means the platform itself
 * changed (a room-discovery feature launched, a directory event)
 * or the signal is being poisoned at scale - either way the
 * output stops rather than mass-accuse the user base. Re-arming
 * is the host's manual act.
 *
 * This is a STEP-UP input in the verification-grace pattern
 * (observe -> step_up for NAMED identities), never an automatic
 * ban: the flag says "this join pattern looks like enumeration",
 * and the proportionate response is asking the identity to prove
 * it is a person, e.g. via `createVerificationGrace.guardStepUp`.
 *
 * HARD LIMITS.
 * - ADVISORY ONLY: `enforcement: "none"` on every output.
 * - Identities are never grouped by IP or any shared attribute
 *   here - the verdict is per-identity breadth over its own join
 *   stream (carrier NAT makes shared IPs meaningless).
 * - A mapper that spreads its sweep over more than an hour, or
 *   across many identities, falls below this threshold by
 *   construction; slow enumeration belongs to fleet-level
 *   layers. Recorded as a limit, not hidden.
 * - All lab numbers are seeded simulation (CAND-273-5 pin):
 *   internal validity only, NOT real-traffic performance.
 *
 * Pure computation: no I/O, no runtime dependencies. State is
 * bounded: per-identity join lists are truncated past
 * `maxJoinsPerIdentity` (oldest first, counted) and identities
 * past `maxIdentities` are evicted least-recently-seen first.
 */

const DEFAULT_THRESHOLD = 16;
const DEFAULT_WINDOW_MS = 3_600_000;
const DEFAULT_DISARM_SHARE = 0.25;

const ADVISORY_NOTICE =
  "Advisory telemetry only (enforcement: none): identities whose distinct-room joins inside a " +
  "trailing hour reach 16 - an enumeration shape measured against legitimate room-surfing (lab " +
  "maxima: 6/hour baseline surfers, 11/hour heavy surfers; a 40-room sweep flagged 20/20). Use as " +
  "a step-up input for the named identities, never an automatic ban. If more than 25% of tracked " +
  "identities would flag, the evaluation disarms and names nobody - that shape means the platform " +
  "changed or the signal is poisoned. Thresholds are population properties: re-derive them from " +
  "your own legit distribution. All lab numbers are seeded simulation (CAND-273-5 pin), not " +
  "real-traffic performance.";

export interface RoomHopEvent {
  /** The authenticated identity joining. */
  identity: string;
  /** The room joined (any stable host-side room identifier). */
  room: string;
  /** Millisecond timestamp of the join. */
  ts: number;
}

export interface CreateRoomHopSignalOptions {
  /** Distinct rooms inside the trailing window that flag an identity. Default 16 (lab-frozen). */
  threshold?: number;
  /** Trailing window length in ms. Default 3,600,000 (1 h, lab law). */
  windowMs?: number;
  /** Flagged share of tracked identities above which the evaluation disarms and names nobody. Default 0.25. */
  disarmShare?: number;
  /** Maximum identities retained (least recently seen evicted). Defaults to 100,000. */
  maxIdentities?: number;
  /** Maximum joins retained per identity (oldest truncated). Defaults to 10,000. */
  maxJoinsPerIdentity?: number;
}

export interface RoomHopObservation {
  status: "recorded" | "invalid_ts";
  counted: boolean;
}

export interface RoomHopEvaluateOptions {
  /** Evaluate windows ending at this ms timestamp. Defaults to the latest observed join. */
  asOfTs?: number;
}

export interface RoomHopResult {
  kind: "room-hop";
  /** True when the disarm rule fired: nobody is named, whatever the raw flags were. */
  disarmed: boolean;
  /** Flagged identities, sorted. Empty when disarmed. */
  flagged: string[];
  /** How many identities the raw law flagged (before any disarm). */
  flaggedCount: number;
  /** Identities with at least one join in the evaluated window. */
  trackedIdentities: number;
  /** Largest distinct-room count observed in any identity's window. */
  maxDistinctObserved: number;
  threshold: number;
  /** Always `"none"`: this module enforces nothing, about anyone. */
  enforcement: "none";
  notice: string;
}

export interface RoomHopSnapshot {
  enforcement: "none";
  threshold: number;
  windowMs: number;
  disarmShare: number;
  identities: number;
  counters: {
    observed: number;
    invalidTs: number;
    evictedIdentities: number;
    truncatedJoins: number;
  };
  notice: string;
}

export interface RoomHopSignalInstance {
  observe(event: RoomHopEvent): RoomHopObservation;
  evaluate(options?: RoomHopEvaluateOptions): RoomHopResult;
  snapshot(): RoomHopSnapshot;
}

/** Named error thrown for every invalid room-hop input. */
export class RoomHopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomHopError";
  }
}

const fail = (message: string): never => {
  throw new RoomHopError(`createRoomHopSignal: ${message}`);
};

function requireIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requireShare(value: unknown, field: string): number {
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
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value as string;
}

function isValidTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8.64e15;
}

export function createRoomHopSignal(
  options: CreateRoomHopSignalOptions = {},
): RoomHopSignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");
  const threshold = requireIntInRange(options.threshold ?? DEFAULT_THRESHOLD, "threshold", 1, 1_000_000);
  const windowMs = requirePositiveMs(options.windowMs ?? DEFAULT_WINDOW_MS, "windowMs");
  const disarmShare = requireShare(options.disarmShare ?? DEFAULT_DISARM_SHARE, "disarmShare");
  const maxIdentities = requireIntInRange(options.maxIdentities ?? 100_000, "maxIdentities", 1, 10_000_000);
  const maxJoinsPerIdentity = requireIntInRange(options.maxJoinsPerIdentity ?? 10_000, "maxJoinsPerIdentity", 1, 10_000_000);

  const joins = new Map<string, { room: string; ts: number }[]>();
  const lastSeen = new Map<string, number>();
  const counters = { observed: 0, invalidTs: 0, evictedIdentities: 0, truncatedJoins: 0 };
  let latestTs = -Infinity;

  function observe(event: RoomHopEvent): RoomHopObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    const identity = requireIdentity(event.identity, "event.identity");
    const room = requireIdentity(event.room, "event.room");
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      return { status: "invalid_ts", counted: false };
    }
    counters.observed++;
    if (event.ts > latestTs) latestTs = event.ts;
    if (!joins.has(identity)) {
      while (joins.size >= maxIdentities) {
        let oldestId: string | null = null;
        let oldestTs = Infinity;
        for (const [id, ts] of lastSeen) if (ts < oldestTs) { oldestTs = ts; oldestId = id; }
        if (oldestId === null) break;
        joins.delete(oldestId);
        lastSeen.delete(oldestId);
        counters.evictedIdentities++;
      }
      joins.set(identity, []);
    }
    const list = joins.get(identity) as { room: string; ts: number }[];
    list.push({ room, ts: event.ts });
    if (list.length > maxJoinsPerIdentity) {
      const excess = list.length - maxJoinsPerIdentity;
      list.splice(0, excess);
      counters.truncatedJoins += excess;
    }
    lastSeen.set(identity, Math.max(lastSeen.get(identity) ?? -Infinity, event.ts));
    return { status: "recorded", counted: true };
  }

  /** Max distinct rooms in any trailing window [end-windowMs, end] for one identity. */
  function maxDistinctInWindow(list: { room: string; ts: number }[], asOfTs: number): number {
    const sorted = list.filter((j) => j.ts <= asOfTs).sort((a, b) => a.ts - b.ts);
    let best = 0;
    let left = 0;
    const counts = new Map<string, number>();
    for (let right = 0; right < sorted.length; right++) {
      const rj = sorted[right] as { room: string; ts: number };
      counts.set(rj.room, (counts.get(rj.room) ?? 0) + 1);
      while (rj.ts - (sorted[left] as { room: string; ts: number }).ts > windowMs) {
        const lj = sorted[left] as { room: string; ts: number };
        const c = (counts.get(lj.room) as number) - 1;
        if (c <= 0) counts.delete(lj.room); else counts.set(lj.room, c);
        left++;
      }
      if (counts.size > best) best = counts.size;
    }
    return best;
  }

  function evaluate(evaluateOptions: RoomHopEvaluateOptions = {}): RoomHopResult {
    if (typeof evaluateOptions !== "object" || evaluateOptions === null) {
      fail("evaluate options must be an object");
    }
    const asOfTs = evaluateOptions.asOfTs !== undefined ? evaluateOptions.asOfTs : latestTs;
    if (asOfTs === -Infinity) {
      // No event observed yet: inert empty result, not an exception -
      // a scheduled evaluator before the first join is a no-op.
      return {
        kind: "room-hop",
        disarmed: false,
        flagged: [],
        flaggedCount: 0,
        trackedIdentities: 0,
        maxDistinctObserved: 0,
        threshold,
        enforcement: "none",
        notice: ADVISORY_NOTICE,
      };
    }
    if (!isValidTs(asOfTs)) fail("asOfTs must be a finite timestamp within the representable range");

    const flaggedRaw: string[] = [];
    let maxDistinctObserved = 0;
    let tracked = 0;
    for (const [identity, list] of joins) {
      if (!list.some((j) => j.ts > asOfTs - windowMs && j.ts <= asOfTs)) continue;
      tracked++;
      const d = maxDistinctInWindow(list, asOfTs);
      if (d > maxDistinctObserved) maxDistinctObserved = d;
      if (d >= threshold) flaggedRaw.push(identity);
    }
    const disarmed = tracked > 0 && flaggedRaw.length / tracked > disarmShare;
    return {
      kind: "room-hop",
      disarmed,
      flagged: disarmed ? [] : flaggedRaw.sort(),
      flaggedCount: flaggedRaw.length,
      trackedIdentities: tracked,
      maxDistinctObserved,
      threshold,
      enforcement: "none",
      notice: ADVISORY_NOTICE,
    };
  }

  function snapshot(): RoomHopSnapshot {
    return {
      enforcement: "none",
      threshold,
      windowMs,
      disarmShare,
      identities: joins.size,
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  return { observe, evaluate, snapshot };
}
