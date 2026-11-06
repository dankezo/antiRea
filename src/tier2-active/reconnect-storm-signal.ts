/**
 * Reconnect-storm signal (live-room candidate CAND-273-6, lab pin
 * roomguard-lab/cand273-lab/REGISTRATION-CAND-273-6.md, results in
 * CAND273-RESULTS.md).
 *
 * WHAT IT MEASURES. The wetube case's crash shape - a room's
 * realtime server dying and reviving - can be CAUSED at the app
 * layer by reconnect abuse: a source cycling connect/disconnect
 * at sub-second cadence forces the server to redo handshake,
 * auth and room-state work thousands of times. A host CAN feed
 * this signal: socket servers expose connect/disconnect hooks in
 * app code, so the event stream is host-owned data, not
 * packet-level telemetry. Feed every connect and disconnect per
 * source (a session/account key - NOT an IP; carrier NAT makes
 * IPs shared, and a storm source is identified by its own event
 * stream, never grouped by address).
 *
 * The law needs TWO legs, and the lab showed why: rate alone is
 * not enough. A source flags when, inside some trailing
 * `windowMs` (default 10 min), it opens at least `minConnects`
 * sessions (default 40) AND the median duration of the sessions
 * starting in that window is under `maxMedianDurationMs`
 * (default 5 s). Legitimate reconnect pain is real but shaped
 * differently: flaky phones reconnect a handful of times per
 * dropout episode; commuters on trains cycle longer sessions.
 *
 * WHAT THE LAB MEASURED (seeded simulation of socket event
 * streams; internal validity only - NOT real-traffic
 * performance): stable sources peaked at 2 connects / 10 min;
 * flaky-network sources (3 dropout episodes a day, 3-15 s
 * retries) at 13; heavy commuters (2 dead-zone episodes a day on
 * tight retry cycles, 2-8 minute rides between) at 21 - none
 * flagged. Storm sources cycling 0.2-1.5 s sessions for 30
 * minutes were flagged 20/20 inside their first evaluation
 * window, peaking at 549 connects / 10 min.
 *
 * THE DOCUMENTED BLIND SPOT. A DISTRIBUTED storm - 200 sources
 * each cycling just 25 times per 10 minutes - flags 0 sources
 * under this law, and the pin deliberately registered NO
 * population-level gate: the legitimate commuter cell's
 * population total reaches 417 connects / 10 min (a train
 * emptying into a dead zone at rush hour looks like that), so no
 * population line separated storm from commute with margin. The
 * per-source rate law is what ships; distributed low-rate storms
 * remain a host-infrastructure problem (connection-rate limits at
 * the socket layer), stated here as a limit, not hidden.
 *
 * SELF-DISARM (C35 pattern): if more than `disarmShare` (default
 * 25%) of tracked sources would flag in one evaluation, the
 * evaluation names NOBODY and reports `disarmed: true` - that
 * shape means the platform itself is flapping (a bad deploy
 * reconnecting every client IS a fleet-wide storm), and the
 * module's job flips from accusation to silence. The intended
 * host response to a flag is friction (backoff enforcement /
 * step-up), never punishment of the source's user.
 *
 * HARD LIMITS.
 * - ADVISORY ONLY: `enforcement: "none"` on every output.
 * - Open sessions (no disconnect yet) count toward the connect
 *   rate but not toward the median until they close; evaluate
 *   after disconnects land for the duration leg to bite.
 * - All lab numbers are seeded simulation (CAND-273-6 pin).
 *
 * Pure computation: no I/O, no runtime dependencies. State is
 * bounded: per-source event lists truncate past
 * `maxEventsPerSource` (oldest first, counted) and sources past
 * `maxSources` are evicted least-recently-seen first.
 */

const DEFAULT_MIN_CONNECTS = 40;
const DEFAULT_WINDOW_MS = 600_000;
const DEFAULT_MAX_MEDIAN_DURATION_MS = 5_000;
const DEFAULT_DISARM_SHARE = 0.25;

const ADVISORY_NOTICE =
  "Advisory telemetry only (enforcement: none): sources opening at least 40 sessions in a trailing " +
  "10 minutes whose median session duration in that window is under 5 s - a reconnect-storm shape " +
  "measured against legitimate reconnect pain (lab maxima: 2 connects/10 min stable, 13 flaky " +
  "phones, 21 heavy commuters; storm sources 20/20 flagged). Respond with friction (backoff, " +
  "step-up), never punishment. Documented blind spot: a storm distributed so each source stays " +
  "under the per-source rate flags nobody - no population gate is registered, because legitimate " +
  "rush-hour commutes reach 417 connects/10 min at population level. If more than 25% of sources " +
  "would flag, the evaluation disarms and names nobody (the platform itself is flapping). All lab " +
  "numbers are seeded simulation (CAND-273-6 pin), not real-traffic performance.";

export interface ReconnectStormEvent {
  /** The source key (session/account key - NOT an IP address). */
  source: string;
  kind: "connect" | "disconnect";
  /** Millisecond timestamp of the socket event. */
  ts: number;
}

export interface CreateReconnectStormSignalOptions {
  /** Minimum connects inside the trailing window for the rate leg. Default 40 (lab-frozen). */
  minConnects?: number;
  /** Trailing window length in ms. Default 600,000 (10 min, lab law). */
  windowMs?: number;
  /** The median session duration inside the window must be under this, in ms. Default 5,000 (lab-frozen). */
  maxMedianDurationMs?: number;
  /** Flagged share of tracked sources above which the evaluation disarms and names nobody. Default 0.25. */
  disarmShare?: number;
  /** Maximum sources retained (least recently seen evicted). Defaults to 100,000. */
  maxSources?: number;
  /** Maximum events retained per source (oldest truncated). Defaults to 100,000. */
  maxEventsPerSource?: number;
}

export interface ReconnectStormObservation {
  status: "recorded" | "invalid_ts";
  counted: boolean;
}

export interface ReconnectStormEvaluateOptions {
  /** Evaluate windows ending at this ms timestamp. Defaults to the latest observed event. */
  asOfTs?: number;
}

export interface ReconnectStormResult {
  kind: "reconnect-storm";
  /** True when the disarm rule fired: nobody is named, whatever the raw flags were. */
  disarmed: boolean;
  /** Flagged sources, sorted. Empty when disarmed. */
  flagged: string[];
  /** How many sources the raw law flagged (before any disarm). */
  flaggedCount: number;
  /** Sources with at least one connect in the evaluated window. */
  trackedSources: number;
  /** Largest connect count observed in any source's window. */
  maxConnectsObserved: number;
  /** Always `"none"`: this module enforces nothing, about anyone. */
  enforcement: "none";
  notice: string;
}

export interface ReconnectStormSnapshot {
  enforcement: "none";
  minConnects: number;
  windowMs: number;
  maxMedianDurationMs: number;
  disarmShare: number;
  sources: number;
  counters: {
    observed: number;
    invalidTs: number;
    /** Disconnects with no open connect to pair with. */
    orphanDisconnects: number;
    evictedSources: number;
    truncatedEvents: number;
  };
  notice: string;
}

export interface ReconnectStormSignalInstance {
  observe(event: ReconnectStormEvent): ReconnectStormObservation;
  evaluate(options?: ReconnectStormEvaluateOptions): ReconnectStormResult;
  snapshot(): ReconnectStormSnapshot;
}

/** Named error thrown for every invalid reconnect-storm input. */
export class ReconnectStormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconnectStormError";
  }
}

const fail = (message: string): never => {
  throw new ReconnectStormError(`createReconnectStormSignal: ${message}`);
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

function requireSource(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value as string;
}

function isValidTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8.64e15;
}

interface SourceState {
  /** Sessions in arrival order: connect ts + disconnect ts (null while open). */
  sessions: { start: number; end: number | null }[];
  /** FIFO stack of open session indexes awaiting a disconnect. */
  open: number[];
}

export function createReconnectStormSignal(
  options: CreateReconnectStormSignalOptions = {},
): ReconnectStormSignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");
  const minConnects = requireIntInRange(options.minConnects ?? DEFAULT_MIN_CONNECTS, "minConnects", 1, 1_000_000);
  const windowMs = requirePositiveMs(options.windowMs ?? DEFAULT_WINDOW_MS, "windowMs");
  const maxMedianDurationMs = requirePositiveMs(options.maxMedianDurationMs ?? DEFAULT_MAX_MEDIAN_DURATION_MS, "maxMedianDurationMs");
  const disarmShare = requireShare(options.disarmShare ?? DEFAULT_DISARM_SHARE, "disarmShare");
  const maxSources = requireIntInRange(options.maxSources ?? 100_000, "maxSources", 1, 10_000_000);
  const maxEventsPerSource = requireIntInRange(options.maxEventsPerSource ?? 100_000, "maxEventsPerSource", 1, 10_000_000);

  const sources = new Map<string, SourceState>();
  const lastSeen = new Map<string, number>();
  const counters = { observed: 0, invalidTs: 0, orphanDisconnects: 0, evictedSources: 0, truncatedEvents: 0 };
  let latestTs = -Infinity;

  function observe(event: ReconnectStormEvent): ReconnectStormObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    if (event.kind !== "connect" && event.kind !== "disconnect") {
      fail('event.kind must be "connect" or "disconnect"');
    }
    const source = requireSource(event.source, "event.source");
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      return { status: "invalid_ts", counted: false };
    }
    counters.observed++;
    if (event.ts > latestTs) latestTs = event.ts;
    if (!sources.has(source)) {
      while (sources.size >= maxSources) {
        let oldestId: string | null = null;
        let oldestTs = Infinity;
        for (const [id, ts] of lastSeen) if (ts < oldestTs) { oldestTs = ts; oldestId = id; }
        if (oldestId === null) break;
        sources.delete(oldestId);
        lastSeen.delete(oldestId);
        counters.evictedSources++;
      }
      sources.set(source, { sessions: [], open: [] });
    }
    const state = sources.get(source) as SourceState;
    if (event.kind === "connect") {
      state.sessions.push({ start: event.ts, end: null });
      state.open.push(state.sessions.length - 1);
      while (state.sessions.length > maxEventsPerSource) {
        state.sessions.shift();
        state.open = state.open.map((i) => i - 1).filter((i) => i >= 0);
        counters.truncatedEvents++;
      }
    } else {
      const idx = state.open.shift();
      if (idx === undefined || state.sessions[idx] === undefined) {
        counters.orphanDisconnects++;
      } else {
        state.sessions[idx].end = event.ts;
      }
    }
    lastSeen.set(source, Math.max(lastSeen.get(source) ?? -Infinity, event.ts));
    return { status: "recorded", counted: true };
  }

  /**
   * The storm law over windows anchored at each connect: rate leg
   * = connects in (anchor - windowMs, anchor]; duration leg =
   * median duration of CLOSED sessions starting in that window
   * (must exist and be under the cap).
   */
  function sourceFlagged(state: SourceState, asOfTs: number): { flagged: boolean; maxConnects: number } {
    const starts = state.sessions.filter((s) => s.start <= asOfTs);
    let maxConnects = 0;
    for (let i = 0; i < starts.length; i++) {
      const anchor = (starts[i] as { start: number }).start;
      const inWindow = starts.filter((s) => s.start > anchor - windowMs && s.start <= anchor);
      if (inWindow.length > maxConnects) maxConnects = inWindow.length;
      if (inWindow.length < minConnects) continue;
      const durations = inWindow
        .filter((s) => s.end !== null)
        .map((s) => (s.end as number) - s.start)
        .sort((a, b) => a - b);
      if (durations.length === 0) continue;
      const mid = Math.floor(durations.length / 2);
      const median = durations.length % 2 === 1
        ? (durations[mid] as number)
        : ((durations[mid - 1] as number) + (durations[mid] as number)) / 2;
      if (median < maxMedianDurationMs) return { flagged: true, maxConnects };
    }
    return { flagged: false, maxConnects };
  }

  function evaluate(evaluateOptions: ReconnectStormEvaluateOptions = {}): ReconnectStormResult {
    if (typeof evaluateOptions !== "object" || evaluateOptions === null) {
      fail("evaluate options must be an object");
    }
    const asOfTs = evaluateOptions.asOfTs !== undefined ? evaluateOptions.asOfTs : latestTs;
    if (asOfTs === -Infinity) {
      // No event observed yet: inert empty result, not an exception -
      // a scheduled evaluator before the first connect is a no-op.
      return {
        kind: "reconnect-storm",
        disarmed: false,
        flagged: [],
        flaggedCount: 0,
        trackedSources: 0,
        maxConnectsObserved: 0,
        enforcement: "none",
        notice: ADVISORY_NOTICE,
      };
    }
    if (!isValidTs(asOfTs)) fail("asOfTs must be a finite timestamp within the representable range");

    const flaggedRaw: string[] = [];
    let maxConnectsObserved = 0;
    let tracked = 0;
    for (const [source, state] of sources) {
      if (!state.sessions.some((s) => s.start > asOfTs - windowMs && s.start <= asOfTs)) continue;
      tracked++;
      const r = sourceFlagged(state, asOfTs);
      if (r.maxConnects > maxConnectsObserved) maxConnectsObserved = r.maxConnects;
      if (r.flagged) flaggedRaw.push(source);
    }
    const disarmed = tracked > 0 && flaggedRaw.length / tracked > disarmShare;
    return {
      kind: "reconnect-storm",
      disarmed,
      flagged: disarmed ? [] : flaggedRaw.sort(),
      flaggedCount: flaggedRaw.length,
      trackedSources: tracked,
      maxConnectsObserved,
      enforcement: "none",
      notice: ADVISORY_NOTICE,
    };
  }

  function snapshot(): ReconnectStormSnapshot {
    return {
      enforcement: "none",
      minConnects,
      windowMs,
      maxMedianDurationMs,
      disarmShare,
      sources: sources.size,
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  return { observe, evaluate, snapshot };
}
