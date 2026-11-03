/**
 * Input-space coverage signal (HARVEST2 candidate C6, the first
 * candidate of the HARVEST2 queue to PASS its lab gate - see the
 * study lab's C6-DESIGN.md and C6-RESULTS.md under the antiRea
 * research tree).
 *
 * WHAT IT MEASURES. Every individual request to an enumerable
 * feature (a directory/contact lookup, a search over a sparse id
 * space - the CS1/Facebook contact-importer shape) can be perfectly
 * legitimate; the offence is the SHAPE of the accumulated coverage
 * of the input space: which part of the space gets covered, in what
 * order, and with what hit rate. Two statistic families, each scored
 * with the accumulated conformal frame that survived the whole
 * HARVEST2 queue (checkpoint vectors -> per-statistic TRAIN pools ->
 * two-sided ties-inclusive conformal p -> checkpoint score
 * S = sum(-ln p) -> stream evidence = max S -> flag iff evidence
 * exceeds the conformal threshold of TRAIN leave-one-stream-out
 * evidences at alpha):
 *
 * - Family F (declared enumerable feature; checkpoints at query
 *   counts 20, 36, 52, ...): hitRate (purposeful lookup hits the
 *   host's real records; enumeration of a sparse space hits at the
 *   space's density), distinctRate (scans never repeat; purposeful
 *   lookup revisits targets), fSeq (share of consecutive query
 *   pairs stepping exactly +1 - the sequential-sweep signature).
 * - Family R (resource space; checkpoints at event counts 64, 80,
 *   ...; statistics of the DISTINCT COVERED SET, never of its
 *   size - the count itself is the novel-CUSUM baseline's and is
 *   excluded by the lab's anti-overlap rule): tailShare (share of
 *   the covered set in the unpopular half of the site) and medRank
 *   (median popularity rank of the covered set). Legitimate
 *   coverage concentrates at the Zipf head; enumeration covers
 *   flat or deep.
 *
 * THIS IS A DETECTOR WITH A NOMINAL FALSE-POSITIVE RATE, NOT A
 * ZERO-FP FEATURE. Unlike the asset/referrer profile (C9), whose
 * separation gates carried a lab FP of exactly 0, C6 flags by
 * conformal design at about alpha per family: the lab measured a
 * pooled legitimate FP of 1.26% on VALID (bar: <= 2.0% for the two
 * families combined), 1.20% on sale-week traffic and 0.50% on
 * declared bulk cohorts calibrated against their own pool. A flag
 * is investigation telemetry at that base rate - never proof of
 * automation and never sufficient evidence on its own.
 *
 * WHAT THE LAB MEASURED (simulation, scripted populations - see
 * the honest limits below): enumeration through the declared
 * feature that both pre-existing coverage mechanisms are
 * structurally blind to was caught in full - sequential sweep 9/9
 * and systematic-random probing 9/9 at the FIRST checkpoint (20
 * queries) where the novel-CUSUM baseline caught 0/9; a dispersed
 * 24-identity feature herd was flagged member-wise 72/72 and as a
 * cohort 3/3 while the resource-union mechanism flagged 0/3.
 * Evasion is priced, not free: a slow sweep at a casual query
 * budget is still flagged at the first checkpoint (the statistics
 * do not read time, so slowing down buys nothing but time - about
 * 32 years to cover half the lab space at that budget), and a
 * subset rotator is flagged when its distinctRate falls BELOW the
 * legitimate floor (re-querying a closed set is itself anomalous);
 * the lab's diagnostic price curve puts the flag at roughly
 * 2.9x the rotator's subset size in queries.
 *
 * HARD CONDITIONS - these are in the code, not just the docs:
 *
 * 1. DECLARED SURFACE IS MANDATORY (lab kill-criterion 1). The
 *    host must declare its enumerable surface up front: the
 *    feature(s), their input-space sizes and how a query's hit is
 *    determined (a populated-id set, a predicate, or an explicit
 *    per-event hit), plus the resource space and its popularity
 *    ranking. With no declaration the module is DISABLED: it
 *    records nothing, fits nothing, and every call returns an
 *    explicit disabled status. Queries naming an undeclared
 *    feature are never scored.
 * 2. DECLARED COHORTS ARE CALIBRATED SEPARATELY, BY CONSTRUCTION
 *    (lab kill-criterion 2). Legitimate bulk lookup (contact sync,
 *    real imports) is flagged 100% against the casual pool in the
 *    lab - separate calibration is not decoration. Routing to that
 *    calibration is a PER-EVENT property of each query, not a
 *    property of the identity (audit C6-1 contract, resolved
 *    2026-11-03): a query whose event carries a host-declared
 *    cohort id is accumulated into the identity's declared-cohort
 *    lane and scored against the declared-cohort (bulk) pools
 *    fitted by `fitBulkCalibration`; a query carrying no cohort id
 *    - or a cohort id that is not host-declared - is accumulated
 *    into the casual lane and scored against the casual pools. All
 *    declared cohort ids share the one bulk calibration. The two
 *    lanes keep SEPARATE stream state per identity and feature
 *    (counters, distinct sets, sequence state, checkpoints), so a
 *    checkpoint closes on a lane's own item count. Routing never
 *    latches and is never retroactive: tagging one query does not
 *    move any earlier or later query between lanes, and emitted
 *    checkpoints are never re-scored. An identity that mixes tagged
 *    and untagged queries is therefore scored in BOTH lanes; the
 *    family signal carries the per-lane breakdown (`lanes`) and its
 *    top-level fields report one lane (a flagged lane first). Until
 *    the bulk calibration is fitted, the declared lane's status is
 *    "uncalibrated" and it never flags. A cohort id on a RESOURCE
 *    event registers cohort membership for `evaluateCohort` only;
 *    it does not route feature queries (family R has no bulk
 *    calibration and is always scored against the casual pools).
 *    Declared cohorts are also excluded from the cohort-max rule
 *    (`evaluateCohort` reports them as declared, per-member bulk
 *    scoring is their lane).
 * 3. ADVISORY ONLY. The module emits signal objects
 *    (`enforcement: "none"`, the policy-signals precedent). It has
 *    no blocking decision and attaches no consequence.
 * 4. OPT-IN. Nothing runs until the host constructs an instance
 *    and fits calibrations on its own legitimate traffic.
 *
 * HONEST LIMITS (also in docs/LIMITATIONS.md):
 * - The resource family is SLOW evidence on single-identity
 *   resource enumeration: the lab caught raw ID-walk and polite
 *   slicing 3/3 but at delays of 480-816 events against the
 *   novel-CUSUM baseline's 11-13 steps (~50x slower). Coverage
 *   shape needs a large covered set to declare itself; this module
 *   does not replace the baseline on that cell. Family R's value
 *   is identity-level tiling resolution (43.1% vs the baseline's
 *   23.6% in the lab) and orthogonality.
 * - Cohort false positives run HOT in the lab: legit 24-member
 *   cohorts flagged at 2.67% (max-F) and 4.0% (max-R) against a 1%
 *   nominal - a max over 24 members against thresholds fitted from
 *   only 200 TRAIN cohorts has real seed variance (max-F ran
 *   0/0/8% per seed). Hosts must calibrate the cohort scope more
 *   heavily than the lab did before attaching consequences.
 * - Negative space (requests outside the declared space, P13) and
 *   grammar violations have NO numbers at any level: the lab
 *   harness's legitimate population never emits out-of-space
 *   requests, so that component was design-only and is not
 *   implemented here. Do not claim it.
 * - A browser-shaped attacker whose covered set is Zipf-like is
 *   invisible to coverage statistics by construction (lab: 0/3 -
 *   the novel-CUSUM baseline caught it 3/3). An attacker who
 *   already holds the populated id list is likewise out of scope:
 *   this module taxes blind enumeration, not list replay.
 * - All lab numbers are simulation at one registered design point
 *   (2% space density, 45% bulk membership, 4% casual miss rate).
 *   A real host has different parameters and must recalibrate from
 *   its own traffic; the verdict does not transfer by default.
 *
 * Pure computation: no I/O, no runtime dependencies. State is
 * bounded in-memory maps (per-identity stream counters and capped
 * checkpoint-statistic lists, LRU-evicted).
 */

/** An input id in a declared feature's space (numeric ids are the lab's shape; strings are accepted, with fSeq defined only over numeric steps). */
export type CoverageInputId = number | string;

const F_STAT_NAMES = ["hitRate", "distinctRate", "fSeq"] as const;
type FStatName = (typeof F_STAT_NAMES)[number];
type FeatureStats = Record<FStatName, number>;

const R_STAT_NAMES = ["tailShare", "medRank"] as const;
type RStatName = (typeof R_STAT_NAMES)[number];
type ResourceStats = Record<RStatName, number>;

const DISABLED_REASON = "surface_not_declared";

/** Checkpoint-statistic lists retained per stream; beyond this, evidence reflects the retained prefix (documented bound). */
const MAX_CHECKPOINTS_PER_STREAM = 4096;

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): an input-space coverage shape match. " +
  "This detector flags by conformal design at a nominal ~1% per family on legitimate traffic; " +
  "a flag is investigation telemetry, never proof of automation, and must never be " +
  "the sole evidence for any consequence.";

/* ---------------- declaration ---------------- */

/** One declared enumerable feature. */
export interface InputSpaceFeatureDeclaration {
  /** The feature's name, matched against `featureId` on query events and samples. */
  featureId: string;
  /** Size of the feature's input space (the lab's directory: 100,000 ids at 2% density). */
  spaceSize: number;
  /**
   * The populated (real-record) ids of the space, when the host can
   * enumerate them. Used to resolve a query's hit when the event
   * does not carry one. Mutually exclusive with `isPopulated`.
   */
  populatedIds?: Iterable<CoverageInputId>;
  /**
   * Predicate resolving whether an input id is populated, when the
   * host cannot or will not enumerate the set. Mutually exclusive
   * with `populatedIds`.
   */
  isPopulated?: (inputId: CoverageInputId) => boolean;
}

/** The host's declared resource space (family R). */
export interface InputSpaceResourceDeclaration {
  /** Number of resources in the space (the lab's site: 2,000). */
  spaceSize: number;
  /**
   * Popularity-rank cutoff separating the head from the tail: a
   * covered resource with rank >= tailRank counts as tail.
   * Defaults to min(1000, spaceSize) (the lab's registered 1000 on
   * a 2,000-resource site).
   */
  tailRank?: number;
  /**
   * Maps a resource id to its popularity rank (0 = most popular).
   * When omitted, a resource event's own `rank` is used, falling
   * back to the numeric value of a numeric (or numeric-string)
   * resource id. Events whose rank cannot be resolved are counted
   * in the snapshot's `rankUnknown` counter and excluded from
   * family R - never silently treated as rank 0.
   */
  rankOf?: (resourceId: string | number) => number | null | undefined;
}

/** The host's surface declaration. Required for the module to be enabled at all. */
export interface InputSpaceSurfaceDeclaration {
  /** Declared enumerable features. At least one is required. */
  features: InputSpaceFeatureDeclaration[];
  /** Declared resource space for family R. When omitted, family R is not configured and resource events are refused with a named status. */
  resources?: InputSpaceResourceDeclaration;
  /**
   * Host-declared cohort ids whose members perform legitimate bulk
   * lookup (contact sync, imports, declared integrations). Members
   * are routed to the declared-cohort (bulk) calibration for
   * family F - see hard condition 2 in the module header.
   */
  declaredCohorts?: string[];
}

export interface CreateInputSpaceCoverageOptions {
  /**
   * The host's surface declaration. When omitted, the instance is
   * created DISABLED (it records nothing and every call reports
   * the disabled status) - see the module header, hard condition
   * 1. When present but malformed, construction throws.
   */
  surface?: InputSpaceSurfaceDeclaration;
  /** Conformal level for every fitted threshold. Defaults to 0.01 (the lab's alpha). */
  alpha?: number;
  /** Family F: query count of the first checkpoint. Defaults to 20 (the lab's F_START). */
  featureCheckpointStart?: number;
  /** Family F: queries between checkpoints. Defaults to 16 (the lab's F_STRIDE). */
  featureCheckpointStride?: number;
  /** Family R: event count of the first checkpoint. Defaults to 64 (the lab's R_START). */
  resourceCheckpointStart?: number;
  /** Family R: events between checkpoints. Defaults to 16 (the lab's R_STRIDE). */
  resourceCheckpointStride?: number;
  /** Minimum scorable legitimate streams a family fit must yield. Defaults to 50. */
  minTrainStreams?: number;
  /** Minimum scorable legitimate cohorts `fitCohortCalibration` must yield per family. Defaults to 30. */
  minTrainCohorts?: number;
  /** Maximum identities tracked at once (least-recently-seen evicted). Defaults to 10,000. */
  maxIdentities?: number;
  /** Maximum cohorts tracked at once (least-recently-seen evicted). Defaults to 2,000. */
  maxCohorts?: number;
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/* ---------------- events and samples ---------------- */

/** One query against a declared enumerable feature, on the host's serving path. */
export interface CoverageQueryEvent {
  /** The authenticated identity issuing the query. */
  identity: string;
  /** The declared feature being queried. Undeclared features are never scored. */
  featureId: string;
  /** The input id queried. */
  inputId: CoverageInputId;
  /**
   * Whether the query hit a populated record. When omitted, the
   * hit is resolved from the feature declaration (`populatedIds` /
   * `isPopulated`); a feature declared with neither REQUIRES every
   * event to carry `hit` - an unresolvable hit throws, because
   * silently guessing it would corrupt the family's load-bearing
   * statistic.
   */
  hit?: boolean;
  /**
   * Optional cohort id FOR THIS QUERY ONLY (hard condition 2): if
   * it names a host-declared cohort, this query - and only this
   * query - is accumulated into the identity's declared-cohort
   * (bulk) lane; any other value, or none, puts this query in the
   * casual lane. It never re-routes past or future queries.
   */
  cohortId?: string;
  /** Millisecond timestamp (accepted for forward compatibility; the statistics do not read time). */
  ts?: number;
}

/** One resource-serving event (a page/detail view), on the host's serving path. */
export interface CoverageResourceEvent {
  /** The authenticated identity being served. */
  identity: string;
  /** The resource served. */
  resourceId: string | number;
  /** The resource's popularity rank (0 = most popular), when the host carries it per event. See `rankOf` for the resolution order. */
  rank?: number;
  /**
   * Optional cohort id for this event. On a resource event this
   * registers the identity's membership of the cohort for
   * `evaluateCohort` ONLY: family R has no declared-cohort
   * calibration, and the tag never routes the identity's feature
   * queries (their lane is decided by each query's own cohortId).
   */
  cohortId?: string;
  /** Millisecond timestamp (accepted for forward compatibility; the statistics do not read time). */
  ts?: number;
}

/** One feature query as fed to calibration fitting. Mirrors {@link CoverageQueryEvent} minus identity/cohort. */
export interface CoverageQuerySample {
  featureId: string;
  inputId: CoverageInputId;
  hit?: boolean;
}

/** One resource event as fed to calibration fitting. Mirrors {@link CoverageResourceEvent} minus identity/cohort. */
export interface CoverageResourceSample {
  resourceId: string | number;
  rank?: number;
}

/** One legitimate stream (one identity) as fed to calibration fitting. */
export interface CoverageStreamSample {
  /** The stream's feature queries, in issue order. */
  queries?: CoverageQuerySample[];
  /** The stream's resource events, in serve order. */
  events?: CoverageResourceSample[];
}

/* ---------------- results ---------------- */

export interface CoverageObservation {
  /**
   * `"recorded"` - accepted into the stream; `"undeclared_feature"` -
   * the query names a feature the host never declared (never
   * scored); `"space_not_declared"` - a resource event arrived but
   * no resource space was declared (never scored); `"rank_unknown"` -
   * the event's rank could not be resolved, so it was not
   * accumulated; `"disabled"` - the module is disabled (no surface
   * declared).
   */
  status: "recorded" | "undeclared_feature" | "space_not_declared" | "rank_unknown" | "disabled";
  /** Present when `status` is `"disabled"`: the named reason the module is off. */
  reason?: string;
  /** Which family this observation belongs to. */
  family: "feature" | "resource";
  /** Whether the item was accumulated into the identity's stream. */
  scored: boolean;
  /** Stream length after this item: for a feature query, the length of the LANE stream this query was routed to (per-event routing, hard condition 2); for a resource event, the resource stream length. */
  items: number;
  /** Whether this item closed a checkpoint in its family. */
  checkpoint: boolean;
  /**
   * The identity signal, present exactly when this item closed a
   * checkpoint on an enabled instance.
   */
  signal?: InputSpaceCoverageSignal;
}

export interface CoverageFamilySignal {
  /**
   * `"scored"` - at least one checkpoint exists and the applicable
   * calibration is fitted; `"insufficient_data"` - no checkpoint
   * yet; `"uncalibrated"` - checkpoints exist but the applicable
   * calibration (casual, or declared-cohort for declared members)
   * has not been fitted. `flagged` is false unless `"scored"`.
   */
  status: "scored" | "insufficient_data" | "uncalibrated";
  /** Which calibration scored (or would score) this family. For family F this is the calibration of the lane this signal describes (see `lanes` for the per-lane breakdown of a mixed identity). */
  calibration: "casual" | "declared_cohort";
  /** Stream evidence (max checkpoint score), or null when not scored. */
  evidence: number | null;
  /** The fitted conformal threshold, or null when not scored. */
  threshold: number | null;
  /** Whether the evidence exceeds the threshold. */
  flagged: boolean;
  /** Checkpoints scored. */
  checkpoints: number;
  /** Items consumed at the first checkpoint whose score crossed the threshold (the detection delay), or null. */
  firstFlagAt: number | null;
  /** Statistics of the most recent checkpoint, or null when no checkpoint exists. */
  lastStats: Record<string, number> | null;
  /**
   * Family F, identity scope only: the per-lane breakdown behind
   * this summary, keyed by lane, present for every lane in which
   * the identity has at least one query on any feature. The
   * top-level fields report ONE lane - a flagged lane if any lane
   * flags, otherwise the scored lane with the highest evidence,
   * otherwise an uncalibrated lane, otherwise the insufficient-data
   * lane - so a mixed identity's other lane is never hidden: read
   * `lanes` when the identity both tags and does not tag. Per-lane
   * entries do not themselves carry `lanes`. Absent for family R
   * (single casual lane) and for cohort scope.
   */
  lanes?: Partial<Record<"casual" | "declared_cohort", CoverageFamilySignal>>;
}

export interface InputSpaceCoverageSignal {
  kind: "input_space_coverage";
  scope: "identity" | "cohort";
  identity?: string;
  cohortId?: string;
  /**
   * `"scored"` - at least one family is scored; `"insufficient_data"` -
   * no family has a checkpoint; `"uncalibrated"` - families have
   * checkpoints but no applicable calibration is fitted;
   * `"declared_cohort"` - cohort scope only: the cohort is
   * host-declared, so the cohort-max rule does not apply to it (its
   * members are scored individually against the declared-cohort
   * calibration); `"disabled"` - the module is off. `flagged` is
   * false in every non-`"scored"` status.
   */
  status: "scored" | "insufficient_data" | "uncalibrated" | "declared_cohort" | "disabled";
  /** True when any scored family (identity scope) or the cohort-max rule (cohort scope) flags. */
  flagged: boolean;
  /** Family F result, or null when the identity/cohort has no feature data at all. For cohort scope: max member evidence against the cohort threshold. */
  feature: CoverageFamilySignal | null;
  /** Family R result, or null when there is no resource data at all. For cohort scope: max member evidence against the cohort threshold. */
  resource: CoverageFamilySignal | null;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface CoverageFamilyFit {
  /** Legitimate streams (or cohorts, for the cohort scope) that entered the fit. */
  streams: number;
  /** The fitted conformal threshold. */
  threshold: number;
  /** Total checkpoints in the fitted pool (identity/declared-cohort scopes). */
  poolCheckpoints: number;
}

export interface InputSpaceCoverageFitResult {
  fitted: boolean;
  status: "fitted" | "disabled";
  scope: "identity" | "declared_cohort" | "cohort";
  /** Family F fit (per feature when several are declared, the aggregate over features is reported per feature in `features`). */
  feature: CoverageFamilyFit | null;
  /** Per-feature family F fits, keyed by featureId (identity and declared-cohort scopes). */
  features: Record<string, CoverageFamilyFit>;
  /** Family R fit (identity scope) or family R cohort fit (cohort scope). */
  resource: CoverageFamilyFit | null;
  /** Streams/cohorts skipped for reaching no checkpoint in the fitted families. */
  skipped: number;
}

export interface InputSpaceCoverageSnapshot {
  enabled: boolean;
  /** `"surface_not_declared"` when disabled, otherwise null. */
  disabledReason: string | null;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  /** Whether the casual identity calibration (at least one family) is fitted. */
  calibrated: boolean;
  /** Whether the declared-cohort (bulk) calibration is fitted. */
  bulkCalibrated: boolean;
  /** Whether the cohort thresholds are fitted. */
  cohortCalibrated: boolean;
  alpha: number;
  /** Declared features with their space sizes. */
  features: Array<{ featureId: string; spaceSize: number }>;
  /** Declared resource space size, or null when not declared. */
  resourceSpaceSize: number | null;
  /** Cohort ids the host declared as bulk cohorts. */
  declaredCohorts: string[];
  identitiesTracked: number;
  cohortsTracked: number;
  counters: {
    /** Feature queries accepted for accumulation. */
    queriesRecorded: number;
    /** Resource events accepted for accumulation. */
    resourceEventsRecorded: number;
    /** Queries naming an undeclared feature (never scored). */
    undeclaredFeature: number;
    /** Resource events refused because no resource space was declared. */
    resourceSpaceNotDeclared: number;
    /** Resource events whose popularity rank could not be resolved (excluded from family R). */
    rankUnknown: number;
  };
  identityCalibration: { features: Record<string, CoverageFamilyFit>; resource: CoverageFamilyFit | null } | null;
  bulkCalibration: { features: Record<string, CoverageFamilyFit> } | null;
  cohortCalibration: { feature: CoverageFamilyFit | null; resource: CoverageFamilyFit | null } | null;
  notice: string;
}

export interface InputSpaceCoverage {
  /** Whether the module is on (a valid surface was declared at construction). */
  readonly enabled: boolean;
  /** Feed one feature query. See {@link CoverageObservation} for the outcome vocabulary. */
  observeQuery(event: CoverageQueryEvent): CoverageObservation;
  /** Feed one resource-serving event. See {@link CoverageObservation} for the outcome vocabulary. */
  observeResource(event: CoverageResourceEvent): CoverageObservation;
  /**
   * Fit the casual identity calibration from the host's own
   * legitimate streams (one entry per identity). Family F pools are
   * built per declared feature; family R from the streams' resource
   * events. A family whose scorable streams fall below
   * `minTrainStreams` throws; a family with no samples at all is
   * left unfitted.
   */
  fitCalibration(samples: CoverageStreamSample[]): InputSpaceCoverageFitResult;
  /**
   * Fit the declared-cohort (bulk) family F calibration from
   * legitimate bulk query streams (contact sync / import shape).
   * Requires at least one declared cohort in the surface
   * declaration; bulk streams MUST be calibrated separately -
   * against the casual pools the lab measured them flagged 100%.
   */
  fitBulkCalibration(streams: CoverageQuerySample[][]): InputSpaceCoverageFitResult;
  /**
   * Fit the cohort thresholds (max member evidence per family,
   * conformal at alpha) from legitimate cohorts of streams.
   * Requires `fitCalibration` first (member evidences are computed
   * against the casual pools).
   */
  fitCohortCalibration(cohorts: CoverageStreamSample[][]): InputSpaceCoverageFitResult;
  /** Evaluate one tracked identity against the fitted calibrations. */
  evaluateIdentity(identity: string): InputSpaceCoverageSignal;
  /** Evaluate one tracked cohort against the fitted cohort thresholds. */
  evaluateCohort(cohortId: string): InputSpaceCoverageSignal;
  /** State and calibration summary. */
  snapshot(): InputSpaceCoverageSnapshot;
}

/** Named error thrown for every invalid input-space-coverage input. */
export class InputSpaceCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputSpaceCoverageError";
  }
}

const fail = (message: string): never => {
  throw new InputSpaceCoverageError(`createInputSpaceCoverage: ${message}`);
};

const hasControlOrNewline = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value);

function requireName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  if (hasControlOrNewline(value as string)) {
    fail(`${field} must be a single line (no control characters or newlines)`);
  }
  return value as string;
}

function requireIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requireFiniteAtLeast(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    fail(`${field} must be a finite number >= ${min}`);
  }
  return value as number;
}

/* ---------------- conformal machinery (the lab's, verbatim in form) ---------------- */

function countLess(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function countLessEq(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function countGreaterEq(sorted: number[], x: number): number {
  return sorted.length - countLess(sorted, x);
}

/**
 * Two-sided conformal p, INCLUSIVE of ties (the C5-corrected house
 * form): p = min(1, 2 * min(1 + #{v <= x}, 1 + #{v >= x}) / (n + 1)).
 * `ownSorted` is the scored stream's own sorted values for this
 * statistic when it is a member of the pool (leave-one-stream-out);
 * pass null for streams outside the pool.
 */
function twoSidedP(sortedAll: number[], ownSorted: number[] | null, x: number): number {
  let cl = countLessEq(sortedAll, x);
  let cg = countGreaterEq(sortedAll, x);
  let n = sortedAll.length;
  if (ownSorted) {
    cl -= countLessEq(ownSorted, x);
    cg -= countGreaterEq(ownSorted, x);
    n -= ownSorted.length;
  }
  const p = (2 * Math.min(1 + cl, 1 + cg)) / (n + 1);
  return Math.min(1, p);
}

interface StatPools<K extends string> {
  sorted: Record<K, number[]>;
  perStream: Record<K, number[]>[];
}

function buildPools<K extends string>(
  perStreamCkpts: Array<Array<Record<K, number>>>,
  keys: readonly K[],
): StatPools<K> {
  const sorted = {} as Record<K, number[]>;
  for (const j of keys) sorted[j] = [];
  const perStream = perStreamCkpts.map((ck) => {
    const o = {} as Record<K, number[]>;
    for (const j of keys) {
      o[j] = ck.map((c) => c[j]).sort((a, b) => a - b);
      for (const v of o[j]) sorted[j].push(v);
    }
    return o;
  });
  for (const j of keys) sorted[j].sort((a, b) => a - b);
  return { sorted, perStream };
}

function checkpointScore<K extends string>(
  stats: Record<K, number>,
  pools: StatPools<K>,
  keys: readonly K[],
  excludeIdx: number | null,
): number {
  let s = 0;
  for (const j of keys) {
    const own = excludeIdx == null ? null : (pools.perStream[excludeIdx]![j] ?? null);
    s += -Math.log(twoSidedP(pools.sorted[j]!, own, stats[j]));
  }
  return s;
}

/** Conformal order statistic of a score list at `level` (the lab's threshold form). */
function conformalThreshold(scores: number[], level: number): number {
  const sorted = [...scores].sort((a, b) => a - b);
  const n = sorted.length;
  let rank = Math.ceil((n + 1) * (1 - level));
  if (rank < 1) rank = 1;
  if (rank > n) rank = n;
  return sorted[rank - 1]!;
}

interface FamilyCalibration<K extends string> {
  pools: StatPools<K>;
  threshold: number;
  streams: number;
  poolCheckpoints: number;
}

/**
 * Fit one family's pools + threshold: pools from every scorable
 * stream's checkpoints; threshold = conformal order statistic of
 * the streams' leave-one-stream-out evidences (max checkpoint
 * score) at alpha. Callers guarantee at least one scorable stream.
 */
function fitFamily<K extends string>(
  perStreamCkpts: Array<Array<Record<K, number>>>,
  keys: readonly K[],
  alpha: number,
): FamilyCalibration<K> {
  const scorable = perStreamCkpts.filter((ck) => ck.length > 0);
  const pools = buildPools(scorable, keys);
  const evidences: number[] = [];
  let poolCheckpoints = 0;
  for (let s = 0; s < scorable.length; s++) {
    poolCheckpoints += scorable[s]!.length;
    let ev = 0;
    for (const ck of scorable[s]!) {
      const sc = checkpointScore(ck, pools, keys, s);
      if (sc > ev) ev = sc;
    }
    evidences.push(ev);
  }
  return {
    pools,
    threshold: conformalThreshold(evidences, alpha),
    streams: scorable.length,
    poolCheckpoints,
  };
}

/** Score a checkpoint-statistic list against fitted pools (stream outside the pool). */
function scoreRun<K extends string>(
  ckStats: Array<Record<K, number>>,
  ckEnds: number[],
  cal: FamilyCalibration<K>,
  keys: readonly K[],
): { evidence: number; firstFlagAt: number | null; lastStats: Record<K, number> } {
  let evidence = 0;
  let firstFlagAt: number | null = null;
  for (let i = 0; i < ckStats.length; i++) {
    const sc = checkpointScore(ckStats[i]!, cal.pools, keys, null);
    if (sc > evidence) evidence = sc;
    if (firstFlagAt === null && sc > cal.threshold) firstFlagAt = ckEnds[i]!;
  }
  return { evidence, firstFlagAt, lastStats: ckStats[ckStats.length - 1]! };
}

/* ---------------- resolved stream items ---------------- */

interface ResolvedQuery {
  inputId: CoverageInputId;
  hit: boolean;
}

interface ResolvedResource {
  resourceId: string | number;
  rank: number;
}

/* ---------------- runtime state ---------------- */

interface FeatureStreamState {
  n: number;
  hits: number;
  seqPairs: number;
  lastNumeric: number | null;
  distinct: Set<CoverageInputId>;
  nextAt: number;
  ckStats: FeatureStats[];
  ckEnds: number[];
}

interface ResourceStreamState {
  n: number;
  distinct: Map<string | number, number>;
  nextAt: number;
  ckStats: ResourceStats[];
  ckEnds: number[];
}

/** The calibration lane one event is routed to (hard condition 2: decided per event, never latched). */
type CoverageLane = "casual" | "declared_cohort";

interface IdentityState {
  /** Feature streams, split by lane: features -> lane -> that lane's own stream state. */
  features: Map<string, Map<CoverageLane, FeatureStreamState>>;
  resources: ResourceStreamState | null;
  lastSeen: number;
}

interface CohortState {
  members: Set<string>;
  lastSeen: number;
}

interface FeatureDecl {
  featureId: string;
  spaceSize: number;
  populatedSet: Set<CoverageInputId> | null;
  isPopulated: ((inputId: CoverageInputId) => boolean) | null;
}

interface ResourceDecl {
  spaceSize: number;
  tailRank: number;
  rankOf: ((resourceId: string | number) => number | null | undefined) | null;
}

export function createInputSpaceCoverage(
  options: CreateInputSpaceCoverageOptions = {},
): InputSpaceCoverage {
  if (typeof options !== "object" || options === null) fail("options must be an object");

  const alpha = options.alpha ?? 0.01;
  if (typeof alpha !== "number" || !Number.isFinite(alpha) || alpha <= 0 || alpha > 0.5) {
    fail("alpha must be a finite number in (0, 0.5]");
  }
  const fStart = requireIntInRange(options.featureCheckpointStart ?? 20, "featureCheckpointStart", 2, 1_000_000);
  const fStride = requireIntInRange(options.featureCheckpointStride ?? 16, "featureCheckpointStride", 1, 1_000_000);
  const rStart = requireIntInRange(options.resourceCheckpointStart ?? 64, "resourceCheckpointStart", 2, 1_000_000);
  const rStride = requireIntInRange(options.resourceCheckpointStride ?? 16, "resourceCheckpointStride", 1, 1_000_000);
  const minTrainStreams = requireIntInRange(options.minTrainStreams ?? 50, "minTrainStreams", 1, 1_000_000);
  const minTrainCohorts = requireIntInRange(options.minTrainCohorts ?? 30, "minTrainCohorts", 1, 1_000_000);
  const maxIdentities = requireIntInRange(options.maxIdentities ?? 10_000, "maxIdentities", 1, 10_000_000);
  const maxCohorts = requireIntInRange(options.maxCohorts ?? 2_000, "maxCohorts", 1, 10_000_000);
  const clock = options.now ?? (() => Date.now());

  /* Surface declaration: absence disables (never throws); a present
   * but malformed declaration is a programming error and throws. */
  const features = new Map<string, FeatureDecl>();
  let resourceDecl: ResourceDecl | null = null;
  const declaredCohorts = new Set<string>();
  let enabled = false;
  if (options.surface !== undefined) {
    const surf = options.surface;
    if (typeof surf !== "object" || surf === null) fail("surface must be an object");
    if (!Array.isArray(surf.features) || surf.features.length < 1) {
      fail("surface.features must declare at least one enumerable feature (no declared feature, no enumerable surface to score)");
    }
    for (const f of surf.features) {
      if (typeof f !== "object" || f === null) fail("surface.features entries must be objects");
      const featureId = requireName(f.featureId, "surface.features[].featureId");
      if (features.has(featureId)) fail(`surface.features contains a duplicate featureId: ${JSON.stringify(featureId)}`);
      const spaceSize = requireIntInRange(f.spaceSize, `surface.features[${JSON.stringify(featureId)}].spaceSize`, 2, Number.MAX_SAFE_INTEGER);
      if (f.populatedIds !== undefined && f.isPopulated !== undefined) {
        fail(`surface.features[${JSON.stringify(featureId)}] must declare populatedIds or isPopulated, not both`);
      }
      let populatedSet: Set<CoverageInputId> | null = null;
      if (f.populatedIds !== undefined) {
        populatedSet = new Set<CoverageInputId>();
        for (const id of f.populatedIds) {
          if ((typeof id !== "number" || !Number.isFinite(id)) && typeof id !== "string") {
            fail(`surface.features[${JSON.stringify(featureId)}].populatedIds entries must be finite numbers or strings`);
          }
          populatedSet.add(id);
        }
        if (populatedSet.size >= spaceSize) {
          fail(`surface.features[${JSON.stringify(featureId)}].populatedIds must be a proper subset of the declared space`);
        }
      }
      if (f.isPopulated !== undefined && typeof f.isPopulated !== "function") {
        fail(`surface.features[${JSON.stringify(featureId)}].isPopulated must be a function`);
      }
      features.set(featureId, { featureId, spaceSize, populatedSet, isPopulated: f.isPopulated ?? null });
    }
    if (surf.resources !== undefined) {
      const r = surf.resources;
      if (typeof r !== "object" || r === null) fail("surface.resources must be an object");
      const spaceSize = requireIntInRange(r.spaceSize, "surface.resources.spaceSize", 2, Number.MAX_SAFE_INTEGER);
      const tailRank =
        r.tailRank === undefined
          ? Math.min(1000, spaceSize)
          : requireIntInRange(r.tailRank, "surface.resources.tailRank", 1, spaceSize);
      if (r.rankOf !== undefined && typeof r.rankOf !== "function") fail("surface.resources.rankOf must be a function");
      resourceDecl = { spaceSize, tailRank, rankOf: r.rankOf ?? null };
    }
    if (surf.declaredCohorts !== undefined) {
      if (!Array.isArray(surf.declaredCohorts)) fail("surface.declaredCohorts must be an array of cohort ids");
      for (const c of surf.declaredCohorts) {
        const name = requireName(c, "surface.declaredCohorts entry");
        if (declaredCohorts.has(name)) fail(`surface.declaredCohorts contains a duplicate: ${JSON.stringify(name)}`);
        declaredCohorts.add(name);
      }
    }
    enabled = true;
  }

  const identities = new Map<string, IdentityState>();
  const cohorts = new Map<string, CohortState>();
  const counters = { queriesRecorded: 0, resourceEventsRecorded: 0, undeclaredFeature: 0, resourceSpaceNotDeclared: 0, rankUnknown: 0 };
  let fCal = new Map<string, FamilyCalibration<FStatName>>();
  let bulkFCal = new Map<string, FamilyCalibration<FStatName>>();
  let rCal: FamilyCalibration<RStatName> | null = null;
  let cohortFCal: { threshold: number; cohorts: number; memberCheckpoints: number } | null = null;
  let cohortRCal: { threshold: number; cohorts: number; memberCheckpoints: number } | null = null;

  const disabledNotice = `Module disabled (${DISABLED_REASON}): no enumerable surface was declared, so nothing is scored.`;

  /* ---------------- resolution helpers ---------------- */

  function resolveHit(decl: FeatureDecl, inputId: CoverageInputId, hit: boolean | undefined, field: string): boolean {
    if (hit !== undefined) {
      if (typeof hit !== "boolean") fail(`${field}.hit must be a boolean when present`);
      return hit;
    }
    if (decl.isPopulated) return !!decl.isPopulated(inputId);
    if (decl.populatedSet) return decl.populatedSet.has(inputId);
    return fail(
      `${field}: feature ${JSON.stringify(decl.featureId)} declares neither populatedIds nor isPopulated, ` +
        `so every query must carry an explicit hit`,
    );
  }

  function resolveRank(resourceId: string | number, rank: number | undefined, field: string): number | null {
    if (rank !== undefined) {
      if (typeof rank !== "number" || !Number.isFinite(rank) || rank < 0) {
        fail(`${field}.rank must be a finite number >= 0 when present`);
      }
      return rank;
    }
    if (resourceDecl && resourceDecl.rankOf) {
      const v = resourceDecl.rankOf(resourceId);
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
    }
    if (typeof resourceId === "number" && Number.isInteger(resourceId) && resourceId >= 0) return resourceId;
    if (typeof resourceId === "string" && /^\d+$/.test(resourceId)) return parseInt(resourceId, 10);
    return null;
  }

  /* ---------------- checkpoint computation (fit-time arrays) ---------------- */

  function featureCheckpointsOf(queries: ResolvedQuery[]): Array<{ stats: FeatureStats; end: number }> {
    const out: Array<{ stats: FeatureStats; end: number }> = [];
    const seen = new Set<CoverageInputId>();
    let hits = 0;
    let seqPairs = 0;
    let n = 0;
    let nextAt = fStart;
    let lastNumeric: number | null = null;
    for (const q of queries) {
      n++;
      if (q.hit) hits++;
      seen.add(q.inputId);
      if (typeof q.inputId === "number" && lastNumeric !== null && q.inputId - lastNumeric === 1) seqPairs++;
      lastNumeric = typeof q.inputId === "number" ? q.inputId : null;
      if (n === nextAt) {
        out.push({ stats: { hitRate: hits / n, distinctRate: seen.size / n, fSeq: seqPairs / (n - 1) }, end: n });
        nextAt += fStride;
      }
    }
    return out;
  }

  function resourceStatsOf(distinct: Map<string | number, number>): ResourceStats {
    const ranks = [...distinct.values()].sort((a, b) => a - b);
    const d = ranks.length;
    const tailRank = resourceDecl ? resourceDecl.tailRank : 1000;
    let tail = 0;
    for (const r of ranks) if (r >= tailRank) tail++;
    return {
      tailShare: tail / d,
      medRank: d % 2 ? ranks[(d - 1) / 2]! : (ranks[d / 2 - 1]! + ranks[d / 2]!) / 2,
    };
  }

  function resourceCheckpointsOf(events: ResolvedResource[]): Array<{ stats: ResourceStats; end: number }> {
    const out: Array<{ stats: ResourceStats; end: number }> = [];
    const distinct = new Map<string | number, number>();
    let n = 0;
    let nextAt = rStart;
    for (const e of events) {
      n++;
      if (!distinct.has(e.resourceId)) distinct.set(e.resourceId, e.rank);
      if (n === nextAt) {
        out.push({ stats: resourceStatsOf(distinct), end: n });
        nextAt += rStride;
      }
    }
    return out;
  }

  /* ---------------- state management ---------------- */

  const touchIdentity = (identity: string, now: number): IdentityState => {
    const existing = identities.get(identity);
    if (existing) {
      existing.lastSeen = now;
      identities.delete(identity);
      identities.set(identity, existing);
      return existing;
    }
    if (identities.size >= maxIdentities) {
      const oldest = identities.keys().next().value as string | undefined;
      if (oldest !== undefined) identities.delete(oldest);
    }
    const fresh: IdentityState = { features: new Map(), resources: null, lastSeen: now };
    identities.set(identity, fresh);
    return fresh;
  };

  /**
   * The lane ONE event belongs to: the declared-cohort (bulk) lane
   * iff the event's own cohortId names a host-declared cohort. This
   * is evaluated fresh for every event - nothing about it is stored
   * on the identity, so it cannot latch (audit C6-1).
   */
  const laneOf = (cohortId: string | undefined): CoverageLane =>
    cohortId !== undefined && declaredCohorts.has(cohortId) ? "declared_cohort" : "casual";

  /**
   * Register cohort MEMBERSHIP (for `evaluateCohort`) only. This
   * deliberately does NOT touch family-F routing: membership of a
   * declared cohort is reported by `evaluateCohort` as
   * `"declared_cohort"`, while each query's lane is decided by
   * `laneOf` on that query alone.
   */
  const registerCohort = (cohortId: string, identity: string, now: number): void => {
    let entry = cohorts.get(cohortId);
    if (entry) {
      entry.lastSeen = now;
      cohorts.delete(cohortId);
      cohorts.set(cohortId, entry);
    } else {
      if (cohorts.size >= maxCohorts) {
        const oldest = cohorts.keys().next().value as string | undefined;
        if (oldest !== undefined) cohorts.delete(oldest);
      }
      entry = { members: new Set(), lastSeen: now };
      cohorts.set(cohortId, entry);
    }
    entry.members.add(identity);
  };

  /* ---------------- signal construction ---------------- */

  const baseSignal = (
    scope: "identity" | "cohort",
    ids: { identity?: string; cohortId?: string },
    status: InputSpaceCoverageSignal["status"],
    notice: string,
  ): InputSpaceCoverageSignal => ({
    kind: "input_space_coverage",
    scope,
    ...ids,
    status,
    flagged: false,
    feature: null,
    resource: null,
    enforcement: "none",
    notice,
  });

  interface FamilyAgg {
    evidence: number;
    threshold: number;
    firstFlagAt: number | null;
    flagged: boolean;
    checkpoints: number;
    lastStats: Record<string, number>;
  }

  /** Aggregate one identity's family F over its features IN ONE LANE against that lane's calibration map. Null when nothing is scored. */
  function aggregateF(
    state: IdentityState,
    calMap: Map<string, FamilyCalibration<FStatName>>,
    lane: CoverageLane,
  ): { agg: FamilyAgg | null; anyCkpt: boolean; ckptTotal: number; lastStats: FeatureStats | null } {
    let anyCkpt = false;
    let ckptTotal = 0;
    let lastStats: FeatureStats | null = null;
    let bestEv: FamilyAgg | null = null;
    let bestFlag: FamilyAgg | null = null;
    for (const [fid, laneMap] of state.features) {
      const fs = laneMap.get(lane);
      if (!fs) continue;
      ckptTotal += fs.ckStats.length;
      if (fs.ckStats.length) {
        anyCkpt = true;
        lastStats = fs.ckStats[fs.ckStats.length - 1]!;
      }
      const cal = calMap.get(fid);
      if (!cal || fs.ckStats.length === 0) continue;
      const run = scoreRun(fs.ckStats, fs.ckEnds, cal, F_STAT_NAMES);
      const entry: FamilyAgg = {
        evidence: run.evidence,
        threshold: cal.threshold,
        firstFlagAt: run.firstFlagAt,
        flagged: run.evidence > cal.threshold,
        checkpoints: fs.ckStats.length,
        lastStats: run.lastStats,
      };
      if (!bestEv || entry.evidence > bestEv.evidence) bestEv = entry;
      if (entry.flagged && (!bestFlag || entry.evidence > bestFlag.evidence)) bestFlag = entry;
    }
    const chosen = bestFlag ?? bestEv;
    if (!chosen) return { agg: null, anyCkpt, ckptTotal, lastStats };
    return {
      agg: { ...chosen, checkpoints: ckptTotal, flagged: bestFlag !== null, firstFlagAt: bestFlag ? bestFlag.firstFlagAt : null },
      anyCkpt,
      ckptTotal,
      lastStats,
    };
  }

  /** Family F signal for ONE lane of one identity. Null when the identity has no query in that lane. */
  function featureLaneSignal(state: IdentityState, lane: CoverageLane): CoverageFamilySignal | null {
    let hasStream = false;
    for (const laneMap of state.features.values()) {
      const fs = laneMap.get(lane);
      if (fs && fs.n > 0) hasStream = true;
    }
    if (!hasStream) return null;
    const { agg, anyCkpt, ckptTotal, lastStats } = aggregateF(state, lane === "declared_cohort" ? bulkFCal : fCal, lane);
    if (agg) {
      return {
        status: "scored",
        calibration: lane,
        evidence: agg.evidence,
        threshold: agg.threshold,
        flagged: agg.flagged,
        checkpoints: ckptTotal,
        firstFlagAt: agg.firstFlagAt,
        lastStats: agg.lastStats,
      };
    }
    if (anyCkpt) {
      return {
        status: "uncalibrated",
        calibration: lane,
        evidence: null,
        threshold: null,
        flagged: false,
        checkpoints: ckptTotal,
        firstFlagAt: null,
        lastStats,
      };
    }
    return {
      status: "insufficient_data",
      calibration: lane,
      evidence: null,
      threshold: null,
      flagged: false,
      checkpoints: 0,
      firstFlagAt: null,
      lastStats: null,
    };
  }

  /**
   * Family F signal for an identity: the per-lane signals plus a
   * top-level reporting lane. Reporting-lane precedence: a flagged
   * lane first (the highest-evidence one if both flag), then the
   * scored lane with the highest evidence, then an uncalibrated
   * lane, then the insufficient-data lane. The full breakdown is
   * always attached as `lanes`, so the non-reporting lane of a
   * mixed identity is visible, never silently merged.
   */
  function featureFamilySignal(state: IdentityState): CoverageFamilySignal | null {
    const lanes: Partial<Record<CoverageLane, CoverageFamilySignal>> = {};
    for (const lane of ["casual", "declared_cohort"] as const) {
      const sig = featureLaneSignal(state, lane);
      if (sig) lanes[lane] = sig;
    }
    const present = Object.values(lanes) as CoverageFamilySignal[];
    if (present.length === 0) return null;
    const flagged = present.filter((s) => s.flagged);
    const scored = present.filter((s) => s.status === "scored");
    const uncalibrated = present.filter((s) => s.status === "uncalibrated");
    const byEvidenceDesc = (a: CoverageFamilySignal, b: CoverageFamilySignal) => (b.evidence ?? 0) - (a.evidence ?? 0);
    const reporting =
      flagged.length > 0
        ? [...flagged].sort(byEvidenceDesc)[0]!
        : scored.length > 0
          ? [...scored].sort(byEvidenceDesc)[0]!
          : uncalibrated.length > 0
            ? uncalibrated[0]!
            : present[0]!;
    return { ...reporting, lanes };
  }

  function resourceFamilySignal(state: IdentityState): CoverageFamilySignal | null {
    const rs = state.resources;
    if (!rs || rs.n === 0) return null;
    if (rs.ckStats.length === 0) {
      return {
        status: "insufficient_data",
        calibration: "casual",
        evidence: null,
        threshold: null,
        flagged: false,
        checkpoints: 0,
        firstFlagAt: null,
        lastStats: null,
      };
    }
    if (!rCal) {
      return {
        status: "uncalibrated",
        calibration: "casual",
        evidence: null,
        threshold: null,
        flagged: false,
        checkpoints: rs.ckStats.length,
        firstFlagAt: null,
        lastStats: rs.ckStats[rs.ckStats.length - 1]!,
      };
    }
    const run = scoreRun(rs.ckStats, rs.ckEnds, rCal, R_STAT_NAMES);
    return {
      status: "scored",
      calibration: "casual",
      evidence: run.evidence,
      threshold: rCal.threshold,
      flagged: run.evidence > rCal.threshold,
      checkpoints: rs.ckStats.length,
      firstFlagAt: run.evidence > rCal.threshold ? run.firstFlagAt : null,
      lastStats: run.lastStats,
    };
  }

  function evaluateIdentity(identity: string): InputSpaceCoverageSignal {
    if (!enabled) return baseSignal("identity", { identity }, "disabled", disabledNotice);
    const state = identities.get(identity);
    if (!state) {
      return baseSignal("identity", { identity }, "insufficient_data", "No stream has been observed for this identity.");
    }
    const feature = featureFamilySignal(state);
    const resource = resourceFamilySignal(state);
    const status: InputSpaceCoverageSignal["status"] =
      feature?.status === "scored" || resource?.status === "scored"
        ? "scored"
        : feature?.status === "uncalibrated" || resource?.status === "uncalibrated"
          ? "uncalibrated"
          : "insufficient_data";
    return {
      kind: "input_space_coverage",
      scope: "identity",
      identity,
      status,
      flagged: status === "scored" && !!((feature && feature.flagged) || (resource && resource.flagged)),
      feature,
      resource,
      enforcement: "none",
      notice: ADVISORY_NOTICE,
    };
  }

  function evaluateCohort(cohortId: string): InputSpaceCoverageSignal {
    if (!enabled) return baseSignal("cohort", { cohortId }, "disabled", disabledNotice);
    if (declaredCohorts.has(cohortId)) {
      return baseSignal(
        "cohort",
        { cohortId },
        "declared_cohort",
        "This cohort is host-declared: the cohort-max rule does not apply to it. Its members are scored " +
          "individually against the declared-cohort (bulk) calibration - see evaluateIdentity.",
      );
    }
    const entry = cohorts.get(cohortId);
    if (!entry || entry.members.size === 0) {
      return baseSignal("cohort", { cohortId }, "insufficient_data", "No members have been observed for this cohort.");
    }
    // Cohort-max rule (the lab's): member evidences against the
    // CASUAL pools, max over members, against the cohort thresholds.
    let fBest: FamilyAgg | null = null;
    let rBest: FamilyAgg | null = null;
    let fAnyCkpt = false;
    let rAnyCkpt = false;
    for (const id of entry.members) {
      const st = identities.get(id);
      if (!st) continue;
      const fa = aggregateF(st, fCal, "casual");
      if (fa.anyCkpt) fAnyCkpt = true;
      if (fa.agg && (!fBest || fa.agg.evidence > fBest.evidence)) fBest = fa.agg;
      const rs = st.resources;
      if (rs && rs.ckStats.length > 0) {
        rAnyCkpt = true;
        if (rCal) {
          const run = scoreRun(rs.ckStats, rs.ckEnds, rCal, R_STAT_NAMES);
          const aggR: FamilyAgg = {
            evidence: run.evidence,
            threshold: 0,
            firstFlagAt: null,
            flagged: false,
            checkpoints: rs.ckStats.length,
            lastStats: run.lastStats,
          };
          if (!rBest || aggR.evidence > rBest.evidence) rBest = aggR;
        }
      }
    }
    const buildFamily = (
      best: FamilyAgg | null,
      anyCkpt: boolean,
      cal: { threshold: number } | null,
    ): CoverageFamilySignal | null => {
      if (!anyCkpt) return null;
      if (!best) {
        return {
          status: "uncalibrated",
          calibration: "casual",
          evidence: null,
          threshold: null,
          flagged: false,
          checkpoints: 0,
          firstFlagAt: null,
          lastStats: null,
        };
      }
      if (!cal) {
        return {
          status: "uncalibrated",
          calibration: "casual",
          evidence: null,
          threshold: null,
          flagged: false,
          checkpoints: best.checkpoints,
          firstFlagAt: null,
          lastStats: best.lastStats,
        };
      }
      return {
        status: "scored",
        calibration: "casual",
        evidence: best.evidence,
        threshold: cal.threshold,
        flagged: best.evidence > cal.threshold,
        checkpoints: best.checkpoints,
        firstFlagAt: null,
        lastStats: best.lastStats,
      };
    };
    const feature = buildFamily(fBest, fAnyCkpt, cohortFCal);
    const resource = buildFamily(rBest, rAnyCkpt, cohortRCal);
    const status: InputSpaceCoverageSignal["status"] =
      feature?.status === "scored" || resource?.status === "scored"
        ? "scored"
        : feature?.status === "uncalibrated" || resource?.status === "uncalibrated"
          ? "uncalibrated"
          : "insufficient_data";
    return {
      kind: "input_space_coverage",
      scope: "cohort",
      cohortId,
      status,
      flagged: status === "scored" && !!((feature && feature.flagged) || (resource && resource.flagged)),
      feature,
      resource,
      enforcement: "none",
      notice: ADVISORY_NOTICE,
    };
  }

  /* ---------------- observation ---------------- */

  const disabledObservation = (family: "feature" | "resource"): CoverageObservation => ({
    status: "disabled",
    reason: DISABLED_REASON,
    family,
    scored: false,
    items: 0,
    checkpoint: false,
  });

  function observeQuery(event: CoverageQueryEvent): CoverageObservation {
    if (!enabled) return disabledObservation("feature");
    if (typeof event !== "object" || event === null) fail("event must be an object");
    const identity = requireName(event.identity, "event.identity");
    const featureId = requireName(event.featureId, "event.featureId");
    if (
      (typeof event.inputId !== "number" || !Number.isFinite(event.inputId)) &&
      (typeof event.inputId !== "string" || event.inputId.length === 0)
    ) {
      fail("event.inputId must be a finite number or a non-empty string");
    }
    if (event.ts !== undefined) requireFiniteAtLeast(event.ts, "event.ts", 0);
    if (event.cohortId !== undefined) requireName(event.cohortId, "event.cohortId");

    const decl = features.get(featureId);
    if (!decl) {
      counters.undeclaredFeature++;
      return {
        status: "undeclared_feature",
        family: "feature",
        scored: false,
        items: 0,
        checkpoint: false,
      };
    }
    const hit = resolveHit(decl, event.inputId, event.hit, "observeQuery event");
    counters.queriesRecorded++;
    const now = clock();
    const state = touchIdentity(identity, now);
    // Per-event routing (hard condition 2): this query - and only
    // this query - lands in the lane its own cohortId selects, in
    // that lane's separate stream state for this feature.
    const lane = laneOf(event.cohortId);
    let laneMap = state.features.get(featureId);
    if (!laneMap) {
      laneMap = new Map();
      state.features.set(featureId, laneMap);
    }
    let fs = laneMap.get(lane);
    if (!fs) {
      fs = { n: 0, hits: 0, seqPairs: 0, lastNumeric: null, distinct: new Set(), nextAt: fStart, ckStats: [], ckEnds: [] };
      laneMap.set(lane, fs);
    }
    fs.n++;
    if (hit) fs.hits++;
    fs.distinct.add(event.inputId);
    if (typeof event.inputId === "number" && fs.lastNumeric !== null && event.inputId - fs.lastNumeric === 1) fs.seqPairs++;
    fs.lastNumeric = typeof event.inputId === "number" ? event.inputId : null;
    let checkpoint = false;
    if (fs.n === fs.nextAt) {
      if (fs.ckStats.length < MAX_CHECKPOINTS_PER_STREAM) {
        fs.ckStats.push({ hitRate: fs.hits / fs.n, distinctRate: fs.distinct.size / fs.n, fSeq: fs.seqPairs / (fs.n - 1) });
        fs.ckEnds.push(fs.n);
        checkpoint = true;
      }
      fs.nextAt += fStride;
    }
    if (event.cohortId !== undefined) registerCohort(event.cohortId, identity, now);
    const result: CoverageObservation = { status: "recorded", family: "feature", scored: true, items: fs.n, checkpoint };
    if (checkpoint) result.signal = evaluateIdentity(identity);
    return result;
  }

  function observeResource(event: CoverageResourceEvent): CoverageObservation {
    if (!enabled) return disabledObservation("resource");
    if (typeof event !== "object" || event === null) fail("event must be an object");
    const identity = requireName(event.identity, "event.identity");
    if (
      (typeof event.resourceId !== "number" || !Number.isFinite(event.resourceId)) &&
      (typeof event.resourceId !== "string" || event.resourceId.length === 0)
    ) {
      fail("event.resourceId must be a finite number or a non-empty string");
    }
    if (event.ts !== undefined) requireFiniteAtLeast(event.ts, "event.ts", 0);
    if (event.cohortId !== undefined) requireName(event.cohortId, "event.cohortId");

    const existing = identities.get(identity);
    if (!resourceDecl) {
      counters.resourceSpaceNotDeclared++;
      return {
        status: "space_not_declared",
        family: "resource",
        scored: false,
        items: existing?.resources?.n ?? 0,
        checkpoint: false,
      };
    }
    const rank = resolveRank(event.resourceId, event.rank, "observeResource event");
    if (rank === null) {
      counters.rankUnknown++;
      return {
        status: "rank_unknown",
        family: "resource",
        scored: false,
        items: existing?.resources?.n ?? 0,
        checkpoint: false,
      };
    }
    counters.resourceEventsRecorded++;
    const now = clock();
    const state = touchIdentity(identity, now);
    let rs = state.resources;
    if (!rs) {
      rs = { n: 0, distinct: new Map(), nextAt: rStart, ckStats: [], ckEnds: [] };
      state.resources = rs;
    }
    rs.n++;
    if (!rs.distinct.has(event.resourceId)) rs.distinct.set(event.resourceId, rank);
    let checkpoint = false;
    if (rs.n === rs.nextAt) {
      if (rs.ckStats.length < MAX_CHECKPOINTS_PER_STREAM) {
        rs.ckStats.push(resourceStatsOf(rs.distinct));
        rs.ckEnds.push(rs.n);
        checkpoint = true;
      }
      rs.nextAt += rStride;
    }
    if (event.cohortId !== undefined) registerCohort(event.cohortId, identity, now);
    const result: CoverageObservation = { status: "recorded", family: "resource", scored: true, items: rs.n, checkpoint };
    if (checkpoint) result.signal = evaluateIdentity(identity);
    return result;
  }

  /* ---------------- calibration fits ---------------- */

  const fitSummary = (cal: { streams: number; threshold: number; poolCheckpoints: number }): CoverageFamilyFit => ({
    streams: cal.streams,
    threshold: cal.threshold,
    poolCheckpoints: cal.poolCheckpoints,
  });

  const firstFit = (record: Record<string, CoverageFamilyFit>): CoverageFamilyFit | null => {
    const values = Object.values(record);
    return values.length ? values[0]! : null;
  };

  const validateInputId = (value: unknown, field: string): void => {
    if ((typeof value !== "number" || !Number.isFinite(value)) && (typeof value !== "string" || value.length === 0)) {
      fail(`${field} must be a finite number or a non-empty string`);
    }
  };

  /** Group one stream's query samples by declared feature and resolve hits. Throws on undeclared features. */
  function resolveStreamQueries(queries: CoverageQuerySample[], field: string): Map<string, ResolvedQuery[]> {
    const byFeature = new Map<string, ResolvedQuery[]>();
    queries.forEach((q, qi) => {
      if (typeof q !== "object" || q === null) fail(`${field}[${qi}] must be an object`);
      const fid = requireName(q.featureId, `${field}[${qi}].featureId`);
      const decl = features.get(fid);
      if (!decl) {
        throw new InputSpaceCoverageError(
          `${field}[${qi}] names undeclared feature ${JSON.stringify(fid)}; calibration samples must use the declared surface`,
        );
      }
      validateInputId(q.inputId, `${field}[${qi}].inputId`);
      const hit = resolveHit(decl, q.inputId, q.hit, `${field}[${qi}]`);
      const list = byFeature.get(fid) ?? [];
      list.push({ inputId: q.inputId, hit });
      byFeature.set(fid, list);
    });
    return byFeature;
  }

  function resolveStreamEvents(events: CoverageResourceSample[], field: string): ResolvedResource[] {
    return events.map((e, ei) => {
      if (typeof e !== "object" || e === null) fail(`${field}[${ei}] must be an object`);
      validateInputId(e.resourceId, `${field}[${ei}].resourceId`);
      const rank = resolveRank(e.resourceId, e.rank, `${field}[${ei}]`);
      if (rank === null) {
        throw new InputSpaceCoverageError(
          `${field}[${ei}]: resource rank is unresolvable; calibration samples must carry resolvable ranks`,
        );
      }
      return { resourceId: e.resourceId, rank };
    });
  }

  /** Fit per-feature F pools from a list of streams (each stream = its query samples). */
  function fitFeaturePools(
    queryLists: CoverageQuerySample[][],
    field: string,
  ): { cals: Map<string, FamilyCalibration<FStatName>>; record: Record<string, CoverageFamilyFit>; skipped: number } {
    const perFeature = new Map<string, Array<FeatureStats[]>>();
    let skipped = 0;
    queryLists.forEach((queries, si) => {
      if (!Array.isArray(queries)) fail(`${field}[${si}] must be an array of query samples`);
      const byFeature = resolveStreamQueries(queries, `${field}[${si}]`);
      let hadCk = false;
      for (const [fid, qs] of byFeature) {
        const ck = featureCheckpointsOf(qs).map((c) => c.stats);
        const list = perFeature.get(fid) ?? [];
        list.push(ck);
        perFeature.set(fid, list);
        if (ck.length) hadCk = true;
      }
      if (queries.length > 0 && !hadCk) skipped++;
    });
    const cals = new Map<string, FamilyCalibration<FStatName>>();
    const record: Record<string, CoverageFamilyFit> = {};
    for (const [fid, ckList] of perFeature) {
      const cal = fitFamily(ckList, F_STAT_NAMES, alpha);
      if (cal.streams === 0) continue;
      if (cal.streams < minTrainStreams) {
        fail(
          `${field}: feature ${JSON.stringify(fid)} yields ${cal.streams} scorable training streams, below minTrainStreams ` +
            `${minTrainStreams}; supply more legitimate training streams (an undersized pool is not conformal-grade)`,
        );
      }
      cals.set(fid, cal);
      record[fid] = fitSummary(cal);
    }
    return { cals, record, skipped };
  }

  const disabledFit = (scope: InputSpaceCoverageFitResult["scope"]): InputSpaceCoverageFitResult => ({
    fitted: false,
    status: "disabled",
    scope,
    feature: null,
    features: {},
    resource: null,
    skipped: 0,
  });

  function fitCalibration(samples: CoverageStreamSample[]): InputSpaceCoverageFitResult {
    if (!enabled) return disabledFit("identity");
    if (!Array.isArray(samples)) fail("fitCalibration samples must be an array of stream samples");
    samples.forEach((s, i) => {
      if (typeof s !== "object" || s === null) fail(`fitCalibration samples[${i}] must be an object`);
      if (s.queries !== undefined && !Array.isArray(s.queries)) fail(`fitCalibration samples[${i}].queries must be an array`);
      if (s.events !== undefined && !Array.isArray(s.events)) fail(`fitCalibration samples[${i}].events must be an array`);
    });

    const fFit = fitFeaturePools(
      samples.map((s) => s.queries ?? []),
      "fitCalibration samples",
    );

    let resourceFit: CoverageFamilyFit | null = null;
    let rSkipped = 0;
    const withEvents = samples.filter((s) => (s.events?.length ?? 0) > 0);
    if (withEvents.length > 0) {
      if (!resourceDecl) fail("fitCalibration samples carry resource events but no resource space is declared");
      const ckLists: Array<ResourceStats[]> = [];
      withEvents.forEach((s, si) => {
        const resolved = resolveStreamEvents(s.events ?? [], `fitCalibration samples events[${si}]`);
        const ck = resourceCheckpointsOf(resolved).map((c) => c.stats);
        if (ck.length === 0) rSkipped++;
        ckLists.push(ck);
      });
      const cal = fitFamily(ckLists, R_STAT_NAMES, alpha);
      if (cal.streams > 0) {
        if (cal.streams < minTrainStreams) {
          fail(
            `fitCalibration: resource family yields ${cal.streams} scorable training streams, below minTrainStreams ${minTrainStreams}`,
          );
        }
        rCal = cal;
        resourceFit = fitSummary(cal);
      }
    }

    if (fFit.cals.size > 0) fCal = fFit.cals;
    if (fFit.cals.size === 0 && !resourceFit) {
      fail(
        `fitCalibration: no scorable streams in any family (a stream must reach the first checkpoint: ` +
          `${fStart} queries on one feature or ${rStart} resource events at the configured starts)`,
      );
    }
    return {
      fitted: true,
      status: "fitted",
      scope: "identity",
      feature: firstFit(fFit.record),
      features: fFit.record,
      resource: resourceFit,
      skipped: fFit.skipped + rSkipped,
    };
  }

  function fitBulkCalibration(streams: CoverageQuerySample[][]): InputSpaceCoverageFitResult {
    if (!enabled) return disabledFit("declared_cohort");
    if (declaredCohorts.size === 0) {
      fail(
        "fitBulkCalibration requires the surface declaration to name at least one declared cohort " +
          "(surface.declaredCohorts): bulk pools exist to calibrate declared cohorts, and scoring declared " +
          "traffic against the casual pool is exactly the configuration error this module refuses",
      );
    }
    if (!Array.isArray(streams)) fail("fitBulkCalibration streams must be an array of query-sample arrays");
    const fFit = fitFeaturePools(streams, "fitBulkCalibration streams");
    if (fFit.cals.size === 0) {
      fail(`fitBulkCalibration: no scorable streams (a stream must reach the first feature checkpoint at ${fStart} queries)`);
    }
    bulkFCal = fFit.cals;
    return {
      fitted: true,
      status: "fitted",
      scope: "declared_cohort",
      feature: firstFit(fFit.record),
      features: fFit.record,
      resource: null,
      skipped: fFit.skipped,
    };
  }

  function fitCohortCalibration(cohortSamples: CoverageStreamSample[][]): InputSpaceCoverageFitResult {
    if (!enabled) return disabledFit("cohort");
    if (fCal.size === 0 && !rCal) {
      fail("fitCohortCalibration requires fitCalibration first: member evidences are computed against the casual pools");
    }
    if (!Array.isArray(cohortSamples)) fail("fitCohortCalibration cohorts must be an array of cohorts (arrays of stream samples)");

    const memberF = (s: CoverageStreamSample, field: string): { ev: number; ck: number } | null => {
      const byFeature = resolveStreamQueries(s.queries ?? [], field);
      let best: number | null = null;
      let ck = 0;
      for (const [fid, qs] of byFeature) {
        const cal = fCal.get(fid);
        if (!cal) continue;
        const cks = featureCheckpointsOf(qs);
        if (!cks.length) continue;
        ck += cks.length;
        const run = scoreRun(
          cks.map((c) => c.stats),
          cks.map((c) => c.end),
          cal,
          F_STAT_NAMES,
        );
        if (best === null || run.evidence > best) best = run.evidence;
      }
      return best === null ? null : { ev: best, ck };
    };
    const memberR = (s: CoverageStreamSample, field: string): { ev: number; ck: number } | null => {
      if (!rCal || !s.events || s.events.length === 0) return null;
      if (!resourceDecl) fail(`${field} carries resource events but no resource space is declared`);
      const resolved = resolveStreamEvents(s.events, field);
      const cks = resourceCheckpointsOf(resolved);
      if (!cks.length) return null;
      const run = scoreRun(
        cks.map((c) => c.stats),
        cks.map((c) => c.end),
        rCal,
        R_STAT_NAMES,
      );
      return { ev: run.evidence, ck: cks.length };
    };

    const fMaxes: number[] = [];
    const rMaxes: number[] = [];
    let fCk = 0;
    let rCk = 0;
    let skipped = 0;
    cohortSamples.forEach((cohort, ci) => {
      if (!Array.isArray(cohort)) fail(`fitCohortCalibration cohorts[${ci}] must be an array of stream samples`);
      let fMax: number | null = null;
      let rMax: number | null = null;
      cohort.forEach((s, si) => {
        if (typeof s !== "object" || s === null) fail(`fitCohortCalibration cohorts[${ci}][${si}] must be an object`);
        const mf = memberF(s, `fitCohortCalibration cohorts[${ci}][${si}]`);
        if (mf) {
          fCk += mf.ck;
          if (fMax === null || mf.ev > fMax) fMax = mf.ev;
        }
        const mr = memberR(s, `fitCohortCalibration cohorts[${ci}][${si}]`);
        if (mr) {
          rCk += mr.ck;
          if (rMax === null || mr.ev > rMax) rMax = mr.ev;
        }
      });
      if (fMax !== null) fMaxes.push(fMax);
      if (rMax !== null) rMaxes.push(rMax);
      if (fMax === null && rMax === null) skipped++;
    });
    if (fMaxes.length === 0 && rMaxes.length === 0) {
      fail("fitCohortCalibration: no cohort reached a checkpoint in any calibrated family");
    }
    if (fMaxes.length > 0 && fMaxes.length < minTrainCohorts) {
      fail(
        `fitCohortCalibration: feature family yields ${fMaxes.length} scorable training cohorts, below minTrainCohorts ${minTrainCohorts}`,
      );
    }
    if (rMaxes.length > 0 && rMaxes.length < minTrainCohorts) {
      fail(
        `fitCohortCalibration: resource family yields ${rMaxes.length} scorable training cohorts, below minTrainCohorts ${minTrainCohorts}`,
      );
    }
    if (fMaxes.length > 0) {
      cohortFCal = { threshold: conformalThreshold(fMaxes, alpha), cohorts: fMaxes.length, memberCheckpoints: fCk };
    }
    if (rMaxes.length > 0) {
      cohortRCal = { threshold: conformalThreshold(rMaxes, alpha), cohorts: rMaxes.length, memberCheckpoints: rCk };
    }
    return {
      fitted: true,
      status: "fitted",
      scope: "cohort",
      feature: cohortFCal
        ? { streams: cohortFCal.cohorts, threshold: cohortFCal.threshold, poolCheckpoints: cohortFCal.memberCheckpoints }
        : null,
      features: {},
      resource: cohortRCal
        ? { streams: cohortRCal.cohorts, threshold: cohortRCal.threshold, poolCheckpoints: cohortRCal.memberCheckpoints }
        : null,
      skipped,
    };
  }

  /* ---------------- snapshot ---------------- */

  function snapshot(): InputSpaceCoverageSnapshot {
    const calRecord = (map: Map<string, FamilyCalibration<FStatName>>): Record<string, CoverageFamilyFit> => {
      const out: Record<string, CoverageFamilyFit> = {};
      for (const [fid, cal] of map) out[fid] = fitSummary(cal);
      return out;
    };
    return {
      enabled,
      disabledReason: enabled ? null : DISABLED_REASON,
      enforcement: "none",
      calibrated: fCal.size > 0 || rCal !== null,
      bulkCalibrated: bulkFCal.size > 0,
      cohortCalibrated: cohortFCal !== null || cohortRCal !== null,
      alpha,
      features: [...features.values()].map((d) => ({ featureId: d.featureId, spaceSize: d.spaceSize })),
      resourceSpaceSize: resourceDecl ? resourceDecl.spaceSize : null,
      declaredCohorts: [...declaredCohorts],
      identitiesTracked: identities.size,
      cohortsTracked: cohorts.size,
      counters: { ...counters },
      identityCalibration:
        fCal.size > 0 || rCal !== null
          ? { features: calRecord(fCal), resource: rCal ? fitSummary(rCal) : null }
          : null,
      bulkCalibration: bulkFCal.size > 0 ? { features: calRecord(bulkFCal) } : null,
      cohortCalibration:
        cohortFCal !== null || cohortRCal !== null
          ? {
              feature: cohortFCal
                ? { streams: cohortFCal.cohorts, threshold: cohortFCal.threshold, poolCheckpoints: cohortFCal.memberCheckpoints }
                : null,
              resource: cohortRCal
                ? { streams: cohortRCal.cohorts, threshold: cohortRCal.threshold, poolCheckpoints: cohortRCal.memberCheckpoints }
                : null,
            }
          : null,
      notice: enabled ? ADVISORY_NOTICE : disabledNotice,
    };
  }

  return {
    enabled,
    observeQuery,
    observeResource,
    fitCalibration,
    fitBulkCalibration,
    fitCohortCalibration,
    evaluateIdentity,
    evaluateCohort,
    snapshot,
  };
}
