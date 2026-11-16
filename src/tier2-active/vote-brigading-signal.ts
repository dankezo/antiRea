/**
 * Vote-brigading signal (live-room candidate CAND-273-4, lab pin
 * roomguard-lab/cand273-lab/REGISTRATION-CAND-273-4.md, results in
 * CAND273-RESULTS.md).
 *
 * WHAT IT MEASURES. Karaoke and watch-together rooms run on
 * votes: skip this song, queue that one. A small brigade of fresh
 * accounts voting together inside a few seconds can wreck an
 * evening - kill every song, bully a singer off the queue. The
 * signal watches the share of votes in each clock-aligned
 * `windowMs` window (default 60 s) that come from identities
 * created within `newnessWindowMs` (default 24 h) of their vote,
 * and accumulates it as one-sided evidence, CUSUM-style:
 *
 *   window score s = N - 0.5 * T   (only when T >= 5 votes;
 *                                   N = new-identity votes,
 *                                   T = all votes in the window)
 *   accumulator A = max(0, A + s)  over windows in time order.
 *
 * The room flags when A reaches `threshold` (default 12) with
 * contributions from at least `minWindows` distinct positive
 * windows (default 2). THE TWO-WINDOW RULE IS THE SIGNAL: in the
 * lab, a first-time raid audience mass-skipping one genuinely
 * hated song produced a single window of s = 9 - LARGER than one
 * brigade window (7.5). Any one-window flag kills the candidate
 * on that legitimate cell. A brigade, by definition, has to do
 * it again on the next song; a raid audience does not.
 *
 * WHAT THE LAB MEASURED (seeded simulation; internal validity
 * only - NOT real-traffic performance): legitimate karaoke weeks
 * (including an alternative-parameter population with 3x signups
 * and 35% bad-song skip rates) never moved the accumulator off 0;
 * the first-time raid cell peaked at A = 9 in exactly one window
 * and never flagged; the 15-bot brigade flagged after exactly
 * two wrecked songs (gate: before the third brigade song starts).
 *
 * This is a ROOM state in the population family: outputs name no
 * identity. The measured scope of `createVoteBrigadingSignal` is
 * the vote-skip axis; the queue-stuffing axis is covered by
 * `createQueueStuffingSignal` below, which transplants the same
 * law verbatim onto queue submissions. Queue stuffing was
 * measured in seeded simulation (PASS-LAB, CAND-273-4 stuffing
 * pin): its constants are harness-fitted and uncalibrated for
 * real traffic, aged-account stuffing is invisible by
 * construction, and stuffing whose new-identity share stays at
 * or below half of a room's submission volume is structurally
 * invisible. Brigades voting - and stuffers submitting - from
 * AGED accounts are also out of scope by construction: newness
 * is the estimand's main leg, stated as a limit, not hidden.
 *
 * SELF-DISARM, CONSIDERED AND NOT APPLIED (registered reasoning):
 * the C35-style suspension rule exists for signals whose output
 * can be poisoned into harming identities. This module names no
 * identity and its two-window accumulation is itself the
 * insurance - a one-off legitimate mass event structurally
 * cannot flag. If a future variant attaches per-identity
 * consequences, the disarm question must be reopened.
 *
 * FEEDING. One instance per room. Feed every vote (skip votes;
 * other vote kinds if the host wants them in T) with identity,
 * millisecond ts, and `accountCreatedTs` when known - otherwise
 * first observation stands in for creation time. `evaluate`
 * folds the stored per-window aggregates in time order, so it
 * is a deterministic function of state. For the queue factory,
 * feed every queue submission the same way, plus the optional
 * `songRef`: the reference is carried on the event but never
 * enters the statistic.
 *
 * HARD LIMITS.
 * - ADVISORY ONLY: `enforcement: "none"` on every output. The
 *   intended host response to a flag is friction for NEW voters
 *   (step-up via `createVerificationGrace`), never cancelling a
 *   session or naming voters.
 * - The accumulator's calibration is harness-fitted, like the
 *   project's other bundled tables: labeled uncalibrated for
 *   real traffic.
 *
 * Pure computation: no I/O, no runtime dependencies. State is
 * bounded: per-window aggregates past `maxWindows` evict the
 * oldest windows (the accumulator history before them is
 * forgotten, counted), and the identity registry is bounded by
 * `maxIdentities`.
 */

const DAY_MS = 86_400_000;

const DEFAULT_THRESHOLD = 12;
const DEFAULT_MIN_WINDOWS = 2;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MIN_WINDOW_VOTES = 5;
const DEFAULT_NEWNESS_WINDOW_MS = DAY_MS;

const ADVISORY_NOTICE =
  "Advisory telemetry only (enforcement: none): one-sided accumulated evidence that a room's votes " +
  "are being brigaded by new identities - each 60 s window scores N - 0.5*T (N = votes from " +
  "identities created within 24 h of voting, T = all votes, windows under 5 votes score 0), the " +
  "accumulator floors at 0, and the room flags only at A >= 12 with contributions from at least 2 " +
  "distinct windows. A single mass skip by first-time visitors cannot flag by construction (lab " +
  "peak A = 9, one window). No output names an identity. Scope is vote-skip only (queue stuffing " +
  "is the separate createQueueStuffingSignal in this module, measured in seeded simulation as " +
  "PASS-LAB), and brigades voting from aged accounts are out of scope by construction. " +
  "All lab numbers are seeded simulation (CAND-273-4 pin), uncalibrated for real traffic.";

const QUEUE_ADVISORY_NOTICE =
  "Advisory telemetry only (enforcement: none): one-sided accumulated evidence that a room's queue " +
  "submissions are being stuffed by new identities - each 60 s window scores N - 0.5*T (N = submissions " +
  "from identities created within 24 h of submitting, T = all submissions, windows under 5 submissions " +
  "score 0), the accumulator floors at 0, and the room flags only at A >= 12 with contributions from at " +
  "least 2 distinct windows. No output names an identity. Queue stuffing was measured in seeded " +
  "simulation only (PASS-LAB, CAND-273-4 stuffing pin): the constants are harness-fitted and " +
  "uncalibrated for real traffic; stuffing from aged accounts is invisible by construction, and " +
  "stuffing that keeps the new-identity share at or below half of a room's submission volume is " +
  "structurally invisible. Submission content (songRef) never enters the statistic.";

export interface VoteBrigadingEvent {
  /** The authenticated identity casting the vote. */
  identity: string;
  /** Millisecond timestamp of the vote. */
  ts: number;
  /** Account creation time (ms), when the host knows it; otherwise first observation stands in. */
  accountCreatedTs?: number;
}

export interface CreateVoteBrigadingSignalOptions {
  /** Accumulator level that flags the room. Default 12 (lab-frozen). */
  threshold?: number;
  /** Distinct positive windows that must contribute before a flag. Default 2 (lab-frozen; the separating leg). */
  minWindows?: number;
  /** Clock-aligned window length in ms. Default 60,000 (lab law). */
  windowMs?: number;
  /** Windows with fewer votes than this score 0. Default 5 (lab law). */
  minWindowVotes?: number;
  /** A vote counts as new when the identity was created less than this many ms before it. Default 86,400,000 (24 h). */
  newnessWindowMs?: number;
  /** Maximum window aggregates retained (oldest evicted). Defaults to 100,000 (~69 days of minutes). */
  maxWindows?: number;
  /** Maximum identities in the creation registry (least recently seen evicted). Defaults to 100,000. */
  maxIdentities?: number;
}

export interface VoteBrigadingObservation {
  status: "recorded" | "invalid_ts";
  counted: boolean;
}

export interface VoteBrigadingEvaluateOptions {
  /** Fold only windows ending at or before this ms timestamp. Defaults to all stored windows. */
  asOfTs?: number;
}

export interface VoteBrigadingResult {
  kind: "vote-brigading";
  flagged: boolean;
  /** End of the window at which the accumulator first crossed, or null. */
  firstFlagTs: number | null;
  /** The accumulator's final value over the folded windows. */
  accumulator: number;
  /** The accumulator's peak value over the folded windows. */
  maxAccumulator: number;
  /** Positive windows contributing to the run that flagged (or to the final run). */
  contributingWindows: number;
  /** Windows folded into this evaluation. */
  windows: number;
  threshold: number;
  /** Always `"none"`: this module enforces nothing, about anyone. */
  enforcement: "none";
  notice: string;
}

export interface VoteBrigadingSnapshot {
  enforcement: "none";
  threshold: number;
  minWindows: number;
  windowMs: number;
  windows: number;
  identities: number;
  counters: {
    observed: number;
    invalidTs: number;
    evictedWindows: number;
    evictedIdentities: number;
  };
  notice: string;
}

export interface VoteBrigadingSignalInstance {
  observe(event: VoteBrigadingEvent): VoteBrigadingObservation;
  evaluate(options?: VoteBrigadingEvaluateOptions): VoteBrigadingResult;
  snapshot(): VoteBrigadingSnapshot;
}

/**
 * One queue-submission event, as fed to {@link createQueueStuffingSignal}.
 * The vote-axis law transplanted verbatim (CAND-273-4 stuffing
 * registration): the event is a submission, not a vote.
 */
export interface QueueStuffingEvent {
  /** The authenticated identity submitting to the queue. */
  identity: string;
  /** Millisecond timestamp of the submission. */
  ts: number;
  /** Account creation time (ms), when the host knows it; otherwise first observation stands in. */
  accountCreatedTs?: number;
  /**
   * Reference to the submitted song/content. Carried on the event
   * for the host's own bookkeeping; it NEVER enters the statistic.
   */
  songRef?: string;
}

/** Options for {@link createQueueStuffingSignal}: identical in shape, defaults and frozen constants to the vote factory's. */
export interface CreateQueueStuffingSignalOptions extends CreateVoteBrigadingSignalOptions {}

export type QueueStuffingObservation = VoteBrigadingObservation;

export type QueueStuffingEvaluateOptions = VoteBrigadingEvaluateOptions;

export interface QueueStuffingResult extends Omit<VoteBrigadingResult, "kind"> {
  kind: "queue-stuffing";
}

export type QueueStuffingSnapshot = VoteBrigadingSnapshot;

export interface QueueStuffingSignalInstance {
  observe(event: QueueStuffingEvent): QueueStuffingObservation;
  evaluate(options?: QueueStuffingEvaluateOptions): QueueStuffingResult;
  snapshot(): QueueStuffingSnapshot;
}

/** The shared accumulator core's result: identical to the vote result except `kind` is the factory's own. */
interface BrigadingCoreResult extends Omit<VoteBrigadingResult, "kind"> {
  kind: string;
}

interface BrigadingCoreInstance {
  observe(event: VoteBrigadingEvent): VoteBrigadingObservation;
  evaluate(options?: VoteBrigadingEvaluateOptions): BrigadingCoreResult;
  snapshot(): VoteBrigadingSnapshot;
}

/** Named error thrown for every invalid vote-brigading input. */
export class VoteBrigadingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoteBrigadingError";
  }
}

/** Named error thrown for every invalid queue-stuffing input. */
export class QueueStuffingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueStuffingError";
  }
}

type FailFn = (message: string) => never;

function makeFail(factoryName: string, ErrorClass: new (message: string) => Error): FailFn {
  return (message: string): never => {
    throw new ErrorClass(`${factoryName}: ${message}`);
  };
}

function requireIntInRange(fail: FailFn, value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requirePositive(fail: FailFn, value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${field} must be a positive finite number`);
  }
  return value as number;
}

function requireIdentity(fail: FailFn, value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value as string;
}

function isValidTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8.64e15;
}

function createBrigadingSignalCore(
  options: CreateVoteBrigadingSignalOptions,
  config: { kind: string; notice: string; fail: FailFn },
): BrigadingCoreInstance {
  const fail = config.fail;
  if (typeof options !== "object" || options === null) fail("options must be an object");
  const threshold = requirePositive(fail, options.threshold ?? DEFAULT_THRESHOLD, "threshold");
  const minWindows = requireIntInRange(fail, options.minWindows ?? DEFAULT_MIN_WINDOWS, "minWindows", 1, 1_000_000);
  const windowMs = requirePositive(fail, options.windowMs ?? DEFAULT_WINDOW_MS, "windowMs");
  const minWindowVotes = requireIntInRange(fail, options.minWindowVotes ?? DEFAULT_MIN_WINDOW_VOTES, "minWindowVotes", 1, 1_000_000);
  const newnessWindowMs = requirePositive(fail, options.newnessWindowMs ?? DEFAULT_NEWNESS_WINDOW_MS, "newnessWindowMs");
  const maxWindows = requireIntInRange(fail, options.maxWindows ?? 100_000, "maxWindows", 1, 10_000_000);
  const maxIdentities = requireIntInRange(fail, options.maxIdentities ?? 100_000, "maxIdentities", 1, 10_000_000);

  const windows = new Map<number, { total: number; fresh: number }>();
  const created = new Map<string, number>();
  const counters = { observed: 0, invalidTs: 0, evictedWindows: 0, evictedIdentities: 0 };

  function observe(event: VoteBrigadingEvent): VoteBrigadingObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    const identity = requireIdentity(fail, event.identity, "event.identity");
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      return { status: "invalid_ts", counted: false };
    }
    if (event.accountCreatedTs !== undefined && !isValidTs(event.accountCreatedTs)) {
      fail("event.accountCreatedTs must be a finite timestamp within the representable range");
    }
    counters.observed++;
    if (!created.has(identity)) {
      while (created.size >= maxIdentities) {
        const oldest = created.keys().next().value as string;
        created.delete(oldest);
        counters.evictedIdentities++;
      }
      created.set(identity, event.accountCreatedTs !== undefined ? event.accountCreatedTs : event.ts);
    }
    const w = Math.floor(event.ts / windowMs);
    let rec = windows.get(w);
    if (!rec) {
      while (windows.size >= maxWindows) {
        const oldest = windows.keys().next().value as number;
        windows.delete(oldest);
        counters.evictedWindows++;
      }
      rec = { total: 0, fresh: 0 };
      windows.set(w, rec);
    }
    rec.total++;
    if (event.ts - (created.get(identity) as number) < newnessWindowMs) rec.fresh++;
    return { status: "recorded", counted: true };
  }

  function evaluate(evaluateOptions: VoteBrigadingEvaluateOptions = {}): BrigadingCoreResult {
    if (typeof evaluateOptions !== "object" || evaluateOptions === null) {
      fail("evaluate options must be an object");
    }
    const asOfTs = evaluateOptions.asOfTs;
    if (asOfTs !== undefined && !isValidTs(asOfTs)) {
      fail("asOfTs must be a finite timestamp within the representable range");
    }
    const sorted = [...windows.entries()]
      .filter(([w]) => asOfTs === undefined || (w + 1) * windowMs <= asOfTs)
      .sort((a, b) => a[0] - b[0]);
    let a = 0;
    let contrib = 0;
    let maxA = 0;
    let firstFlagTs: number | null = null;
    let contribAtFlag = 0;
    for (const [w, rec] of sorted) {
      const s = rec.total >= minWindowVotes ? rec.fresh - 0.5 * rec.total : 0;
      if (s > 0) contrib++;
      a = Math.max(0, a + s);
      if (a === 0) contrib = 0;
      if (a > maxA) maxA = a;
      if (firstFlagTs === null && a >= threshold && contrib >= minWindows) {
        firstFlagTs = (w + 1) * windowMs;
        contribAtFlag = contrib;
      }
    }
    return {
      kind: config.kind,
      flagged: firstFlagTs !== null,
      firstFlagTs,
      accumulator: a,
      maxAccumulator: maxA,
      contributingWindows: firstFlagTs !== null ? contribAtFlag : contrib,
      windows: sorted.length,
      threshold,
      enforcement: "none",
      notice: config.notice,
    };
  }

  function snapshot(): VoteBrigadingSnapshot {
    return {
      enforcement: "none",
      threshold,
      minWindows,
      windowMs,
      windows: windows.size,
      identities: created.size,
      counters: { ...counters },
      notice: config.notice,
    };
  }

  return { observe, evaluate, snapshot };
}

export function createVoteBrigadingSignal(
  options: CreateVoteBrigadingSignalOptions = {},
): VoteBrigadingSignalInstance {
  return createBrigadingSignalCore(options, {
    kind: "vote-brigading",
    notice: ADVISORY_NOTICE,
    fail: makeFail("createVoteBrigadingSignal", VoteBrigadingError),
  }) as unknown as VoteBrigadingSignalInstance;
}

/**
 * Queue-stuffing signal: the vote-brigading accumulator law
 * transplanted VERBATIM onto the queue-submission stream
 * (CAND-273-4 stuffing axis, PASS-LAB in seeded simulation - see
 * the module header for the measured scope and its limits).
 * One instance per room; feed every queue submission. Output is
 * a room state naming no identity, advisory, enforcement "none".
 */
export function createQueueStuffingSignal(
  options: CreateQueueStuffingSignalOptions = {},
): QueueStuffingSignalInstance {
  const queueFail = makeFail("createQueueStuffingSignal", QueueStuffingError);
  const core = createBrigadingSignalCore(options, {
    kind: "queue-stuffing",
    notice: QUEUE_ADVISORY_NOTICE,
    fail: queueFail,
  });
  return {
    observe(event: QueueStuffingEvent): QueueStuffingObservation {
      if (
        typeof event === "object" &&
        event !== null &&
        event.songRef !== undefined &&
        typeof event.songRef !== "string"
      ) {
        queueFail("event.songRef must be a string when present");
      }
      // songRef is carried on the event; the core never reads it,
      // so submission content cannot enter the statistic.
      return core.observe(event);
    },
    evaluate(evaluateOptions?: QueueStuffingEvaluateOptions): QueueStuffingResult {
      return core.evaluate(evaluateOptions) as unknown as QueueStuffingResult;
    },
    snapshot(): QueueStuffingSnapshot {
      return core.snapshot();
    },
  };
}
