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
  crossed: boolean;
  flagged: boolean;
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
  unionRecords: number;
  /** True once `unionRecords` reaches `consequenceFloorRecords`. */
  consequenceEligible: boolean;
  /** The absolute floor (exact distinct records) in effect. */
  consequenceFloorRecords: number;
  ceilingLimit: number;
  bucketTokens: number;
  calibrationVersion: string;
  uncalibrated: boolean;
  notice: string;
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
}

interface CohortState {
  id: string;
  members: Set<string>;
  score: number;
  flagged: boolean;
  flaggedAtMs: number;
  ceilingActive: boolean;
  bucketTokens: number;
  bucketLastRefillMs: number;
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
  const minMemberRecords = Math.max(1, options.gates?.minMemberRecords ?? 150);
  const minCohortSum = Math.max(1, options.gates?.minCohortSum ?? 1200);
  // Consequence floor: defaults to the tiling per-member gate (the
  // spec's absolute-scale constant); see the header derivation.
  const minConsequenceUnion = Math.max(1, options.consequences?.minUnionRecords ?? minMemberRecords);
  const now = options.now ?? Date.now;

  const declaredGroupOf = new Map<string, number>();
  (options.declaredCohorts ?? []).forEach((group, index) => {
    for (const member of group) declaredGroupOf.set(member, index);
  });

  const identities = new Map<string, IdentityState>();
  const parent = new Map<string, string>();
  const cohorts = new Map<string, CohortState>();
  const singletonScores = new Map<string, number>();
  const predicateRing: PredicateEntry[] = [];

  const identityState = (identity: string): IdentityState => {
    let state = identities.get(identity);
    if (!state) {
      state = { served: new Set(), introduced: new Set(), explained: new Set(), coldWindow: [], ewmaTauMs: 150 };
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

  const bucketRate = (size: number): number => bucketRateBase * Math.pow(Math.max(1, size), bucketRateExponent);

  const refill = (cohort: CohortState, atMs: number): void => {
    const elapsed = Math.max(0, atMs - cohort.bucketLastRefillMs);
    if (elapsed > 0) {
      cohort.bucketTokens = Math.min(
        bucketBurst,
        cohort.bucketTokens + (elapsed / 1000) * bucketRate(cohort.members.size),
      );
    }
    cohort.bucketLastRefillMs = atMs;
  };

  const ensureCohort = (root: string, atMs: number): CohortState => {
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
        bucketTokens: bucketBurst,
        bucketLastRefillMs: atMs,
        contributions: new Map(),
      };
      cohorts.set(root, cohort);
    }
    return cohort;
  };

  /** Union-find merge with R6 rules: singleton scores discarded, bucket min-merged. */
  const mergeIdentities = (a: string, b: string, atMs: number): CohortState => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return ensureCohort(rootA, atMs);
    const cohortA = cohorts.get(rootA);
    const cohortB = cohorts.get(rootB);
    // Larger component keeps the root; its accumulator continues.
    const sizeA = membersOf(rootA).length;
    const sizeB = membersOf(rootB).length;
    const [keepRoot, dropRoot, keep, drop] =
      sizeA >= sizeB ? [rootA, rootB, cohortA, cohortB] : [rootB, rootA, cohortB, cohortA];
    parent.set(dropRoot, keepRoot);
    const merged = ensureCohort(keepRoot, atMs);
    const mergeContributions = (into: CohortState, from: CohortState): void => {
      for (const [member, value] of from.contributions) {
        into.contributions.set(member, (into.contributions.get(member) ?? 0) + value);
      }
    };
    if (keep && drop) {
      merged.score = keep.score;
      merged.flagged = keep.flagged || drop.flagged;
      merged.flaggedAtMs = Math.max(keep.flaggedAtMs, drop.flaggedAtMs);
      merged.ceilingActive = keep.ceilingActive || drop.ceilingActive;
      merged.contributions = new Map(keep.contributions);
      mergeContributions(merged, drop);
      const mergedBucket = mergeCohortBucketStates(
        { tokens: keep.bucketTokens, lastRefillMs: keep.bucketLastRefillMs, burst: bucketBurst, refillPerSecond: bucketRate(keep.members.size) },
        { tokens: drop.bucketTokens, lastRefillMs: drop.bucketLastRefillMs, burst: bucketBurst, refillPerSecond: bucketRate(drop.members.size) },
      );
      merged.bucketTokens = mergedBucket.tokens;
      merged.bucketLastRefillMs = mergedBucket.lastRefillMs;
    } else if (!keep && drop) {
      merged.score = drop.score;
      merged.flagged = drop.flagged;
      merged.flaggedAtMs = drop.flaggedAtMs;
      merged.ceilingActive = drop.ceilingActive;
      merged.bucketTokens = drop.bucketTokens;
      merged.bucketLastRefillMs = drop.bucketLastRefillMs;
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

  const snapshotOf = (cohort: CohortState, atMs: number): CampaignSnapshot => {
    refill(cohort, atMs);
    const union = unionRecords(cohort);
    return {
      cohortId: cohort.id,
      members: [...cohort.members].sort(),
      contributingMembers: [...cohort.members]
        .filter(member => (cohort.contributions.get(member) ?? 0) > 0)
        .sort(),
      protectedMembers: [...cohort.members]
        .filter(member => options.isProtected?.(member) === true)
        .sort(),
      score: cohort.score,
      flagged: cohort.flagged,
      ceilingActive: cohort.ceilingActive,
      unionRecords: union,
      consequenceEligible: union >= minConsequenceUnion,
      consequenceFloorRecords: minConsequenceUnion,
      ceilingLimit,
      bucketTokens: Math.floor(cohort.bucketTokens),
      calibrationVersion: tables.version,
      uncalibrated: tables.uncalibrated,
      notice: tables.uncalibrated ? UNCALIBRATED_AUDIT_ONLY_NOTICE : "calibrated tables supplied by host",
    };
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

  async function observe(event: CusumEvent): Promise<CusumDecision> {
    const ts = event.ts ?? now();
    const identity = event.identity;
    if (options.isExempt && options.isExempt(identity)) {
      return {
        identity,
        cohortId: null,
        score: 0,
        increments: EMPTY_INCREMENTS(),
        crossed: false,
        flagged: false,
        action: "none",
        consequenceEligible: false,
        protectedSubject: false,
      };
    }
    const state = identityState(identity);
    const increments = EMPTY_INCREMENTS();

    /* Warm set: list/search renders introduce ids (spec SS1.3). */
    if (event.introducedIds) for (const id of event.introducedIds) state.introduced.add(id);
    if ((event.type === "list" || event.type === "search") && event.recordIds) {
      for (const id of event.recordIds) state.introduced.add(id);
    }

    /* --- Stream 1: predicate adjacency --- */
    let cohort = cohortOf(identity);
    if (event.echoFrom && event.echoFrom !== identity) {
      identityState(event.echoFrom);
      cohort = mergeIdentities(identity, event.echoFrom, ts);
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
            for (const other of abutting) cohort = mergeIdentities(identity, other, ts);
            if (event.recordIds) {
              for (const id of event.recordIds) if (id >= p.min && id <= p.max) state.explained.add(id);
            }
            const size = cohort ? cohort.members.size : 2;
            increments.adjacency =
              size >= 5 ? tables.adjacency.c5plus : size === 4 ? tables.adjacency.c4 : size === 3 ? tables.adjacency.c3 : tables.adjacency.c2;
          } else {
            increments.adjacency = tables.adjacency.null;
          }
        }
      }
    }

    /* Served set (post-serve accounting, one unit per event). */
    if (event.recordIds) for (const id of event.recordIds) state.served.add(id);

    /* --- Stream 3: cold-ID misses over exact introduced sets --- */
    if (streams.cold && event.type === "detail" && event.detailId !== undefined) {
      if (state.introduced.has(event.detailId)) {
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
        increments.cold =
          regular && count >= 3
            ? tables.cold.high_regular
            : count >= 6
              ? tables.cold.high
              : count >= 3
                ? tables.cold.mid
                : tables.cold.low;
      }
    }

    /* --- Stream 4: cursor velocity (EWMA dwell per record) --- */
    if (streams.velocity && event.cursor) {
      const dwell = (ts - event.cursor.issuedAtMs) / Math.max(1, event.cursor.pageSize);
      state.ewmaTauMs = 0.7 * state.ewmaTauMs + 0.3 * dwell;
      if (event.cursor.step > 3) {
        const tau = state.ewmaTauMs;
        increments.velocity =
          tau >= 200 ? tables.velocity.human : tau >= 80 ? tables.velocity.v80_200 : tau >= 30 ? tables.velocity.v30_80 : tables.velocity.v_lt_30;
      }
    }

    /* Refresh cohort membership after possible merges. */
    cohort = cohortOf(identity);
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
          increments.tiling =
            z < 0.3
              ? tables.tiling.z_lt_0_3
              : z < 0.5
                ? tables.tiling.z_0_3_0_5
                : z < 0.65
                  ? tables.tiling.z_0_5_0_65
                  : z < 0.78
                    ? tables.tiling.z_0_65_0_78
                    : tables.tiling.z_ge_0_78;
        }
      }
    }

    /* --- Accumulate (one-sided, zero floor) --- */
    const total = increments.adjacency + increments.tiling + increments.cold + increments.velocity;
    let crossed = false;
    let action: CusumDecision["action"] = "none";
    let clampedReason: string | undefined;

    if (inCohort && cohort) {
      if (cohort.flagged && ts - cohort.flaggedAtMs > epochMs) {
        cohort.flagged = false;
        cohort.ceilingActive = false;
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
        if (options.onCampaignFlag) options.onCampaignFlag(snapshotOf(cohort, ts));
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
      // Protection (protected-cohorts.ts): for an INFERRED cohort, a
      // host-declared protected subject keeps the evidence but never
      // the consequence - the decision collapses to telemetry for
      // this subject, while unprotected members are unaffected.
      const protectedHere =
        cohortOrigin(cohort) === "inferred" && options.isProtected?.(identity) === true;
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
        crossed,
        flagged: cohort.flagged,
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
      crossed: false,
      flagged: false,
      action: "none",
      consequenceEligible: false,
      protectedSubject: false,
      ...(clampedReason ? { clampedReason } : {}),
    };
  }

  async function checkServe(identity: string, requested: number) {
    const ts = now();
    const cohort = cohortOf(identity);
    if (!cohort || !cohort.flagged || mode === "observe") return { allowed: requested };
    // A protected subject in an inferred cohort is never paced or
    // ceilinged by that cohort's inferred evidence.
    if (cohortOrigin(cohort) === "inferred" && options.isProtected?.(identity) === true) {
      return { allowed: requested };
    }
    // A below-floor flag is telemetry only: no pacing, no ceiling.
    if (unionRecords(cohort) < minConsequenceUnion) return { allowed: requested };
    if (cohort.ceilingActive && unionRecords(cohort) >= ceilingLimit) {
      return { allowed: 0, cohortId: cohort.id, reason: "campaign_ceiling" };
    }
    refill(cohort, ts);
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
      for (const cohort of cohorts.values()) if (cohort.id === cohortId) return snapshotOf(cohort, now());
      return null;
    },
    async snapshotFor(identity) {
      const cohort = cohortOf(identity);
      return cohort && cohort.members.size >= 2 ? snapshotOf(cohort, now()) : null;
    },
    async clearCohort(cohortId) {
      for (const cohort of cohorts.values()) {
        if (cohort.id === cohortId) {
          cohort.flagged = false;
          cohort.ceilingActive = false;
          cohort.score = 0;
          cohort.contributions.clear();
        }
      }
    },
  };
}
