/**
 * FC-07 pin statistic - novel-only exposure count per identity,
 * thresholds fitted per stratum under C-LAW, flag rule STRICT
 * (novel > tau). OPT-IN, selectable statistic form for the pin
 * channel; this module is a pure evaluator - it holds no state,
 * enforces nothing, and changes no shipped default.
 *
 * Source evidence: farmgate-2026-11-16/
 * REGISTRATION-FC07-PIN-STRATUM-NOVEL.md (frozen 2026-11-16) +
 * FC07-RESULTS-2026-11-16.md (results sha256 7f2b874b...). The
 * estimator code below is a faithful port of the reference runner
 * fc07.cjs in that directory.
 *
 * EVIDENCE STATE (binding, stated plainly): the verdict for this
 * statistic is PASS-LAB-WITH-COST on the CALIBRATION WINDOW ONLY -
 * fit exposures through 2026-11-11, score exposures through
 * 2026-11-15, and the scoring reuses the calibration identities
 * (day-split, not a fresh population). HOLDOUT VALIDATION ON THE
 * 16-22/11 TRACES IS PENDING (scheduled ~23/11, after the holdout
 * window closes) - it has NOT been run, and this verdict does not
 * pre-answer it. Do not present this statistic as holdout-validated
 * or field-proven.
 *
 * Farm results on that calibration window (frozen score table,
 * reproduced exactly by tests/pin-novel-statistic.test.cjs):
 * tau_pooled = 500; ordinary_reader FP 0/36 at its fitted
 * tau_S = 500; heavy_reader FP 0/18 at tau_S = 500 taken BY
 * FALLBACK (the stratum has 18 fit identities, below the frozen
 * minimum of 20 - the fallback path is reported in the fit result,
 * not hidden); slow_attacker detection 2/2; bulk scraper shapes
 * 4/4 (novels 1400 / 2800 / 4200 / 5600 against tau_pooled).
 *
 * COST (the reason the verdict is WITH-COST, not PASS-LAB):
 * review_team-shape crossing is 100% (14/14), above the frozen
 * 25% cost line (gate F-G4). review_team is coordinated traffic
 * the channel is meant to catch, and its crossing rate is printed
 * as the price of the bound: if traffic shaped like review_team
 * were legitimate, this bound would flag all of it.
 *
 * THE STRICT RULE IS THE FIX THIS STATISTIC EXISTS FOR. FC-06
 * Arm N fitted the same pooled bound (tau = 500) with a >= rule
 * and flagged 100% of heavy_reader, because every heavy fit/score
 * identity sits exactly ON the 500 saturation point. Flagging AT
 * the bound flags the legit mass the bound was estimated from.
 * Under the strict rule (novel > tau), 500 > 500 is false and the
 * heavy FP falls to 0% with no detection loss anywhere. The margin
 * at the bound is EXACTLY ONE RECORD: a legit identity at novel
 * 501 in the score window would flag, and how much legitimate mass
 * sits just above the saturation point in a longer window is the
 * holdout's question (see EVIDENCE STATE above).
 *
 * THE FIT (frozen, C-LAW-shaped, as fc07.cjs computes it):
 * - tau_pooled = weighted nearest-rank q95 of fit novel over the
 *   reference (false-positive) population. Weights are the FC-01R
 *   choice-(d) mixture weights, recomputed from the fit table:
 *   each stratum's weight share is its share of total fit events
 *   (sum of nEventsFit), divided evenly across its identities.
 * - Per stratum S: tau_S = max(tau_pooled, Q_S), where Q_S is the
 *   stratum's UNWEIGHTED nearest-rank quantile of fit novel at the
 *   stratum's frozen level - ordinary_reader Q99.5 (its 0.5% FP
 *   budget), heavy_reader Q98 (its 2% FP budget); any other
 *   host-declared stratum defaults to Q99.5 unless the host pins
 *   its level in the fit options.
 * - FALLBACK (arm-A precedent, named): a stratum with fewer than
 *   20 fit identities does NOT get a fitted tau_S; it uses
 *   tau_pooled, and the fit result reports `fallback: true` for
 *   that stratum (heavy_reader's path in the farm run).
 *
 * STRATA ARE BY HOST DECLARATION ONLY (the tier-2 doctrine, Item
 * 1(d) of the 3.0 build spec): the host supplies the stratum of
 * each identity through the fit exposures and the score-time
 * strata resolver (a callback or an identity -> stratum map). No
 * stratum is ever inferred from traffic. An identity the resolver
 * does not declare - or declares into a stratum that was not in
 * the reference fit - is scored under tau_pooled, the default
 * bound an unclassified identity faces.
 *
 * RELATION TO THE SHIPPED PIN FORMS: the shipped (novel, total)
 * pair forms were KILLed as calibrated defaults on farm data
 * (FC-01R pooled, FC-02R per-stratum C-LAW, FC-06 Arm R ratio
 * cap), and FC-06 Arm N (novel-only, >= rule) was KILLed by the
 * mass-point defect above. Those code paths are untouched by this
 * module and remain the default; this statistic ships OPT-IN
 * alongside them. No threshold in the SDK changes on the basis of
 * the FC-07 lab report alone beyond adding this opt-in form.
 */

export class PinNovelStatisticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinNovelStatisticError";
  }
}

/** Frozen flag rule: an identity flags iff novel > tau (STRICT). */
export const PIN_NOVEL_FLAG_RULE = "novel > tau (STRICT)" as const;

/** Pooled fit quantile (FC-01R estimator convention): weighted nearest-rank q95. */
export const PIN_NOVEL_POOLED_QUANTILE = 0.95;

/**
 * Fallback minimum (arm-A precedent, frozen): a stratum with fewer
 * fit identities than this uses tau_pooled instead of a fitted
 * tau_S, and the fit result reports the fallback.
 */
export const PIN_NOVEL_FALLBACK_MIN_FIT_IDENTITIES = 20;

/** Default per-stratum quantile level for a host-declared stratum (Q99.5, the ordinary_reader budget). */
export const PIN_NOVEL_DEFAULT_STRATUM_QUANTILE = 0.995;

/**
 * Frozen per-stratum quantile levels from the FC-07 registration:
 * ordinary_reader Q99.5 (0.5% FP budget), heavy_reader Q98 (2% FP
 * budget). A host may override or extend these in the fit options;
 * a stratum absent here and absent from the options uses
 * PIN_NOVEL_DEFAULT_STRATUM_QUANTILE.
 */
export const PIN_NOVEL_STRATUM_QUANTILES: Readonly<Record<string, number>> = {
  ordinary_reader: 0.995,
  heavy_reader: 0.98,
};

/** One identity's fit-window exposure, as consumed by fc07.cjs. */
export interface PinNovelFitExposure {
  identity: string;
  /** Host-declared stratum of this identity. */
  stratum: string;
  /** Distinct records this identity was exposed to in the fit window (fit.novel). */
  novelFit: number;
  /** Fit-window trace events for this identity; drives the choice-(d) mixture weights. */
  nEventsFit: number;
}

/** One identity's score-window exposure. */
export interface PinNovelScoreExposure {
  identity: string;
  /** Distinct records this identity was exposed to in the score window (score.novel). */
  novel: number;
}

export interface PinNovelStratumFit {
  stratum: string;
  /** Fit identities in this stratum. */
  nFit: number;
  /** The stratum's frozen quantile level (see PIN_NOVEL_STRATUM_QUANTILES). */
  qLevel: number;
  /** Q_S: the stratum's unweighted nearest-rank quantile of fit novel at qLevel. Computed and reported even on the fallback path. */
  qS: number;
  /**
   * True when the fallback path was taken (nFit below the frozen
   * minimum): tauS is tau_pooled, NOT a fitted bound. Reported, not
   * hidden - heavy_reader's farm fit is the canonical example.
   */
  fallback: boolean;
  /** tau_S = max(tau_pooled, Q_S), or tau_pooled on the fallback path. */
  tauS: number;
}

export interface PinNovelFitResult {
  /** Weighted nearest-rank q95 of fit novel over the reference population. */
  tauPooled: number;
  /** Unweighted nearest-rank q95 of fit novel over the same population (diagnostic; fc07.cjs reports it too). */
  tauPooledUnweightedDiagnostic: number;
  /** Per-stratum fits, keyed by stratum, for every stratum in the reference population. */
  strata: Record<string, PinNovelStratumFit>;
  /** The strata that formed the reference (FP) population for this fit, in fit order. */
  referenceStrata: string[];
  /** Identities in the reference population. */
  fitIdentities: number;
  /** Sum of nEventsFit per reference stratum (the mixture-weight numerators). */
  fitEventsByStratum: Record<string, number>;
  /** Sum of nEventsFit over the reference population. */
  fitEventsTotal: number;
  flagRule: typeof PIN_NOVEL_FLAG_RULE;
}

export interface PinNovelFitOptions {
  /**
   * The strata that form the reference (false-positive) population
   * for the pooled fit and the per-stratum fits. Default: every
   * stratum present in the fit exposures - i.e. the host passes
   * only its reference population. Pin this explicitly when the fit
   * exposures also carry non-reference identities (the farm table
   * does: its FP population is ordinary_reader + heavy_reader).
   */
  referenceStrata?: readonly string[];
  /** Per-stratum quantile levels, merged over PIN_NOVEL_STRATUM_QUANTILES. */
  stratumQuantileLevels?: Readonly<Record<string, number>>;
  /** Fallback minimum fit identities per stratum. Default PIN_NOVEL_FALLBACK_MIN_FIT_IDENTITIES (20, frozen). */
  fallbackMinFitIdentities?: number;
}

/**
 * Host-declared strata resolver for scoring: a callback returning
 * the identity's declared stratum (or null / undefined when
 * undeclared), or a plain identity -> stratum map. Strata are
 * never inferred from traffic by this module.
 */
export type PinNovelStrataResolver =
  | ((identity: string) => string | null | undefined)
  | Readonly<Record<string, string>>;

export interface PinNovelScoreDecision {
  identity: string;
  /** The host-declared stratum the resolver returned, or null when undeclared. */
  stratum: string | null;
  novel: number;
  /** The bound this identity was scored under. */
  tauApplied: number;
  /** "stratum" when tauApplied is that stratum's fitted tau_S; "pooled" when it is tau_pooled. */
  tauSource: "stratum" | "pooled";
  /** STRICT rule: novel > tauApplied. novel == tauApplied does NOT flag. */
  flagged: boolean;
}

/** The strict flag rule itself: novel > tau. novel == tau does not flag. */
export function pinNovelExceeds(novel: number, tau: number): boolean {
  return novel > tau;
}

// ---- estimators (conventions verbatim from fc07.cjs) ----

function weightedQuantile<T>(
  samples: readonly T[],
  valueFn: (sample: T) => number,
  weightFn: (sample: T) => number,
  p: number,
): number {
  const sorted = [...samples].sort((a, b) => valueFn(a) - valueFn(b));
  let cum = 0;
  for (const s of sorted) {
    cum += weightFn(s);
    if (cum >= p) return valueFn(s);
  }
  return valueFn(sorted[sorted.length - 1] as T);
}

function nearestRank(vals: readonly number[], p: number): number {
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.ceil(p * s.length) - 1] as number;
}

function requireIdentity(identity: unknown, where: string): string {
  if (typeof identity !== "string" || identity.length === 0) {
    throw new PinNovelStatisticError(`${where}: identity must be a non-empty string`);
  }
  return identity;
}

function requireCount(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PinNovelStatisticError(`${where}: count must be a finite number >= 0`);
  }
  return value;
}

/**
 * Fit the FC-07 statistic on a reference population.
 *
 * Pure and deterministic: the input is copied and sorted by
 * identity before any grouping (fc07.cjs's own discipline), so the
 * same table always produces the same fit.
 */
export function fitPinNovelStatistic(
  fitExposures: readonly PinNovelFitExposure[],
  options: PinNovelFitOptions = {},
): PinNovelFitResult {
  if (!Array.isArray(fitExposures) || fitExposures.length === 0) {
    throw new PinNovelStatisticError("fit: at least one fit exposure is required");
  }
  const identities = [...fitExposures].sort((a, b) =>
    a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0,
  );
  for (const row of identities) {
    requireIdentity(row?.identity, "fit");
    if (typeof row?.stratum !== "string" || row.stratum.length === 0) {
      throw new PinNovelStatisticError("fit: stratum must be a non-empty string (host-declared)");
    }
    requireCount(row?.novelFit, "fit novelFit");
    requireCount(row?.nEventsFit, "fit nEventsFit");
  }

  const byStratum = new Map<string, PinNovelFitExposure[]>();
  for (const row of identities) {
    const members = byStratum.get(row.stratum);
    if (members) members.push(row);
    else byStratum.set(row.stratum, [row]);
  }

  const referenceStrata: string[] = options.referenceStrata
    ? [...options.referenceStrata]
    : [...byStratum.keys()];
  if (referenceStrata.length === 0) {
    throw new PinNovelStatisticError("fit: referenceStrata must name at least one stratum");
  }
  const referencePop = identities.filter((row) => referenceStrata.includes(row.stratum));
  if (referencePop.length === 0) {
    throw new PinNovelStatisticError("fit: the reference population is empty");
  }

  // (d) mixture weights: fit-window trace-event shares over the
  // reference population, divided evenly across each stratum's
  // identities - recomputed from the table, exactly as fc07.cjs.
  const fitEventsByStratum: Record<string, number> = {};
  for (const s of referenceStrata) {
    fitEventsByStratum[s] = (byStratum.get(s) ?? []).reduce((acc, i) => acc + i.nEventsFit, 0);
  }
  const fitEventsTotal = referenceStrata.reduce((acc, s) => acc + (fitEventsByStratum[s] ?? 0), 0);
  if (!(fitEventsTotal > 0)) {
    throw new PinNovelStatisticError("fit: total fit events must be > 0 to derive mixture weights");
  }
  const weightOf: Record<string, number> = {};
  for (const s of referenceStrata) {
    const members = byStratum.get(s) ?? [];
    weightOf[s] = members.length > 0 ? (fitEventsByStratum[s] ?? 0) / fitEventsTotal / members.length : 0;
  }

  const tauPooled = weightedQuantile(
    referencePop,
    (i) => i.novelFit,
    (i) => weightOf[i.stratum] as number,
    PIN_NOVEL_POOLED_QUANTILE,
  );
  const tauPooledUnweightedDiagnostic = nearestRank(
    referencePop.map((i) => i.novelFit),
    PIN_NOVEL_POOLED_QUANTILE,
  );

  const quantileLevels: Record<string, number> = {
    ...PIN_NOVEL_STRATUM_QUANTILES,
    ...(options.stratumQuantileLevels ?? {}),
  };
  const fallbackMin = options.fallbackMinFitIdentities ?? PIN_NOVEL_FALLBACK_MIN_FIT_IDENTITIES;
  if (!Number.isFinite(fallbackMin) || fallbackMin < 1) {
    throw new PinNovelStatisticError("fit: fallbackMinFitIdentities must be >= 1");
  }

  const strata: Record<string, PinNovelStratumFit> = {};
  for (const s of referenceStrata) {
    const members = byStratum.get(s) ?? [];
    const qLevel = quantileLevels[s] ?? PIN_NOVEL_DEFAULT_STRATUM_QUANTILE;
    if (!(qLevel > 0 && qLevel <= 1)) {
      throw new PinNovelStatisticError(`fit: quantile level for stratum "${s}" must be in (0, 1]`);
    }
    const qS = members.length > 0 ? nearestRank(members.map((i) => i.novelFit), qLevel) : tauPooled;
    const fallback = members.length < fallbackMin;
    strata[s] = {
      stratum: s,
      nFit: members.length,
      qLevel,
      qS,
      fallback,
      tauS: fallback ? tauPooled : Math.max(tauPooled, qS),
    };
  }

  return {
    tauPooled,
    tauPooledUnweightedDiagnostic,
    strata,
    referenceStrata,
    fitIdentities: referencePop.length,
    fitEventsByStratum,
    fitEventsTotal,
    flagRule: PIN_NOVEL_FLAG_RULE,
  };
}

/**
 * Score score-window exposures against a fit. FP / declared strata
 * are scored under their own tau_S; every other identity - detection
 * shapes, descriptive strata, and identities the resolver does not
 * declare - is scored under tau_pooled. Input order is preserved.
 * Pure: neither the fit nor the exposures are mutated.
 */
export function scorePinNovelStatistic(
  fit: PinNovelFitResult,
  scoreExposures: readonly PinNovelScoreExposure[],
  strataResolver?: PinNovelStrataResolver,
): PinNovelScoreDecision[] {
  if (!fit || typeof fit.tauPooled !== "number" || !fit.strata) {
    throw new PinNovelStatisticError("score: a fit result from fitPinNovelStatistic is required");
  }
  const resolve = (identity: string): string | null => {
    if (strataResolver === undefined) return null;
    const value =
      typeof strataResolver === "function" ? strataResolver(identity) : strataResolver[identity];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  return scoreExposures.map((row) => {
    const identity = requireIdentity(row?.identity, "score");
    const novel = requireCount(row?.novel, "score novel");
    const stratum = resolve(identity);
    const stratumFit = stratum !== null ? fit.strata[stratum] : undefined;
    const tauApplied = stratumFit ? stratumFit.tauS : fit.tauPooled;
    return {
      identity,
      stratum,
      novel,
      tauApplied,
      tauSource: stratumFit ? ("stratum" as const) : ("pooled" as const),
      flagged: pinNovelExceeds(novel, tauApplied),
    };
  });
}
