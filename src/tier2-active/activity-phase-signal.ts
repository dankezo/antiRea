/**
 * Activity-phase signal (live-room candidate CAND-273-3, lab pin
 * roomguard-lab/cand273-lab/REGISTRATION-CAND-273-3.md, results in
 * CAND273-RESULTS.md).
 *
 * WHAT IT MEASURES. A bot fleet does not have to lock phase on
 * JOIN: it can join like everyone else and lock phase on its
 * ACTIONS - chat bursts, emote storms, reaction spam emitted on
 * one shared scheduler to fake engagement or drown a room. This
 * module runs the exact herd-phase law of `createHerdPhaseSignal`
 * (H7-01: Kuramoto phase-lock on a 900 s grid, member iff
 * R_i >= 0.90, cohort confirmed iff >= 10 members AND
 * R_cohort >= 0.80 over the scored identities' mean phases,
 * members named only on confirmation) over an ACTIVITY timestamp
 * stream instead of a join stream. It is a thin factory over the
 * herd-phase core - the math, thresholds and cohort law are the
 * validated ones, not a re-implementation.
 *
 * THE DANGEROUS NULL, MEASURED. The obvious fear is a film
 * climax: the whole room reacts to the same scene at the same
 * moment - surely that looks like a fleet? In the pin's premiere
 * cell (45 regulars + 25 first-time viewers chatting 2-6 times
 * within +/-90 s of six irregular content moments), the scoped
 * evaluation scored 40 identities and found ZERO members: reacting
 * to content at irregular moments does not lock anyone onto a
 * fixed 900 s grid. The shared-scheduler chat herd confirmed
 * (60/60 members, R_cohort 0.9230); the same herd on per-identity
 * grid offsets produced 60 R_i members but R_cohort 0.0402 and
 * was NOT confirmed - the cohort leg is what separates them.
 *
 * SCOPING IS PART OF THE LAW. The pin also measured the failure
 * mode of skipping scoping: evaluated over the WHOLE room
 * population, even the shared herd does not confirm (R_cohort
 * dilutes to ~0.25 under the legitimate background). Run this
 * signal the way the lab did: one instance per room/surface, and
 * evaluate with `cohortWindowMs` (24 h for room streams) so the
 * cohort is the population under suspicion - new arrivals, a
 * flagged segment - not the entire user base.
 *
 * HARD LIMITS.
 * - ADVISORY ONLY: `enforcement: "none"` on every output; a
 *   confirmed cohort is evidence, never a block list.
 * - Only the 900 s scheduler period is validated (inherited from
 *   the herd-phase law); other periods are unmeasured.
 * - A fleet that randomises its grid offset per identity is
 *   invisible to the confirmation law BY DESIGN (the INDEP cell
 *   above) - the same deliberate trade as herd-phase.
 * - Identities with fewer than `minEvents` actions are never
 *   scored; one-shot spam belongs to metering layers.
 *
 * All lab numbers are seeded simulation (CAND-273-3 pin, on top
 * of the H7-01 Step 1 and roomguard wave-1 records), internal
 * validity only - NOT real-traffic performance.
 *
 * Pure computation: no I/O, no runtime dependencies. State and
 * bounds are the herd-phase core's (bounded identities, bounded
 * events per identity, counters in the snapshot).
 */

import {
  createHerdPhaseSignal,
  HerdPhaseError,
  HERD_PHASE_ROOM_COHORT_WINDOW_MS,
  type CreateHerdPhaseSignalOptions,
  type HerdPhaseEvaluateOptions,
  type HerdPhaseObservation,
} from "./herd-phase-signal";

const ADVISORY_NOTICE =
  "Advisory telemetry only (enforcement: none): Kuramoto phase-lock statistics over one activity " +
  "stream per identity (chat, emotes, reactions) - a cohort is confirmed as sharing one scheduler " +
  "only when at least minMembers identities are grid-locked members (R_i >= memberThreshold) AND " +
  "R_cohort >= cohortThreshold; members are named only on confirmation, and only members whose " +
  "event span covers a full grid period can confirm (span gate). Content-driven simultaneity " +
  "(a room reacting to the same film moment) measured zero members in the lab's premiere cell. " +
  "Evaluate scoped (cohortWindowMs, 24 h for room streams): unscoped whole-population runs dilute " +
  "R_cohort and were measured NOT to confirm even a real shared herd. All lab numbers are seeded " +
  "simulation (CAND-273-3 pin over the H7-01 law), the only validated period is 900 s, and " +
  "offset-randomising fleets are invisible by design - never use this signal as the sole basis " +
  "for any consequence.";

export interface ActivityPhaseEvent {
  /** The authenticated identity the activity belongs to. */
  identity: string;
  /** Millisecond timestamp of one activity event (one homogeneous stream: chat, emotes, ...). */
  ts: number;
}

/** Options are the herd-phase core's, unchanged - the law is the validated one. */
export type CreateActivityPhaseSignalOptions = CreateHerdPhaseSignalOptions;
export type ActivityPhaseEvaluateOptions = HerdPhaseEvaluateOptions;
export type ActivityPhaseObservation = HerdPhaseObservation;

export interface ActivityPhaseResult {
  kind: "activity-phase";
  status: "scored" | "insufficient_population";
  confirmed: boolean;
  cohortIdentities: number;
  scoredIdentities: number;
  memberCount: number;
  /** Members whose event span covers at least one full grid period; only they can confirm (span gate, inherited from the herd-phase core). */
  spanEligibleMembers: number;
  /** Member identities, named ONLY when the cohort is confirmed. Empty otherwise. */
  members: string[];
  cohortR: number | null;
  meanPhaseRad: number | null;
  periodSec: number;
  enforcement: "none";
  notice: string;
}

export interface ActivityPhaseSnapshot {
  enforcement: "none";
  periodSec: number;
  memberThreshold: number;
  cohortThreshold: number;
  minEvents: number;
  minMembers: number;
  identities: number;
  events: number;
  counters: {
    observed: number;
    invalidTs: number;
    evictedIdentities: number;
    truncatedEvents: number;
  };
  notice: string;
}

export interface ActivityPhaseSignalInstance {
  /** Feed one activity timestamp for one identity. */
  observe(event: ActivityPhaseEvent): ActivityPhaseObservation;
  /** Run the herd-phase law over the activity cohort observed so far. */
  evaluate(options?: ActivityPhaseEvaluateOptions): ActivityPhaseResult;
  snapshot(): ActivityPhaseSnapshot;
}

/** Named error thrown for every invalid activity-phase input. */
export class ActivityPhaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityPhaseError";
  }
}

function rethrow(error: unknown): never {
  if (error instanceof HerdPhaseError) {
    throw new ActivityPhaseError(error.message.replace("createHerdPhaseSignal", "createActivityPhaseSignal"));
  }
  throw error;
}

export function createActivityPhaseSignal(
  options: CreateActivityPhaseSignalOptions = {},
): ActivityPhaseSignalInstance {
  let core: ReturnType<typeof createHerdPhaseSignal>;
  try {
    core = createHerdPhaseSignal(options);
  } catch (error) {
    rethrow(error);
  }
  return {
    observe(event: ActivityPhaseEvent): ActivityPhaseObservation {
      try {
        return core.observe(event);
      } catch (error) {
        return rethrow(error);
      }
    },
    evaluate(evaluateOptions: ActivityPhaseEvaluateOptions = {}): ActivityPhaseResult {
      try {
        const r = core.evaluate(evaluateOptions);
        return {
          kind: "activity-phase",
          status: r.status,
          confirmed: r.confirmed,
          cohortIdentities: r.cohortIdentities,
          scoredIdentities: r.scoredIdentities,
          memberCount: r.memberCount,
          spanEligibleMembers: r.spanEligibleMembers,
          members: r.members,
          cohortR: r.cohortR,
          meanPhaseRad: r.meanPhaseRad,
          periodSec: r.periodSec,
          enforcement: "none",
          notice: ADVISORY_NOTICE,
        };
      } catch (error) {
        return rethrow(error);
      }
    },
    snapshot(): ActivityPhaseSnapshot {
      const s = core.snapshot();
      return {
        enforcement: "none",
        periodSec: s.periodSec,
        memberThreshold: s.memberThreshold,
        cohortThreshold: s.cohortThreshold,
        minEvents: s.minEvents,
        minMembers: s.minMembers,
        identities: s.identities,
        events: s.events,
        counters: { ...s.counters },
        notice: ADVISORY_NOTICE,
      };
    },
  };
}

/** The validated cohort window for room streams: 24 h in ms (same constant as herd-phase). */
export const ACTIVITY_PHASE_ROOM_COHORT_WINDOW_MS = HERD_PHASE_ROOM_COHORT_WINDOW_MS;
