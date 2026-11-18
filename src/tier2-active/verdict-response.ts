/**
 * Verdict response construction (ABS-09): a verdict oracle must not
 * leak score or tags to the requester.
 *
 * The neighbour failure, measured in abs-lab (RESULTS-ABS-STEP0):
 * an allowed request carried its score (40) and tags in response
 * headers; a block body carried score 70 plus tags; a challenge
 * JSON carried score 75 plus tags; even a clean client was told its
 * score (0). The leak was unconditional - every response was an
 * oracle for the detector's internal state, so an attacker could
 * tune against the score one request at a time.
 *
 * antiRea's rule: evaluate() results, flow scores, signal tags and
 * their kin are HOST-SIDE telemetry. They go to operator logs and
 * callbacks, never into a response the requester can read. A
 * requester-facing answer carries only what the requester needs to
 * act: the action taken, a status, and optionally a retry hint.
 *
 * - `toPublicVerdictResponse` builds that shape from scratch: it
 *   reads only `action` and `retryAfterSec` from the internal
 *   result and copies nothing else, so a score or tag present on
 *   the internal object cannot ride along by accident.
 * - `findVerdictLeaks` scans a candidate response (headers object,
 *   parsed body, or any nested structure) for the forbidden field
 *   names, so a host can conformance-test its own response
 *   construction - including hand-rolled responses that never pass
 *   through `toPublicVerdictResponse`.
 *
 * Pure computation; zero runtime dependencies.
 */

/** Actions a requester-facing verdict response may name. */
export type PublicVerdictAction = "allow" | "challenge" | "block";

export interface PublicVerdictResponse {
  status: number;
  action: PublicVerdictAction;
  retryAfterSec?: number;
}

/** Named error thrown for invalid verdict-response inputs. */
export class VerdictResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerdictResponseError";
  }
}

const STATUS_BY_ACTION: Record<PublicVerdictAction, number> = {
  allow: 200,
  challenge: 429,
  block: 403,
};

/**
 * Build the requester-facing response for an internal verdict.
 * Only `action` and `retryAfterSec` are read; every other field on
 * the internal result (score, tags, reasons, signals) is internal
 * telemetry and is dropped by construction. Throws
 * `VerdictResponseError` on an unknown action - fail closed rather
 * than echo internal state in an improvised shape.
 */
export function toPublicVerdictResponse(internal: {
  action: unknown;
  retryAfterSec?: unknown;
  [key: string]: unknown;
}): PublicVerdictResponse {
  if (typeof internal !== "object" || internal === null) {
    throw new VerdictResponseError("toPublicVerdictResponse: internal verdict must be an object");
  }
  const action = internal.action;
  if (action !== "allow" && action !== "challenge" && action !== "block") {
    throw new VerdictResponseError(
      `toPublicVerdictResponse: action must be "allow" | "challenge" | "block", got ${JSON.stringify(action)}`,
    );
  }
  const out: PublicVerdictResponse = { status: STATUS_BY_ACTION[action as PublicVerdictAction], action: action as PublicVerdictAction };
  const retry = internal.retryAfterSec;
  if (typeof retry === "number" && Number.isFinite(retry) && retry > 0) {
    out.retryAfterSec = Math.floor(retry);
  }
  return out;
}

/**
 * Field names that mark a verdict leak when they appear as keys in
 * a requester-facing response, at any depth. Matching is
 * case-insensitive and treats "-" and "_" as equivalent, so
 * "X-AntiBot-Score" and "risk_score" are both caught.
 */
export const VERDICT_LEAK_KEYS: readonly string[] = [
  "score",
  "risk",
  "riskScore",
  "tags",
  "reasons",
  "signals",
  "x-antibot-score",
  "x-antibot-tags",
];

const normalizeKey = (key: string): string => key.toLowerCase().replace(/_/g, "-");
const LEAK_KEY_SET = new Set(VERDICT_LEAK_KEYS.map(normalizeKey));

/**
 * Scan a candidate requester-facing response for verdict leaks.
 * Returns the offending field names as they appear in the input
 * (empty array when clean). Recurses through plain objects and
 * arrays; primitives and null are clean by definition.
 */
export function findVerdictLeaks(value: unknown): string[] {
  const leaks: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (LEAK_KEY_SET.has(normalizeKey(key))) leaks.push(key);
      visit(child);
    }
  };
  visit(value);
  return leaks;
}
