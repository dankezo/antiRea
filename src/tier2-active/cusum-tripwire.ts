/**
 * Mixture GLR-CUSUM sequential evidence tripwire.
 *
 * Implements CUSUM-SPEC.md (overnight session 02/11/2026; ARGON-R6 form,
 * CHATGPT-R6 correlation discipline, REM-SDK-AUDIT host boundaries).
 * Four evidence streams - predicate adjacency, exact-set disjoint
 * tiling, cold-ID misses, cursor velocity - each emit a log-likelihood
 * increment from a versioned lookup table, and the increments sum into
 * ONE one-sided accumulator per cohort with a zero floor:
 *
 *     S_C <- max(0, S_C + l_adj + l_tile + l_cold + l_vel)
 *
 * The zero floor is the point of the form: a vanilla SPRT has an
 * indifference point that lets a mid-intensity attacker drift negative
 * and bank "innocence"; a one-sided CUSUM cannot go below 0, so there
 * is nothing to bank. The boundary is B = ln(1/alpha) (default
 * alpha = 1e-3, B ~= 6.91). Crossing latches the cohort `flagged` for
 * the current epoch; crossing alone NEVER cuts a per-identity budget
 * (the herd detector's `graduated_only` discipline) - the tripwire's
 * own consequences are cohort-level: pacing via a shared rate bucket,
 * step-up friction, and - only when the tiering law allows it (see
 * below) - a shared campaign ceiling counting PRIOR disclosures.
 *
 * Correlation discipline: adjacency and tiling are two views of the
 * same partitioning act, so summing their raw LLRs would double-count.
 * The tiling stream therefore EXCLUDES every record whose id falls
 * inside a range that already formed an adjacency edge for the cohort
 * (conditional computation, CUSUM-SPEC SS1.2). The spec names the
 * residual correlation as a known weak point: it is unquantified until
 * the joint increment distribution is measured on held-out traces.
 *
 * CALIBRATION HONESTY: the bundled tables are `r6-calib-1`, fitted in
 * the lab on SCRIPTED traces (N_eff = 189 fitted; the tiling stream
 * was inert in that harness because no legit component reached its
 * evaluation gates). They ship labeled `uncalibrated: true` with the
 * notice "uncalibrated - audit only". Snapshots carry both fields so
 * no host mistakes placeholder evidence for measured evidence.
 *
 * CONSEQUENCE FLOOR (v2.4 classic-test fix, 02/11/2026): a crossing is
 * evidence, and evidence alone used to be enough to enroll a cohort
 * into step-up. The v24 classic test showed why that is wrong at
 * small scale: a polite+NAT cohort (6 legitimate identities sharing a
 * first page and the same details - the textbook NAT/onboarding
 * shape) crossed at an exact union of 25 records and step-up dwell
 * landed on a legitimate user. Statistical significance is not
 * absolute scale. A crossing therefore remains a full telemetry flag
 * at ANY scale (score, snapshot, `onCampaignFlag`), but it is only
 * ELIGIBLE to carry consequences - step-up enrollment in `enforce`
 * mode, cohort pacing via `checkServe` - once the cohort's exact
 * union coverage reaches an absolute floor. Derivation of the
 * default: CUSUM-SPEC SS1.2 already contains exactly one
 * absolute-scale constant, the tiling stream's per-member evaluation
 * gate (150 distinct records) - below that scale the spec refuses to
 * let even one evidence stream contribute. A consequence is weightier
 * than an evidence increment, so it must demand at least the same
 * absolute scale, measured on the cohort's exact union (the same
 * exact-set accounting the disclosure ledger uses). The floor
 * therefore defaults to the resolved `gates.minMemberRecords` (150
 * shipped) so the two constants cannot drift apart; hosts pin it
 * independently via `consequences.minUnionRecords` (a host running
 * ceiling-tier calibrated tables may deliberately lower it).
 * Eligibility is evaluated live: a cohort that crosses below the
 * floor and later grows past it becomes eligible while still flagged.
 *
 * MEMBER ATTRIBUTION: snapshots carry `contributingMembers` - the
 * members whose net in-cohort LLR contribution over the current score
 * window is > 0 (consistent with the evidence-attribution rules:
 * credit follows the acting subject). Hosts enrolling step-up from
 * `onCampaignFlag` should enroll contributing members, and MUST check
 * `snapshot.consequenceEligible` before enrolling anyone.
 *
 * TIERING LAW (enforcement-tiering.ts, 09:44 revision): cohorts here
 * are INFERRED from behavior. The friction tier is ON by default -
 * an eligible crossing in the default mode enrolls step-up - but the
 * tripwire's own consequence never exceeds step-up friction unless
 * the cohort was host-declared (`declaredCohorts`) or the host
 * supplies a calibration manifest that evaluates to the `ceiling`
 * tier. With the bundled uncalibrated tables and no manifest,
 * `enforce` mode engages pacing + step-up recommendation only - the
 * ceiling physically cannot engage. (The wider law also permits a
 * soft budget step-down to the 500-record floor for inferred
 * cohorts; that consequence lives in the tiering/herd-response
 * layer and in host budget wiring, not in this engine, whose
 * vocabulary stays step-up.) That is deliberate, and it is the R5
 * compliance lesson applied at the engine layer: an uncalibrated
 * heuristic flag must never hard-cut anyone.
 *
 * DECLARED CEILING ARMING (2.5.0 ceiling fix, 02/11/2026): the
 * tiering law above has TWO lawful paths to a hard ceiling, and they
 * engage differently. An INFERRED cohort reaches the ceiling only
 * through a crossing (resolveConsequence at the flag, consequence
 * floor included) - unchanged. A HOST-DECLARED cohort backed by a
 * ceiling-tier calibration manifest is different: the host has
 * already made the authorization decision and named the cohort, so
 * requiring the evidence engine to cross before the cap binds makes
 * the declared number a lie - the 2.5.0 round's pre-fix classic cell measured each
 * declared cohort's union at ~900 records against a declared 600
 * when its crossing landed (2,700 total). A declared cohort that
 * resolves to `hard_ceiling` under the clamp with a ceiling-tier
 * manifest is therefore ARMED at declaration: its members form one
 * cohort from construction, `ceilingActive` (and the snapshot's
 * `ceilingArmed`) is true from first sight, the union counts from
 * the first record served, and `checkServe` refuses at the limit
 * with NO crossing and NO consequence floor in the way. A declared
 * cohort WITHOUT a ceiling-tier manifest is NOT armed (the clamp
 * path at a crossing is the tiering law, unchanged); inferred
 * cohorts are never armed. Arming is a data cap over the cohort's
 * total, not a per-subject punishment: it counts every member's
 * serves, and the protected-subject lane below is a separate concept
 * that neither arms nor disarms a declared cohort.
 *
 * PROTECTED SUBJECTS: a host that has declared subjects protected
 * (compliance / audit / support / agreed pentest - see
 * `protected-cohorts.ts`) passes `isProtected`; for an INFERRED
 * cohort, a protected member's decisions stay telemetry-only
 * (action `logged`, `protectedSubject: true`) and `checkServe`
 * passes them through untouched, while their evidence still accrues
 * and snapshots list them under `protectedMembers`. Protection does
 * not apply to host-declared cohorts: declaring a cohort for
 * enforcement and protecting its members from that enforcement would
 * be the host contradicting its own authorization, so the declared
 * path ignores the predicate.
 *
 * Lab round 6 fixes carried into this implementation:
 * - whole-domain predicates (a range covering >= 99.9% of its field)
 *   form NO adjacency edges - a polite user filtering "everything" was
 *   merged into a campaign cohort by full-range predicates in the lab;
 * - cohort bucket state merges by MINIMUM on component merge, never
 *   resets upward;
 * - the tiling stream uses exact sets, never sketches (a bitmap is
 *   1,250 bytes at N = 10,000; sketch error bands are wider than the
 *   thresholds they would feed).
 *
 * Default mode is `enforce` (changed 02/11/2026 with the 09:44
 * law): an eligible crossing enrolls step-up friction and cohort
 * pacing with no host opt-in - but ONLY at the step-up tier, and
 * only past the consequence floor, precisely because the bundled
 * tables remain uncalibrated; the honest claim for the default is
 * "friction on strong scripted evidence", never detection rates.
 * `mode: "observe"` remains available for hosts that want crossings
 * logged and reported via `onCampaignFlag` while restricting
 * nothing. State is in-process memory (the spec's host
 * `EvidenceStore` adapter is not implemented in this version - see
 * the v2.4 implementation report); horizontally scaled hosts should
 * run one tripwire per process and treat flags as per-process
 * signals until a shared-state adapter lands.
 */

import {
  evaluateCalibrationManifest,
  UNCALIBRATED_AUDIT_ONLY_NOTICE,
  type CalibrationGateOptions,
  type CalibrationManifest,
} from "./calibration-manifest";
import { clampEnforcement, type CohortOrigin } from "./enforcement-tiering";
import { mergeCohortBucketStates } from "./disclosure-ledger";
import { monoNowMs } from "../internal/mono-clock";

export type CusumStreamName = "adjacency" | "tiling" | "cold" | "velocity";
export type CusumMode = "observe" | "enforce";

export interface CusumPredicate {
  field: string;
  min: number;
  max: number;
  domainMin: number;
  domainMax: number;
}

export interface CusumEvent {
  type: "list" | "search" | "detail" | "export" | "page_view";
  identity: string;
  recordIds?: number[];
  introducedIds?: number[];
  detailId?: number;
  predicate?: CusumPredicate;
  cursor?: { issuedAtMs: number; pageSize: number; step: number };
  /** Canary-echo link: this identity requested a synthetic reference id minted for `echoFrom`. */
  echoFrom?: string;
  ts?: number;
}

export interface CusumLlrTables {
  version: string;
  uncalibrated: boolean;
  nEff: number;
  adjacency: Record<"null" | "c2" | "c3" | "c4" | "c5plus", number>;
  tiling: Record<"z_lt_0_3" | "z_0_3_0_5" | "z_0_5_0_65" | "z_0_65_0_78" | "z_ge_0_78", number>;
  cold: Record<"warm" | "low" | "mid" | "high" | "high_regular", number>;
  velocity: Record<"human" | "v80_200" | "v30_80" | "v_lt_30", number>;
}

/**
 * Bundled r6-calib-1 tables. Fitted on scripted lab traces (N_eff =
 * 189); NOT fitted on any real population. Labeled uncalibrated - the
 * enforcement tier they can support without a host manifest is
 * audit/step-up only.
 */
export const R6_CALIB_1_LLR_TABLES: CusumLlrTables = {
  version: "r6-calib-1",
  uncalibrated: true,
  nEff: 189,
  adjacency: { null: -0.05, c2: 0.9, c3: 1.4, c4: 1.9, c5plus: 2.4 },
  tiling: { z_lt_0_3: -0.1, z_0_3_0_5: 0.15, z_0_5_0_65: 0.55, z_0_65_0_78: 1.05, z_ge_0_78: 1.6 },
  cold: { warm: -0.03, low: 0.1, mid: 0.45, high: 0.95, high_regular: 1.5 },
  velocity: { human: -0.08, v80_200: 0.05, v30_80: 0.45, v_lt_30: 1.0 },
};

export interface CusumDecision {
  identity: string;
  cohortId: string | null;
  score: number;
  increments: Record<CusumStreamName, number>;
  /**
   * The bin label each stream actually used for this event, so offline
   * calibration tooling can read the raw observables instead of only
   * the increment they produced. A label is null when that stream was
   * not evaluated for this event (see formation / stream docs):
   * adjacency - "null" for an evaluated predicate with zero abutting
   * edges, "c2" / "c3" / "c4" / "c5plus" by cohort size after a merge,
   * null when no predicate was evaluated; tiling - a z bin label,
   * null when the gates were not reached, the identity is not in a
   * cohort, or the stream is off; cold - "warm" / "low" / "mid" /
   * "high" / "high_regular", null when the event carries no detailId;
   * velocity - "human" / "v80_200" / "v30_80" / "v_lt_30", null when
   * there is no valid cursor step.
   */
  bins: { adjacency: string | null; tiling: string | null; cold: string | null; velocity: string | null };
  crossed: boolean;
  flagged: boolean;
  /**
   * The cohort's shared campaign ceiling state at decision time:
   * true from declaration for an armed host-declared cohort (see the
   * header's DECLARED CEILING ARMING), or once a crossing engages
   * the ceiling for any other lawful cohort.
   */
  ceilingActive: boolean;
  action: "none" | "logged" | "step_up" | "campaign_engaged";
  /**
   * Whether the cohort's exact union coverage has reached the
   * consequence floor (see `CusumTripwireOptions.consequences`), so a
   * crossing may carry consequences rather than telemetry only.
   */
  consequenceEligible: boolean;
  /**
   * True when this decision's subject is host-declared protected and
   * the cohort is inferred: the evidence stands, but the consequence
   * was suppressed to telemetry for this subject (see `isProtected`).
   */
  protectedSubject: boolean;
  /** Set when the tiering law clamped an enforce-mode consequence. */
  clampedReason?: string;
}

export interface CampaignSnapshot {
  cohortId: string;
  members: string[];
  /**
   * Members whose net in-cohort LLR contribution over the current
   * score window is > 0. Step-up enrollment should target these
   * members (attribution follows the acting subject).
   */
  contributingMembers: string[];
  /**
   * Members the host has declared protected (via the `isProtected`
   * option). They remain full telemetry members - they are listed so
   * hosts enrolling consequences from a snapshot can exclude them,
   * exactly as `partitionConsequenceTargets` does host-side.
   */
  protectedMembers: string[];
  score: number;
  flagged: boolean;
  ceilingActive: boolean;
  /**
   * True when this cohort's ceiling was ARMED AT DECLARATION
   * (host-declared cohort + ceiling-tier calibration manifest):
   * `ceilingActive` has been true since the cohort was declared,
   * the cap binds from the first record, and `checkServe` enforces
   * it without a crossing or the consequence floor. False for every
   * inferred cohort and for declared cohorts without a ceiling-tier
   * manifest - their ceilings, when lawful at all, engage only at a
   * crossing.
   */
  ceilingArmed: boolean;
  unionRecords: number;
  /** True once `unionRecords` reaches `consequenceFloorRecords`. */
  consequenceEligible: boolean;
  /** The absolute floor (exact distinct records) in effect. */
  consequenceFloorRecords: number;
  ceilingLimit: number;
  bucketTokens: number;
  /**
   * Live state sizes of the engine (F-10): identities and cohorts
   * currently held, plus formation pair-throttle entries across both
   * pair maps - the operator-visible proof that identity state is
   * capped (`maxIdentities`) instead of growing without bound.
   */
  stateSizes?: { identities: number; cohorts: number; pairThrottles: number };
  calibrationVersion: string;
  uncalibrated: boolean;
  notice: string;
}

export interface ConsequenceTargets {
  targets: string[];
  protectedMembers: string[];
  nonContributingMembers: string[];
}

/**
 * Partition a campaign snapshot into the subjects a consequence may
 * actually land on.
 *
 * - `targets` is `contributingMembers` minus `protectedMembers`:
 *   friction-tier consequences (step_up, budget step-down) apply
 *   ONLY to these subjects, because attribution follows the acting
 *   subject and a protected subject never receives an inferred
 *   consequence.
 * - `nonContributingMembers` is `members` minus
 *   `contributingMembers` minus `protectedMembers`: members whose
 *   net in-cohort contribution is not positive, so no friction-tier
 *   consequence is attributed to them either.
 * - `protectedMembers` is the snapshot list verbatim.
 *
 * Distinguish the tiers carefully: friction-tier consequences above
 * are per-subject and target-only. A lawful campaign ceiling (a
 * host-declared cohort ceiling, or a manifest tier ceiling) is a
 * DATA CAP counted over EVERY record served to the cohort -
 * including records served by non-contributors - it is not a
 * punishment aimed at a subject, and `checkServe` still passes a
 * protected subject through on a per-subject basis.
 */
export function consequenceTargets(snapshot: CampaignSnapshot): ConsequenceTargets {
  const protectedSet = new Set(snapshot.protectedMembers);
  const contributingSet = new Set(snapshot.contributingMembers);
  return {
    targets: snapshot.contributingMembers.filter(member => !protectedSet.has(member)),
    protectedMembers: [...snapshot.protectedMembers],
    nonContributingMembers: snapshot.members.filter(
      member => !contributingSet.has(member) && !protectedSet.has(member),
    ),
  };
}

export interface CusumTripwireOptions {
  /**
   * Default `enforce` (09:44 law): eligible crossings carry step-up
   * friction with no opt-in. The consequence remains capped at the
   * step-up tier for inferred cohorts on the bundled uncalibrated
   * tables; `observe` keeps crossings telemetry-only.
   */
  mode?: CusumMode;
  alpha?: number;
  llrTables?: CusumLlrTables;
  streams?: Partial<Record<CusumStreamName, boolean>>;
  ceiling?: { limit?: number };
  bucket?: { burst?: number; rateBase?: number; rateExponent?: number };
  epochMs?: number;
  /** Tiling evaluation gates (CUSUM-SPEC SS1.2). Defaults 150 / 1200. */
  gates?: { minMemberRecords?: number; minCohortSum?: number };
  /**
   * Consequence eligibility floor: a crossing is telemetry at any
   * scale, but consequences (step-up in `enforce` mode, cohort pacing
   * in `checkServe`) require the cohort's exact union coverage to
   * reach `minUnionRecords` distinct records. Default: the tiling
   * stream's per-member evaluation gate (`gates.minMemberRecords`,
   * 150 shipped) - the spec's one absolute-scale constant, reused so
   * the two cannot drift apart. Hosts with ceiling-tier calibrated
   * evidence may pin a lower floor here deliberately.
   */
  consequences?: { minUnionRecords?: number };
  /**
   * Cohort formation signals that do not need a predicate (see the
   * formation block in `observe`). All fields are optional.
   */
  formation?: {
    /** Served-set slice complementarity. Default true. */
    sliceComplementarity?: boolean;
    /** Cold-walk complementarity over cold detail ids. Default true. */
    coldWalk?: boolean;
    /** Minimum served records per member for a slice pairing. Default: the tiling gate (`gates.minMemberRecords`, 150 shipped). */
    minServedPerMember?: number;
    /** Minimum cold records per member for a cold-walk pairing. Default 50 (the herd v2 `minOwnRecords` constant). */
    minColdPerMember?: number;
    /** Minimum union size for either pairing to merge. Default 300 (the herd union floor). */
    minUnionRecords?: number;
    /** Maximum pairwise Jaccard for a pairing to count as complementary. Default 0.10 (the herd link ceiling). */
    maxOverlap?: number;
    /** Minimum per-side range density, cold-walk only. Default 0.5. */
    minRangeDensity?: number;
    /** Co-activity window (ms) for a pairing. Default 60_000. */
    windowMs?: number;
    /** Pair re-evaluation throttle: the smaller side must grow by at least this much before a pair is checked again. Default 25 (the herd recheck growth). */
    recheckGrowth?: number;
  };
  /** Cohorts the host declares itself; members listed together form one declared cohort. */
  declaredCohorts?: string[][];
  /** Host calibration manifest; gates the ceiling via the tiering law. */
  manifest?: CalibrationManifest | null;
  calibrationGate?: CalibrationGateOptions;
  onCampaignFlag?: (snapshot: CampaignSnapshot) => void;
  isExempt?: (identity: string) => boolean;
  /**
   * Host-declared protected subjects (compliance / audit / support /
   * agreed pentest), typically `createProtectedCohortRegistry`'s
   * `isProtected`. Unlike `isExempt` - which holds no state at all -
   * a protected subject's evidence accrues normally; only the
   * CONSEQUENCES of inferred-cohort membership are suppressed for
   * them (decision action stays `logged`, `checkServe` passes
   * through). Ignored for host-declared cohorts.
   */
  isProtected?: (identity: string) => boolean;
  now?: () => number;
  /**
   * Monotonic clock for the cohort pacing bucket's refill arithmetic
   * (L-DEEP-2) - the only interval this engine measures on its own
   * clock. Formation windows and epoch rotation run over event
   * timestamps (host time domain) and are untouched. When only `now`
   * is given, the injected clock drives both domains (pre-patch
   * behavior).
   */
  monoNow?: () => number;
  /**
   * Cap on identity state held at once (F-10): when a new identity
   * would exceed the cap, the least-recently-active identity is
   * evicted - its served/cold state, singleton score and cohort
   * membership are dropped. Host-declared cohort members are evicted
   * last (the host named them deliberately). Mirrors the herd
   * detector's `maxIdentities`. Default 2000, minimum 10.
   */
  maxIdentities?: number;
}

export interface CusumTripwire {
  observe(event: CusumEvent): Promise<CusumDecision>;
  checkServe(
    identity: string,
    requested: number,
  ): Promise<{ allowed: number; notBeforeMs?: number; cohortId?: string; reason?: string }>;
  getSnapshot(cohortId: string): Promise<CampaignSnapshot | null>;
  snapshotFor(identity: string): Promise<CampaignSnapshot | null>;
  clearCohort(cohortId: string): Promise<void>;
}

interface IdentityState {
  served: Set<number>;
  introduced: Set<number>;
  explained: Set<number>;
  coldWindow: { ts: number; id: number }[];
  ewmaTauMs: number;
  /** Distinct cold detail ids (detail ids not in the introduced set when observed). Formation state for the cold-walk signal. */
  coldSet: Set<number>;
  coldMin: number | null;
  coldMax: number | null;
  lastColdTs: number;
  lastActiveTs: number;
}

interface CohortState {
  id: string;
  members: Set<string>;
  score: number;
  flagged: boolean;
  flaggedAtMs: number;
  ceilingActive: boolean;
  /** Armed at declaration (host-declared + ceiling-tier manifest); see the header. */
  ceilingArmed: boolean;
  bucketTokens: number;
  bucketLastRefillMs: number;
  /** Monotonic twin of `bucketLastRefillMs` (L-DEEP-2): refill elapsed time is measured on this clock. */
  bucketLastRefillMonoMs: number;
  /**
   * A crossing happened whose `onCampaignFlag` delivery has not yet
   * succeeded (the host callback threw). Delivery is retried on the
   * next observe / snapshot of this cohort; epoch rotation and
   * `clearCohort` retire the pending notification with the flag.
   */
  flagNotificationPending: boolean;
  /** Net LLR attributed to each member over the current score window. */
  contributions: Map<string, number>;
}

interface PredicateEntry {
  identity: string;
  field: string;
  l: number;
  u: number;
}

const EMPTY_INCREMENTS = (): Record<CusumStreamName, number> => ({
  adjacency: 0,
  tiling: 0,
  cold: 0,
  velocity: 0,
});

export function createCusumTripwire(options: CusumTripwireOptions = {}): CusumTripwire {
  const mode: CusumMode = options.mode ?? "enforce";
  const alpha = Math.min(0.5, Math.max(1e-9, options.alpha ?? 1e-3));
  const boundary = Math.log(1 / alpha);
  const tables = options.llrTables ?? R6_CALIB_1_LLR_TABLES;
  const streams = {
    adjacency: options.streams?.adjacency !== false,
    tiling: options.streams?.tiling !== false,
    cold: options.streams?.cold !== false,
    velocity: options.streams?.velocity !== false,
  };
  const ceilingLimit = Math.max(1, options.ceiling?.limit ?? 2000);
  const bucketBurst = Math.max(1, options.bucket?.burst ?? 150);
  const bucketRateBase = options.bucket?.rateBase ?? 3.5;
  const bucketRateExponent = options.bucket?.rateExponent ?? 0.15;
  const epochMs = Math.max(1, options.epochMs ?? 86_400_000);
  const maxIdentities = Math.max(10, Math.floor(options.maxIdentities ?? 2000) || 2000);
  /** Backstop size for each formation pair-throttle map (F-10). */
  const pairThrottleCap = Math.max(1024, maxIdentities * 4);
  const minMemberRecords = Math.max(1, options.gates?.minMemberRecords ?? 150);
  const minCohortSum = Math.max(1, options.gates?.minCohortSum ?? 1200);
  // Consequence floor: defaults to the tiling per-member gate (the
  // spec's absolute-scale constant); see the header derivation.
  const minConsequenceUnion = Math.max(1, options.consequences?.minUnionRecords ?? minMemberRecords);
  // Formation constants: defaults bind to the existing constants named
  // in CusumTripwireOptions.formation so they cannot drift apart.
  const formationSlice = options.formation?.sliceComplementarity !== false;
  const formationColdWalk = options.formation?.coldWalk !== false;
  const formationMinServed = Math.max(1, options.formation?.minServedPerMember ?? minMemberRecords);
  const formationMinCold = Math.max(1, options.formation?.minColdPerMember ?? 50);
  const formationMinUnion = Math.max(1, options.formation?.minUnionRecords ?? 300);
  const formationMaxOverlap = options.formation?.maxOverlap ?? 0.1;
  const formationMinRangeDensity = options.formation?.minRangeDensity ?? 0.5;
  const formationWindowMs = Math.max(0, options.formation?.windowMs ?? 60_000);
  const formationRecheckGrowth = Math.max(1, options.formation?.recheckGrowth ?? 25);
  const now = options.now ?? Date.now;
  const monoNowFn = options.monoNow ?? (options.now ? now : monoNowMs);

  const declaredGroupOf = new Map<string, number>();
  (options.declaredCohorts ?? []).forEach((group, index) => {
    for (const member of group) declaredGroupOf.set(member, index);
  });

  const identities = new Map<string, IdentityState>();
  const parent = new Map<string, string>();
  const cohorts = new Map<string, CohortState>();
  const singletonScores = new Map<string, number>();
  const predicateRing: PredicateEntry[] = [];
  /**
   * Formation pair throttles: sorted pair key -> { smaller side size,
   * evaluation timestamp } at last full evaluation. Entries expire
   * after the formation window (F-10 TTL) and each map is size-capped,
   * so pair state cannot grow without bound either.
   */
  const slicePairLastChecked = new Map<string, { size: number; atMs: number }>();
  const coldPairLastChecked = new Map<string, { size: number; atMs: number }>();

  const identityState = (identity: string): IdentityState => {
    let state = identities.get(identity);
    if (!state) {
      // Bound the state (F-10): at the cap, evict least-recently-active
      // identities until there is room - host-declared cohort members
      // are evicted last, since the host named them deliberately.
      while (identities.size >= maxIdentities) {
        let victim: string | undefined;
        for (const candidate of identities.keys()) {
          if (!declaredGroupOf.has(candidate)) {
            victim = candidate;
            break;
          }
        }
        victim ??= identities.keys().next().value as string | undefined;
        if (victim === undefined || victim === identity) break;
        removeIdentity(victim);
      }
      state = {
        served: new Set(),
        introduced: new Set(),
        explained: new Set(),
        coldWindow: [],
        ewmaTauMs: 150,
        coldSet: new Set(),
        coldMin: null,
        coldMax: null,
        lastColdTs: Number.NEGATIVE_INFINITY,
        lastActiveTs: Number.NEGATIVE_INFINITY,
      };
      identities.set(identity, state);
    } else {
      // LRU refresh: activity is what protects an identity from
      // eviction, so a hit re-inserts it at the newest end (F-10).
      identities.delete(identity);
      identities.set(identity, state);
    }
    return state;
  };

  const find = (identity: string): string => {
    let root = parent.get(identity) ?? identity;
    if (!parent.has(identity)) parent.set(identity, identity);
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) as string;
    let current = identity;
    while ((parent.get(current) ?? current) !== root) {
      const next = parent.get(current) as string;
      parent.set(current, root);
      current = next;
    }
    return root;
  };

  const cohortOf = (identity: string): CohortState | null => {
    const root = find(identity);
    return cohorts.get(root) ?? null;
  };

  const membersOf = (root: string): string[] => {
    const members: string[] = [];
    for (const identity of identities.keys()) if (find(identity) === root) members.push(identity);
    return members;
  };

  const cohortIdFor = (members: string[]): string => `coh:${[...members].sort()[0] ?? "empty"}`;

  /** Read a pair-throttle entry, expiring it past the formation window (F-10). */
  const pairThrottleGet = (
    map: Map<string, { size: number; atMs: number }>,
    key: string,
    ts: number,
  ): number | undefined => {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (ts - entry.atMs > formationWindowMs) {
      map.delete(key);
      return undefined;
    }
    return entry.size;
  };

  /** Write a pair-throttle entry, pruning oldest-inserted entries beyond the cap (F-10). */
  const pairThrottleSet = (
    map: Map<string, { size: number; atMs: number }>,
    key: string,
    size: number,
    ts: number,
  ): void => {
    map.set(key, { size, atMs: ts });
    if (map.size > pairThrottleCap) {
      for (const oldestKey of map.keys()) {
        if (map.size <= pairThrottleCap) break;
        map.delete(oldestKey);
      }
    }
  };

  /**
   * Evict one identity entirely (F-10): its served/cold state,
   * singleton score, pair throttles and predicate-ring entries go
   * with it, and its cohort (if any) loses the member. If the
   * evicted identity was the union-find root, another member is
   * promoted and the cohort re-keyed - the same surgery
   * mergeIdentities performs when it retires a root.
   */
  const removeIdentity = (victim: string): void => {
    const root = find(victim);
    identities.delete(victim);
    singletonScores.delete(victim);
    for (let i = predicateRing.length - 1; i >= 0; i--) {
      if ((predicateRing[i] as PredicateEntry).identity === victim) predicateRing.splice(i, 1);
    }
    for (const map of [slicePairLastChecked, coldPairLastChecked]) {
      for (const key of [...map.keys()]) {
        if (key.split("\u0001").includes(victim)) map.delete(key);
      }
    }
    const cohort = cohorts.get(root);
    if (cohort) {
      cohort.members.delete(victim);
      cohort.contributions.delete(victim);
      if (cohort.members.size === 0) {
        cohorts.delete(root);
      } else if (root === victim) {
        const newRoot = [...cohort.members].sort()[0] as string;
        cohorts.delete(root);
        cohorts.set(newRoot, cohort);
        cohort.id = cohortIdFor([...cohort.members]);
        for (const [id, pointed] of [...parent.entries()]) {
          if (pointed === victim) parent.set(id, newRoot);
        }
        parent.set(newRoot, newRoot);
      } else {
        for (const [id, pointed] of [...parent.entries()]) {
          if (pointed === victim) parent.set(id, root);
        }
      }
    }
    parent.delete(victim);
  };

  const bucketRate = (size: number): number => bucketRateBase * Math.pow(Math.max(1, size), bucketRateExponent);

  const refill = (cohort: CohortState, atMs: number, atMonoMs: number): void => {
    // Self-heal (F-09): a non-finite token count can never be cleansed
    // by the Math.min below (every comparison with NaN is false), so a
    // poisoned bucket resets to full instead of refusing forever.
    if (!Number.isFinite(cohort.bucketTokens)) cohort.bucketTokens = bucketBurst;
    const elapsed = Math.max(0, atMonoMs - cohort.bucketLastRefillMonoMs);
    if (elapsed > 0) {
      cohort.bucketTokens = Math.min(
        bucketBurst,
        cohort.bucketTokens + (elapsed / 1000) * bucketRate(cohort.members.size),
      );
    }
    // The bucket invariant is [0, burst]; clamp defensively so a bad
    // debit can neither negative-poison nor inflate the bucket.
    cohort.bucketTokens = Math.min(bucketBurst, Math.max(0, cohort.bucketTokens));
    cohort.bucketLastRefillMs = atMs;
    cohort.bucketLastRefillMonoMs = atMonoMs;
  };

  const ensureCohort = (root: string, atMs: number, atMonoMs: number): CohortState => {
    let cohort = cohorts.get(root);
    if (!cohort) {
      const members = membersOf(root);
      cohort = {
        id: cohortIdFor(members),
        members: new Set(members),
        score: 0,
        flagged: false,
        flaggedAtMs: 0,
        ceilingActive: false,
        ceilingArmed: false,
        bucketTokens: bucketBurst,
        bucketLastRefillMs: atMs,
        bucketLastRefillMonoMs: atMonoMs,
        flagNotificationPending: false,
        contributions: new Map(),
      };
      cohorts.set(root, cohort);
    }
    return cohort;
  };

  /** Union-find merge with R6 rules: singleton scores discarded, bucket min-merged. */
  const mergeIdentities = (a: string, b: string, atMs: number, atMonoMs: number): CohortState => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return ensureCohort(rootA, atMs, atMonoMs);
    const cohortA = cohorts.get(rootA);
    const cohortB = cohorts.get(rootB);
    // Larger component keeps the root; its accumulator continues.
    const sizeA = membersOf(rootA).length;
    const sizeB = membersOf(rootB).length;
    const [keepRoot, dropRoot, keep, drop] =
      sizeA >= sizeB ? [rootA, rootB, cohortA, cohortB] : [rootB, rootA, cohortB, cohortA];
    parent.set(dropRoot, keepRoot);
    const merged = ensureCohort(keepRoot, atMs, atMonoMs);
    const mergeContributions = (into: CohortState, from: CohortState): void => {
      for (const [member, value] of from.contributions) {
        into.contributions.set(member, (into.contributions.get(member) ?? 0) + value);
      }
    };
    if (keep && drop) {
      merged.score = keep.score;
      merged.flagged = keep.flagged || drop.flagged;
      merged.flagNotificationPending = keep.flagNotificationPending || drop.flagNotificationPending;
      merged.flaggedAtMs = Math.max(keep.flaggedAtMs, drop.flaggedAtMs);
      merged.ceilingActive = keep.ceilingActive || drop.ceilingActive;
      merged.ceilingArmed = keep.ceilingArmed || drop.ceilingArmed;
      merged.contributions = new Map(keep.contributions);
      mergeContributions(merged, drop);
      const mergedBucket = mergeCohortBucketStates(
        { tokens: keep.bucketTokens, lastRefillMs: keep.bucketLastRefillMs, burst: bucketBurst, refillPerSecond: bucketRate(keep.members.size) },
        { tokens: drop.bucketTokens, lastRefillMs: drop.bucketLastRefillMs, burst: bucketBurst, refillPerSecond: bucketRate(drop.members.size) },
      );
      merged.bucketTokens = mergedBucket.tokens;
      merged.bucketLastRefillMs = mergedBucket.lastRefillMs;
      // The monotonic refill anchor merges by the same "latest wins"
      // rule the merged bucket's lastRefillMs follows.
      merged.bucketLastRefillMonoMs = Math.max(keep.bucketLastRefillMonoMs, drop.bucketLastRefillMonoMs);
    } else if (!keep && drop) {
      merged.score = drop.score;
      merged.flagged = drop.flagged;
      merged.flagNotificationPending = drop.flagNotificationPending;
      merged.flaggedAtMs = drop.flaggedAtMs;
      merged.ceilingActive = drop.ceilingActive;
      merged.ceilingArmed = drop.ceilingArmed;
      merged.bucketTokens = drop.bucketTokens;
      merged.bucketLastRefillMs = drop.bucketLastRefillMs;
      merged.bucketLastRefillMonoMs = drop.bucketLastRefillMonoMs;
      merged.contributions = new Map(drop.contributions);
    }
    cohorts.delete(dropRoot);
    merged.members = new Set(membersOf(keepRoot));
    merged.id = cohortIdFor([...merged.members]);
    singletonScores.delete(a);
    singletonScores.delete(b);
    return merged;
  };

  const unionRecords = (cohort: CohortState): number => {
    const union = new Set<number>();
    for (const member of cohort.members) {
      const state = identities.get(member);
      if (state) for (const id of state.served) union.add(id);
    }
    return union.size;
  };

  const pairKeyOf = (a: string, b: string): string => (a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`);

  const setOverlap = (a: Set<number>, b: Set<number>): { intersection: number; union: number } => {
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let intersection = 0;
    for (const id of small) if (big.has(id)) intersection++;
    return { intersection, union: a.size + b.size - intersection };
  };

  const coldDensity = (state: IdentityState): number => {
    if (state.coldSet.size === 0 || state.coldMin === null || state.coldMax === null) return 0;
    return state.coldSet.size / (state.coldMax - state.coldMin + 1);
  };

  /*
   * Formation - cohort grouping without a predicate.
   *
   * (a) Served-set complementarity stands in for the predicate when a
   * list carries a filter: a range predicate does not honestly exist
   * for a text filter, but the served set always does, so two
   * identities whose served sets are large, co-active, near-disjoint
   * and jointly large are partitioning something whether or not a
   * predicate was ever emitted.
   * (b) Cold-walk complementarity works on cold detail ids only: a
   * warm fetch contributes nothing, because a warm id was introduced
   * to that identity first - only ids fetched cold extend the walk.
   * (c) Known limit, stated plainly: a compliance team reviewing
   * details sequentially is NOT separable from a walker at the
   * formation level - both walk disjoint, dense, cold ranges. The
   * consequence for that shape is blocked at the friction tier for
   * inferred cohorts by the tiering law, and a host-declared
   * protected cohort is exempt from inferred consequences; formation
   * itself makes no claim to tell the two apart.
   *
   * Merges reuse mergeIdentities, so the existing rules carry over
   * unchanged: singleton scores are discarded on merge, union-find
   * roots update through the same path, and epoch rotation is
   * untouched. Pair evaluation is throttled like herd v2: a pair is
   * re-evaluated only once its smaller side has grown by at least
   * formationRecheckGrowth since the last full evaluation.
   */
  const evaluateFormation = (identity: string, ts: number, tsMono: number): void => {
    if (!formationSlice && !formationColdWalk) return;
    const self = identities.get(identity);
    if (!self) return;
    for (const otherId of [...identities.keys()]) {
      if (otherId === identity) continue;
      const other = identities.get(otherId);
      if (!other) continue;
      if (formationSlice) {
        if (find(otherId) !== find(identity)) {
          const curMin = Math.min(self.served.size, other.served.size);
          if (
            curMin >= formationMinServed &&
            Math.abs(ts - other.lastActiveTs) <= formationWindowMs
          ) {
            const key = pairKeyOf(identity, otherId);
            const lastChecked = pairThrottleGet(slicePairLastChecked, key, ts);
            if (lastChecked === undefined || curMin - lastChecked >= formationRecheckGrowth) {
              pairThrottleSet(slicePairLastChecked, key, curMin, ts);
              const { intersection, union } = setOverlap(self.served, other.served);
              const jaccard = union > 0 ? intersection / union : 0;
              if (jaccard <= formationMaxOverlap && union >= formationMinUnion) {
                mergeIdentities(identity, otherId, ts, tsMono);
              }
            }
          }
        }
      }
      if (formationColdWalk) {
        if (find(otherId) === find(identity)) continue;
        const curMin = Math.min(self.coldSet.size, other.coldSet.size);
        if (
          curMin >= formationMinCold &&
          Math.abs(ts - other.lastColdTs) <= formationWindowMs &&
          coldDensity(self) >= formationMinRangeDensity &&
          coldDensity(other) >= formationMinRangeDensity
        ) {
          const key = pairKeyOf(identity, otherId);
          const lastChecked = pairThrottleGet(coldPairLastChecked, key, ts);
          if (lastChecked === undefined || curMin - lastChecked >= formationRecheckGrowth) {
            pairThrottleSet(coldPairLastChecked, key, curMin, ts);
            const { intersection, union } = setOverlap(self.coldSet, other.coldSet);
            const jaccard = union > 0 ? intersection / union : 0;
            if (jaccard <= formationMaxOverlap && union >= formationMinUnion) {
              mergeIdentities(identity, otherId, ts, tsMono);
            }
          }
        }
      }
    }
  };

  /*
   * Host callbacks are never trusted to behave (F-08): a throwing
   * `isExempt` / `isProtected` predicate is treated as if the
   * predicate were absent (the subject is not exempt / not
   * protected) and the error is swallowed - the sibling engines
   * (herd, flow, action-cohort) already wrap host callbacks this
   * way, and an exception escaping observe() / checkServe() would
   * land in the host's request path.
   */
  const safeIsExempt = (identity: string): boolean => {
    if (!options.isExempt) return false;
    try {
      return options.isExempt(identity) === true;
    } catch {
      return false;
    }
  };
  const safeIsProtected = (identity: string): boolean => {
    if (!options.isProtected) return false;
    try {
      return options.isProtected(identity) === true;
    } catch {
      return false;
    }
  };

  const snapshotOf = (cohort: CohortState, atMs: number, atMonoMs: number): CampaignSnapshot => {
    refill(cohort, atMs, atMonoMs);
    // A snapshot must never under-report an armed declared ceiling.
    maybeArmDeclaredCeiling(cohort, atMs);
    const union = unionRecords(cohort);
    return {
      cohortId: cohort.id,
      members: [...cohort.members].sort(),
      contributingMembers: [...cohort.members]
        .filter(member => (cohort.contributions.get(member) ?? 0) > 0)
        .sort(),
      protectedMembers: [...cohort.members]
        .filter(member => safeIsProtected(member))
        .sort(),
      score: cohort.score,
      flagged: cohort.flagged,
      ceilingActive: cohort.ceilingActive,
      ceilingArmed: cohort.ceilingArmed,
      unionRecords: union,
      consequenceEligible: union >= minConsequenceUnion,
      consequenceFloorRecords: minConsequenceUnion,
      ceilingLimit,
      bucketTokens: Math.floor(cohort.bucketTokens),
      stateSizes: {
        identities: identities.size,
        cohorts: cohorts.size,
        pairThrottles: slicePairLastChecked.size + coldPairLastChecked.size,
      },
      calibrationVersion: tables.version,
      uncalibrated: tables.uncalibrated,
      notice: tables.uncalibrated ? UNCALIBRATED_AUDIT_ONLY_NOTICE : "calibrated tables supplied by host",
    };
  };

  /**
   * Deliver a pending campaign-flag notification (F-08). The flag
   * used to latch BEFORE the host callback ran, so a throwing
   * `onCampaignFlag` both rejected observe() into the host's request
   * path AND lost the notification forever (the callback only fires
   * in the crossing branch). Now the crossing marks the notification
   * pending and delivery is attempted here: success clears the
   * marker, a throw keeps it, and the next observe / snapshot of the
   * cohort retries. The snapshot handed to the callback is built
   * fresh at each attempt.
   */
  const deliverFlag = (cohort: CohortState, atMs: number, atMonoMs: number): void => {
    if (!cohort.flagNotificationPending) return;
    if (!options.onCampaignFlag) {
      cohort.flagNotificationPending = false;
      return;
    }
    try {
      options.onCampaignFlag(snapshotOf(cohort, atMs, atMonoMs));
      cohort.flagNotificationPending = false;
    } catch {
      /* Stays pending; retried on the next observe / snapshot. */
    }
  };

  const consequenceFloorReason = (union: number): string =>
    `consequence floor: exact union coverage ${union} is below the ${minConsequenceUnion}-record floor - ` +
    "the crossing is telemetry only until the cohort's union reaches it (v24 classic-test fix)";

  /**
   * Resolve the enforce-mode consequence for an ELIGIBLE flagged
   * cohort under the tiering law: engage the shared ceiling only when
   * the law allows it outright, else step-up with the clamp reason.
   */
  const resolveConsequence = (
    cohort: CohortState,
    atMs: number,
  ): { action: "step_up" | "campaign_engaged"; clampedReason?: string } => {
    const evaluation = evaluateCalibrationManifest(options.manifest ?? null, {
      ...options.calibrationGate,
      now: atMs,
    });
    const clamp = clampEnforcement("hard_ceiling", {
      origin: cohortOrigin(cohort),
      calibrationTier: evaluation.tier,
      tripwireGated: true,
    });
    if (!clamp.clamped && clamp.action === "hard_ceiling") {
      cohort.ceilingActive = true;
      return { action: "campaign_engaged" };
    }
    return { action: "step_up", clampedReason: clamp.reason };
  };

  const cohortOrigin = (cohort: CohortState): CohortOrigin => {
    const groups = new Set<number>();
    for (const member of cohort.members) {
      const group = declaredGroupOf.get(member);
      if (group !== undefined) groups.add(group);
    }
    return groups.size === 1 && cohort.members.size > 0 && [...cohort.members].every(m => declaredGroupOf.get(m) !== undefined)
      ? "host_declared"
      : "inferred";
  };

  /**
   * Whether a HOST-DECLARED cohort may lawfully carry a hard ceiling
   * from declaration: the manifest must evaluate to the `ceiling`
   * tier AND the tiering clamp must let `hard_ceiling` through for a
   * declared cohort at that tier. Both conditions are required - a
   * declaration without ceiling-tier calibration arms nothing.
   */
  const declaredCeilingLawful = (atMs: number): boolean => {
    const evaluation = evaluateCalibrationManifest(options.manifest ?? null, {
      ...options.calibrationGate,
      now: atMs,
    });
    if (evaluation.tier !== "ceiling") return false;
    const clamp = clampEnforcement("hard_ceiling", {
      origin: "host_declared",
      calibrationTier: evaluation.tier,
      tripwireGated: true,
    });
    return !clamp.clamped && clamp.action === "hard_ceiling";
  };

  /**
   * Arm a cohort's campaign ceiling at declaration, when lawful.
   * Only ever SETS the armed state: a cohort whose origin is not
   * host-declared (every member from the same declared group), or
   * whose manifest is not ceiling-tier, is left exactly as it was,
   * so inferred cohorts keep the crossing-gated path untouched.
   */
  const maybeArmDeclaredCeiling = (cohort: CohortState, atMs: number): boolean => {
    if (cohort.ceilingArmed) {
      cohort.ceilingActive = true;
      return true;
    }
    if (cohortOrigin(cohort) !== "host_declared") return false;
    if (!declaredCeilingLawful(atMs)) return false;
    cohort.ceilingArmed = true;
    cohort.ceilingActive = true;
    return true;
  };

  /*
   * Declared cohorts exist from declaration, not from detection:
   * form each declared group into one cohort at construction and arm
   * its ceiling when the law above allows. The union therefore
   * counts every member's serves from the first record, and a member
   * is never a singleton waiting for a formation signal to merge it
   * into the cohort the host already named. (Groups the host
   * declared without a ceiling-tier manifest still form - origin is
   * a fact about the cohort - they are simply not armed.)
   */
  {
    const armTs = now();
    const armMono = monoNowFn();
    for (const group of options.declaredCohorts ?? []) {
      const members = [...new Set(group)].filter(member => member.length > 0);
      if (members.length === 0) continue;
      for (const member of members) identityState(member);
      let cohort = ensureCohort(find(members[0] as string), armTs, armMono);
      for (const member of members.slice(1)) cohort = mergeIdentities(members[0] as string, member, armTs, armMono);
      maybeArmDeclaredCeiling(cohort, armTs);
    }
  }

  async function observe(event: CusumEvent): Promise<CusumDecision> {
    const ts = event.ts ?? now();
    // Internal-clock events also stamp the monotonic twin; host-ts
    // events stay in the host's time domain (their twin mirrors ts).
    const tsMono = event.ts !== undefined ? ts : monoNowFn();
    const identity = event.identity;
    if (safeIsExempt(identity)) {
      return {
        identity,
        cohortId: null,
        score: 0,
        increments: EMPTY_INCREMENTS(),
        bins: { adjacency: null, tiling: null, cold: null, velocity: null },
        crossed: false,
        flagged: false,
        ceilingActive: false,
        action: "none",
        consequenceEligible: false,
        protectedSubject: false,
      };
    }
    const state = identityState(identity);
    state.lastActiveTs = ts;
    const increments = EMPTY_INCREMENTS();
    const bins: CusumDecision["bins"] = { adjacency: null, tiling: null, cold: null, velocity: null };

    /* Warm set: list/search renders introduce ids (spec SS1.3). */
    if (event.introducedIds) for (const id of event.introducedIds) state.introduced.add(id);
    if ((event.type === "list" || event.type === "search") && event.recordIds) {
      for (const id of event.recordIds) state.introduced.add(id);
    }

    /* --- Stream 1: predicate adjacency --- */
    let cohort = cohortOf(identity);
    if (event.echoFrom && event.echoFrom !== identity) {
      identityState(event.echoFrom);
      cohort = mergeIdentities(identity, event.echoFrom, ts, tsMono);
    }
    if (streams.adjacency && event.predicate) {
      const p = event.predicate;
      const span = p.domainMax - p.domainMin;
      if (span > 0) {
        const l = (p.min - p.domainMin) / span;
        const u = (p.max - p.domainMin) / span;
        if (u - l >= 0.999) {
          /* Whole-domain predicate: NO edge, NO evidence (R6 fix). */
          increments.adjacency = 0;
        } else {
          const abutting: string[] = [];
          for (const entry of predicateRing) {
            if (entry.identity === identity || entry.field !== p.field) continue;
            const gap = Math.max(entry.l - u, l - entry.u);
            const intersection = Math.max(0, Math.min(u, entry.u) - Math.max(l, entry.l));
            const union = Math.max(u, entry.u) - Math.min(l, entry.l);
            const iou = union > 0 ? intersection / union : 0;
            if (gap <= 0.015 && iou < 0.1 && !abutting.includes(entry.identity)) abutting.push(entry.identity);
          }
          predicateRing.push({ identity, field: p.field, l, u });
          if (predicateRing.length > 256) predicateRing.splice(0, predicateRing.length - 256);
          if (abutting.length > 0) {
            for (const other of abutting) cohort = mergeIdentities(identity, other, ts, tsMono);
            if (event.recordIds) {
              for (const id of event.recordIds) if (id >= p.min && id <= p.max) state.explained.add(id);
            }
            const size = cohort ? cohort.members.size : 2;
            const adjacencyBin =
              size >= 5 ? "c5plus" : size === 4 ? "c4" : size === 3 ? "c3" : "c2";
            bins.adjacency = adjacencyBin;
            increments.adjacency = tables.adjacency[adjacencyBin];
          } else {
            bins.adjacency = "null";
            increments.adjacency = tables.adjacency.null;
          }
        }
      }
    }

    /* Served set (post-serve accounting, one unit per event). */
    if (event.recordIds) for (const id of event.recordIds) state.served.add(id);

    /* --- Stream 3: cold-ID misses over exact introduced sets --- */
    // Formation cold state is tracked on the same isCold test (a
    // detail id not in the introduced set at observe time), whether
    // or not the cold evidence stream itself is enabled.
    const isColdDetail =
      event.type === "detail" && event.detailId !== undefined && !state.introduced.has(event.detailId);
    if (isColdDetail && event.detailId !== undefined) {
      state.coldSet.add(event.detailId);
      state.coldMin = state.coldMin === null ? event.detailId : Math.min(state.coldMin, event.detailId);
      state.coldMax = state.coldMax === null ? event.detailId : Math.max(state.coldMax, event.detailId);
      state.lastColdTs = ts;
    }
    if (streams.cold && event.type === "detail" && event.detailId !== undefined) {
      if (state.introduced.has(event.detailId)) {
        bins.cold = "warm";
        increments.cold = tables.cold.warm;
      } else {
        state.coldWindow.push({ ts, id: event.detailId });
        state.coldWindow = state.coldWindow.filter(entry => ts - entry.ts <= 60_000);
        const count = state.coldWindow.length;
        const recent = state.coldWindow.slice(-6).map(entry => entry.id);
        const deltas: number[] = [];
        for (let i = 1; i < recent.length; i++) deltas.push((recent[i] as number) - (recent[i - 1] as number));
        let regular = false;
        if (deltas.length >= 4) {
          const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
          const variance = deltas.reduce((a, d) => a + (d - mean) * (d - mean), 0) / deltas.length;
          regular = variance <= 4;
        }
        const coldBin =
          regular && count >= 3 ? "high_regular" : count >= 6 ? "high" : count >= 3 ? "mid" : "low";
        bins.cold = coldBin;
        increments.cold = tables.cold[coldBin];
      }
    }

    /* --- Stream 4: cursor velocity (EWMA dwell per record) --- */
    if (streams.velocity && event.cursor) {
      const dwell = (ts - event.cursor.issuedAtMs) / Math.max(1, event.cursor.pageSize);
      state.ewmaTauMs = 0.7 * state.ewmaTauMs + 0.3 * dwell;
      if (event.cursor.step > 3) {
        const tau = state.ewmaTauMs;
        const velocityBin =
          tau >= 200 ? "human" : tau >= 80 ? "v80_200" : tau >= 30 ? "v30_80" : "v_lt_30";
        bins.velocity = velocityBin;
        increments.velocity = tables.velocity[velocityBin];
      }
    }

    /* Formation: pair this identity against the others on its
     * just-updated served / cold state, BEFORE scoring, so the
     * current event belongs to the new cohort when a merge fires -
     * the same ordering adjacency merges already use. */
    evaluateFormation(identity, ts, tsMono);

    /* Refresh cohort membership after possible merges. */
    cohort = cohortOf(identity);
    if (cohort) maybeArmDeclaredCeiling(cohort, ts);
    const inCohort = cohort !== null && cohort.members.size >= 2;

    /* --- Stream 2: exact-set tiling, adjacency-explained records excluded --- */
    if (streams.tiling && event.recordIds && event.recordIds.length > 0 && inCohort && cohort) {
      const members = [...cohort.members];
      const rawSizes = members.map(m => identities.get(m)?.served.size ?? 0);
      const sumRaw = rawSizes.reduce((a, b) => a + b, 0);
      if (rawSizes.every(size => size >= minMemberRecords) && sumRaw >= minCohortSum) {
        let sum = 0;
        const union = new Set<number>();
        for (const member of members) {
          const memberState = identities.get(member);
          if (!memberState) continue;
          let counted = 0;
          for (const id of memberState.served) {
            if (memberState.explained.has(id)) continue;
            counted++;
            union.add(id);
          }
          sum += counted;
        }
        if (sum > 0) {
          const eta = union.size / sum;
          const nEff = tables.nEff;
          const etaExp = (nEff * (1 - Math.exp(-sum / nEff))) / sum;
          const z = (eta - etaExp) / Math.max(1e-9, 1 - etaExp);
          const tilingBin =
            z < 0.3
              ? "z_lt_0_3"
              : z < 0.5
                ? "z_0_3_0_5"
                : z < 0.65
                  ? "z_0_5_0_65"
                  : z < 0.78
                    ? "z_0_65_0_78"
                    : "z_ge_0_78";
          bins.tiling = tilingBin;
          increments.tiling = tables.tiling[tilingBin];
        }
      }
    }

    /* --- Accumulate (one-sided, zero floor) --- */
    const total = increments.adjacency + increments.tiling + increments.cold + increments.velocity;
    let crossed = false;
    let action: CusumDecision["action"] = "none";
    let clampedReason: string | undefined;
    let flagDeliveryAttempted = false;

    if (inCohort && cohort) {
      if (cohort.flagged && ts - cohort.flaggedAtMs > epochMs) {
        cohort.flagged = false;
        cohort.ceilingActive = false;
        // Epoch rotation opens a NEW evidence window (F-11): the
        // accumulator and the per-member attribution reset with the
        // flag, so the first event of the new epoch cannot re-cross
        // on the stale score, and friction cannot target members
        // whose only contributions predate the rotation. (The
        // served/union sets are facts, not an evidence window - the
        // consequence floor keeps reading them, so they stay.)
        cohort.score = 0;
        cohort.contributions.clear();
        cohort.flagNotificationPending = false;
        // Epoch rotation retires a flag, not a host declaration: an
        // armed declared ceiling survives it.
        maybeArmDeclaredCeiling(cohort, ts);
      }
      cohort.score = Math.max(0, cohort.score + total);
      // Attribution: credit follows the acting subject (net increments
      // from events observed while a member of this cohort).
      cohort.contributions.set(identity, (cohort.contributions.get(identity) ?? 0) + total);
      const unionNow = unionRecords(cohort);
      const eligible = unionNow >= minConsequenceUnion;
      if (!cohort.flagged && cohort.score >= boundary) {
        crossed = true;
        cohort.flagged = true;
        cohort.flaggedAtMs = ts;
        if (mode === "observe") {
          action = "logged";
        } else if (!eligible) {
          // Telemetry stands; consequences wait for absolute scale.
          action = "logged";
          clampedReason = consequenceFloorReason(unionNow);
        } else {
          const resolved = resolveConsequence(cohort, ts);
          action = resolved.action;
          clampedReason = resolved.clampedReason;
        }
        // Mark first, deliver second (F-08): if the host callback
        // throws, the notification stays pending and is retried by a
        // later observe / snapshot instead of being lost with the
        // latched flag - and the throw never escapes observe().
        cohort.flagNotificationPending = true;
        flagDeliveryAttempted = true;
        deliverFlag(cohort, ts, tsMono);
      } else if (cohort.flagged) {
        if (mode === "observe") {
          action = "logged";
        } else if (!eligible) {
          action = "logged";
          clampedReason = consequenceFloorReason(unionNow);
        } else if (cohort.ceilingActive) {
          action = "campaign_engaged";
        } else {
          // Also covers a cohort that crossed below the floor and has
          // since grown into eligibility while still flagged.
          const resolved = resolveConsequence(cohort, ts);
          action = resolved.action;
          clampedReason = resolved.clampedReason;
        }
      }
      // Armed declared ceiling, host ignoring checkServe: the cap is
      // already reached, so the decision reports the engagement even
      // though this cohort never crossed (and may never cross).
      if (
        !cohort.flagged &&
        cohort.ceilingArmed &&
        cohort.ceilingActive &&
        mode === "enforce" &&
        unionNow >= ceilingLimit
      ) {
        action = "campaign_engaged";
      }
      // Retry a flag notification an earlier throwing callback lost
      // (F-08) - at most one delivery attempt per observe call.
      if (!flagDeliveryAttempted) deliverFlag(cohort, ts, tsMono);
      // Protection (protected-cohorts.ts): for an INFERRED cohort, a
      // host-declared protected subject keeps the evidence but never
      // the consequence - the decision collapses to telemetry for
      // this subject, while unprotected members are unaffected.
      const protectedHere =
        cohortOrigin(cohort) === "inferred" && safeIsProtected(identity);
      if (protectedHere && (action === "step_up" || action === "campaign_engaged")) {
        action = "logged";
        clampedReason =
          "protected subject (host-declared): inferred-evidence consequences are suppressed - telemetry only";
      }
      return {
        identity,
        cohortId: cohort.id,
        score: cohort.score,
        increments,
        bins,
        crossed,
        flagged: cohort.flagged,
        ceilingActive: cohort.ceilingActive,
        action,
        consequenceEligible: eligible,
        protectedSubject: protectedHere,
        ...(clampedReason ? { clampedReason } : {}),
      };
    }

    const singletonScore = Math.max(0, (singletonScores.get(identity) ?? 0) + total);
    singletonScores.set(identity, singletonScore);
    return {
      identity,
      cohortId: null,
      score: singletonScore,
      increments,
      bins,
      crossed: false,
      flagged: false,
      // A single-member declared cohort reaches this path (scoring
      // needs a pair) - its armed ceiling state still reports here.
      ceilingActive: cohort?.ceilingActive ?? false,
      action: "none",
      consequenceEligible: false,
      protectedSubject: false,
      ...(clampedReason ? { clampedReason } : {}),
    };
  }

  async function checkServe(identity: string, requested: number) {
    // Input discipline (F-09): a non-finite or negative `requested`
    // must never reach the bucket arithmetic - a NaN debit poisons
    // the cohort bucket permanently (NaN survives every refill,
    // because Math.min never cleanses it) and a negative one mints
    // tokens out of thin air. Refuse structurally, mutate no bucket
    // state, and never throw into the host's serving path.
    if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0) {
      const cohort = cohortOf(identity);
      return {
        allowed: 0,
        ...(cohort ? { cohortId: cohort.id } : {}),
        reason: "invalid_request",
      };
    }
    const ts = now();
    const tsMono = monoNowFn();
    const cohort = cohortOf(identity);
    if (!cohort || mode === "observe") return { allowed: requested };
    // An armed declared ceiling enforces WITHOUT a flag: the cohort
    // was named by the host and its cap counts from the first record.
    const armed = maybeArmDeclaredCeiling(cohort, ts);
    if (!cohort.flagged && !armed) return { allowed: requested };
    // A protected subject in an inferred cohort is never paced or
    // ceilinged by that cohort's inferred evidence. (Protection never
    // applies inside a host-declared cohort - see the header.)
    if (cohortOrigin(cohort) === "inferred" && safeIsProtected(identity)) {
      return { allowed: requested };
    }
    const unionNow = unionRecords(cohort);
    // The armed cap binds before the consequence floor and before
    // any crossing: at the limit, every further serve is refused.
    if (armed && unionNow >= ceilingLimit) {
      return { allowed: 0, cohortId: cohort.id, reason: "campaign_ceiling" };
    }
    // A multi-record request must not overshoot the armed cap by
    // request granularity: below the limit, the armed path allows at
    // most the remaining headroom, so a host serving exactly
    // `allowed` records lands the union exactly on the limit and the
    // next call refuses. (Hosts that treat any short allowance as a
    // whole-request refusal - the classic harness does - simply
    // refuse a little earlier; the cap still never leaks.)
    if (armed && ceilingLimit - unionNow < requested) {
      return {
        allowed: Math.max(0, ceilingLimit - unionNow),
        cohortId: cohort.id,
        reason: "campaign_ceiling",
      };
    }
    // Armed but below the cap and not flagged: no pacing tax either -
    // pacing remains a consequence of a flag, not of a declaration.
    if (!cohort.flagged) return { allowed: requested };
    // A below-floor flag is telemetry only: no pacing, no ceiling.
    if (unionNow < minConsequenceUnion) return { allowed: requested };
    if (cohort.ceilingActive && unionNow >= ceilingLimit) {
      return { allowed: 0, cohortId: cohort.id, reason: "campaign_ceiling" };
    }
    refill(cohort, ts, tsMono);
    const allowed = Math.min(requested, Math.floor(cohort.bucketTokens));
    cohort.bucketTokens -= allowed;
    if (allowed < requested) {
      const rho = bucketRate(cohort.members.size);
      return {
        allowed,
        cohortId: cohort.id,
        notBeforeMs: ts + Math.ceil(((requested - allowed) / rho) * 1000),
        reason: "campaign_bucket",
      };
    }
    return { allowed, cohortId: cohort.id };
  }

  return {
    observe,
    checkServe,
    async getSnapshot(cohortId) {
      for (const cohort of cohorts.values()) {
        if (cohort.id === cohortId) {
          const atMs = now();
          const atMonoMs = monoNowFn();
          const snapshot = snapshotOf(cohort, atMs, atMonoMs);
          // A snapshot read is also a flag-delivery retry point (F-08).
          deliverFlag(cohort, atMs, atMonoMs);
          return snapshot;
        }
      }
      return null;
    },
    async snapshotFor(identity) {
      const cohort = cohortOf(identity);
      // A cohort snapshot normally needs a pair - except an armed
      // declared cohort, whose state (armed, capped) is meaningful
      // even for a single-member declared group.
      if (cohort && (cohort.members.size >= 2 || cohort.ceilingArmed)) {
        const atMs = now();
        const atMonoMs = monoNowFn();
        const snapshot = snapshotOf(cohort, atMs, atMonoMs);
        // A snapshot read is also a flag-delivery retry point (F-08).
        deliverFlag(cohort, atMs, atMonoMs);
        return snapshot;
      }
      return null;
    },
    async clearCohort(cohortId) {
      for (const cohort of cohorts.values()) {
        if (cohort.id === cohortId) {
          cohort.flagged = false;
          cohort.ceilingActive = false;
          cohort.score = 0;
          cohort.contributions.clear();
          cohort.flagNotificationPending = false;
          // Clearing also rehabilitates the pacing bucket (F-09): a
          // full bucket on fresh refill anchors is the host's
          // recovery path for a bucket damaged by bad debits - the
          // pre-fix clear left the bucket exactly as poisoned as it
          // found it.
          cohort.bucketTokens = bucketBurst;
          cohort.bucketLastRefillMs = now();
          cohort.bucketLastRefillMonoMs = monoNowFn();
          // Note: clearing retires the flag and the score, not the
          // host's declaration - an armed declared ceiling re-arms on
          // the next snapshot / checkServe for as long as the cohort
          // stays declared with a ceiling-tier manifest.
        }
      }
    },
  };
}
