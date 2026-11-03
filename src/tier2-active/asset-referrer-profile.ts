/**
 * Asset/referrer profile signal (HARVEST2 candidate C9, lab PASS as a
 * capped low-weight feature - see the study lab's C9-DESIGN.md and
 * C9-RESULTS.md under the antiRea research tree).
 *
 * WHAT IT MEASURES. Automated callers that do not run a real browser
 * render pipeline leave an extreme asset profile: they fetch almost
 * no subresources (published measurement: ~0.3 images/page against a
 * human ~22.4) and arrive with an empty referrer on almost every page
 * (~98.4% against a human ~5%). This module accumulates three
 * statistics over fixed-horizon windows of a browser-stratum
 * identity's pages - mean images/page, mean asset requests/page,
 * share of pages with an empty referrer - scores each window with
 * one-sided, ties-inclusive conformal p-values against a host-fitted
 * legitimate pool, and treats a window as violating only when the
 * conformal score crosses the fitted threshold AND the profile
 * simultaneously sits inside the bot-side separation gates (the
 * conjunctive rule the lab registered: the score alone flags ~1.23%
 * of legitimate streams at alpha 0.01; the gates are what carried
 * the lab's 0 false positives on 6,658 legitimate streams, 923
 * sale-week streams and 150 cohorts, all in simulation). A flag
 * additionally requires the violation to persist across two
 * consecutive windows - see POST-LAB TIGHTENING below.
 *
 * A cohort form pools the first pages across a host-declared cohort
 * (the 1-hit herd shape: no member ever reaches the identity
 * horizon, but the pooled profile is still extreme - the lab caught
 * it 3/3 seeds).
 *
 * HARD CONDITIONS - these are in the code, not just the docs:
 *
 * 1. DECLARED STRATIFICATION IS MANDATORY. The host must declare its
 *    client strata up front: exactly one browser stratum and at
 *    least one declared non-browser stratum (API clients, declared
 *    integrations). Only events carrying the declared browser
 *    stratum are ever scored. Events from a declared neutral
 *    stratum, an undeclared stratum, or with no stratum at all are
 *    never scored and never accumulated - an undeclared API client
 *    is indistinguishable from the naive bots this signal exists to
 *    catch (the lab measured 1,500/1,500 declared-API identities
 *    flagged when scored as browsers, 0 once stratified), so
 *    scoring without a declaration is a structural false-positive
 *    bug, not a configuration detail. If the host declares no
 *    stratification at all, the module is DISABLED: it records
 *    nothing, fits nothing, and every call returns an explicit
 *    disabled status.
 * 2. ADVISORY ONLY. The module emits signal objects
 *    (`enforcement: "none"`, the policy-signals precedent). It has
 *    no blocking decision, attaches no consequence, and a flag is
 *    investigation telemetry - never proof of automation and never
 *    sufficient evidence on its own for any consequence.
 * 3. OPT-IN. Nothing runs until the host constructs an instance and
 *    fits a calibration on its own legitimate traffic.
 *
 * POST-LAB TIGHTENING - two extra layers on top of the lab rule,
 * added after the lab verdict at the operator's request:
 *
 * A. GATE SAFETY MARGIN. The fitted gates are padded away from the
 *    legitimate region by `gateSafetyMargin` (default 0.25): the
 *    imgMean gate is scaled down by (1 - margin) and the refShare
 *    gate is moved the same fraction of its remaining headroom
 *    toward 1. Sizing rationale, from the lab's own diagnostics:
 *    the gates are computed from TRAIN extremes, and the observed
 *    out-of-sample drift of those extremes (TRAIN -> VALID on the
 *    calibration seed, diagnostics.json) was 5.7% on imgMean
 *    (min 16.24 -> 15.32) and nil on refShare (max 0.18 in both).
 *    A 25% pad is roughly 4x that observed drift, yet the padded
 *    gates still sit far from the published bot profile (on the
 *    lab fit: imgMean gate 1.66 against a bot mean of 0.3;
 *    refShare gate 0.69 against a bot share of 0.984), so the
 *    naive shapes the lab caught still clear them by a wide
 *    multiple. Honest scope: the pad is sized from that ONE
 *    observed drift - the lab probed TRAIN extremes on a single
 *    calibration seed - it is not a measured cross-seed
 *    distribution of extreme drift.
 * B. TWO-WINDOW PERSISTENCE. Pages are grouped into consecutive,
 *    non-overlapping windows of `horizonPages` pages (identity)
 *    or `cohortPages` pooled pages (cohort). A window that
 *    violates the conjunctive rule (score over threshold AND both
 *    padded gates) on its own only raises the signal level to
 *    "watch"; the level reaches "flag" only when TWO CONSECUTIVE
 *    windows both violate, and any clean window resets the level
 *    to "none". A one-off violation that returns to normal
 *    therefore never becomes a flag. The price, stated plainly:
 *    detection of a persistent naive profile is delayed by one
 *    extra horizon relative to the lab's single-window rule
 *    (+50 pages identity, +120 pooled pages cohort at the
 *    defaults), and a profile that violates for exactly one
 *    window and then goes clean is never flagged at all.
 *
 * KNOWN SLIP - measured, not hidden. An evader that loads the full
 * legitimate asset profile and chains referrers like a browser is
 * invisible to this signal (lab: 0/9 flagged, scores inside the
 * legitimate range). What it pays is a bandwidth tax: ~22.8x the
 * request volume of a naive bot in the lab measurement, ~1.03x the
 * cost of a genuine user - which is exactly why the lab capped this
 * candidate as a low-weight "bandwidth tax" feature and forbade
 * promoting it to a standalone detector. An evader that fakes only
 * ONE gated channel also escapes the flag rule (the score may still
 * cross; the part-wise score parts are reported so the host can see
 * what the gates held back).
 *
 * FP = 0 IS A LAB NUMBER. It was measured on a simulated population
 * whose legitimate generator always loads a full asset profile.
 * Real populations contain legitimate subpopulations that sit in
 * the bot corner - users who disable image loading, text browsers,
 * RSS/reader clients, privacy tooling that strips referrers,
 * undeclared legitimate HTTP clients. The harness does not generate
 * them, so their rate is UNMEASURED; that is precisely why
 * condition 1 is a hard condition and why this module self-disables
 * without it. Do not read the lab result as a real-world
 * false-positive guarantee.
 *
 * Pure computation: no I/O, no runtime dependencies. State is
 * bounded in-memory maps (fixed-horizon sums per identity, a capped
 * page buffer per cohort).
 */

/** The three profile statistics, in score order. */
const STAT_NAMES = ["imgMean", "astMean", "refShare"] as const;
type StatName = (typeof STAT_NAMES)[number];

const DISABLED_REASON = "stratification_not_declared";

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): an extreme asset/referrer profile match. " +
  "A flag is investigation telemetry, never proof of automation, and must never be " +
  "the sole evidence for any consequence. Levels: a first violating window is a watch; " +
  "only a second consecutive violating window is a flag.";

/** One page observation, as fed to calibration fitting. Mirrors the per-page fields of {@link AssetReferrerProfileEvent}. */
export interface AssetReferrerPageSample {
  /** Images loaded by this page view. */
  images: number;
  /** Total asset (subresource) requests for this page view, images included. */
  assets: number;
  /** Whether the page view arrived with an empty referrer. */
  referrerEmpty: boolean;
  /** Millisecond timestamp; used only to pool cohort pages chronologically. */
  ts?: number;
}

/** One page-view event on the host's serving path. */
export interface AssetReferrerProfileEvent extends AssetReferrerPageSample {
  /** The authenticated identity the page was served to. */
  identity: string;
  /**
   * The host's declared client stratum for this client, matched
   * against the instance's declared stratification. Only the
   * declared browser stratum is scored; a missing or undeclared
   * stratum is never scored.
   */
  clientType?: string;
  /**
   * Optional host-declared cohort the identity belongs to for this
   * page (a declared team, campaign or integration grouping). Only
   * browser-stratum pages are pooled into a cohort.
   */
  cohortId?: string;
}

/** The host's client-stratum declaration. Required for the module to be enabled at all. */
export interface AssetReferrerStratification {
  /** The stratum whose clients render pages in a real browser and are therefore scorable (e.g. `"browser"`). */
  browserStratum: string;
  /**
   * Declared non-browser strata (API clients, declared integrations,
   * partner feeds). Identities in these strata are NEVER scored.
   * Must name at least one stratum: a declaration with no
   * non-browser lane is vacuous and is rejected.
   */
  neutralStrata: string[];
}

export interface CreateAssetReferrerProfileOptions {
  /**
   * The host's client-stratum declaration. When omitted, the
   * instance is created DISABLED (it records nothing and every call
   * reports the disabled status) - see the module header, hard
   * condition 1. When present but malformed, construction throws.
   */
  stratification?: AssetReferrerStratification;
  /** Fixed identity horizon: pages accumulated per identity before it is scored. Defaults to 50 (the lab's H). */
  horizonPages?: number;
  /** Fixed cohort horizon: pages pooled across a cohort before it is scored. Defaults to 120 (the lab's COHORT_PAGES). */
  cohortPages?: number;
  /** Conformal level for the flag threshold. Defaults to 0.01 (the lab's alpha). */
  alpha?: number;
  /**
   * The published naive-bot profile the separation gates are placed
   * against: mean images/page and empty-referrer share. Defaults to
   * the published values the lab registered (0.3 images/page, 0.984
   * empty-referrer share).
   */
  botProfile?: {
    imagesMean?: number;
    emptyReferrerShare?: number;
  };
  /**
   * Safety pad applied to the fitted separation gates at fit time,
   * moving them away from the legitimate region: the imgMean gate
   * is multiplied by (1 - margin) and the refShare gate is moved
   * the same fraction of its remaining headroom toward 1. The
   * lab's registered formulas (C9-DESIGN 2.4) are recovered exactly
   * at margin 0. Defaults to 0.25 - see the module header for the
   * sizing rationale (roughly 4x the one TRAIN -> VALID extreme
   * drift the lab observed, while leaving the padded gates far
   * from the published bot profile).
   */
  gateSafetyMargin?: number;
  /** Minimum scorable legitimate streams a `fitCalibration` call must yield. Defaults to 50. */
  minTrainStreams?: number;
  /** Minimum scorable legitimate cohorts a `fitCohortCalibration` call must yield. Defaults to 30. */
  minTrainCohorts?: number;
  /** Maximum identities tracked at once (least-recently-seen evicted). Defaults to 10,000. */
  maxIdentities?: number;
  /** Maximum cohorts tracked at once (least-recently-seen evicted). Defaults to 2,000. */
  maxCohorts?: number;
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface AssetProfileObservation {
  /**
   * `"recorded"` - browser-stratum page accepted; `"neutral_stratum"` /
   * `"undeclared_stratum"` / `"unstratified"` - page not scored and
   * not accumulated, for the named reason; `"disabled"` - the module
   * is disabled (no stratification declared).
   */
  status: "recorded" | "neutral_stratum" | "undeclared_stratum" | "unstratified" | "disabled";
  /** Present when `status` is `"disabled"`: the named reason the module is off. */
  reason?: string;
  /** Whether this page counts toward scoring (browser stratum on an enabled instance). */
  scored: boolean;
  /** Whether this page entered the identity's currently open window (every recorded page does). */
  counted: boolean;
  /** Total pages recorded for the identity after this event (across all windows). */
  pages: number;
  /**
   * The identity signal, present exactly when this event closed a
   * window on a calibrated instance.
   */
  signal?: AssetReferrerProfileSignal;
}

export interface AssetProfileStats {
  imgMean: number;
  astMean: number;
  refShare: number;
  /** Pages the statistics were computed over (the fixed horizon). */
  pages: number;
}

export interface AssetReferrerProfileSignal {
  kind: "asset_referrer_profile";
  scope: "identity" | "cohort";
  identity?: string;
  cohortId?: string;
  /**
   * `"scored"` - at least one full window has closed and the level
   * fields are meaningful; `"insufficient_data"` - no window has
   * closed yet; `"uncalibrated"` - no calibration has been fitted
   * for this scope; `"disabled"` - the module is off. `flagged` is
   * false and `level` is `"none"` in every non-`"scored"` status.
   */
  status: "scored" | "insufficient_data" | "uncalibrated" | "disabled";
  /**
   * Persistence level (post-lab tightening B): `"none"` - the most
   * recent closed window was clean (or none has closed); `"watch"` -
   * the most recent closed window violated the conjunctive rule
   * but its predecessor did not; `"flag"` - two or more
   * consecutive closed windows violated. Only `"flag"` sets
   * `flagged`.
   */
  level: "none" | "watch" | "flag";
  /** Trailing run of consecutive violating closed windows (0 when the last window was clean). */
  consecutiveViolations: number;
  /** True exactly when `level` is `"flag"`: the violation persisted across two consecutive windows. */
  flagged: boolean;
  /** Whether the most recent closed window's conformal score alone crossed the fitted threshold (before the gates). */
  scorePass: boolean;
  /** Whether the most recent closed window passed both padded separation gates (before the score). */
  gateOk: boolean;
  /** The most recent closed window's summed one-sided conformal score S, or null when not scored. */
  score: number | null;
  /** Per-statistic -ln(p) contributions to S for the most recent closed window, or null when not scored. */
  parts: Record<StatName, number> | null;
  /** The three profile statistics of the most recent closed window, or null when not scored. */
  stats: AssetProfileStats | null;
  /** Total pages observed for this scope (all windows plus the open one). */
  pagesObserved: number;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface AssetReferrerFitResult {
  fitted: boolean;
  status: "fitted" | "disabled";
  scope: "identity" | "cohort";
  /** Legitimate streams/cohorts that reached the horizon and entered the pool. */
  streams: number;
  /** Samples skipped for not reaching the horizon. */
  skipped: number;
  /** The fitted conformal threshold h, or null when not fitted. */
  threshold: number | null;
  /** The fitted separation gates AFTER the safety-margin pad (the effective gates), or null when not fitted. */
  gates: { imgMeanMax: number; refShareMin: number } | null;
  /** The safety margin applied to the gates (the configured value; `gates` are null when not fitted). */
  gateSafetyMargin: number;
}

export interface AssetReferrerProfileSnapshot {
  enabled: boolean;
  /** `"stratification_not_declared"` when disabled, otherwise null. */
  disabledReason: string | null;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  calibrated: boolean;
  cohortCalibrated: boolean;
  horizonPages: number;
  cohortPages: number;
  alpha: number;
  /** The configured gate safety margin (post-lab tightening A). */
  gateSafetyMargin: number;
  browserStratum: string | null;
  neutralStrata: string[];
  identitiesTracked: number;
  cohortsTracked: number;
  counters: {
    /** Browser-stratum pages accepted for accumulation. */
    recorded: number;
    /** Pages from declared neutral strata (never scored). */
    neutral: number;
    /** Pages with no stratum declared (never scored). */
    unstratified: number;
    /** Pages naming a stratum the host never declared (never scored). */
    undeclaredStratum: number;
  };
  identityCalibration: { streams: number; threshold: number; gates: { imgMeanMax: number; refShareMin: number } } | null;
  cohortCalibration: { streams: number; threshold: number; gates: { imgMeanMax: number; refShareMin: number } } | null;
  notice: string;
}

export interface AssetReferrerProfile {
  /** Whether the module is on (a valid stratification was declared at construction). */
  readonly enabled: boolean;
  /** Feed one page-view event. See {@link AssetProfileObservation} for the outcome vocabulary. */
  observe(event: AssetReferrerProfileEvent): AssetProfileObservation;
  /**
   * Fit the identity calibration from the host's own legitimate
   * browser-stratum page streams (one inner array per identity, in
   * page order). Only streams reaching the horizon enter the pool.
   * Throws when fewer than `minTrainStreams` streams are scorable.
   */
  fitCalibration(samples: AssetReferrerPageSample[][]): AssetReferrerFitResult;
  /**
   * Fit the cohort calibration from legitimate cohorts (one entry
   * per cohort: one inner array per member, pages pooled
   * chronologically). Throws when fewer than `minTrainCohorts`
   * cohorts are scorable.
   */
  fitCohortCalibration(samples: AssetReferrerPageSample[][][]): AssetReferrerFitResult;
  /** Evaluate one tracked identity against the fitted identity calibration. */
  evaluateIdentity(identity: string): AssetReferrerProfileSignal;
  /** Evaluate one tracked cohort against the fitted cohort calibration. */
  evaluateCohort(cohortId: string): AssetReferrerProfileSignal;
  /** State and calibration summary. */
  snapshot(): AssetReferrerProfileSnapshot;
}

/** Named error thrown for every invalid asset-profile input. */
export class AssetReferrerProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetReferrerProfileError";
  }
}

const fail = (message: string): never => {
  throw new AssetReferrerProfileError(`createAssetReferrerProfile: ${message}`);
};

const hasControlOrNewline = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value);

function requireStratumName(value: unknown, field: string): string {
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

function requireShare(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${field} must be a finite number between 0 and 1`);
  }
  return value as number;
}

/* ---------------- fixed-horizon statistics ---------------- */

function prefixStats(pages: AssetReferrerPageSample[], n: number): AssetProfileStats | null {
  if (pages.length < n) return null;
  let img = 0;
  let ast = 0;
  let ref = 0;
  for (let i = 0; i < n; i++) {
    const e = pages[i]!;
    img += e.images;
    ast += e.assets;
    if (e.referrerEmpty) ref++;
  }
  return { imgMean: img / n, astMean: ast / n, refShare: ref / n, pages: n };
}

/** Pool member page lists chronologically and take the first `n` pages (the lab's cohort pooling). */
function cohortPrefixStats(members: AssetReferrerPageSample[][], n: number): AssetProfileStats | null {
  const all: AssetReferrerPageSample[] = [];
  for (const member of members) for (const page of member) all.push(page);
  if (all.length < n) return null;
  all.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return prefixStats(all, n);
}

/* ---------------- conformal machinery (the lab's, verbatim in form) ---------------- */

function countLE(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function countGE(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length - lo;
}

interface ConformalPools {
  sorted: Record<StatName, number[]>;
}

function buildPools(statsList: AssetProfileStats[]): ConformalPools {
  const sorted: Record<StatName, number[]> = { imgMean: [], astMean: [], refShare: [] };
  for (const s of statsList) for (const j of STAT_NAMES) sorted[j].push(s[j]);
  for (const j of STAT_NAMES) sorted[j].sort((a, b) => a - b);
  return { sorted };
}

/** One-sided conformal p, ties-inclusive; `ownValue` set scores a pool member leave-one-out. */
function oneSidedP(pools: ConformalPools, stat: StatName, x: number, ownValue: number | undefined): number {
  let n = pools.sorted[stat].length;
  let c = stat === "refShare" ? countGE(pools.sorted[stat], x) : countLE(pools.sorted[stat], x);
  if (ownValue !== undefined) {
    // Leave-one-out: the stream's own value sits in the pool once
    // and, being equal to x, is counted by both LE and GE.
    c -= 1;
    n -= 1;
  }
  return (1 + c) / (n + 1);
}

function scoreStats(
  pools: ConformalPools,
  stats: AssetProfileStats,
  ownStats: AssetProfileStats | undefined,
): { score: number; parts: Record<StatName, number> } {
  const parts: Record<StatName, number> = { imgMean: 0, astMean: 0, refShare: 0 };
  let score = 0;
  for (const j of STAT_NAMES) {
    const p = oneSidedP(pools, j, stats[j], ownStats ? ownStats[j] : undefined);
    parts[j] = -Math.log(p);
    score += parts[j];
  }
  return { score, parts };
}

function conformalThreshold(scores: number[], level: number): number {
  const sorted = [...scores].sort((a, b) => a - b);
  const n = sorted.length;
  let rank = Math.ceil((n + 1) * (1 - level));
  if (rank < 1) rank = 1;
  if (rank > n) rank = n;
  return sorted[rank - 1]!;
}

/* ---------------- fitted calibration ---------------- */

interface Calibration {
  pools: ConformalPools;
  threshold: number;
  gates: { imgMeanMax: number; refShareMin: number };
  streams: number;
}

function fitFromStats(
  statsList: AssetProfileStats[],
  alpha: number,
  botImagesMean: number,
  botRefShare: number,
  gateSafetyMargin: number,
): Calibration {
  const pools = buildPools(statsList);
  const looScores = statsList.map((s) => scoreStats(pools, s, s).score);
  const threshold = conformalThreshold(looScores, alpha);
  // The lab's registered gate formulas (C9-DESIGN 2.4): the gates sit
  // between the published bot profile and the TRAIN legit extremes.
  let minImg = Infinity;
  let maxRef = -Infinity;
  for (const s of statsList) {
    if (s.imgMean < minImg) minImg = s.imgMean;
    if (s.refShare > maxRef) maxRef = s.refShare;
  }
  const rawImgMeanMax = Math.sqrt(botImagesMean * minImg);
  const rawRefShareMin = (maxRef + botRefShare) / 2;
  // Post-lab tightening A: pad both gates away from the legitimate
  // region by the configured margin (see the module header for the
  // sizing rationale). Margin 0 recovers the lab formulas exactly.
  return {
    pools,
    threshold,
    gates: {
      imgMeanMax: rawImgMeanMax * (1 - gateSafetyMargin),
      refShareMin: rawRefShareMin + gateSafetyMargin * (1 - rawRefShareMin),
    },
    streams: statsList.length,
  };
}

function validatePageSample(page: unknown, field: string): AssetReferrerPageSample {
  if (typeof page !== "object" || page === null) fail(`${field} must be an object`);
  const p = page as AssetReferrerPageSample;
  requireFiniteAtLeast(p.images, `${field}.images`, 0);
  requireFiniteAtLeast(p.assets, `${field}.assets`, 0);
  if (typeof p.referrerEmpty !== "boolean") fail(`${field}.referrerEmpty must be a boolean`);
  if (p.ts !== undefined) requireFiniteAtLeast(p.ts, `${field}.ts`, 0);
  return p;
}

/* ---------------- runtime state ---------------- */

/** Sums of one closed window (always accumulated over exactly the horizon's page count). */
interface WindowSums {
  img: number;
  ast: number;
  ref: number;
}

/**
 * Closed windows retained per scope: far more than the persistence
 * chain needs (2), so dropping older windows can never manufacture
 * or destroy a trailing violation run shorter than the cap.
 */
const MAX_CLOSED_WINDOWS = 32;

interface IdentityState {
  /** Total recorded pages (all closed windows plus the open one). */
  totalPages: number;
  /** Pages accumulated in the currently open window. */
  openPages: number;
  imgSum: number;
  astSum: number;
  refCount: number;
  closed: WindowSums[];
  lastSeen: number;
}

interface CohortPage {
  ts: number;
  seq: number;
  images: number;
  assets: number;
  referrerEmpty: boolean;
}

interface CohortState {
  /**
   * Pages of the currently open window. Window membership is by
   * arrival batch of `cohortPages` pages; the window statistics are
   * order-free sums, so the lab's chronological pooling and live
   * arrival order agree on the numbers (a page that arrives after
   * its timestamp's window has closed counts toward the open one).
   */
  pages: CohortPage[];
  /** Total pooled pages observed (all closed windows plus the open one). */
  totalPages: number;
  closed: WindowSums[];
  lastSeen: number;
}

export function createAssetReferrerProfile(
  options: CreateAssetReferrerProfileOptions = {},
): AssetReferrerProfile {
  if (typeof options !== "object" || options === null) fail("options must be an object");

  const horizonPages = requireIntInRange(options.horizonPages ?? 50, "horizonPages", 1, 100_000);
  const cohortPages = requireIntInRange(options.cohortPages ?? 120, "cohortPages", 1, 100_000);
  const alpha = options.alpha ?? 0.01;
  if (typeof alpha !== "number" || !Number.isFinite(alpha) || alpha <= 0 || alpha > 0.5) {
    fail("alpha must be a finite number in (0, 0.5]");
  }
  const botImagesMean = requireFiniteAtLeast(options.botProfile?.imagesMean ?? 0.3, "botProfile.imagesMean", 0);
  const botRefShare = requireShare(options.botProfile?.emptyReferrerShare ?? 0.984, "botProfile.emptyReferrerShare");
  const gateSafetyMargin = options.gateSafetyMargin ?? 0.25;
  if (
    typeof gateSafetyMargin !== "number" ||
    !Number.isFinite(gateSafetyMargin) ||
    gateSafetyMargin < 0 ||
    gateSafetyMargin > 0.9
  ) {
    fail("gateSafetyMargin must be a finite number between 0 and 0.9");
  }
  const minTrainStreams = requireIntInRange(options.minTrainStreams ?? 50, "minTrainStreams", 1, 1_000_000);
  const minTrainCohorts = requireIntInRange(options.minTrainCohorts ?? 30, "minTrainCohorts", 1, 1_000_000);
  const maxIdentities = requireIntInRange(options.maxIdentities ?? 10_000, "maxIdentities", 1, 10_000_000);
  const maxCohorts = requireIntInRange(options.maxCohorts ?? 2_000, "maxCohorts", 1, 10_000_000);
  const clock = options.now ?? (() => Date.now());

  /* Stratification: absence disables (never throws); a present but
   * malformed declaration is a programming error and throws. */
  let browserStratum: string | null = null;
  let neutralStrata: string[] = [];
  if (options.stratification !== undefined) {
    const decl = options.stratification;
    if (typeof decl !== "object" || decl === null) fail("stratification must be an object");
    browserStratum = requireStratumName(decl.browserStratum, "stratification.browserStratum");
    if (!Array.isArray(decl.neutralStrata) || decl.neutralStrata.length < 1) {
      fail(
        "stratification.neutralStrata must name at least one declared non-browser stratum " +
          "(a declaration with no non-browser lane is vacuous)",
      );
    }
    const seen = new Set<string>();
    for (const name of decl.neutralStrata) {
      const valid = requireStratumName(name, "stratification.neutralStrata entry");
      if (valid === browserStratum) {
        fail("stratification.neutralStrata must not contain the browser stratum");
      }
      if (seen.has(valid)) fail(`stratification.neutralStrata contains a duplicate: ${JSON.stringify(valid)}`);
      seen.add(valid);
    }
    neutralStrata = [...seen];
  }
  const enabled = browserStratum !== null;
  const neutralSet = new Set(neutralStrata);

  const identities = new Map<string, IdentityState>();
  const cohorts = new Map<string, CohortState>();
  const counters = { recorded: 0, neutral: 0, unstratified: 0, undeclaredStratum: 0 };
  let identityCal: Calibration | null = null;
  let cohortCal: Calibration | null = null;
  let seq = 0;

  const disabledObservation = (): AssetProfileObservation => ({
    status: "disabled",
    reason: DISABLED_REASON,
    scored: false,
    counted: false,
    pages: 0,
  });

  const baseSignal = (
    scope: "identity" | "cohort",
    ids: { identity?: string; cohortId?: string },
    status: AssetReferrerProfileSignal["status"],
    pagesObserved: number,
    notice: string,
  ): AssetReferrerProfileSignal => ({
    kind: "asset_referrer_profile",
    scope,
    ...ids,
    status,
    level: "none",
    consecutiveViolations: 0,
    flagged: false,
    scorePass: false,
    gateOk: false,
    score: null,
    parts: null,
    stats: null,
    pagesObserved,
    enforcement: "none",
    notice,
  });

  interface WindowEval {
    stats: AssetProfileStats;
    score: number;
    parts: Record<StatName, number>;
    scorePass: boolean;
    gateOk: boolean;
    violation: boolean;
  }

  const evalWindow = (cal: Calibration, sums: WindowSums, windowPages: number): WindowEval => {
    const stats: AssetProfileStats = {
      imgMean: sums.img / windowPages,
      astMean: sums.ast / windowPages,
      refShare: sums.ref / windowPages,
      pages: windowPages,
    };
    const { score, parts } = scoreStats(cal.pools, stats, undefined);
    const scorePass = score > cal.threshold;
    const gateOk = stats.imgMean <= cal.gates.imgMeanMax && stats.refShare >= cal.gates.refShareMin;
    return { stats, score, parts, scorePass, gateOk, violation: scorePass && gateOk };
  };

  /**
   * Build a "scored" signal from a scope's closed windows: the
   * reported score/parts/stats are the most recent window's, and
   * the level is the trailing run of consecutive violating windows
   * (post-lab tightening B): 0 -> "none", 1 -> "watch", >= 2 ->
   * "flag".
   */
  const scoredSignal = (
    scope: "identity" | "cohort",
    ids: { identity?: string; cohortId?: string },
    cal: Calibration,
    closed: WindowSums[],
    windowPages: number,
    totalPages: number,
  ): AssetReferrerProfileSignal => {
    const evals = closed.map((w) => evalWindow(cal, w, windowPages));
    const last = evals[evals.length - 1]!;
    let tail = 0;
    for (let i = evals.length - 1; i >= 0; i--) {
      if (evals[i]!.violation) tail++;
      else break;
    }
    const level: AssetReferrerProfileSignal["level"] = tail >= 2 ? "flag" : tail === 1 ? "watch" : "none";
    return {
      kind: "asset_referrer_profile",
      scope,
      ...ids,
      status: "scored",
      level,
      consecutiveViolations: tail,
      flagged: level === "flag",
      scorePass: last.scorePass,
      gateOk: last.gateOk,
      score: last.score,
      parts: last.parts,
      stats: last.stats,
      pagesObserved: totalPages,
      enforcement: "none",
      notice: ADVISORY_NOTICE,
    };
  };

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
    const fresh: IdentityState = {
      totalPages: 0,
      openPages: 0,
      imgSum: 0,
      astSum: 0,
      refCount: 0,
      closed: [],
      lastSeen: now,
    };
    identities.set(identity, fresh);
    return fresh;
  };

  const touchCohort = (cohortId: string, now: number): CohortState => {
    const existing = cohorts.get(cohortId);
    if (existing) {
      existing.lastSeen = now;
      cohorts.delete(cohortId);
      cohorts.set(cohortId, existing);
      return existing;
    }
    if (cohorts.size >= maxCohorts) {
      const oldest = cohorts.keys().next().value as string | undefined;
      if (oldest !== undefined) cohorts.delete(oldest);
    }
    const fresh: CohortState = { pages: [], totalPages: 0, closed: [], lastSeen: now };
    cohorts.set(cohortId, fresh);
    return fresh;
  };

  function evaluateIdentity(identity: string): AssetReferrerProfileSignal {
    if (!enabled) {
      return baseSignal("identity", { identity }, "disabled", 0,
        `Module disabled (${DISABLED_REASON}): no client stratification was declared, so nothing is scored.`);
    }
    const state = identities.get(identity);
    const pagesObserved = state ? state.totalPages : 0;
    if (!identityCal) {
      return baseSignal("identity", { identity }, "uncalibrated", pagesObserved,
        "No identity calibration has been fitted; this module never flags on uncalibrated pools.");
    }
    if (!state || state.closed.length === 0) {
      const open = state ? state.openPages : 0;
      return baseSignal("identity", { identity }, "insufficient_data", pagesObserved,
        `No window has closed yet (${open}/${horizonPages} pages in the open window); the profile is not scored yet.`);
    }
    return scoredSignal("identity", { identity }, identityCal, state.closed, horizonPages, state.totalPages);
  }

  function evaluateCohort(cohortId: string): AssetReferrerProfileSignal {
    if (!enabled) {
      return baseSignal("cohort", { cohortId }, "disabled", 0,
        `Module disabled (${DISABLED_REASON}): no client stratification was declared, so nothing is scored.`);
    }
    const state = cohorts.get(cohortId);
    const pagesObserved = state ? state.totalPages : 0;
    if (!cohortCal) {
      return baseSignal("cohort", { cohortId }, "uncalibrated", pagesObserved,
        "No cohort calibration has been fitted; this module never flags on uncalibrated pools.");
    }
    if (!state || state.closed.length === 0) {
      const open = state ? state.pages.length : 0;
      return baseSignal("cohort", { cohortId }, "insufficient_data", pagesObserved,
        `No cohort window has closed yet (${open}/${cohortPages} pooled pages in the open window); the profile is not scored yet.`);
    }
    return scoredSignal("cohort", { cohortId }, cohortCal, state.closed, cohortPages, state.totalPages);
  }

  function observe(event: AssetReferrerProfileEvent): AssetProfileObservation {
    if (!enabled) return disabledObservation();
    if (typeof event !== "object" || event === null) fail("event must be an object");
    if (typeof event.identity !== "string" || event.identity.trim().length === 0) {
      fail("event.identity must be a non-empty string");
    }
    requireFiniteAtLeast(event.images, "event.images", 0);
    requireFiniteAtLeast(event.assets, "event.assets", 0);
    if (typeof event.referrerEmpty !== "boolean") fail("event.referrerEmpty must be a boolean");
    if (event.ts !== undefined) requireFiniteAtLeast(event.ts, "event.ts", 0);
    if (event.clientType !== undefined && typeof event.clientType !== "string") {
      fail("event.clientType must be a string when present");
    }
    if (event.cohortId !== undefined && (typeof event.cohortId !== "string" || event.cohortId.trim().length === 0)) {
      fail("event.cohortId must be a non-empty string when present");
    }

    const state = identities.get(event.identity);
    const currentPages = state ? state.totalPages : 0;

    if (event.clientType === undefined) {
      counters.unstratified++;
      return { status: "unstratified", scored: false, counted: false, pages: currentPages };
    }
    if (event.clientType !== browserStratum) {
      if (neutralSet.has(event.clientType)) {
        counters.neutral++;
        return { status: "neutral_stratum", scored: false, counted: false, pages: currentPages };
      }
      counters.undeclaredStratum++;
      return { status: "undeclared_stratum", scored: false, counted: false, pages: currentPages };
    }

    counters.recorded++;
    const now = clock();
    const idState = touchIdentity(event.identity, now);
    idState.totalPages++;
    idState.imgSum += event.images;
    idState.astSum += event.assets;
    if (event.referrerEmpty) idState.refCount++;
    idState.openPages++;
    let windowClosed = false;
    if (idState.openPages === horizonPages) {
      idState.closed.push({ img: idState.imgSum, ast: idState.astSum, ref: idState.refCount });
      if (idState.closed.length > MAX_CLOSED_WINDOWS) idState.closed.shift();
      idState.imgSum = 0;
      idState.astSum = 0;
      idState.refCount = 0;
      idState.openPages = 0;
      windowClosed = true;
    }
    if (event.cohortId !== undefined) {
      const cohort = touchCohort(event.cohortId, now);
      cohort.totalPages++;
      cohort.pages.push({
        ts: event.ts ?? now,
        seq: seq++,
        images: event.images,
        assets: event.assets,
        referrerEmpty: event.referrerEmpty,
      });
      if (cohort.pages.length === cohortPages) {
        // Close the cohort window: fold its pages into window sums.
        let img = 0;
        let ast = 0;
        let ref = 0;
        for (const p of cohort.pages) {
          img += p.images;
          ast += p.assets;
          if (p.referrerEmpty) ref++;
        }
        cohort.closed.push({ img, ast, ref });
        if (cohort.closed.length > MAX_CLOSED_WINDOWS) cohort.closed.shift();
        cohort.pages = [];
      }
    }
    const result: AssetProfileObservation = {
      status: "recorded",
      scored: true,
      counted: true,
      pages: idState.totalPages,
    };
    if (windowClosed && identityCal) {
      result.signal = evaluateIdentity(event.identity);
    }
    return result;
  }

  function fitCalibration(samples: AssetReferrerPageSample[][]): AssetReferrerFitResult {
    if (!enabled) {
      return {
        fitted: false,
        status: "disabled",
        scope: "identity",
        streams: 0,
        skipped: 0,
        threshold: null,
        gates: null,
        gateSafetyMargin,
      };
    }
    if (!Array.isArray(samples)) fail("fitCalibration samples must be an array of page arrays");
    const statsList: AssetProfileStats[] = [];
    let skipped = 0;
    samples.forEach((stream, i) => {
      if (!Array.isArray(stream)) fail(`fitCalibration samples[${i}] must be an array of pages`);
      stream.forEach((page, j) => validatePageSample(page, `fitCalibration samples[${i}][${j}]`));
      const stats = prefixStats(stream, horizonPages);
      if (stats) statsList.push(stats);
      else skipped++;
    });
    if (statsList.length < minTrainStreams) {
      fail(
        `fitCalibration needs at least ${minTrainStreams} legitimate streams reaching the ` +
          `${horizonPages}-page horizon; got ${statsList.length} (${skipped} below horizon)`,
      );
    }
    identityCal = fitFromStats(statsList, alpha, botImagesMean, botRefShare, gateSafetyMargin);
    return {
      fitted: true,
      status: "fitted",
      scope: "identity",
      streams: identityCal.streams,
      skipped,
      threshold: identityCal.threshold,
      gates: identityCal.gates,
      gateSafetyMargin,
    };
  }

  function fitCohortCalibration(samples: AssetReferrerPageSample[][][]): AssetReferrerFitResult {
    if (!enabled) {
      return {
        fitted: false,
        status: "disabled",
        scope: "cohort",
        streams: 0,
        skipped: 0,
        threshold: null,
        gates: null,
        gateSafetyMargin,
      };
    }
    if (!Array.isArray(samples)) fail("fitCohortCalibration samples must be an array of cohorts");
    const statsList: AssetProfileStats[] = [];
    let skipped = 0;
    samples.forEach((members, i) => {
      if (!Array.isArray(members)) fail(`fitCohortCalibration samples[${i}] must be an array of member page arrays`);
      members.forEach((stream, j) => {
        if (!Array.isArray(stream)) fail(`fitCohortCalibration samples[${i}][${j}] must be an array of pages`);
        stream.forEach((page, k) => validatePageSample(page, `fitCohortCalibration samples[${i}][${j}][${k}]`));
      });
      const stats = cohortPrefixStats(members, cohortPages);
      if (stats) statsList.push(stats);
      else skipped++;
    });
    if (statsList.length < minTrainCohorts) {
      fail(
        `fitCohortCalibration needs at least ${minTrainCohorts} legitimate cohorts reaching the ` +
          `${cohortPages}-page pooled horizon; got ${statsList.length} (${skipped} below horizon)`,
      );
    }
    cohortCal = fitFromStats(statsList, alpha, botImagesMean, botRefShare, gateSafetyMargin);
    return {
      fitted: true,
      status: "fitted",
      scope: "cohort",
      streams: cohortCal.streams,
      skipped,
      threshold: cohortCal.threshold,
      gates: cohortCal.gates,
      gateSafetyMargin,
    };
  }

  function snapshot(): AssetReferrerProfileSnapshot {
    return {
      enabled,
      disabledReason: enabled ? null : DISABLED_REASON,
      enforcement: "none",
      calibrated: identityCal !== null,
      cohortCalibrated: cohortCal !== null,
      horizonPages,
      cohortPages,
      alpha,
      gateSafetyMargin,
      browserStratum,
      neutralStrata: [...neutralStrata],
      identitiesTracked: identities.size,
      cohortsTracked: cohorts.size,
      counters: { ...counters },
      identityCalibration: identityCal
        ? { streams: identityCal.streams, threshold: identityCal.threshold, gates: identityCal.gates }
        : null,
      cohortCalibration: cohortCal
        ? { streams: cohortCal.streams, threshold: cohortCal.threshold, gates: cohortCal.gates }
        : null,
      notice: enabled ? ADVISORY_NOTICE : `Module disabled (${DISABLED_REASON}): no client stratification was declared, so nothing is scored.`,
    };
  }

  return {
    enabled,
    observe,
    fitCalibration,
    fitCohortCalibration,
    evaluateIdentity,
    evaluateCohort,
    snapshot,
  };
}
