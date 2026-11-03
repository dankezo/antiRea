/**
 * Post-verification grace (ân hạn sau xác minh).
 *
 * Why this exists (operator's ruling, 2026-11-03): under the default
 * law an inferred-evidence flag enrolls step-up friction, and the
 * flag's evidence is a PATTERN, not an event - it stays hot for as
 * long as the pattern continues. A legitimate user whose work pattern
 * resembles a bot's (an accessibility tool with a fixed rhythm, a
 * power user driving a systematic review from a script of their own)
 * can therefore be asked to step up AGAIN AND AGAIN: they pass the
 * challenge, the pattern continues, the evidence is still over the
 * line, the next crossing re-enrolls them. Before this module the SDK
 * had no "verified once, left alone for a while" state.
 *
 * Semantics, kept deliberately narrow:
 *
 * - Grace shields STEP-UP FRICTION ONLY. It never raises a budget,
 *   never lifts a ceiling, never disables the soft budget step-down,
 *   never touches quota or action-budget accounting: those live in
 *   modules this one holds no reference to, so the shield cannot
 *   reach them structurally (the same one-way shape as the reviewer
 *   channel). An attacker who passes one step-up challenge buys a
 *   quieter day at the friction tier - the record budget and cohort
 *   ceilings keep metering every record they take during it.
 * - Grace is PER IDENTITY. A sybil herd gains nothing from it: each
 *   rotated identity must pass its own step-up to earn its own grace,
 *   and the cohort-level meters (disclosure ledger, herd detector,
 *   action cohorts) aggregate across identities regardless of any
 *   member's grace state. Grace is a false-positive shock absorber,
 *   not an anti-sybil mechanism, and is not claimed as one.
 * - Grace BREAKS on escalation. While evidence stays below
 *   `escalationFactor` x the normal flag threshold, step-up is
 *   suppressed; the first evaluation at or above that threshold voids
 *   the grace on the spot (latched - it does not quietly resume when
 *   evidence dips) and step-up applies immediately, without waiting
 *   for the window to expire. To earn grace again the identity must
 *   pass step-up again, which re-baselines the record.
 * - Grace is a DURATION, so it is measured on a monotonic clock
 *   (L-DEEP-2 discipline): an NTP step or a VM clock correction can
 *   neither stretch it (a legitimate user held in friction past the
 *   design) nor shrink it (free friction relief). Wall-clock readings
 *   are recorded for audit display only and never feed the arithmetic.
 * - Telemetry is untouched: engines keep scoring, flags keep firing,
 *   snapshots keep listing the identity. Grace gates one consequence
 *   (step-up enrollment), exactly the layer where the protected-cohort
 *   registry gates its own - the two lanes are independent: a
 *   host-declared protected subject never needs grace, and grace never
 *   overrides a host-authorized consequence (a declared cohort's
 *   ceiling is the host's own decision, not inferred friction).
 *
 * Host wiring (two calls):
 *
 * 1. When an identity PASSES a step-up challenge, record it:
 *    `grace.recordVerified(identity, { evidenceLevel: scoreAtPass })`.
 * 2. Before enrolling step-up for an identity - from a tripwire
 *    decision with `action: "step_up"`, from a flag snapshot's
 *    consequence targets, or from an `onConsequenceEligibility`
 *    handler - gate it: `grace.guardStepUp(identity, currentScore)`
 *    collapses the action to `observe` while grace holds, and returns
 *    `step_up` unchanged when there is no grace, when it expired, or
 *    when the evaluation itself broke it by escalation.
 *
 * The `evidenceLevel` is expressed in whatever units the host's flag
 * threshold uses: pass the same score the flag decision was made on
 * (a raw CUSUM score, a normalized ratio-to-threshold, ...) and set
 * `flagThreshold` to the level that normally triggers step-up in
 * those units. The module never invents an evidence scale.
 */

import { resolveIntervalClock } from "../internal/mono-clock";
import type { EnforcementAction } from "./enforcement-tiering";

/** Default grace window: 24 h (see the factory docs for the rationale). */
export const DEFAULT_GRACE_WINDOW_MS = 86_400_000;
/** Default escalation factor over the flag threshold. */
export const DEFAULT_GRACE_ESCALATION_FACTOR = 2;
/** Default cap on identities with a grace record. */
export const DEFAULT_GRACE_MAX_IDENTITIES = 2_000;

export interface VerificationGraceOptions {
  /**
   * How long a passed step-up shields the identity from repeat
   * step-up at ordinary evidence levels, in milliseconds, measured
   * on the monotonic clock. Default 86,400,000 (24 h): the codebase's
   * existing day-scale rhythm (echo-id TTL, record-budget window) and
   * the human scale of the complaint this fixes - a falsely flagged
   * legitimate user is not re-challenged inside the same day of work -
   * while a verified-then-hostile identity's low-friction window
   * stays bounded to one day (budgets and ceilings bite throughout
   * it regardless). Range: 1 s to 30 days; a sub-second window is
   * almost certainly a seconds/milliseconds unit mistake.
   */
  graceWindowMs?: number;
  /**
   * The evidence level, in the host's own units, at which step-up is
   * normally recommended (the flag threshold the host's engine
   * crossed). Default 1, which suits hosts feeding a normalized
   * ratio-to-threshold; hosts feeding a raw CUSUM score should pass
   * their boundary B = ln(1/alpha). Must be finite and > 0.
   */
  flagThreshold?: number;
  /**
   * Escalation multiple of `flagThreshold`: at or above
   * `flagThreshold * escalationFactor`, grace breaks immediately and
   * step-up applies again. Default 2 - clearly above the flag level,
   * not at its edge; for scores in log-likelihood units (the CUSUM
   * tripwire) doubling the boundary in nats squares the likelihood
   * ratio, so the default demands a decisive escalation, not noise.
   * Must be finite and > 1 (a factor of 1 would void every grace at
   * the moment it is granted). NOT calibrated on real traffic - see
   * docs/LIMITATIONS.md.
   */
  escalationFactor?: number;
  /**
   * Cap on identities holding a grace record; beyond it the oldest
   * record is evicted. Eviction fails toward MORE friction (the
   * evicted identity simply loses its shield early), never less.
   * Default 2,000 (the CUSUM tripwire's state cap).
   */
  maxIdentities?: number;
  /** Wall clock override (audit timestamps only), mainly for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Monotonic clock override: the only clock grace arithmetic reads.
   * Resolution follows the L-DEEP-2 rule (see
   * `src/internal/mono-clock.ts`): injecting `now` without `monoNow`
   * keeps single-clock behavior; injecting neither splits the clocks.
   */
  monoNow?: () => number;
}

export interface VerificationGraceRecordInput {
  /**
   * The identity's evidence level at the moment it passed step-up, in
   * the same units as `flagThreshold`. Recorded verbatim for audit
   * (verdicts report it as `baselineEvidence`); the escalation line
   * is computed from `flagThreshold`, not from this value.
   */
  evidenceLevel?: number;
  /** Why/how the identity verified, in the host's words. Recorded verbatim; never interpreted. */
  reason?: string;
}

export interface VerificationGraceRecord {
  identity: string;
  /** Wall-clock instant the verification was recorded (audit display only). */
  verifiedAtMs: number;
  /**
   * Monotonic-scale instant the grace expires. Enforcement compares
   * monotonic readings against monotonic readings; this value sits on
   * roughly the wall scale (see mono-clock.ts) for operator display.
   */
  graceExpiresAtMonoMs: number;
  graceWindowMs: number;
  /** Evidence level recorded at verification, or null when the host did not supply one. */
  baselineEvidence: number | null;
  reason: string | null;
  /** How many times this identity has (re-)verified on this instance, including this record. */
  verifications: number;
}

export type VerificationGraceReason =
  | "no_grace"
  | "in_grace"
  | "grace_expired"
  | "grace_broken_escalation"
  | "invalid_evidence";

export interface VerificationGraceVerdict {
  identity: string;
  /** True while a live (unexpired, unbroken) grace record covers the identity at evaluation time. */
  inGrace: boolean;
  /** True when this evaluation says step-up must NOT be re-applied. */
  stepUpSuppressed: boolean;
  /**
   * True only on the evaluation that itself broke the grace by
   * escalation; later evaluations report the broken state with
   * `escalated: false` (the break is history, not news).
   */
  escalated: boolean;
  reason: VerificationGraceReason;
  /** The evidence level this verdict was computed on (echoed; NaN when `invalid_evidence`). */
  evidenceLevel: number;
  /** `flagThreshold * escalationFactor` - the line that breaks grace. */
  escalationThreshold: number;
  /** Monotonic milliseconds of grace left; null when no live grace applies. */
  graceRemainingMs: number | null;
  /** Evidence level recorded at verification, or null when absent/no record. */
  baselineEvidence: number | null;
}

export interface VerificationGraceStepUpVerdict extends VerificationGraceVerdict {
  /** The action that may be applied: `observe` while suppressed, `step_up` otherwise. */
  action: Extract<EnforcementAction, "observe" | "step_up">;
}

export interface VerificationGraceSnapshot {
  /** Identities holding any record (live, expired or broken). */
  identities: number;
  /** Records currently shielding their identity. */
  active: number;
  /** Records latched broken by escalation (until re-verification or eviction). */
  broken: number;
  /** Records whose window has elapsed without an escalation break. */
  expired: number;
  graceWindowMs: number;
  flagThreshold: number;
  escalationFactor: number;
  escalationThreshold: number;
}

export interface VerificationGrace {
  /**
   * Record that an identity PASSED a step-up challenge just now.
   * Replaces any previous record for the identity (re-verification
   * after an escalation break re-baselines the grace) and returns the
   * stored record.
   */
  recordVerified(identity: string, record?: VerificationGraceRecordInput): VerificationGraceRecord;
  /**
   * Evaluate one identity at one evidence level. While grace holds
   * and evidence is below the escalation line, `stepUpSuppressed` is
   * true. An evaluation at or above the line LATCHES the record
   * broken as a side effect and reports `escalated: true` - callers
   * must not treat evaluate as a pure read for evidence they do not
   * stand behind. A non-finite evidence level never poisons state: it
   * returns an `invalid_evidence` verdict that suppresses nothing
   * (pre-grace behavior), mirroring the tripwire's invalid-input rule.
   */
  evaluate(identity: string, evidenceLevel: number): VerificationGraceVerdict;
  /**
   * The one-line host gate, mirroring
   * `createProtectedCohortRegistry`'s `guardInferredConsequence`:
   * identical to `evaluate`, plus the consequence collapses to
   * `observe` while suppressed and stays `step_up` otherwise.
   */
  guardStepUp(identity: string, evidenceLevel: number): VerificationGraceStepUpVerdict;
  /** True while a live grace record covers the identity (time/state only; no evidence input). */
  isInGrace(identity: string): boolean;
  /** Drop an identity's record entirely. Returns true when one existed. */
  forget(identity: string): boolean;
  /** State summary for operator tooling. */
  snapshot(): VerificationGraceSnapshot;
}

/** Named error thrown for every invalid verification-grace input. */
export class VerificationGraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationGraceError";
  }
}

const fail = (message: string): never => {
  throw new VerificationGraceError(`createVerificationGrace: ${message}`);
};

const hasControlOrNewline = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value);

function requireIdentity(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("identity must be a non-empty string");
  }
  if (hasControlOrNewline(value as string)) {
    fail("identity must be a single line (no control characters or newlines)");
  }
  return value as string;
}

function requireFiniteInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${field} must be a finite number between ${min} and ${max}`);
  }
  return value as number;
}

function requirePositiveFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${field} must be a finite number > 0`);
  }
  return value as number;
}

function requireIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

interface GraceState {
  verifiedMonoMs: number;
  verifiedWallMs: number;
  baselineEvidence: number | null;
  reason: string | null;
  verifications: number;
  broken: boolean;
  brokenMonoMs: number | null;
  brokenEvidence: number | null;
}

export function createVerificationGrace(
  options: VerificationGraceOptions = {},
): VerificationGrace {
  const graceWindowMs =
    options.graceWindowMs === undefined
      ? DEFAULT_GRACE_WINDOW_MS
      : requireFiniteInRange(options.graceWindowMs, "graceWindowMs", 1_000, 2_592_000_000);
  const flagThreshold =
    options.flagThreshold === undefined
      ? 1
      : requirePositiveFinite(options.flagThreshold, "flagThreshold");
  const escalationFactor =
    options.escalationFactor === undefined
      ? DEFAULT_GRACE_ESCALATION_FACTOR
      : requireFiniteInRange(options.escalationFactor, "escalationFactor", 1.000_001, 10_000);
  const maxIdentities =
    options.maxIdentities === undefined
      ? DEFAULT_GRACE_MAX_IDENTITIES
      : requireIntInRange(options.maxIdentities, "maxIdentities", 1, 1_000_000);
  const escalationThreshold = flagThreshold * escalationFactor;

  const clocks = resolveIntervalClock(options);
  const records = new Map<string, GraceState>();

  const elapsedMs = (state: GraceState, monoMs: number): number =>
    // A monotonic clock never runs backwards; an injected clock that
    // does is clamped to 0 rather than extending grace.
    Math.max(0, monoMs - state.verifiedMonoMs);

  const liveAt = (state: GraceState, monoMs: number): boolean =>
    !state.broken && elapsedMs(state, monoMs) < graceWindowMs;

  const recordVerified = (
    identityRaw: string,
    record: VerificationGraceRecordInput = {},
  ): VerificationGraceRecord => {
    const identity = requireIdentity(identityRaw);
    let baselineEvidence: number | null = null;
    if (record.evidenceLevel !== undefined) {
      baselineEvidence = requireFiniteInRange(record.evidenceLevel, "evidenceLevel", 0, Number.MAX_VALUE);
    }
    let reason: string | null = null;
    if (record.reason !== undefined) {
      if (typeof record.reason !== "string" || hasControlOrNewline(record.reason)) {
        fail("reason must be a single-line string");
      }
      reason = record.reason;
    }
    const monoMs = clocks.mono();
    const previous = records.get(identity);
    const state: GraceState = {
      verifiedMonoMs: monoMs,
      verifiedWallMs: clocks.wall(),
      baselineEvidence,
      reason,
      verifications: (previous?.verifications ?? 0) + 1,
      broken: false,
      brokenMonoMs: null,
      brokenEvidence: null,
    };
    // Refresh recency so an actively re-verifying identity is not the
    // eviction candidate; then bound the map, evicting oldest first.
    records.delete(identity);
    records.set(identity, state);
    while (records.size > maxIdentities) {
      const oldest = records.keys().next().value as string;
      records.delete(oldest);
    }
    return {
      identity,
      verifiedAtMs: state.verifiedWallMs,
      graceExpiresAtMonoMs: state.verifiedMonoMs + graceWindowMs,
      graceWindowMs,
      baselineEvidence: state.baselineEvidence,
      reason: state.reason,
      verifications: state.verifications,
    };
  };

  const evaluate = (identityRaw: string, evidenceLevel: number): VerificationGraceVerdict => {
    const identity = requireIdentity(identityRaw);
    const state = records.get(identity);
    const base = {
      identity,
      escalationThreshold,
      baselineEvidence: state?.baselineEvidence ?? null,
    };
    if (typeof evidenceLevel !== "number" || !Number.isFinite(evidenceLevel)) {
      // Invalid input refuses to act, in both directions: it neither
      // suppresses a step-up the host would otherwise apply nor
      // breaks a live grace, and it mutates nothing.
      return {
        ...base,
        inGrace: state !== undefined && liveAt(state, clocks.mono()),
        stepUpSuppressed: false,
        escalated: false,
        reason: "invalid_evidence",
        evidenceLevel: typeof evidenceLevel === "number" ? evidenceLevel : Number.NaN,
        graceRemainingMs: null,
      };
    }
    if (state === undefined) {
      return {
        ...base,
        inGrace: false,
        stepUpSuppressed: false,
        escalated: false,
        reason: "no_grace",
        evidenceLevel,
        graceRemainingMs: null,
      };
    }
    if (state.broken) {
      return {
        ...base,
        inGrace: false,
        stepUpSuppressed: false,
        escalated: false,
        reason: "grace_broken_escalation",
        evidenceLevel,
        graceRemainingMs: null,
      };
    }
    const monoMs = clocks.mono();
    const elapsed = elapsedMs(state, monoMs);
    if (elapsed >= graceWindowMs) {
      return {
        ...base,
        inGrace: false,
        stepUpSuppressed: false,
        escalated: false,
        reason: "grace_expired",
        evidenceLevel,
        graceRemainingMs: null,
      };
    }
    if (evidenceLevel >= escalationThreshold) {
      state.broken = true;
      state.brokenMonoMs = monoMs;
      state.brokenEvidence = evidenceLevel;
      return {
        ...base,
        inGrace: false,
        stepUpSuppressed: false,
        escalated: true,
        reason: "grace_broken_escalation",
        evidenceLevel,
        graceRemainingMs: null,
      };
    }
    return {
      ...base,
      inGrace: true,
      stepUpSuppressed: true,
      escalated: false,
      reason: "in_grace",
      evidenceLevel,
      graceRemainingMs: graceWindowMs - elapsed,
    };
  };

  const guardStepUp = (identity: string, evidenceLevel: number): VerificationGraceStepUpVerdict => {
    const verdict = evaluate(identity, evidenceLevel);
    return { ...verdict, action: verdict.stepUpSuppressed ? "observe" : "step_up" };
  };

  const isInGrace = (identityRaw: string): boolean => {
    const identity = requireIdentity(identityRaw);
    const state = records.get(identity);
    return state !== undefined && liveAt(state, clocks.mono());
  };

  const forget = (identityRaw: string): boolean => {
    const identity = requireIdentity(identityRaw);
    return records.delete(identity);
  };

  const snapshot = (): VerificationGraceSnapshot => {
    const monoMs = clocks.mono();
    let active = 0;
    let broken = 0;
    let expired = 0;
    for (const state of records.values()) {
      if (state.broken) broken += 1;
      else if (elapsedMs(state, monoMs) >= graceWindowMs) expired += 1;
      else active += 1;
    }
    return {
      identities: records.size,
      active,
      broken,
      expired,
      graceWindowMs,
      flagThreshold,
      escalationFactor,
      escalationThreshold,
    };
  };

  return { recordVerified, evaluate, guardStepUp, isInGrace, forget, snapshot };
}
