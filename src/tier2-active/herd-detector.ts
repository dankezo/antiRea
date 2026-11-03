/**
 * Cross-identity herd detector (sybil correlation telemetry + opt-in ladder).
 *
 * `createRecordBudget` caps what ONE identity can extract, and its own
 * documentation names the dilution: an extractor who can mint identities
 * rotates them, each staying politely under its own cap, and the union of
 * six "legal" identities is the whole dataset. That is not hypothetical -
 * in the reconstruction study's round 3, one session extracted 100% of a
 * 10,000-record dataset by rotating 6 free identities, each inside its own
 * 2,000-record budget, while every per-identity defense behaved exactly as
 * designed. What the per-identity layer cannot see is the CORRELATION: the
 * herd's aggregate traces (identities minted minutes apart, disjoint
 * coverage that tiles the dataset with zero overlap, lockstep activity,
 * every member drifting toward its cap) are visible only across identities.
 * This module watches that dimension. It never blocks, bans or alters a
 * response; it emits `onFlag` when a GROUP of identities crosses the flag
 * threshold, and the host decides the consequence (see `applyHerdLadder`
 * for the one response whose policy is encoded in code).
 *
 * Two grouping mechanisms, both ported from the lab detectors that were
 * validated against scripted herd/control arms (see docs/LIMITATIONS.md
 * for the measured flag points and the shapes that remain open):
 *
 * - Grouping v1 - signup chaining. Identities whose signups fall within
 *   `chainingWindowMs` of a member's signup join that member's group,
 *   tracked per source IP and as a global cohort. The cohort view is
 *   DIAGNOSTIC ONLY (listed by `groups()`, never flags): the lab showed
 *   it reaches the flaggable configuration on a distinct-IP herd
 *   (~326 records), but its false-positive risk on a real site with real
 *   signup volume is unmeasurable in a lab, so the deployable flag path
 *   is the per-IP view, exactly as in the lab detector.
 * - Grouping v2 - coverage complement. Signup chaining is blind to herds
 *   whose identities were registered dispersedly (the lab's aged-dispersed
 *   arm extracted 10,000/10,000 unflagged under v1 alone). V2 ignores
 *   signup time: over the rolling `activityWindowMs`, identities link
 *   (union-find) when they are recently co-active and their served-record
 *   sets are strongly complementary - each side at least `minOwnRecords`
 *   distinct, union at least `unionFloor`, Jaccard at most
 *   `linkOverlapCeiling`. Legitimate collaborators overlap (the
 *   lab's dense onboarding team had pairwise Jaccard far above the
 *   ceiling and formed zero links); herds partition, so they link.
 *   Candidate generation is LEADER-based (2.5.0): an active identity's
 *   coverage group is compared against the other coverage GROUPS'
 *   aggregate sets (one aggregate bitmap + refcount map per group),
 *   never against every other identity, and a merge decision is the
 *   same complementarity test applied to the two aggregates. A
 *   singleton group is the degenerate case, so two ungrouped
 *   identities still link exactly when the old pairwise test linked
 *   them; a formed group then absorbs further complementary identities
 *   directly, which is the shape a dispersed herd actually takes.
 *
 * Late-joiner / materiality re-announcement (2.5.0): a flag used to be
 * a single snapshot of whoever was in the group at flag time, and the
 * classic rounds showed the cost - the slicing crew's first flag
 * landed when only 8 of its 18 identities had signed up, and the ID
 * walk's first flag landed when every walker was still below the
 * friction-materiality floor, so both flags consequenced nobody new
 * ever again. A flagged group now remembers each announced member's
 * unique coverage at announcement time (the materiality floor is
 * derived as 1/12 of the combined flag floor - the same derivation
 * as `HERD_FRICTION_MIN_UNIQUE_RECORDS`, 25 at the defaults). When a
 * member who is not settled - a LATE JOINER (never announced) or a
 * PENDING partial contributor (announced with 0 < unique < floor) -
 * crosses that floor inside a still-flagged group, the detector
 * emits a SUPPLEMENTARY flag snapshot (`supplementary: true`, same
 * mechanism, full current member list) so the host's response
 * reaches them. Members announced at exactly 0 unique coverage are
 * settled-inactive: they were named in the flag snapshot itself, so
 * they never re-trigger one - and members whose unique coverage
 * stays below the floor (the bystander profile: coverage duplicated
 * by others) are never re-announced either. A group with no new
 * material member emits nothing extra - the once-per-window
 * discipline is preserved for groups whose membership and
 * materiality are stable.
 *
 * Scoring uses the lab's feature set over a group: signup cluster (v1
 * only; the v2 score drops the cluster weight WITHOUT renormalizing,
 * matching the lab arithmetic), coverage ramp (combined distinct /
 * `coverageRampDenominator`), tiling (1 - 3x the group's overlap ratio -
 * the herd's defining economic act is partitioning, so tiling near 1 is
 * the herd profile and tiling near 0 is colleagues redundantly covering
 * the same ground), contiguity (mean per-member largest run of
 * consecutive record indices), co-activity (fraction of members active
 * in the trailing `coActivityWindowMs`), and cap pressure (fraction of
 * members at >= 90% of their record-budget limit, from the event's
 * `budgetLimit` field or the `getLimit` callback). A group flags when it
 * has at least `flagMinMembers` members, combined coverage at least
 * `combinedCoverageFloor`, and score at least `flagThreshold`. The flag
 * fires ONCE per group per window (the latch re-arms after the whole
 * group has been idle for `activityWindowMs`).
 *
 * One candidate feature is computed but NOT scored by default: union
 * growth (see `HerdFeatures.unionGrowth`). Interleaving a herd's
 * slices collapses its contiguity term while the complement grouping
 * still proves the members tile disjoint slices; union growth -
 * the share of served records that grew the group's union,
 * discounted by the contiguity that already credits contiguous
 * growth - stays high for that profile and low for redundant
 * readers. Its shipped weight is 0 (the lab-validated scoring is
 * untouched); `weights: { unionGrowth: 0.15 }` opts in.
 *
 * Response bands - the C6 lesson, encoded. A flag is not one kind of
 * evidence. Every measured herd tiles (tiling ~ 1.0); the one measured
 * legitimate group that crossed the threshold - a compliance team
 * systematically reviewing a full segment, a uniform-coverage job
 * description - flagged at tiling 0.239 and would have had its read
 * budgets cut by an ungraduated ladder near the end of legitimate work.
 * So each flag snapshot carries a `band`: `budget_cut_supported` only
 * when the group's tiling is at least `tilingCutThreshold` (the herd
 * partition profile), otherwise `graduated_only`. `applyHerdLadder`
 * refuses to cut budgets for a `graduated_only` snapshot: hosts route
 * those to step-up verification, export-only restriction or human
 * review instead. Low-tiling flags are telemetry, not a sentence.
 *
 * Storage is bounded, following `createRecordBudget`'s approach. Record
 * ids are stored as fixed-length FNV-1a 64-bit hex keys, never raw
 * strings, and each identity stores at most `maxStoredKeysPerIdentity`
 * keys (records past the cap still increment the identity's distinct
 * counter - with the same accepted trade-off as the budget: an id that
 * was not retained cannot be de-duplicated on re-delivery - but they no
 * longer enter group aggregates, so size `maxStoredKeysPerIdentity`
 * above the host's per-identity budget cap). Group union refcount maps
 * hold at most one entry per distinct stored key of their members.
 * Leader-scan throttle state is one scalar per identity (its stored
 * size at the last scan). Identities are capped at `maxIdentities`
 * with least-recently-active eviction (group aggregates are rebuilt
 * from the remaining members' stored keys). The block bitmap used to
 * pre-filter candidate evaluations partitions the HASH space (1024
 * blocks, 128 bytes per identity, plus one aggregate bitmap per
 * coverage group) instead of the lab's index space, with the same
 * contract: two sets sharing no block have an intersection of
 * exactly zero.
 *
 * Scaling bound, stated plainly: grouping v2's leader design (2.5.0)
 * keeps NO per-pair state - the state the lab's exact-pairwise design
 * (C5) grew quadratically until its throttle cap. Candidate
 * enumeration is O(number of coverage groups) per growth-triggered
 * scan of one identity (a scan runs only once that identity's stored
 * set has grown by `recheckGrowth` since its last scan), each
 * candidate is pre-filtered by a 128-byte aggregate bitmap AND, and
 * the exact intersection iterates the smaller aggregate's stored
 * keys. Group count is at most the identity count and collapses as
 * complementary identities merge, so the herd case - the case this
 * detector exists for - gets cheaper as it succeeds; the worst case
 * is a large population of mutually-overlapping legitimate users who
 * never merge, where enumeration stays O(N) per scan with a small
 * constant (bitmap AND + an intersection bounded by the smaller
 * set). Load evidence is in the 2.5.0 study report
 * (RESULTS-V242-PHASE3.md): the pairwise build needed >120 s for
 * 1,000 identities x 60 records in the bench harness (it did not
 * finish inside the measurement window), the leader build processes
 * the same stream in seconds - the exact numbers and the bench's
 * limits are stated there, not here, so they cannot drift.
 *
 * Contiguity needs dataset order, which arbitrary record ids do not
 * carry: supply `recordIndex` to map an id to its ordinal position
 * (the lab's ids were `ACC-<n>`). Ids without an index still count
 * toward coverage, overlap and tiling; without `recordIndex`,
 * contiguity is 0 for everyone - which also removes the feature that
 * separates interleaved-slice herds from the threshold in the other
 * direction, so hosts with ordinal ids should wire it.
 *
 * Feed EVERY surface that serves record data into `observe` - API list,
 * detail and export responses AND server-rendered HTML pages
 * (`page_view`) - and consume those same records from the record
 * budget. The lab's round-3/C4c measurement is blunt: an unmetered
 * HTML surface was simultaneously a budget bypass and a detection
 * bypass (10,000 records taken, 0 record-bearing events emitted);
 * metering the surface restored both layers at once, because in this
 * architecture they are the same wiring. See docs/LIMITATIONS.md.
 */

import { monoNowMs } from "../internal/mono-clock";

export type HerdEventType = "signup" | "login" | "list" | "detail" | "export" | "page_view";

export interface HerdEvent {
  /** What happened. `signup` drives chaining; the rest are activity, and any of them may carry record ids. */
  type: HerdEventType;
  /**
   * The authenticated identity key behind the event. Use the SAME string
   * the record budget uses (the quota-guard key form, e.g.
   * `account:<id>`) so flag snapshots can be fed straight to
   * `setOverride` / `applyHerdLadder`.
   */
  identity: string;
  /** Source IP as observed by the server (never a client-supplied header). Drives v1 per-IP grouping. */
  ip?: string;
  /** Accepted for stream compatibility; the detector does not score on it. */
  userAgent?: string;
  /** Record ids this response served. Counted only when `status` is absent or exactly 200 (lab parity). */
  recordIds?: readonly string[];
  /** HTTP status the request produced. Ids on non-200 responses are not counted as served. */
  status?: number;
  /** The identity's record-budget limit, when the host knows it. Feeds cap pressure; the latest value wins. */
  budgetLimit?: number;
  /** Event time in ms since epoch. Defaults to the detector clock (`now` option, else `Date.now`). */
  ts?: number;
}

export interface HerdFeatures {
  /**
   * Signup-span cluster term (v1 flags only; `null` on v2 flags, whose
   * score drops the cluster weight without renormalizing).
   */
  cluster: number | null;
  /** min(1, combined distinct / coverageRampDenominator). */
  coverageRamp: number;
  /** 1 - min(1, 3 * overlapRatio); ~1 for partitioning herds, ~0 for overlapping colleagues. */
  tiling: number;
  /** Mean per-member largest-consecutive-index-run fraction. 0 without `recordIndex`. */
  contiguity: number;
  /**
   * Union growth through fragmentation (L8b candidate, opt-in via
   * `weights.unionGrowth`, default weight 0): the fraction of served
   * records that grew the group's union (combined / sum of member
   * sizes - 1 for a partitioning group, low for redundant readers),
   * discounted by contiguity. Contiguous assembly is already credited
   * by the contiguity term, so this term pays out only for union
   * growth achieved through NON-contiguous serving - the
   * slice-interleaved profile whose contiguity collapses while its
   * members still tile disjoint slices.
   */
  unionGrowth: number;
  /** Fraction of members active within the trailing co-activity window. */
  coActivity: number;
  /** Fraction of members at >= 90% of their record-budget limit. */
  capPressure: number;
}

/**
 * `budget_cut_supported` is reserved for the herd partition profile
 * (tiling >= `tilingCutThreshold`): the only profile for which a group
 * budget cut is evidence-supported. Everything else is `graduated_only`.
 */
export type HerdResponseBand = "budget_cut_supported" | "graduated_only";

export interface HerdFlagSnapshot {
  groupId: number;
  /** Which grouping path produced the flag. (The v1 cohort view is diagnostic and never flags.) */
  mechanism: "v1-ip" | "v2-coverage";
  /** Member identity keys at flag time. */
  members: string[];
  /**
   * Distinct records each member holds in the group state at flag
   * time (the member's stored-key count in the flagging group).
   */
  memberCoverage: Record<string, number>;
  /**
   * Distinct records that ONLY that member serves in the group:
   * keys in the group's combined refcount map whose refcount is
   * exactly 1 and which belong to that member. A member whose whole
   * coverage is duplicated by others has a unique coverage of 0.
   */
  memberUniqueCoverage: Record<string, number>;
  /** Combined DISTINCT records served to the group at flag time. */
  combinedCoverage: number;
  score: number;
  features: HerdFeatures;
  band: HerdResponseBand;
  /**
   * True on a SUPPLEMENTARY re-announcement: the group had already
   * flagged, and this snapshot exists because a member who was not
   * yet announced with material unique coverage (a late joiner, or a
   * member below the materiality floor at flag time) crossed that
   * floor inside the flagged group. Absent on the initial flag.
   * Hosts should treat a supplementary snapshot exactly like an
   * initial one - the members it newly reaches are precisely the
   * ones the initial snapshot could not consequence.
   */
  supplementary?: boolean;
  /** ISO-8601 timestamp from the detector clock. */
  timestamp: string;
}

export interface HerdWeights {
  cluster: number;
  coverageRamp: number;
  tiling: number;
  contiguity: number;
  coActivity: number;
  capPressure: number;
  /** L8b candidate feature weight. 0 in the shipped defaults: opt-in only. */
  unionGrowth: number;
}

/** The lab-validated weights (chain C). The v2 score drops `cluster` without renormalizing. */
export const DEFAULT_HERD_WEIGHTS: HerdWeights = {
  cluster: 0.25,
  coverageRamp: 0.25,
  tiling: 0.2,
  contiguity: 0.15,
  coActivity: 0.1,
  capPressure: 0.05,
  // L8b candidate (union growth through fragmentation): computed on
  // every snapshot but weighted 0 by default, so the shipped scoring
  // is exactly the lab-validated arithmetic. A host opts in with
  // `weights: { unionGrowth: 0.15 }` - the contiguity weight, so a
  // perfectly partitioning group earns the assembly term in full
  // whether its slices arrive contiguously or interleaved.
  unionGrowth: 0,
};

export interface HerdDetectorOptions {
  /**
   * Fired once per group per window when a group crosses the flag
   * threshold. Errors are swallowed: operator wiring must never break
   * request handling.
   */
  onFlag?: (snapshot: HerdFlagSnapshot) => Promise<void> | void;
  /**
   * Resolve an identity's record-budget limit for the cap-pressure
   * feature. An event's own `budgetLimit` field takes precedence; when
   * neither exists, `defaultRecordCap` is used.
   */
  getLimit?: (identity: string) => number | undefined;
  /**
   * Map a record id to its ordinal position in the dataset (the lab's
   * ids were `ACC-<n>` minus the base). Drives the contiguity feature.
   * Ids with no index still count toward coverage/overlap/tiling.
   */
  recordIndex?: (recordId: string) => number | undefined;
  /** Minimum combined distinct records before a group may flag. Defaults to 300 (the lab floor at 10,000 records). */
  combinedCoverageFloor?: number;
  /** Score at/above which a group flags. Defaults to 60 (lab). */
  flagThreshold?: number;
  /** Minimum group size that may flag. Defaults to 3 (lab). Small groups' feature values are vacuous; the gate carries the false-positive discipline. */
  flagMinMembers?: number;
  /** Denominator of the coverage-ramp feature. Defaults to 4,000 (lab, at a 10,000-record dataset). */
  coverageRampDenominator?: number;
  /** Fallback per-identity record cap for cap pressure. Defaults to 2,000 (lab). */
  defaultRecordCap?: number;
  /** Signup-chaining window for grouping v1. Defaults to 120 minutes (lab). (The cluster step table in the score is part of the validated configuration and does not rescale with this option.) */
  chainingWindowMs?: number;
  /** Trailing window for the co-activity feature. Defaults to 15 minutes (lab). */
  coActivityWindowMs?: number;
  /** V2 link gate: a candidate partner must have been active within this trailing window. Defaults to 60 minutes (lab). */
  coactLinkMs?: number;
  /** Rolling activity window for v2 candidacy, and the idle period after which a flagged group's latch re-arms. Defaults to 7 days (lab). */
  activityWindowMs?: number;
  /** V2 link gate: maximum pairwise Jaccard for two sets to count as complementary. Defaults to 0.10 (lab). */
  linkOverlapCeiling?: number;
  /** V2 link gate: minimum pairwise union size. Defaults to 300 (lab). */
  unionFloor?: number;
  /** V2 link gate: minimum distinct records per identity before it can link. Defaults to 50 (lab). */
  minOwnRecords?: number;
  /** V2 scan throttle: an identity's coverage group is re-evaluated against the group leaders only after its stored set grows by this many records. Defaults to 25 (lab). */
  recheckGrowth?: number;
  /**
   * Materiality floor for supplementary re-announcement: a member of
   * a flagged group is (re-)announced once its UNIQUE coverage in
   * that group reaches this many records. Default: 1/12 of
   * `combinedCoverageFloor`, rounded up (25 at the shipped defaults -
   * the `HERD_FRICTION_MIN_UNIQUE_RECORDS` derivation).
   */
  lateJoinerMinUniqueRecords?: number;
  /**
   * Coalescing window for supplementary re-announcements: at most
   * one supplementary flag per group per this many milliseconds.
   * Members crossing the materiality floor inside the window stay
   * pending and are announced by the next supplementary after it -
   * a bounded delay, never a loss. Defaults to 5,000.
   */
  supplementaryCooldownMs?: number;
  /** Tiling at/above which a flag's band is `budget_cut_supported`. Defaults to 0.5. */
  tilingCutThreshold?: number;
  /** Partial weight overrides over `DEFAULT_HERD_WEIGHTS`. */
  weights?: Partial<HerdWeights>;
  /** Cap on identities held in memory (least-recently-active eviction). Defaults to 2,000. Size it above the expected concurrent identities - see the scaling bound in the header. */
  maxIdentities?: number;
  /** Cap on stored record keys per identity. Defaults to 4,096. Size it above the host's per-identity budget cap. */
  maxStoredKeysPerIdentity?: number;
  /**
   * @deprecated Accepted for compatibility and ignored since 2.5.0:
   * the leader-based grouping keeps no per-pair throttle state, so
   * there is no pair-entry store left to cap.
   */
  maxPairEntries?: number;
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. Display timestamps only (L-DEEP-2). */
  now?: () => number;
  /**
   * Monotonic clock for the activity arithmetic (L-DEEP-2): the
   * co-activity feature, the v2 co-activity link gates, the flagged
   * latch's idle re-arm and the supplementary cooldown are measured
   * on this clock and are immune to wall-clock steps. Events carrying
   * a host `ts` stay in the host's time domain throughout (their
   * monotonic twin mirrors `ts`). When only `now` is given, the
   * injected clock drives both domains (pre-patch behavior).
   */
  monoNow?: () => number;
}

export interface HerdObservation {
  /** False when the event carried no usable identity and nothing was recorded. */
  recorded: boolean;
  /** The flag this event caused, when it caused one. (All flags also go to `onFlag`.) */
  flag?: HerdFlagSnapshot;
}

export interface HerdGroupInfo {
  groupId: number;
  mechanism: "v1-ip" | "v1-cohort" | "v2-coverage";
  members: string[];
  combinedCoverage: number;
  /** Score as of the group's most recent scoring event (0 when never scored). */
  score: number;
  /** Highest score observed for this group. */
  maxScore: number;
  features?: HerdFeatures;
  flagged: boolean;
}

export interface HerdDetector {
  /** Record one event and update grouping/scoring incrementally. */
  observe(event: HerdEvent): HerdObservation;
  /** Diagnostic listing of current groups (v1 per-IP, v1 cohort, v2 coverage) with their latest scores. */
  groups(): HerdGroupInfo[];
  /** Clear one identity (and its group memberships), or all detector state when called with no argument. */
  reset(identity?: string): void;
}

/** The structural slice of `createRecordBudget` the ladder needs. */
export interface HerdBudgetLike {
  setOverride(identity: string, maxDistinct: number): void;
}

export interface HerdLadderResult {
  applied: boolean;
  /**
   * Present when `applied` is false: the snapshot's band is
   * `graduated_only`, so the ladder refused. Route this flag to step-up
   * verification, export-only restriction or human review instead.
   */
  reason?: "graduated_only";
  /** Identities whose budget override was set (empty when refused). */
  identities: string[];
  memberLimit?: number;
}

/**
 * Apply the response ladder to a flag: lower every member's record
 * budget to `memberLimit` via `setOverride`, until each window resets.
 *
 * The band policy is encoded here, not just documented: a
 * `graduated_only` snapshot (low tiling - the profile a legitimate
 * systematically-reviewing team measured) is REFUSED, because the only
 * measured occupant of that band is legitimate work. Budget cuts are
 * applied only to the `budget_cut_supported` herd partition profile.
 */
export function applyHerdLadder(
  budget: HerdBudgetLike,
  snapshot: HerdFlagSnapshot,
  options: { memberLimit: number },
): HerdLadderResult {
  if (snapshot.band !== "budget_cut_supported") {
    return { applied: false, reason: "graduated_only", identities: [] };
  }
  const memberLimit = Math.max(0, Math.floor(options.memberLimit) || 0);
  for (const member of snapshot.members) budget.setOverride(member, memberLimit);
  return { applied: true, identities: [...snapshot.members], memberLimit };
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

/**
 * Largest |ms| value a `Date` can represent (ECMA-262 TimeClip range,
 * +/-8.64e15). An event `ts` outside it makes `new Date(ts).toISOString()`
 * throw a bare RangeError (F-21) and poisons every window comparison it
 * touches, so observe() refuses such events before any state is read.
 */
const MAX_DATE_MS = 8_640_000_000_000_000;

const MIN_MS = 60_000;
const DEFAULT_CHAINING_WINDOW_MS = 120 * MIN_MS;
const DEFAULT_COACTIVITY_WINDOW_MS = 15 * MIN_MS;
const DEFAULT_COACT_LINK_MS = 60 * MIN_MS;
const DEFAULT_ACTIVITY_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** Hash-space blocks for the pair pre-filter bitmap: 1024 blocks = 16 BigUint64 words = 128 bytes per identity. */
const BITMAP_BLOCKS = 1024;
const BITMAP_WORDS = BITMAP_BLOCKS / 64;

/**
 * FNV-1a 64-bit over UTF-16 code units, rendered as 16 hex chars - the
 * same storage-key scheme as `createRecordBudget`, so a hostile 64KB id
 * costs the store 16 chars (a 64-bit collision would merge two ids; a
 * negligible, accepted trade-off).
 */
const hashRecordKey = (id: string): string => {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < id.length; i++) {
    h ^= BigInt(id.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
};

const blockOfKey = (key: string): number => Number.parseInt(key.slice(0, 4), 16) % BITMAP_BLOCKS;

/** Lab cluster step table over signup span (minutes); part of the validated configuration. */
const clusterOfSpan = (spanMin: number): number =>
  spanMin <= 5 ? 1.0 : spanMin <= 15 ? 0.85 : spanMin <= 30 ? 0.7 : spanMin <= 60 ? 0.55 : spanMin <= 120 ? 0.4 : 0;

interface IdentityState {
  identity: string;
  signupTs?: number;
  ip?: string;
  budgetLimit?: number;
  /** Stored record keys (FNV-1a hex), capped at maxStoredKeysPerIdentity. */
  keys: Set<string>;
  /** Distinct increments past the storage cap (unretained ids cannot be de-duplicated on re-delivery). */
  overflowDistinct: number;
  /** Ordinal positions for stored ids that have one (contiguity input). */
  indices: Set<number>;
  largestRun: number;
  /** Hash-space block bitmap over `keys`, for the pair pre-filter. */
  bitmap: BigUint64Array;
  /** Stored-set size at this identity's last leader scan (grouping v2 throttle). */
  lastLeaderScanSize: number;
  lastActive: number;
  /** Monotonic twin of `lastActive` (L-DEEP-2): activity comparisons read this clock. */
  lastActiveMono: number;
  ipGroupId?: number;
  cohortGroupId?: number;
}

interface ChainedGroup {
  id: number;
  kind: "ip" | "cohort";
  key: string;
  members: Set<string>;
  /** Stored-key refcount over the union of member sets. */
  combined: Map<string, number>;
  sumSizes: number;
  flagged: boolean;
  /** Per-member unique coverage at its last flag announcement (see the header's re-announcement paragraph). */
  announcedUnique: Map<string, number>;
  /** Timestamp of the group's last flag emission (initial or supplementary); drives the supplementary coalescing cooldown. */
  lastFlagAt: number;
  /** Monotonic twin of `lastFlagAt` (L-DEEP-2). */
  lastFlagAtMono: number;
  lastActivity: number;
  /** Monotonic twin of `lastActivity` (L-DEEP-2). */
  lastActivityMono: number;
  lastScore: number;
  maxScore: number;
  lastFeatures?: HerdFeatures;
}

interface CoverageGroup {
  id: number;
  members: Set<string>;
  combined: Map<string, number>;
  /** OR of member block bitmaps: the leader aggregate's pre-filter sketch. */
  bitmap: BigUint64Array;
  sumSizes: number;
  flagged: boolean;
  /** Per-member unique coverage at its last flag announcement (see the header's re-announcement paragraph). */
  announcedUnique: Map<string, number>;
  /** Timestamp of the group's last flag emission (initial or supplementary); drives the supplementary coalescing cooldown. */
  lastFlagAt: number;
  /** Monotonic twin of `lastFlagAt` (L-DEEP-2). */
  lastFlagAtMono: number;
  lastActivity: number;
  /** Monotonic twin of `lastActivity` (L-DEEP-2). */
  lastActivityMono: number;
  lastScore: number;
  maxScore: number;
  lastFeatures?: HerdFeatures;
}

export function createHerdDetector(options: HerdDetectorOptions = {}): HerdDetector {
  const weights: HerdWeights = { ...DEFAULT_HERD_WEIGHTS, ...(options.weights ?? {}) };
  const combinedFloor = Math.max(0, Math.floor(options.combinedCoverageFloor ?? 300) || 0);
  const flagThreshold = options.flagThreshold ?? 60;
  const flagMinMembers = Math.max(1, Math.floor(options.flagMinMembers ?? 3) || 3);
  const rampDenominator = Math.max(1, options.coverageRampDenominator ?? 4000);
  const defaultRecordCap = Math.max(1, options.defaultRecordCap ?? 2000);
  const chainingWindowMs = Math.max(0, options.chainingWindowMs ?? DEFAULT_CHAINING_WINDOW_MS);
  const coActivityWindowMs = Math.max(0, options.coActivityWindowMs ?? DEFAULT_COACTIVITY_WINDOW_MS);
  const coactLinkMs = Math.max(0, options.coactLinkMs ?? DEFAULT_COACT_LINK_MS);
  const activityWindowMs = Math.max(1, options.activityWindowMs ?? DEFAULT_ACTIVITY_WINDOW_MS);
  const linkOverlapCeiling = options.linkOverlapCeiling ?? 0.1;
  const unionFloor = Math.max(0, Math.floor(options.unionFloor ?? 300) || 0);
  const minOwnRecords = Math.max(0, Math.floor(options.minOwnRecords ?? 50) || 0);
  const recheckGrowth = Math.max(1, Math.floor(options.recheckGrowth ?? 25) || 25);
  const tilingCutThreshold = options.tilingCutThreshold ?? 0.5;
  const maxIdentities = Math.max(10, Math.floor(options.maxIdentities ?? 2000) || 2000);
  const maxStoredKeys = Math.max(16, Math.floor(options.maxStoredKeysPerIdentity ?? 4096) || 4096);
  /** Materiality floor for supplementary re-announcement (1/12 of the flag floor by default). */
  const lateJoinMaterial = Math.max(
    1,
    Math.floor(options.lateJoinerMinUniqueRecords ?? Math.ceil(Math.max(1, combinedFloor) / 12)) || 1,
  );
  /**
   * Coalescing window for supplementary re-announcements: members who
   * cross the materiality floor in a burst (a rotation herd's walkers
   * typically cross within milliseconds of each other) are announced
   * TOGETHER by the first supplementary flag after the window, not by
   * one flag per member. Members crossing during the window stay
   * pending and are picked up by the next supplementary - the delay
   * is bounded by this window, never a loss.
   */
  const supplementaryCooldownMs = Math.max(0, options.supplementaryCooldownMs ?? 5_000);
  const clock = options.now ?? (() => Date.now());
  const monoClock = options.monoNow ?? (options.now ? clock : monoNowMs);

  const identities = new Map<string, IdentityState>();
  const chainedGroups = new Map<number, ChainedGroup>();
  /** Union-find parent pointers for grouping v2. */
  const parent = new Map<string, string>();
  /** Coverage aggregates keyed by union-find ROOT identity. */
  const coverageGroups = new Map<string, CoverageGroup>();
  let groupSeq = 0;

  const distinctOf = (st: IdentityState): number => st.keys.size + st.overflowDistinct;

  const limitOf = (st: IdentityState): number => {
    if (st.budgetLimit !== undefined && st.budgetLimit > 0) return st.budgetLimit;
    // F-20: a throwing host callback must never escape observe() (the
    // sibling discipline: onFlag / isProtected-style predicates are all
    // swallowed). A failed lookup is treated as no host limit.
    try {
      const fromHost = options.getLimit?.(st.identity);
      if (fromHost !== undefined && fromHost > 0) return fromHost;
    } catch {
      /* fall through to the default cap */
    }
    return defaultRecordCap;
  };

  /** F-20: `recordIndex` is a host callback; a throw is treated as "no index for this id". */
  const safeRecordIndex = (id: string): number | undefined => {
    try {
      return options.recordIndex?.(id);
    } catch {
      return undefined;
    }
  };

  const recomputeLargestRun = (st: IdentityState): void => {
    if (st.indices.size === 0) {
      st.largestRun = 0;
      return;
    }
    const arr = [...st.indices].sort((a, b) => a - b);
    let best = 1;
    let cur = 1;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === (arr[i - 1] as number) + 1) {
        cur++;
        if (cur > best) best = cur;
      } else {
        cur = 1;
      }
    }
    st.largestRun = best;
  };

  /* ------------------------- feature computation ------------------------- */

  const computeFeatures = (
    members: readonly string[],
    combined: number,
    sumSizes: number,
    now: number,
    nowMono: number,
    includeCluster: boolean,
  ): HerdFeatures => {
    const n = members.length;
    let minSignup = Infinity;
    let maxSignup = -Infinity;
    let contSum = 0;
    let coActive = 0;
    let capCount = 0;
    for (const member of members) {
      const st = identities.get(member);
      if (!st) continue;
      if (st.signupTs !== undefined) {
        if (st.signupTs < minSignup) minSignup = st.signupTs;
        if (st.signupTs > maxSignup) maxSignup = st.signupTs;
      }
      contSum += st.keys.size > 0 ? st.largestRun / st.keys.size : 0;
      if (nowMono - st.lastActiveMono <= coActivityWindowMs) coActive++;
      if (distinctOf(st) >= 0.9 * limitOf(st)) capCount++;
    }
    const spanMin = maxSignup >= minSignup ? (maxSignup - minSignup) / MIN_MS : 0;
    const overlapRatio = (sumSizes - combined) / Math.max(1, sumSizes);
    const contiguity = n > 0 ? contSum / n : 0;
    return {
      cluster: includeCluster ? clusterOfSpan(spanMin) : null,
      coverageRamp: Math.min(1, combined / rampDenominator),
      tiling: 1 - Math.min(1, overlapRatio * 3),
      contiguity,
      // Union growth: of everything the group was served, the share
      // that actually grew the union - discounted by contiguity,
      // which already credits the contiguous share of that growth.
      unionGrowth: (combined / Math.max(1, sumSizes)) * (1 - contiguity),
      coActivity: n > 0 ? coActive / n : 0,
      capPressure: n > 0 ? capCount / n : 0,
    };
  };

  const scoreOf = (features: HerdFeatures, includeCluster: boolean): number =>
    100 *
    (weights.coverageRamp * features.coverageRamp +
      weights.tiling * features.tiling +
      weights.contiguity * features.contiguity +
      weights.unionGrowth * features.unionGrowth +
      weights.coActivity * features.coActivity +
      weights.capPressure * features.capPressure +
      (includeCluster && features.cluster !== null ? weights.cluster * features.cluster : 0));

  /** Distinct records only this member serves inside the group's combined refcount map. */
  const uniqueOf = (member: string, combinedMap: Map<string, number>): number => {
    const st = identities.get(member);
    if (!st) return 0;
    let unique = 0;
    for (const key of st.keys) if (combinedMap.get(key) === 1) unique++;
    return unique;
  };

  const emitFlag = (
    mechanism: "v1-ip" | "v2-coverage",
    groupId: number,
    members: string[],
    combined: number,
    score: number,
    features: HerdFeatures,
    now: number,
    combinedMap: Map<string, number>,
    supplementary = false,
  ): HerdFlagSnapshot => {
    const memberCoverage: Record<string, number> = {};
    const memberUniqueCoverage: Record<string, number> = {};
    for (const member of members) {
      const st = identities.get(member);
      if (!st) {
        memberCoverage[member] = 0;
        memberUniqueCoverage[member] = 0;
        continue;
      }
      memberCoverage[member] = st.keys.size;
      memberUniqueCoverage[member] = uniqueOf(member, combinedMap);
    }
    const snapshot: HerdFlagSnapshot = {
      groupId,
      mechanism,
      members: [...members],
      memberCoverage,
      memberUniqueCoverage,
      combinedCoverage: combined,
      score,
      features,
      band: features.tiling >= tilingCutThreshold ? "budget_cut_supported" : "graduated_only",
      ...(supplementary ? { supplementary: true } : {}),
      timestamp: new Date(now).toISOString(),
    };
    if (options.onFlag) {
      try {
        const result = options.onFlag(snapshot);
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        /* Operator wiring must never break request handling. */
      }
    }
    return snapshot;
  };

  /** A member's announcement state is SETTLED when it needs no re-announcement. */
  const announcementSettled = (announcedAt: number | undefined): boolean =>
    announcedAt !== undefined && (announcedAt === 0 || announcedAt >= lateJoinMaterial);

  /**
   * Record a flag emission on the group: each announced member's
   * unique coverage AT THIS SNAPSHOT is remembered. A member is then
   * in one of three states - settled-material (announced at or above
   * the floor), settled-inactive (announced at exactly 0: it was in
   * the snapshot the host received, and the once-per-window
   * discipline covers it), or PENDING (announced with partial unique
   * coverage, 0 < u < floor: the classic ID-walk shape, whose first
   * flag targeted nobody because every member sat below the friction
   * floor). Only pending members and never-announced members can
   * trigger a supplementary flag.
   */
  const markAnnounced = (
    group: { announcedUnique: Map<string, number> },
    snapshot: HerdFlagSnapshot,
  ): void => {
    for (const member of snapshot.members) {
      if (announcementSettled(group.announcedUnique.get(member))) continue;
      group.announcedUnique.set(member, snapshot.memberUniqueCoverage[member] ?? 0);
    }
  };

  /**
   * Supplementary re-announcement for a flagged group: emit a new
   * flag iff at least one member has reached the materiality floor
   * while not settled - a late joiner (never announced) or a pending
   * partial contributor. Settled-inactive members (announced at 0)
   * never trigger one: they were named in the flag snapshot itself,
   * and re-firing for them would break the once-per-window contract
   * every quiet group relies on. The gates are re-checked against
   * the group's CURRENT score/coverage, so a group that no longer
   * qualifies emits nothing.
   */
  const maybeSupplementary = (
    mechanism: "v1-ip" | "v2-coverage",
    group: {
      id: number;
      members: Set<string>;
      combined: Map<string, number>;
      flagged: boolean;
      announcedUnique: Map<string, number>;
      lastFlagAt: number;
      lastFlagAtMono: number;
    },
    combined: number,
    score: number,
    features: HerdFeatures,
    now: number,
    nowMono: number,
  ): HerdFlagSnapshot | undefined => {
    if (!group.flagged) return undefined;
    if (nowMono - group.lastFlagAtMono < supplementaryCooldownMs) return undefined;
    if (group.members.size < flagMinMembers || combined < combinedFloor || score < flagThreshold) {
      return undefined;
    }
    let hasNewMaterial = false;
    for (const member of group.members) {
      if (announcementSettled(group.announcedUnique.get(member))) continue;
      if (uniqueOf(member, group.combined) >= lateJoinMaterial) {
        hasNewMaterial = true;
        break;
      }
    }
    if (!hasNewMaterial) return undefined;
    const snapshot = emitFlag(
      mechanism,
      group.id,
      [...group.members],
      combined,
      score,
      features,
      now,
      group.combined,
      true,
    );
    group.lastFlagAt = now;
    group.lastFlagAtMono = nowMono;
    markAnnounced(group, snapshot);
    return snapshot;
  };

  /* ------------------------- grouping v1: chaining ------------------------ */

  const foldIntoChained = (group: ChainedGroup, st: IdentityState, keys: Iterable<string>): void => {
    for (const key of keys) {
      group.combined.set(key, (group.combined.get(key) ?? 0) + 1);
      group.sumSizes++;
    }
  };

  const chainInto = (
    kind: "ip" | "cohort",
    key: string,
    st: IdentityState,
    signupTs: number,
    signupMono: number,
  ): ChainedGroup => {
    const existingId = kind === "ip" ? st.ipGroupId : st.cohortGroupId;
    if (existingId !== undefined) {
      const existing = chainedGroups.get(existingId);
      if (existing) return existing;
    }
    let target: ChainedGroup | undefined;
    for (const group of chainedGroups.values()) {
      if (group.kind !== kind || group.key !== key) continue;
      for (const member of group.members) {
        const memberState = identities.get(member);
        if (memberState?.signupTs !== undefined && Math.abs(memberState.signupTs - signupTs) <= chainingWindowMs) {
          target = group;
          break;
        }
      }
      if (target) break;
    }
    if (!target) {
      target = {
        id: ++groupSeq,
        kind,
        key,
        members: new Set<string>(),
        combined: new Map<string, number>(),
        sumSizes: 0,
        flagged: false,
        announcedUnique: new Map<string, number>(),
        lastFlagAt: 0,
        lastFlagAtMono: 0,
        lastActivity: signupTs,
        lastActivityMono: signupMono,
        lastScore: 0,
        maxScore: 0,
      };
      chainedGroups.set(target.id, target);
    }
    if (!target.members.has(st.identity)) {
      target.members.add(st.identity);
      // Fold any records served before the group formed (usually none at signup).
      foldIntoChained(target, st, st.keys);
    }
    if (kind === "ip") st.ipGroupId = target.id;
    else st.cohortGroupId = target.id;
    return target;
  };

  /* --------------------- grouping v2: coverage complement ------------------ */

  const findRoot = (identity: string): string => {
    let root = identity;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cursor = identity;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  const ensureCoverageNode = (st: IdentityState): string => {
    if (parent.has(st.identity)) return findRoot(st.identity);
    parent.set(st.identity, st.identity);
    const group: CoverageGroup = {
      id: ++groupSeq,
      members: new Set<string>([st.identity]),
      combined: new Map<string, number>(),
      bitmap: new BigUint64Array(st.bitmap),
      sumSizes: 0,
      flagged: false,
      announcedUnique: new Map<string, number>(),
      lastFlagAt: 0,
      lastFlagAtMono: 0,
      lastActivity: st.lastActive,
      lastActivityMono: st.lastActiveMono,
      lastScore: 0,
      maxScore: 0,
    };
    // Seed with the identity's full stored set (which already includes the current event's records).
    for (const key of st.keys) group.combined.set(key, 1);
    group.sumSizes = st.keys.size;
    coverageGroups.set(st.identity, group);
    return st.identity;
  };

  const mergeCoverage = (rootA: string, rootB: string): string => {
    if (rootA === rootB) return rootA;
    const a = coverageGroups.get(rootA) as CoverageGroup;
    const b = coverageGroups.get(rootB) as CoverageGroup;
    const [big, small, bigRoot, smallRoot] = a.members.size >= b.members.size ? [a, b, rootA, rootB] : [b, a, rootB, rootA];
    for (const member of small.members) big.members.add(member);
    big.sumSizes += small.sumSizes;
    for (const [key, count] of small.combined) big.combined.set(key, (big.combined.get(key) ?? 0) + count);
    for (let i = 0; i < BITMAP_WORDS; i++) {
      big.bitmap[i] = (big.bitmap[i] as bigint) | (small.bitmap[i] as bigint);
    }
    for (const [member, announcedAt] of small.announcedUnique) {
      if (!announcementSettled(big.announcedUnique.get(member)) || !big.announcedUnique.has(member)) {
        big.announcedUnique.set(member, announcedAt);
      }
    }
    if (small.lastActivity > big.lastActivity) {
      big.lastActivity = small.lastActivity;
      big.lastActivityMono = small.lastActivityMono;
    }
    if (small.lastFlagAt > big.lastFlagAt) {
      big.lastFlagAt = small.lastFlagAt;
      big.lastFlagAtMono = small.lastFlagAtMono;
    }
    if (small.maxScore > big.maxScore) big.maxScore = small.maxScore;
    if (small.flagged && !big.flagged) {
      big.flagged = true;
    }
    parent.set(smallRoot, bigRoot);
    coverageGroups.delete(smallRoot);
    return bigRoot;
  };

  const sharedBlocks = (a: BigUint64Array, b: BigUint64Array): number => {
    let shared = 0;
    for (let i = 0; i < BITMAP_WORDS; i++) {
      if (((a[i] as bigint) & (b[i] as bigint)) !== 0n) shared++;
    }
    return shared;
  };

  /* ------------------------------ eviction -------------------------------- */

  const rebuildChained = (group: ChainedGroup): void => {
    group.combined.clear();
    group.sumSizes = 0;
    for (const member of group.members) {
      const st = identities.get(member);
      if (st) foldIntoChained(group, st, st.keys);
    }
  };

  const rebuildCoverage = (root: string): void => {
    const group = coverageGroups.get(root);
    if (!group) return;
    group.combined.clear();
    group.bitmap = new BigUint64Array(BITMAP_WORDS);
    group.sumSizes = 0;
    for (const member of group.members) {
      const st = identities.get(member);
      if (!st) continue;
      group.sumSizes += st.keys.size;
      for (let i = 0; i < BITMAP_WORDS; i++) {
        group.bitmap[i] = (group.bitmap[i] as bigint) | (st.bitmap[i] as bigint);
      }
      for (const key of st.keys) group.combined.set(key, (group.combined.get(key) ?? 0) + 1);
    }
  };

  const removeIdentity = (identity: string): void => {
    const st = identities.get(identity);
    if (!st) return;
    for (const groupId of [st.ipGroupId, st.cohortGroupId]) {
      if (groupId === undefined) continue;
      const group = chainedGroups.get(groupId);
      if (group && group.members.delete(identity)) {
        group.announcedUnique.delete(identity);
        if (group.members.size === 0) chainedGroups.delete(groupId);
        else rebuildChained(group);
      }
    }
    if (parent.has(identity)) {
      const root = findRoot(identity);
      const group = coverageGroups.get(root);
      if (group && group.members.delete(identity)) {
        group.announcedUnique.delete(identity);
        if (group.members.size === 0) {
          coverageGroups.delete(root);
        } else {
          if (root === identity) {
            // Promote another member to root and re-key the aggregate.
            const newRoot = group.members.values().next().value as string;
            for (const member of group.members) parent.set(member, newRoot);
            coverageGroups.delete(root);
            coverageGroups.set(newRoot, group);
            rebuildCoverage(newRoot);
          } else {
            rebuildCoverage(root);
          }
        }
      }
      parent.delete(identity);
    }
    identities.delete(identity);
  };

  const stateFor = (identity: string, now: number, nowMono: number): IdentityState => {
    let st = identities.get(identity);
    if (st) {
      // Refresh LRU position.
      identities.delete(identity);
      identities.set(identity, st);
      return st;
    }
    if (identities.size >= maxIdentities) {
      const oldest = identities.keys().next().value;
      if (oldest !== undefined && oldest !== identity) removeIdentity(oldest);
    }
    st = {
      identity,
      keys: new Set<string>(),
      overflowDistinct: 0,
      indices: new Set<number>(),
      largestRun: 0,
      bitmap: new BigUint64Array(BITMAP_WORDS),
      lastLeaderScanSize: 0,
      lastActive: now,
      lastActiveMono: nowMono,
    };
    identities.set(identity, st);
    return st;
  };

  /* ------------------------------- observe -------------------------------- */

  const observe = (event: HerdEvent): HerdObservation => {
    if (!event || typeof event.identity !== "string" || event.identity.length === 0) {
      return { recorded: false };
    }
    /*
     * Input discipline (F-21, same family as the CUSUM F-16 validation):
     * a present-but-unusable `ts` - not a number, non-finite, or outside
     * the representable Date range (|ts| > 8.64e15) - refuses the event
     * as a structured no-op BEFORE any state is touched (not even an
     * identity creation or an LRU eviction). Before this check, a finite
     * but out-of-range ts (e.g. 1e16) sailed through the finite check,
     * was latched as the group's flag time, and then made emitFlag's
     * `new Date(now).toISOString()` throw a bare RangeError out of
     * observe() - losing the very flag that event carried, permanently
     * (the latch stayed set, the supplementary cooldown compared
     * against the poisoned flag time and never opened again).
     */
    if (
      event.ts !== undefined &&
      (typeof event.ts !== "number" || !Number.isFinite(event.ts) || Math.abs(event.ts) > MAX_DATE_MS)
    ) {
      return { recorded: false };
    }
    const hasTs = typeof event.ts === "number" && Number.isFinite(event.ts);
    const now = hasTs ? (event.ts as number) : clock();
    // Host-ts events stay in the host's time domain (twin mirrors ts);
    // internal-clock events stamp the monotonic twin (L-DEEP-2).
    const nowMono = hasTs ? now : monoClock();
    const st = stateFor(event.identity, now, nowMono);
    if (event.ip && !st.ip) st.ip = event.ip;
    if (typeof event.budgetLimit === "number" && event.budgetLimit > 0) st.budgetLimit = event.budgetLimit;
    st.lastActive = now;
    st.lastActiveMono = nowMono;

    if (event.type === "signup") {
      st.signupTs = now;
      st.ip = event.ip ?? st.ip;
      // Grouping v1 forms on signup only (lab parity). A duplicate signup
      // for an already-grouped identity does not re-chain it; the lab
      // never exercised duplicate signups.
      chainInto("ip", st.ip ?? "unknown", st, now, nowMono);
      chainInto("cohort", "ALL", st, now, nowMono);
      return { recorded: true };
    }

    let flag: HerdFlagSnapshot | undefined;

    // Fold this event's newly served records into the identity and its v1 groups.
    const newKeys: string[] = [];
    const ids = event.recordIds ?? [];
    if (ids.length > 0 && (event.status === undefined || event.status === 200)) {
      let runDirty = false;
      for (const id of ids) {
        if (typeof id !== "string" || id.length === 0) continue;
        const key = hashRecordKey(id);
        if (st.keys.has(key)) continue;
        if (st.keys.size >= maxStoredKeys) {
          // Past the storage cap the id is not retained: it still counts
          // toward the identity's distinct total (and cannot be
          // de-duplicated on re-delivery), but it enters no group aggregate.
          st.overflowDistinct++;
          continue;
        }
        st.keys.add(key);
        newKeys.push(key);
        const block = blockOfKey(key);
        st.bitmap[block >> 6] = (st.bitmap[block >> 6] as bigint) | (1n << BigInt(block & 63));
        const index = safeRecordIndex(id);
        if (typeof index === "number" && Number.isFinite(index)) {
          if (!st.indices.has(index)) {
            st.indices.add(index);
            runDirty = true;
          }
        }
      }
      if (runDirty) recomputeLargestRun(st);
      if (newKeys.length > 0) {
        for (const groupId of [st.ipGroupId, st.cohortGroupId]) {
          if (groupId === undefined) continue;
          const group = chainedGroups.get(groupId);
          if (group) foldIntoChained(group, st, newKeys);
        }
      }
    }

    // Score grouping v1 (per-IP flags; the cohort view is diagnostic only).
    for (const groupId of [st.ipGroupId, st.cohortGroupId]) {
      if (groupId === undefined) continue;
      const group = chainedGroups.get(groupId);
      if (!group) continue;
      if (group.flagged && nowMono - group.lastActivityMono > activityWindowMs) {
        group.flagged = false; // new window: re-arm
        group.announcedUnique.clear();
        group.lastFlagAt = 0;
        group.lastFlagAtMono = 0;
      }
      group.lastActivity = now;
      group.lastActivityMono = nowMono;
      const members = [...group.members];
      const features = computeFeatures(members, group.combined.size, group.sumSizes, now, nowMono, true);
      const score = scoreOf(features, true);
      group.lastScore = score;
      group.lastFeatures = features;
      if (score > group.maxScore) group.maxScore = score;
      if (
        group.kind === "ip" &&
        !group.flagged &&
        members.length >= flagMinMembers &&
        group.combined.size >= combinedFloor &&
        score >= flagThreshold
      ) {
        group.flagged = true;
        group.lastFlagAt = now;
        group.lastFlagAtMono = nowMono;
        const snapshot = emitFlag("v1-ip", group.id, members, group.combined.size, score, features, now, group.combined);
        markAnnounced(group, snapshot);
        if (!flag) flag = snapshot;
      } else if (group.kind === "ip" && group.flagged) {
        const supplementary = maybeSupplementary("v1-ip", group, group.combined.size, score, features, now, nowMono);
        if (supplementary && !flag) flag = supplementary;
      }
    }

    // Grouping v2: fold, leader scan, score the coverage group.
    const freshNode = !parent.has(st.identity);
    const root0 = ensureCoverageNode(st);
    const agg0 = coverageGroups.get(root0) as CoverageGroup;
    if (!freshNode && newKeys.length > 0) {
      agg0.sumSizes += newKeys.length;
      for (const key of newKeys) {
        agg0.combined.set(key, (agg0.combined.get(key) ?? 0) + 1);
        const block = blockOfKey(key);
        agg0.bitmap[block >> 6] = (agg0.bitmap[block >> 6] as bigint) | (1n << BigInt(block & 63));
      }
    }
    /*
     * Leader scan (2.5.0): this identity's coverage group is compared
     * against the other coverage GROUPS' aggregates, not against
     * every other identity. The scan is throttled per identity - it
     * runs only once the identity's stored set has grown by
     * `recheckGrowth` since its last scan (or on its first eligible
     * event) - and each candidate group is pre-filtered by its
     * aggregate bitmap: groups sharing no hash block with this group
     * have an exact intersection of zero by construction. The merge
     * test itself is the lab's complementarity test applied to the
     * two aggregates (both sides past `minOwnRecords` combined,
     * union past `unionFloor`, Jaccard at most `linkOverlapCeiling`,
     * other group co-active inside `coactLinkMs`); for two singleton
     * groups it is exactly the old pairwise test.
     */
    const scanDue =
      agg0.combined.size >= minOwnRecords &&
      (st.lastLeaderScanSize === 0 || st.keys.size - st.lastLeaderScanSize >= recheckGrowth);
    if (scanDue) {
      st.lastLeaderScanSize = st.keys.size;
      for (const otherRoot of [...coverageGroups.keys()]) {
        const ownRoot = findRoot(st.identity);
        if (otherRoot === ownRoot) continue;
        const other = coverageGroups.get(otherRoot);
        if (!other) continue; // merged away during this scan
        if (other.combined.size < minOwnRecords) continue;
        if (nowMono - other.lastActivityMono > activityWindowMs) continue;
        if (nowMono - other.lastActivityMono > coactLinkMs) continue;
        const own = coverageGroups.get(ownRoot) as CoverageGroup;
        if (own.combined.size < minOwnRecords) continue;
        let inter: number;
        if (sharedBlocks(own.bitmap, other.bitmap) === 0) {
          inter = 0;
        } else {
          const [small, big] =
            own.combined.size <= other.combined.size
              ? [own.combined, other.combined]
              : [other.combined, own.combined];
          inter = 0;
          for (const key of small.keys()) if (big.has(key)) inter++;
        }
        const union = own.combined.size + other.combined.size - inter;
        if (union >= unionFloor && inter / Math.max(1, union) <= linkOverlapCeiling) {
          mergeCoverage(ownRoot, otherRoot);
        }
      }
    }
    const root = findRoot(st.identity);
    const agg = coverageGroups.get(root) as CoverageGroup;
    if (agg.flagged && nowMono - agg.lastActivityMono > activityWindowMs) {
      agg.flagged = false; // new window: re-arm
      agg.announcedUnique.clear();
      agg.lastFlagAt = 0;
      agg.lastFlagAtMono = 0;
    }
    agg.lastActivity = now;
    agg.lastActivityMono = nowMono;
    const v2Members = [...agg.members];
    const v2Features = computeFeatures(v2Members, agg.combined.size, agg.sumSizes, now, nowMono, false);
    const v2Score = scoreOf(v2Features, false);
    agg.lastScore = v2Score;
    agg.lastFeatures = v2Features;
    if (v2Score > agg.maxScore) agg.maxScore = v2Score;
    if (!agg.flagged && v2Members.length >= flagMinMembers && agg.combined.size >= combinedFloor && v2Score >= flagThreshold) {
      agg.flagged = true;
      agg.lastFlagAt = now;
      agg.lastFlagAtMono = nowMono;
      const snapshot = emitFlag("v2-coverage", agg.id, v2Members, agg.combined.size, v2Score, v2Features, now, agg.combined);
      markAnnounced(agg, snapshot);
      if (!flag) flag = snapshot;
    } else if (agg.flagged) {
      const supplementary = maybeSupplementary("v2-coverage", agg, agg.combined.size, v2Score, v2Features, now, nowMono);
      if (supplementary && !flag) flag = supplementary;
    }

    return flag ? { recorded: true, flag } : { recorded: true };
  };

  const groups = (): HerdGroupInfo[] => {
    const out: HerdGroupInfo[] = [];
    for (const group of chainedGroups.values()) {
      out.push({
        groupId: group.id,
        mechanism: group.kind === "ip" ? "v1-ip" : "v1-cohort",
        members: [...group.members],
        combinedCoverage: group.combined.size,
        score: group.lastScore,
        maxScore: group.maxScore,
        ...(group.lastFeatures ? { features: group.lastFeatures } : {}),
        flagged: group.flagged,
      });
    }
    for (const group of coverageGroups.values()) {
      out.push({
        groupId: group.id,
        mechanism: "v2-coverage",
        members: [...group.members],
        combinedCoverage: group.combined.size,
        score: group.lastScore,
        maxScore: group.maxScore,
        ...(group.lastFeatures ? { features: group.lastFeatures } : {}),
        flagged: group.flagged,
      });
    }
    return out;
  };

  const reset = (identity?: string): void => {
    if (identity === undefined) {
      identities.clear();
      chainedGroups.clear();
      parent.clear();
      coverageGroups.clear();
      return;
    }
    removeIdentity(identity);
  };

  return { observe, groups, reset };
}
