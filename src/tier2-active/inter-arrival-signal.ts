/**
 * Inter-arrival stddev component (ABE-01, PASS-LAB Step 0, abe-lab
 * REGISTRATION-ABE-STEP0.md and RESULTS-ABE-STEP0.md, cycle C572).
 *
 * WHAT IT MEASURES. The population standard deviation of the gaps
 * between consecutive requests from one identity, over a sliding
 * window of the last 20 timestamps. A caller firing on a fixed or
 * near-fixed interval produces near-zero deviation; human clicking
 * produces wide deviation. The frozen lab law (burst_detector.go
 * port): window 20 timestamps, sessions with fewer than 5
 * timestamps are never evaluated, and the regularity line is a
 * population stddev below 50 ms.
 *
 * NEVER-SOLE-KEY, ENCODED STRUCTURALLY (binding restriction from
 * the registration, R-ABE-3). A perfectly regular human - a switch
 * or accessibility user clicking at a steady pace - is
 * indistinguishable from a fixed-interval bot by this signal
 * alone, and the lab measured that class at 200/200 regular. This
 * module therefore does not export a verdict at all:
 * - its output type is a COMPONENT (role "CORROBORATING" in the
 *   KT-01 sense): it carries the measured stddev and a descriptive
 *   regularity reading, plus soleKeyEligible: false, and no
 *   boolean flag, verdict, or blocked field exists on the type;
 * - the only eligibility-shaped helper,
 *   combineInterArrivalComponent, takes a second, independent
 *   signal's fired state as a required argument and reports
 *   eligible only when BOTH the component reads regular AND that
 *   second signal fired. There is no call shape that turns this
 *   component alone into an eligibility answer.
 * Hosts must combine it with a second signal or session context
 * before any consequence, exactly as the registration binds.
 *
 * WHAT THE LAB MEASURED (seeded simulation, abe01.cjs, seed
 * 20321101, 200 sessions per stratum unless noted; internal
 * validity only - NOT real-traffic rates):
 * - BOT-FIXED (interval exactly 1000 ms): regular 200/200.
 * - BOT-JITTER (intervals U(30,80) ms): regular 200/200.
 * - HUMAN (intervals U(200,800) ms): regular 0/200.
 * - HUMAN-FAST (intervals U(150,400) ms): regular 2/200.
 * - MINSAMPLES (2, 3 or 4 timestamps, 150 sessions): evaluated
 *   0/150 - the min-samples guard is part of the mechanism.
 * Descriptive (measured, not gated):
 * - BOT-JITTER-B (1000 ms plus or minus U(30,80) ms): regular
 *   only 14/200 at the 50 ms line, median stddev 55.354 ms. A bot
 *   jittering around a 1 s base mostly passes; that is the
 *   threshold's measured operating point.
 * - ACCESS-REGULAR (300 ms plus U(0,10) ms, the metronomic
 *   human): regular 200/200 - the disqualifying-as-sole-key FP
 *   class above.
 * - CGNAT-BATCH (bursts of 5 sharing one timestamp, 500 ms
 *   apart): regular 0/200, median stddev 182.321 ms.
 * - G4-COLLAPSE: a sub-ms bot (intervals U(0.05,0.15) ms) reads
 *   regular 0/200 evaluated under the source's millisecond-integer
 *   member model (duplicate timestamps collapse, so 5 samples
 *   never accumulate) but regular 200/200 on high-resolution
 *   timestamps. Any build must use high-resolution timestamps,
 *   never a millisecond-integer member encoding.
 *
 * HARD LIMITS.
 * - ADVISORY, CORROBORATING ONLY: enforcement: "none" on every
 *   output, role "CORROBORATING" on every component.
 * - HIGH-RESOLUTION TIMESTAMPS REQUIRED: the host must feed
 *   timestamps with sub-millisecond precision (float ms, for
 *   example from a monotonic high-resolution clock). Feeding
 *   integer-millisecond timestamps re-opens the measured G4
 *   collapse evasion for sub-ms callers; the module cannot detect
 *   which resolution it was fed, so the requirement is stated
 *   here as a host contract.
 * - The 50 ms line is the source's own operating point, measured
 *   not tuned: jittered bots around a 1 s base mostly pass it
 *   (14/200 above), and regular humans always trip it (200/200).
 *
 * Pure computation: no I/O, no runtime dependencies. State is one
 * bounded timestamp window per identity.
 */

const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_THRESHOLD_MS = 50;

const COMPONENT_NOTICE =
  "Corroborating component only (enforcement: none, soleKeyEligible: false): population " +
  "stddev of inter-arrival gaps over the last 20 high-resolution timestamps, read against " +
  "the 50 ms regularity line measured in the ABE-01 lab (fixed and small-interval bots " +
  "regular 200/200; ordinary humans 0/200; fast humans 2/200; a metronomic accessibility " +
  "user regular 200/200 - seeded simulation, abe-lab seed 20321101). A regular reading " +
  "is never a verdict: combine with a second independent signal before any consequence. " +
  "High-resolution timestamps are required; millisecond-integer timestamps reopen the " +
  "measured sub-ms collapse evasion.";

export interface InterArrivalEvent {
  /** The identity whose request stream this timestamp belongs to. */
  identity: string;
  /**
   * High-resolution timestamp in float milliseconds (sub-ms
   * precision). Integer-millisecond timestamps violate the host
   * contract in the header (G4 collapse).
   */
  ts: number;
}

export interface CreateInterArrivalSignalOptions {
  /** Timestamps kept per identity (the sliding window). Default 20 (lab law). */
  windowSize?: number;
  /** Timestamps an identity needs before any component is measured. Default 5 (lab law). */
  minSamples?: number;
  /** Regularity line in ms: stddev below this reads "regular". Default 50 (lab law). */
  thresholdMs?: number;
  /** Maximum identities retained (least recently seen evicted). Default 10000. */
  maxIdentities?: number;
}

export interface InterArrivalComponent {
  kind: "inter-arrival-stddev";
  /** KT-01 role: this component corroborates, it never grounds a consequence alone. */
  role: "CORROBORATING";
  /** Always false: the type-level statement of the never-sole-key restriction. */
  soleKeyEligible: false;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
  identity: string;
  /** "insufficient" until minSamples timestamps are in the window; then "measured". */
  status: "insufficient" | "measured";
  /** Population stddev of the window's consecutive gaps in ms, or null when insufficient. */
  stddevMs: number | null;
  /**
   * Descriptive regularity reading: "regular" iff a measured
   * stddev is below the threshold line. This is a description of
   * the timing shape, not a flag and not a verdict - a metronomic
   * human reads "regular" by construction (lab: 200/200).
   */
  regularity: "regular" | "irregular" | null;
  /** Timestamps currently in the window. */
  samples: number;
  /** Gaps the stddev ran over (samples - 1), or 0 when insufficient. */
  intervals: number;
  thresholdMs: number;
  notice: string;
}

export interface InterArrivalObservation {
  status: "recorded" | "invalid_ts";
  counted: boolean;
  component?: InterArrivalComponent;
}

export interface InterArrivalSnapshot {
  enforcement: "none";
  role: "CORROBORATING";
  soleKeyEligible: false;
  windowSize: number;
  minSamples: number;
  thresholdMs: number;
  identities: number;
  counters: {
    observed: number;
    invalidTs: number;
    evictedIdentities: number;
  };
  notice: string;
}

export interface InterArrivalSignalInstance {
  observe(event: InterArrivalEvent): InterArrivalObservation;
  /** The current component for one identity, without recording a timestamp. */
  component(identity: string): InterArrivalComponent;
  snapshot(): InterArrivalSnapshot;
  reset(identity?: string): void;
}

/**
 * The only eligibility-shaped combination for this component.
 * Eligibility requires BOTH a measured regular component AND a
 * second, independent signal fired - the caller must supply that
 * second signal's state; there is no default and no way to ask
 * about this component alone. Even an eligible result is only
 * eligibility for the host's own consequence policy, never a
 * consequence itself.
 */
export function combineInterArrivalComponent(
  component: InterArrivalComponent,
  corroboration: { independentSignalFired: boolean },
): { eligible: boolean; reason: "corroborated_regular" | "component_not_regular" | "no_corroboration" } {
  if (!corroboration || typeof corroboration.independentSignalFired !== "boolean") {
    throw new InterArrivalError(
      "combineInterArrivalComponent: corroboration.independentSignalFired (a second, independent signal) is required",
    );
  }
  if (component.status !== "measured" || component.regularity !== "regular") {
    return { eligible: false, reason: "component_not_regular" };
  }
  if (!corroboration.independentSignalFired) {
    return { eligible: false, reason: "no_corroboration" };
  }
  return { eligible: true, reason: "corroborated_regular" };
}

export class InterArrivalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterArrivalError";
  }
}

const fail = (message: string): never => {
  throw new InterArrivalError(`createInterArrivalSignal: ${message}`);
};

function requireIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requireKey(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    fail(`${field} must be a string of 1 to 1024 characters`);
  }
  return value as string;
}

function isValidTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8.64e15;
}

function populationStddev(xs: readonly number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  return Math.sqrt(variance);
}

export function createInterArrivalSignal(
  options: CreateInterArrivalSignalOptions = {},
): InterArrivalSignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");
  const windowSize = requireIntInRange(options.windowSize ?? DEFAULT_WINDOW_SIZE, "windowSize", 2, 1_000_000);
  const minSamples = requireIntInRange(options.minSamples ?? DEFAULT_MIN_SAMPLES, "minSamples", 2, windowSize);
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  if (typeof thresholdMs !== "number" || !Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    fail("thresholdMs must be a positive finite number");
  }
  const maxIdentities = requireIntInRange(options.maxIdentities ?? 10_000, "maxIdentities", 1, 1_000_000);

  const windows = new Map<string, number[]>();
  const lastSeen = new Map<string, number>();
  const counters = { observed: 0, invalidTs: 0, evictedIdentities: 0 };

  function componentFor(identity: string): InterArrivalComponent {
    const win = windows.get(identity) ?? [];
    const base = {
      kind: "inter-arrival-stddev" as const,
      role: "CORROBORATING" as const,
      soleKeyEligible: false as const,
      enforcement: "none" as const,
      identity,
      thresholdMs,
      notice: COMPONENT_NOTICE,
    };
    if (win.length < minSamples) {
      return { ...base, status: "insufficient", stddevMs: null, regularity: null, samples: win.length, intervals: 0 };
    }
    const intervals: number[] = [];
    for (let i = 1; i < win.length; i++) intervals.push((win[i] as number) - (win[i - 1] as number));
    const stddevMs = populationStddev(intervals);
    return {
      ...base,
      status: "measured",
      stddevMs,
      regularity: stddevMs < thresholdMs ? "regular" : "irregular",
      samples: win.length,
      intervals: intervals.length,
    };
  }

  function observe(event: InterArrivalEvent): InterArrivalObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    const identity = requireKey(event.identity, "event.identity");
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      return { status: "invalid_ts", counted: false };
    }
    counters.observed++;
    if (!windows.has(identity)) {
      while (windows.size >= maxIdentities) {
        let oldestId: string | null = null;
        let oldestTs = Infinity;
        for (const [id, ts] of lastSeen) if (ts < oldestTs) { oldestTs = ts; oldestId = id; }
        if (oldestId === null) break;
        windows.delete(oldestId);
        lastSeen.delete(oldestId);
        counters.evictedIdentities++;
      }
      windows.set(identity, []);
    }
    const win = windows.get(identity) as number[];
    win.push(event.ts);
    if (win.length > windowSize) win.splice(0, win.length - windowSize);
    lastSeen.set(identity, Math.max(lastSeen.get(identity) ?? -Infinity, event.ts));
    return { status: "recorded", counted: true, component: componentFor(identity) };
  }

  return {
    observe,
    component(identity: string): InterArrivalComponent {
      requireKey(identity, "identity");
      return componentFor(identity);
    },
    snapshot(): InterArrivalSnapshot {
      return {
        enforcement: "none",
        role: "CORROBORATING",
        soleKeyEligible: false,
        windowSize,
        minSamples,
        thresholdMs,
        identities: windows.size,
        counters: { ...counters },
        notice: COMPONENT_NOTICE,
      };
    },
    reset(identity?: string): void {
      if (identity === undefined) {
        windows.clear();
        lastSeen.clear();
      } else {
        windows.delete(identity);
        lastSeen.delete(identity);
      }
    },
  };
}
