/**
 * Anytime-valid e-value evidence engine (T1, 2.7.0 math track).
 *
 * Construction and derivation: RESEARCH-V270-MATH.md (T1); bars and
 * amendments: PREREG-V270-MATH.md incl. Amendment 1 (Argon round 1).
 * This header fixes the EXACT score and stake definitions BEFORE any
 * simulation runs; they may not change between the validity and
 * power runs of the pre-registration.
 *
 * SCORE (exact definition). Per cohort, per observe-step t, let
 * novel_t be the number of records in the step that are NEW to the
 * cohort's exact served-record union (records the cohort has never
 * been observed serving before, across all its members), and let
 * SCALE be the host scale constant `scaleRecords` (default 50):
 *
 *     x_t = min(1, novel_t / SCALE)        in [0, 1]
 *
 * The score is the step's novel-union contribution normalized by a
 * host-scale constant - a quantity the CUSUM tripwire's accounting
 * already maintains (its exact union). One observe() call is one
 * step; the host chooses the step granularity (per request, per
 * batch, per time window) and must set mu0 for THAT granularity.
 *
 * NULL ASSUMPTION (A1) - the condition of the guarantee. There is a
 * known mu0 in (0,1) with
 *
 *     E[x_t | F_{t-1}] <= mu0   for every t, under legitimate use,
 *
 * where F_{t-1} is everything observed before step t. The guarantee
 * below is claimed ONLY for cohorts the host points this engine at
 * with a mu0 that bounds their legitimate use. If a legitimate
 * workflow's conditional mean exceeds mu0 (a bulk import, a
 * first-week power user at the chosen step granularity), (A1) is
 * violated for that cohort and the guarantee does not apply to it;
 * the misspecification price is measured, not hidden (prereg probe
 * M3 and the sim's per-persona reporting). Amendment 1 note: mu0 may
 * in principle be predictable - an F_{t-1}-measurable mu0_t with
 * E[x_t | F_{t-1}] <= mu0_t - and validity needs only that
 * conditional bound; the shipped module accepts a scalar mu0, and
 * the predictable form is the documented generalization.
 *
 * BETTING E-VALUE (exact stake rule, Amendment 1). With the
 * predictable stake lambda_t defined below,
 *
 *     e_t = 1 + lambda_t * (x_t - mu0),   K_t = prod_{s<=t} e_s.
 *
 * - Validity: E[e_t | F_{t-1}] = 1 + lambda_t (E[x_t|F_{t-1}] - mu0)
 *   <= 1 under (A1), for EVERY predictable stake sequence - tuning
 *   the stake can only change power, never validity. K_t is
 *   therefore a nonnegative supermartingale under H0, and by
 *   Ville's inequality P_H0( sup_t K_t >= 1/alpha ) <= alpha:
 *   flagging the first crossing of 1/alpha has false-flag
 *   probability <= alpha at ANY stopping time (continuous peeking
 *   and data-dependent stopping are inside the guarantee).
 * - Stake bounds: lambda_t in [lambda_floor, lambda_max] with
 *   lambda_max = 0.5 / mu0, so every e_t >= 1 - lambda_max * mu0 =
 *   0.5 (log-steps are bounded below; capital cannot be ruined by
 *   one quiet step) and e_t <= 1 + lambda_max (1 - mu0).
 * - Stake rule (predictable plug-in, blended with a fixed design
 *   alternative so a quiet period cannot collapse the stake):
 *   let mu1* = `designAlternative` (default min(1, 2*mu0)) and
 *   lambda_design = min( (mu1* - mu0) / (mu0 (1 - mu0)), lambda_max )
 *   (the Bernoulli log-optimal stake for mu1*, derived from
 *   maximizing p log(1+lambda(1-mu0)) + (1-p) log(1-lambda mu0)).
 *   lambda_floor = lambda_design / 2. From PAST steps only, with
 *   S = sum of past scores, n = number of past steps and shrinkage
 *   kappa = `shrinkKappa` (default 20):
 *       mu_hat = (S + kappa * mu0) / (n + kappa)
 *       lambda_raw = max(0, (mu_hat - mu0) / (mu0 (1 - mu0)))
 *       lambda_t = clip( (lambda_design + lambda_raw) / 2,
 *                        lambda_floor, lambda_max )
 *   The stake is computed INSIDE observe() from stored history
 *   only. The API accepts no stake input at any point, so a
 *   non-predictable (future-peeking) stake is impossible by shape.
 * - Capital is accumulated in LOG SPACE (logCapital += log(e_t));
 *   `capital` in snapshots is exp(logCapital) and saturates at
 *   Infinity once logCapital exceeds ~709 - long after any
 *   crossing threshold has fired.
 *
 * MERGE RULE (Amendment 1, exact). When two cohorts merge, their
 * capitals combine by WEIGHTED AVERAGE with weights = steps
 * observed per constituent, normalized:
 *
 *     K_merged = (n_a K_a + n_b K_b) / (n_a + n_b)
 *
 * (computed as a log-sum-exp over the constituents' log-capitals).
 * Constituents are frozen at merge; post-merge e-values multiply
 * the averaged capital. Product and max combinations are FORBIDDEN:
 * they break the supermartingale property. Derivation sketch: at
 * the merge time (a stopping time w.r.t. the joined filtration),
 * each frozen constituent capital is a constant, hence a
 * supermartingale w.r.t. the joined filtration; the weights are
 * predictable (they are the constituents' step counts at merge);
 * a predictable convex combination of supermartingales is a
 * supermartingale; and post-merge factors are valid e-values under
 * the merged (A1) for the merged cohort. The merged cohort's union
 * set, member set, score sum and step count are the constituents'
 * unions/sums, so the plug-in stake continues from joined history
 * only. `crossed` LATCHES at merge if either constituent had
 * crossed (crossing is a historical sup event), with
 * crossedAtStep = the earliest constituent crossing step.
 *
 * SHIRYAEV-ROBERTS E-DETECTOR MODE (S1, 2.7.0 synthesis). The
 * module ALSO tracks, on the SAME observe stream and the SAME
 * per-step e-values e_t as product mode, the Shiryaev-Roberts
 * statistic
 *
 *     M_0 = 0,   M_n = (1 + M_{n-1}) * e_n
 *
 * (equivalently M_n = sum over restart points k <= n of the
 * product of e_k..e_n: every step restarts a fresh product
 * process, so capital "debt" accumulated by a long quiet history
 * is NOT banked the way the single product K_t banks it - the
 * measured T1 quiet-then-attack hole, 774 attack steps at score
 * level for product mode, is the hole this mode exists to fix).
 * The detector option selects which reading the host acts on:
 * `detector: "product"` (default) or `detector: "sr"`. Both
 * statistics are computed on every step regardless of the option
 * (the SR update is O(1)); the option records the host's chosen
 * primary detector and never changes the e-values, the stakes, or
 * the product capital, so product-mode behaviour is unchanged.
 * Flag (SR reading) when M_n >= B, B = `srThreshold` (default
 * 1000).
 *
 * GUARANTEES - THE TWO MODES CARRY DIFFERENT GUARANTEES, and they
 * must never be conflated:
 * - Product mode: VILLE. Under (A1), P_H0( sup_t K_t >= 1/alpha )
 *   <= alpha. B/alpha-style lifetime false-flag probability bound
 *   at any stopping time.
 * - SR mode: ARL CONTROL ONLY. Under (A1), E_0[M_n] <= n for all
 *   n, and the expected time to a false alarm satisfies
 *   E_0[tau_B] >= B, where tau_B is the first step with
 *   M_n >= B (Shin & Ramdas 2023, e-detectors). This is NOT a
 *   Ville bound: SR mode makes NO claim of the form
 *   P(ever cross B) <= anything. B is an average-run-length knob:
 *   B = 1000 targets a mean false-alarm interval of >= 1000 steps,
 *   nothing more.
 *
 * SR NUMERICS. M_n is tracked in LOG SPACE: with L_n = log M_n,
 * L_0 = -inf (M_0 = 0) and L_n = log(e_n) + logaddexp(0, L_{n-1}),
 * since log(1 + M_{n-1}) = logaddexp(0, log M_{n-1}). Direct
 * recursion in doubles would also be viable for the horizons in
 * the pre-registration (e_t in [0.5, 3] keeps M_n moderate until
 * it crosses any sane B), but it can overflow to Infinity on a
 * long, hot stream long after crossing, whereas the log form
 * only saturates the EXPOSED `srStatistic = exp(L_n)` (at
 * ~e^709) while L_n itself - and therefore the crossing
 * comparison against log B - stays exact. The snapshot exposes
 * both `srStatistic` and `srLogStatistic`, the SR crossing state
 * (`srCrossed`, `srCrossedAtStep`) SEPARATELY from the product
 * `crossed` / `crossedAtStep`, and `srThreshold`.
 *
 * SR MERGE RULE. On mergeCohorts the merged SR statistic is the
 * STEP-WEIGHTED AVERAGE of the constituents' statistics,
 * M_merged = (n_a M_a + n_b M_b) / (n_a + n_b) (log-sum-exp in
 * code, mirroring the product merge), constituents frozen. This
 * is the defensible choice picked in PREREG-S1S3 follow-up
 * instructions: a restart-from-scratch or product/max merge has
 * no cleaner theory. CAVEAT, stated plainly: the ARL reading of a
 * merged SR statistic is APPROXIMATE after merges - the average
 * of two SR statistics is not itself the SR statistic of the
 * joined stream (whose restart sum would need every constituent
 * step's e-values), so E_0[tau_B] >= B is claimed for unmerged
 * SR streams, and post-merge SR crossings should be read as
 * evidence of the same strength as a product merge reading, not
 * as an exact ARL guarantee. `srCrossed` LATCHES at merge if
 * either constituent had SR-crossed, earliest step kept.
 *
 * CONFORMAL mu0 CALIBRATION (S3, `calibrateMu0`). (A1) is only as
 * good as the host's mu0, and the T1 M3 probe measured the price
 * of a wrong mu0 as total. `calibrateMu0` turns the host's own
 * measured legitimate per-step scores into a finite-sample bound:
 * let q be the split-conformal upper order statistic of n
 * calibration scores at level 1 - delta (1-indexed order
 * ceil((n+1)(1-delta)), clamped to [1, n]) and set
 * mu0 = min(1, q + delta). SATURATION (EV-3 fix): when
 * q + delta >= 1 the proven bound is the trivial bound 1,
 * which createEvalueTripwire itself rejects (mu0 must be
 * < 1), so calibrateMu0 never returns 1: it returns the
 * capped value 1 - 1/(n+1) and marks the result
 * `saturated: true`. The cap is the split-conformal
 * resolution limit - with n calibration scores the
 * achievable coverage levels are spaced 1/(n+1) apart, so
 * no value strictly between 1 - 1/(n+1) and 1 can be
 * certified from n samples; claiming e.g. 0.999 would
 * pretend to a precision the sample size cannot support.
 * A saturated result is NOT a proven (A1) bound (the proven
 * bound degenerated to the trivial one); the flag exists so
 * the host knows the calibration degenerated instead of
 * silently trusting the capped number. DERIVATION: for any x in [0, 1],
 * E[x] <= q + P(x > q) * 1 <= q + delta whenever
 * P(x <= q) >= 1 - delta, because the mass above q contributes
 * at most 1 each and the mass at or below q contributes at most
 * q. The conformal order statistic gives P(x_new <= q) >=
 * 1 - delta in finite samples, distribution-free, PROVIDED the
 * calibration scores and the future score are EXCHANGEABLE.
 * ASSUMPTIONS, stated: the host's legit score stream must be
 * stationary enough that calibration and future scores are
 * exchangeable; the resulting bound is MARGINAL (a per-step mean
 * bound for a fresh legit step), and the conditional form (A1)
 * - E[x_t | F_{t-1}] <= mu0 at EVERY t - additionally needs the
 * host's traffic to lack adversarially-timed legit bursts beyond
 * the calibrated distribution. The helper makes mu0 measurable;
 * it does not upgrade a marginal bound into a conditional one.
 *
 * HONESTY FLOOR (Amendment 1). A sustained stream with true mean
 * BELOW mu0 lives inside H0 by construction: this engine is blind
 * to it, by design, exactly as the T4 mimicry bound says any
 * transcript-only rule must be. No detection below mu0 is claimed,
 * ever.
 *
 * MULTIPLICITY (Amendment 1, stated not solved). Ville is
 * per-cohort: across N independent legit cohorts at per-cohort
 * alpha, the expected number of lifetime false flags is ~N * alpha
 * and P(at least one) ~ 1 - (1 - alpha)^N. Hosts running many
 * cohorts must budget alpha accordingly; cross-cohort alpha
 * budgeting (e-BH and friends) is a recorded candidate, not built
 * here.
 *
 * CONSEQUENCES. A crossing is evidence only, exactly like a CUSUM
 * flag: the tiering law is untouched, and a host MAY gate step-up
 * friction on an e-crossing the way it gates on a CUSUM flag
 * (checking scale/floor policy host-side). This module restricts
 * nothing by itself. State is in-process memory, as with the
 * CUSUM tripwire in this version.
 */

export interface EvalueTripwireOptions {
  /**
   * The (A1) bound: an upper bound on the legitimate conditional
   * mean of the per-step score x_t, at the host's chosen step
   * granularity. In (0, 1). Default 0.2.
   */
  mu0?: number;
  /** False-flag level of the guarantee; flag at K_t >= 1/alpha. In (0, 1). Default 0.05. */
  alpha?: number;
  /** Host scale constant SCALE in x_t = min(1, novel_t / SCALE). Default 50 records. */
  scaleRecords?: number;
  /**
   * Fixed design alternative mu1* the stake floor is derived from,
   * in (mu0, 1]. Default min(1, 2 * mu0).
   */
  designAlternative?: number;
  /** Shrinkage strength kappa of the plug-in mean toward mu0. Default 20 steps. */
  shrinkKappa?: number;
  /**
   * Primary detector the host acts on: "product" (Ville guarantee,
   * default) or "sr" (Shiryaev-Roberts, ARL guarantee - see the
   * header; the two guarantees are different and not conflated).
   * Both statistics are always tracked; this records the choice.
   */
  detector?: "product" | "sr";
  /** SR threshold B: flag (SR reading) when M_n >= B. Must be > 1. Default 1000. */
  srThreshold?: number;
  /**
   * Fired exactly once per cohort, at the step its capital first
   * crosses 1/alpha. Errors are swallowed: synchronous throws AND
   * asynchronous rejections of a returned promise/thenable alike -
   * host wiring must never break request handling or crash the
   * process at the crossing.
   */
  onCross?: (snapshot: EvalueSnapshot) => void | Promise<void>;
  /**
   * Fired exactly once per cohort, at the step its SR statistic
   * first crosses srThreshold. Errors are swallowed, with the same
   * sync + async discipline as `onCross`.
   */
  onSrCross?: (snapshot: EvalueSnapshot) => void | Promise<void>;
}

export interface EvalueObserveInput {
  /** The cohort this step belongs to (e.g. a CUSUM snapshot's cohortId). */
  cohortId: string;
  /** The acting identity, recorded as a cohort member. Alias: `identity`. */
  identityId?: string;
  identity?: string;
  /** Records served in this step. Alias: `recordIds` (the CUSUM event field). */
  records?: number[];
  recordIds?: number[];
}

export interface EvalueDecision {
  cohortId: string;
  identityId: string | null;
  /** 1-based step index within the cohort (post-merge: joined count). */
  step: number;
  /** The step's score x_t in [0, 1]. */
  score: number;
  /** Records in this step that were new to the cohort union. */
  novelRecords: number;
  /** Records carried by this step (after de-duplication within the step). */
  servedRecords: number;
  /** The predictable stake lambda_t used for this step. */
  lambda: number;
  /** The step's e-value e_t in [0.5, 1 + lambda_max (1 - mu0)]. */
  eValue: number;
  capital: number;
  logCapital: number;
  crossed: boolean;
  /** True only on the step that first crosses 1/alpha. */
  crossedNow: boolean;
  /** SR statistic M_n (saturates at Infinity once srLogStatistic exceeds ~709). */
  srStatistic: number;
  /** log M_n; -Infinity while M_n = 0 (no steps yet). */
  srLogStatistic: number;
  /** True once the SR statistic has crossed srThreshold (latched, separate from `crossed`). */
  srCrossed: boolean;
  /** True only on the step that first crosses srThreshold. */
  srCrossedNow: boolean;
}

export interface EvalueSnapshot {
  cohortId: string;
  capital: number;
  logCapital: number;
  steps: number;
  crossed: boolean;
  /** 1-based step at which capital first crossed 1/alpha, or null. */
  crossedAtStep: number | null;
  /** Distinct records in the cohort's exact served union. */
  unionRecords: number;
  members: string[];
  mu0: number;
  alpha: number;
  /** The crossing threshold 1/alpha. */
  threshold: number;
  lambdaFloor: number;
  lambdaMax: number;
  /** Primary detector recorded at construction: "product" or "sr". */
  detector: "product" | "sr";
  /** SR threshold B in force. */
  srThreshold: number;
  /** SR statistic M_n (saturates at Infinity once srLogStatistic exceeds ~709). */
  srStatistic: number;
  /** log M_n; -Infinity while M_n = 0. */
  srLogStatistic: number;
  /** Latched SR crossing state, separate from the product `crossed`. */
  srCrossed: boolean;
  /** 1-based step at which the SR statistic first crossed srThreshold, or null. */
  srCrossedAtStep: number | null;
}

export interface EvalueTripwire {
  observe(input: EvalueObserveInput): EvalueDecision;
  getSnapshot(cohortId: string): EvalueSnapshot | null;
  /**
   * Merge `sourceCohortId` into `targetCohortId` under the weighted
   * -average rule in the header; the source cohort ceases to exist.
   * Returns the merged snapshot. Throws if either cohort is unknown
   * or the two ids are equal.
   */
  mergeCohorts(targetCohortId: string, sourceCohortId: string): EvalueSnapshot;
  clearCohort(cohortId: string): void;
}

interface CohortState {
  id: string;
  logCapital: number;
  steps: number;
  scoreSum: number;
  union: Set<number>;
  members: Set<string>;
  crossed: boolean;
  crossedAtStep: number | null;
  lastScore: number;
  lastLambda: number;
  srLogStatistic: number;
  srCrossed: boolean;
  srCrossedAtStep: number | null;
}

export interface CalibrateMu0Result {
  /**
   * The calibrated (A1) bound, in (0, 1): quantile + delta when
   * that sum is < 1, otherwise the saturation cap
   * 1 - 1/(n + 1) (see `saturated`). Never a value
   * createEvalueTripwire would reject.
   */
  mu0: number;
  /** The split-conformal upper order statistic of the calibration scores. */
  quantile: number;
  /** Number of calibration scores. */
  n: number;
  /** The miscoverage level the quantile was computed at. */
  delta: number;
  /**
   * Present and `true` ONLY when quantile + delta >= 1, i.e. the
   * proven bound degenerated to the trivial bound 1 and `mu0`
   * was capped to 1 - 1/(n + 1) so the engine can consume it.
   * A saturated `mu0` is not a proven bound; the host should
   * treat the calibration as degenerate (collect more / lower
   * scores, or choose mu0 itself). Absent (not `false`) for
   * ordinary results, so non-saturated results are unchanged.
   */
  saturated?: boolean;
}

function namedCalibrateError(name: string, message: string): RangeError {
  const err = new RangeError(message);
  err.name = name;
  return err;
}

/**
 * Split-conformal calibration of the (A1) bound mu0 from a host's
 * measured legitimate per-step scores (each in [0, 1]). Pure: the
 * input array is not mutated. See the module header for the
 * derivation (E[x] <= q + delta for x in [0, 1]) and the
 * exchangeability / marginal-vs-conditional assumptions.
 *
 * The quantile is the order statistic at 1-indexed position
 * ceil((n + 1) * (1 - delta)), clamped to [1, n], of the sorted
 * calibration scores.
 *
 * Return domain: `mu0` is always in (0, 1), so the result can be
 * passed straight to createEvalueTripwire. When
 * quantile + delta >= 1 the bound saturates: the returned `mu0`
 * is capped at 1 - 1/(n + 1) - the finest step below 1 that n
 * calibration samples can resolve, because split-conformal
 * coverage levels are spaced 1/(n + 1) apart - and the result
 * carries `saturated: true` to signal that the proven bound
 * degenerated to the trivial bound 1 and the capped value is a
 * usable placeholder, not a proven bound. Non-saturated results
 * are exactly what the pre-fix formula returned, with no extra
 * field.
 */
export function calibrateMu0(
  scores: readonly number[],
  options: { delta: number },
): CalibrateMu0Result {
  if (!Array.isArray(scores) || scores.length === 0) {
    throw namedCalibrateError(
      "CalibrateMu0EmptyScoresError",
      "calibrateMu0 requires a non-empty scores array",
    );
  }
  const delta = options?.delta;
  if (typeof delta !== "number" || !Number.isFinite(delta) || !(delta > 0 && delta < 1)) {
    throw namedCalibrateError(
      "CalibrateMu0InvalidDeltaError",
      `calibrateMu0 delta must be in (0, 1), got ${delta}`,
    );
  }
  for (let i = 0; i < scores.length; i++) {
    const value = scores[i] as number;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw namedCalibrateError(
        "CalibrateMu0InvalidScoreError",
        `calibrateMu0 scores must all be in [0, 1]; scores[${i}] is ${value}`,
      );
    }
  }
  const n = scores.length;
  const sorted = [...scores].sort((a, b) => a - b);
  const rawIndex = Math.ceil((n + 1) * (1 - delta));
  const index = Math.min(n, Math.max(1, rawIndex)); // 1-indexed, clamped to [1, n]
  const quantile = sorted[index - 1] as number;
  const rawMu0 = quantile + delta;
  if (rawMu0 < 1) {
    return { mu0: rawMu0, quantile, n, delta };
  }
  // Saturation (EV-3): the proven bound is >= 1, i.e. the trivial
  // bound on [0, 1], but createEvalueTripwire requires mu0 < 1 -
  // never hand back a value the engine refuses. Cap at
  // 1 - 1/(n + 1), the conformal resolution limit for n samples
  // (coverage levels are spaced 1/(n + 1) apart, so nothing
  // between that cap and 1 is certifiable from n samples), and
  // flag the degeneracy so the host does not mistake the capped
  // placeholder for a proven bound.
  const mu0 = 1 - 1 / (n + 1);
  return { mu0, quantile, n, delta, saturated: true };
}

/**
 * Invoke a host crossing callback under the "errors are
 * swallowed" contract (EV-1 fix, mirroring the
 * onConsequenceEligibility discipline in cusum-tripwire.ts).
 * A bare try/catch only swallows SYNCHRONOUS throws: an async
 * callback's rejected promise would otherwise escape as an
 * unhandled rejection - fatal by default in Node - exactly at
 * the crossing. So the return value is inspected: a thenable
 * gets a rejection handler attached synchronously (`.catch()`
 * when available; Promise.resolve assimilation for a bare
 * thenable without one), swallowing async failures too. This
 * helper never throws, so the crossing decision is returned
 * normally whatever the callback does.
 */
function invokeSwallowed(
  callback: ((snapshot: EvalueSnapshot) => void | Promise<void>) | undefined,
  snapshot: EvalueSnapshot,
): void {
  if (!callback) return;
  try {
    const result: unknown = callback(snapshot);
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      const thenable = result as { catch?: unknown };
      if (typeof thenable.catch === "function") {
        (thenable.catch as (onRejected: () => void) => void).call(result, () => undefined);
      } else {
        void Promise.resolve(result as PromiseLike<unknown>).catch(() => undefined);
      }
    }
  } catch {
    /* Host wiring must never break request handling. */
  }
}

/** log(exp(a) + exp(b)), stable for -Infinity and large values. */
function logAddExp(a: number, b: number): number {
  if (a === Number.NEGATIVE_INFINITY) return b;
  if (b === Number.NEGATIVE_INFINITY) return a;
  const peak = Math.max(a, b);
  return peak + Math.log1p(Math.exp(-Math.abs(a - b)));
}

export function createEvalueTripwire(options: EvalueTripwireOptions = {}): EvalueTripwire {
  const mu0 = options.mu0 ?? 0.2;
  if (!Number.isFinite(mu0) || !(mu0 > 0 && mu0 < 1)) throw new RangeError(`mu0 must be in (0, 1), got ${mu0}`);
  const alpha = options.alpha ?? 0.05;
  if (!Number.isFinite(alpha) || !(alpha > 0 && alpha < 1)) throw new RangeError(`alpha must be in (0, 1), got ${alpha}`);
  const scaleRecords = options.scaleRecords ?? 50;
  // Finite check is load-bearing here (EV-2): `Infinity >= 1` is
  // true, so without it scaleRecords = Infinity passed and every
  // score novel/Infinity collapsed to 0 - a silently blind engine.
  if (!Number.isFinite(scaleRecords) || !(scaleRecords >= 1)) {
    throw new RangeError(`scaleRecords must be a finite number >= 1, got ${scaleRecords}`);
  }
  const designAlternative = options.designAlternative ?? Math.min(1, 2 * mu0);
  if (!Number.isFinite(designAlternative) || !(designAlternative > mu0 && designAlternative <= 1)) {
    throw new RangeError(`designAlternative must be in (mu0, 1], got ${designAlternative}`);
  }
  const shrinkKappa = options.shrinkKappa ?? 20;
  // Same EV-2 root as scaleRecords: `Infinity > 0` is true, so an
  // infinite kappa passed and froze the plug-in mean at mu0.
  if (!Number.isFinite(shrinkKappa) || !(shrinkKappa > 0)) {
    throw new RangeError(`shrinkKappa must be a finite number > 0, got ${shrinkKappa}`);
  }
  const detector = options.detector ?? "product";
  if (detector !== "product" && detector !== "sr") {
    throw new RangeError(`detector must be "product" or "sr", got ${detector}`);
  }
  const srThreshold = options.srThreshold ?? 1000;
  if (!(srThreshold > 1) || !Number.isFinite(srThreshold)) {
    throw new RangeError(`srThreshold must be a finite number > 1, got ${srThreshold}`);
  }
  const logSrThreshold = Math.log(srThreshold);

  const threshold = 1 / alpha;
  const logThreshold = Math.log(threshold);
  const lambdaMax = 0.5 / mu0;
  const lambdaDesign = Math.min((designAlternative - mu0) / (mu0 * (1 - mu0)), lambdaMax);
  const lambdaFloor = Math.min(lambdaDesign / 2, lambdaMax);

  const cohorts = new Map<string, CohortState>();

  const ensureCohort = (cohortId: string): CohortState => {
    let cohort = cohorts.get(cohortId);
    if (!cohort) {
      cohort = {
        id: cohortId,
        logCapital: 0,
        steps: 0,
        scoreSum: 0,
        union: new Set(),
        members: new Set(),
        crossed: false,
        crossedAtStep: null,
        lastScore: 0,
        lastLambda: lambdaFloor,
        srLogStatistic: Number.NEGATIVE_INFINITY,
        srCrossed: false,
        srCrossedAtStep: null,
      };
      cohorts.set(cohortId, cohort);
    }
    return cohort;
  };

  const snapshotOf = (cohort: CohortState): EvalueSnapshot => ({
    cohortId: cohort.id,
    capital: Math.exp(cohort.logCapital),
    logCapital: cohort.logCapital,
    steps: cohort.steps,
    crossed: cohort.crossed,
    crossedAtStep: cohort.crossedAtStep,
    unionRecords: cohort.union.size,
    members: [...cohort.members].sort(),
    mu0,
    alpha,
    threshold,
    lambdaFloor,
    lambdaMax,
    detector,
    srThreshold,
    srStatistic: Math.exp(cohort.srLogStatistic),
    srLogStatistic: cohort.srLogStatistic,
    srCrossed: cohort.srCrossed,
    srCrossedAtStep: cohort.srCrossedAtStep,
  });

  /** The predictable stake for the NEXT step, from stored history only. */
  const stakeFor = (cohort: CohortState): number => {
    const muHat = (cohort.scoreSum + shrinkKappa * mu0) / (cohort.steps + shrinkKappa);
    const lambdaRaw = muHat > mu0 ? (muHat - mu0) / (mu0 * (1 - mu0)) : 0;
    const blended = (lambdaDesign + lambdaRaw) / 2;
    return Math.min(lambdaMax, Math.max(lambdaFloor, blended));
  };

  function observe(input: EvalueObserveInput): EvalueDecision {
    if (!input || typeof input.cohortId !== "string" || input.cohortId.length === 0) {
      throw new TypeError("observe requires a non-empty cohortId");
    }
    const cohort = ensureCohort(input.cohortId);
    const identityId = input.identityId ?? input.identity ?? null;
    if (identityId !== null) cohort.members.add(identityId);
    const rawRecords = input.records ?? input.recordIds ?? [];
    // De-duplicate within the step: a record served twice in one
    // step is one served record and can be novel at most once.
    const stepRecords = [...new Set(rawRecords)];
    let novelRecords = 0;
    for (const id of stepRecords) {
      if (!cohort.union.has(id)) {
        cohort.union.add(id);
        novelRecords++;
      }
    }
    const score = Math.min(1, novelRecords / scaleRecords);
    // The stake is computed from history BEFORE this step's score
    // is folded into the running sum - predictability by order of
    // operations, and no stake input exists on the API to override.
    const lambda = stakeFor(cohort);
    const eValue = 1 + lambda * (score - mu0);
    cohort.logCapital += Math.log(eValue);
    // SR update in log space (see header): L_n = log(e_n) +
    // logaddexp(0, L_{n-1}); M_0 = 0 is L_0 = -Infinity.
    cohort.srLogStatistic = Math.log(eValue) + logAddExp(0, cohort.srLogStatistic);
    cohort.steps += 1;
    cohort.scoreSum += score;
    cohort.lastScore = score;
    cohort.lastLambda = lambda;
    let crossedNow = false;
    if (!cohort.crossed && cohort.logCapital >= logThreshold) {
      cohort.crossed = true;
      cohort.crossedAtStep = cohort.steps;
      crossedNow = true;
      invokeSwallowed(options.onCross, snapshotOf(cohort));
    }
    let srCrossedNow = false;
    if (!cohort.srCrossed && cohort.srLogStatistic >= logSrThreshold) {
      cohort.srCrossed = true;
      cohort.srCrossedAtStep = cohort.steps;
      srCrossedNow = true;
      invokeSwallowed(options.onSrCross, snapshotOf(cohort));
    }
    return {
      cohortId: cohort.id,
      identityId,
      step: cohort.steps,
      score,
      novelRecords,
      servedRecords: stepRecords.length,
      lambda,
      eValue,
      capital: Math.exp(cohort.logCapital),
      logCapital: cohort.logCapital,
      crossed: cohort.crossed,
      crossedNow,
      srStatistic: Math.exp(cohort.srLogStatistic),
      srLogStatistic: cohort.srLogStatistic,
      srCrossed: cohort.srCrossed,
      srCrossedNow,
    };
  }

  function getSnapshot(cohortId: string): EvalueSnapshot | null {
    const cohort = cohorts.get(cohortId);
    return cohort ? snapshotOf(cohort) : null;
  }

  function mergeCohorts(targetCohortId: string, sourceCohortId: string): EvalueSnapshot {
    if (targetCohortId === sourceCohortId) {
      throw new RangeError("mergeCohorts requires two distinct cohort ids");
    }
    const target = cohorts.get(targetCohortId);
    const source = cohorts.get(sourceCohortId);
    if (!target) throw new RangeError(`unknown target cohort: ${targetCohortId}`);
    if (!source) throw new RangeError(`unknown source cohort: ${sourceCohortId}`);
    const totalSteps = target.steps + source.steps;
    if (totalSteps > 0) {
      // Weighted average in log space: log( (n_a e^{L_a} + n_b e^{L_b}) / (n_a + n_b) ).
      const wTarget = target.steps / totalSteps;
      const wSource = source.steps / totalSteps;
      const terms: Array<[number, number]> = [];
      if (wTarget > 0) terms.push([target.logCapital, Math.log(wTarget)]);
      if (wSource > 0) terms.push([source.logCapital, Math.log(wSource)]);
      const peak = Math.max(...terms.map(([logK, logW]) => logK + logW));
      let sum = 0;
      for (const [logK, logW] of terms) sum += Math.exp(logK + logW - peak);
      target.logCapital = peak + Math.log(sum);
    } else {
      target.logCapital = 0; // Both constituents are fresh: K = 1.
    }
    target.steps = totalSteps;
    target.scoreSum += source.scoreSum;
    for (const id of source.union) target.union.add(id);
    for (const member of source.members) target.members.add(member);
    if (source.crossed && !target.crossed) {
      target.crossed = true;
      target.crossedAtStep = source.crossedAtStep;
    } else if (source.crossed && target.crossed) {
      target.crossedAtStep = Math.min(
        target.crossedAtStep ?? Number.POSITIVE_INFINITY,
        source.crossedAtStep ?? Number.POSITIVE_INFINITY,
      );
    }
    // No new latch can arise from the merge itself: an average of
    // two sub-threshold capitals is sub-threshold. The latch above
    // (either constituent already crossed) is therefore the
    // complete merge-crossing rule.
    // SR merge (header rule): step-weighted average of the two M
    // values, in log space. A constituent with M = 0 (log = -inf)
    // contributes a zero term and is skipped; if both are zero the
    // merged statistic stays zero. The ARL reading of this average
    // is approximate after merges (header caveat).
    if (totalSteps > 0) {
      // Constituent step counts: target.steps was overwritten with
      // totalSteps above, so recover the target's own count as
      // (totalSteps - sourceSteps); source.steps is unchanged.
      const sourceSteps = source.steps;
      const targetSteps = totalSteps - sourceSteps;
      const candidates: Array<[number, number]> = [
        [target.srLogStatistic, targetSteps],
        [source.srLogStatistic, sourceSteps],
      ];
      let peak = Number.NEGATIVE_INFINITY;
      for (const [logM, n] of candidates) {
        if (n > 0 && logM > Number.NEGATIVE_INFINITY) {
          peak = Math.max(peak, logM + Math.log(n / totalSteps));
        }
      }
      if (peak === Number.NEGATIVE_INFINITY) {
        target.srLogStatistic = Number.NEGATIVE_INFINITY;
      } else {
        let sum = 0;
        for (const [logM, n] of candidates) {
          if (n > 0 && logM > Number.NEGATIVE_INFINITY) {
            sum += Math.exp(logM + Math.log(n / totalSteps) - peak);
          }
        }
        target.srLogStatistic = peak + Math.log(sum);
      }
    } else {
      target.srLogStatistic = Number.NEGATIVE_INFINITY; // Both fresh: M = 0.
    }
    if (source.srCrossed && !target.srCrossed) {
      target.srCrossed = true;
      target.srCrossedAtStep = source.srCrossedAtStep;
    } else if (source.srCrossed && target.srCrossed) {
      target.srCrossedAtStep = Math.min(
        target.srCrossedAtStep ?? Number.POSITIVE_INFINITY,
        source.srCrossedAtStep ?? Number.POSITIVE_INFINITY,
      );
    }
    cohorts.delete(sourceCohortId);
    return snapshotOf(target);
  }

  function clearCohort(cohortId: string): void {
    cohorts.delete(cohortId);
  }

  return { observe, getSnapshot, mergeCohorts, clearCohort };
}
