/**
 * EvidenceReviewer hook - the defender-agent idea, cut down to its one
 * promotable slice (DEFENDER-AGENT.md verdict: LAB-ONLY as an autonomous
 * layer; Danny's design recorded 01-02/11/2026).
 *
 * The SDK side is ONLY an interface plus a one-way channel:
 *
 * - the SDK emits a BOUNDED evidence bundle (counts and scores, never
 *   raw record contents, never an unbounded event dump) for sessions in
 *   the ambiguous band;
 * - a reviewer - a cheap model, a rules engine, a human queue, anything
 *   the HOST runs on the HOST's side - reads the bundle and may return
 *   a proposal;
 * - proposals are validated against a strict schema and a FIXED action
 *   vocabulary of advisory verbs (`request_…`, `suggest_…`). There is
 *   no `deny`, no `set_budget`, no `ban` in the vocabulary, and a
 *   proposal carrying extra fields is rejected whole;
 * - validated proposals are delivered to the host's `onProposal`
 *   callback. The host decides. The reviewer holds no budget, moves no
 *   ceiling, and denies nothing.
 *
 * THE ONE-WAY RULE, enforced architecturally and by test: reviewer
 * output NEVER flows back into the calibrated evidence stream. The
 * reviewer's judgment is derived from the same observations the
 * accumulator already counted; feeding it back would count the same
 * evidence twice and silently corrupt the accumulator's false-alarm
 * semantics. This module therefore holds no reference to any evidence
 * engine and exposes no method that could write to one - the channel
 * object is exactly `{ invoke }`. A test wires the channel next to a
 * live CUSUM tripwire and proves its score and flag do not move.
 *
 * The reviewer also never sees real data: bundles carry aggregate
 * counts, scores and stream names only, so a fully prompt-injected
 * reviewer learns nothing worth exfiltrating and can do nothing worse
 * than propose - which the host may ignore.
 */

/** The fixed advisory vocabulary. Enforcement verbs do not exist here. */
export const REVIEWER_ACTIONS = [
  "no_action",
  "request_step_up",
  "request_human_review",
  "suggest_observe_extension",
  "suggest_exemption_review",
] as const;

export type ReviewerAction = (typeof REVIEWER_ACTIONS)[number];

/** Bounded, aggregate-only snapshot handed to the reviewer. */
export interface EvidenceBundle {
  cohortId: string | null;
  score: number;
  flagged: boolean;
  unionRecords: number;
  memberCount: number;
  /** Latest per-stream increments, aggregate numbers only. */
  streamIncrements: Record<string, number>;
  calibrationVersion: string;
  uncalibrated: boolean;
  generatedAtMs: number;
}

export interface EvidenceBundleSource {
  cohortId: string | null;
  score: number;
  flagged: boolean;
  unionRecords: number;
  memberCount: number;
  streamIncrements: Record<string, number>;
  calibrationVersion: string;
  uncalibrated: boolean;
}

/** Build a bundle, truncating the stream summary to a fixed bound. */
export function buildEvidenceBundle(
  source: EvidenceBundleSource,
  options: { maxStreamEntries?: number; now?: number } = {},
): EvidenceBundle {
  const maxEntries = Math.max(1, options.maxStreamEntries ?? 8);
  const entries = Object.entries(source.streamIncrements).slice(0, maxEntries);
  return {
    cohortId: source.cohortId,
    score: source.score,
    flagged: source.flagged,
    unionRecords: source.unionRecords,
    memberCount: source.memberCount,
    streamIncrements: Object.fromEntries(entries),
    calibrationVersion: source.calibrationVersion,
    uncalibrated: source.uncalibrated,
    generatedAtMs: options.now ?? Date.now(),
  };
}

export interface ReviewerProposal {
  action: ReviewerAction;
  /** Reviewer's self-reported confidence, 0..1. Advisory only. */
  confidence: number;
  /** Human-readable rationale, at most 500 characters. */
  rationale: string;
}

export type ReviewerProposalValidation =
  | { valid: true; proposal: ReviewerProposal }
  | { valid: false; errors: string[] };

const PROPOSAL_KEYS = new Set(["action", "confidence", "rationale"]);

/**
 * Strict schema validation for reviewer output. Anything the reviewer
 * returns that is not exactly a well-formed advisory proposal -
 * including enforcement-shaped objects like `{action: "deny"}` or
 * `{action: "request_step_up", setBudget: 0}` - is rejected whole.
 * This function never throws.
 */
export function validateReviewerProposal(raw: unknown): ReviewerProposalValidation {
  if (typeof raw !== "object" || raw === null) return { valid: false, errors: ["proposal is not an object"] };
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!PROPOSAL_KEYS.has(key)) errors.push(`unexpected field "${key}" - proposals carry no enforcement payload`);
  }
  const candidate = raw as Partial<ReviewerProposal>;
  if (typeof candidate.action !== "string" || !(REVIEWER_ACTIONS as readonly string[]).includes(candidate.action)) {
    errors.push(`action must be one of: ${REVIEWER_ACTIONS.join(", ")}`);
  }
  if (
    typeof candidate.confidence !== "number" ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    errors.push("confidence must be a finite number in [0, 1]");
  }
  if (typeof candidate.rationale !== "string" || candidate.rationale.length === 0 || candidate.rationale.length > 500) {
    errors.push("rationale must be a string of 1..500 characters");
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, proposal: candidate as ReviewerProposal };
}

/** What a host-side reviewer looks like. It returns UNTRUSTED output. */
export interface EvidenceReviewer {
  review(bundle: EvidenceBundle): Promise<unknown> | unknown;
}

export interface ReviewerChannelOptions {
  reviewer: EvidenceReviewer;
  /** Receives validated proposals. The host alone decides what they mean. */
  onProposal: (proposal: ReviewerProposal, bundle: EvidenceBundle) => void;
  /** Receives rejected raw output (schema violations, reviewer errors). */
  onRejected?: (raw: unknown, errors: string[]) => void;
}

export interface ReviewerInvocationResult {
  delivered: boolean;
  proposal?: ReviewerProposal;
  errors?: string[];
}

/**
 * The one-way channel. It holds a reviewer and two host callbacks -
 * and nothing else: no evidence engine, no budget, no ceiling, no
 * write path of any kind. `invoke` runs the reviewer on a bundle,
 * validates what comes back, and delivers or rejects it.
 */
export function createReviewerChannel(options: ReviewerChannelOptions): {
  invoke(bundle: EvidenceBundle): Promise<ReviewerInvocationResult>;
} {
  return {
    async invoke(bundle) {
      let raw: unknown;
      try {
        raw = await options.reviewer.review(bundle);
      } catch (error) {
        const errors = [`reviewer threw: ${error instanceof Error ? error.message : String(error)}`];
        if (options.onRejected) options.onRejected(undefined, errors);
        return { delivered: false, errors };
      }
      if (raw === null || raw === undefined) return { delivered: false, errors: ["reviewer returned no proposal"] };
      const validation = validateReviewerProposal(raw);
      if (!validation.valid) {
        if (options.onRejected) options.onRejected(raw, validation.errors);
        return { delivered: false, errors: validation.errors };
      }
      options.onProposal(validation.proposal, bundle);
      return { delivered: true, proposal: validation.proposal };
    },
  };
}
