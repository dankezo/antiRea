/**
 * PoW identity-creation friction policy (C38 POW-LADDER, PASS-lab
 * for the identity-creation leg ONLY; the step-up leg is KILL).
 * Lab record: c38-lab/C38-DESIGN.md (frozen law) and
 * c38-lab/C38-RESULTS.md (this run's numbers, not the old probe's).
 *
 * WHAT IT IS. A pure policy helper that computes the friction
 * VALUES for a host identity-creation flow: given a proof-of-work
 * difficulty d (leading zero bits), it reports the measured solve
 * times, the frozen gate outcome, the sybil cost arithmetic, and
 * the asymmetry - as numbers the host's own product decision can
 * rest on. Per the CAP-01 conclusion, hosts plug in their own
 * verifiers: antiRea does NOT bundle the challenge itself. This
 * module issues no challenge, verifies no solution, and gates no
 * request; it has no enforcement surface at all. The host decides
 * whether seconds of friction belong on its registration path and
 * wires its own challenge lifecycle (issuance, expiry, replay,
 * accessibility fallback) if it decides they do.
 *
 * THE FROZEN GATE (C38-DESIGN section 2, identity-creation leg).
 * PASS-lab as equal-rank cost friction iff some d has: median
 * browser solve time in [2, 20] s AND median native solve time at
 * the same d >= 1 s (the tax is not purely regressive onto
 * browser users). d20 passes both legs on the measured numbers.
 *
 * MEASURED NUMBERS (this lab run; SHA-256; Chromium 156.0.8078.4
 * headless and native Node, both on the lab VM's server-grade
 * CPU - see the scope limits below):
 * - Hash rates: native 457,029 /s; pure-JS single-thread in
 *   Chromium 63,148 /s (test-vector verified in-page before
 *   measuring); SubtleCrypto per-call 107,143 /s.
 * - Median solve times, native: d18 0.69 s, d20 2.45 s,
 *   d22 12.39 s, d24 27.47 s.
 * - Median solve times, browser (pure JS): d18 3.66 s (6/6
 *   samples), d20 6.62 s (6/6 samples). d22 and d24 completed NO
 *   samples inside the shared 120 s budget; the ~66 s / ~266 s
 *   figures for them are arithmetic from the measured JS rate
 *   (2^d / rate), NOT solve measurements, and this module reports
 *   them only as rate-implied estimates flagged as such.
 *
 * THE REVERSED ASYMMETRY (recorded verbatim from the lab, never
 * softened). The asymmetry runs AGAINST the defender: a real
 * browser user pays 6.62 s while a native attacker pays 2.45 s
 * for the same ticket - 2.7x LESS. A native sybil farm pays
 * ~2.45 core-seconds per identity (10,000 identities is ~6.8
 * core-hours, freely parallelisable). A GPU attacker pays
 * effectively nothing: SHA-256 on GPU runs at 10^9-10^10
 * hashes/s, so d20 is a fraction of a millisecond. PoW here is a
 * linear tax on a CPU-bound attacker and a LARGER tax on the
 * host's own legitimate browser users. Any host adopting d20
 * adopts it with that sentence attached.
 *
 * THE STEP-UP LEG IS KILL - DO NOT BUILD IT. Step-up placement
 * depends on a trigger that decides who gets taxed, and the
 * measured trigger evidence kills it: the relative trigger fired
 * on 99.9% of legitimate users over 90 days and 0% of the RAMP
 * cells (C33, same lab round; memo V9 circularity). There is no
 * measured trigger that delivers PoW to the identities that need
 * taxing without taxing everyone. `evaluatePowStepUp` therefore
 * returns the KILL verdict unconditionally; this module will
 * never return a step-up difficulty.
 *
 * SCOPE LIMITS (the memo's quarantine, kept). Every number above
 * was measured on a server-grade CPU. MOBILE IS UNMEASURED: a
 * weak phone may be many times slower, and the lab's tax numbers
 * do not transfer to mobile until measured on real client
 * hardware. Solve times are also a distribution, not a point:
 * the median is the middle user's wait, not the worst. Sample
 * sizes at d18/d20 were 6/6 per cell - thin next to the SDK's
 * population-scale FP corpora, which is one more reason this
 * ships as a policy helper for a host decision, not as a
 * calibrated control.
 *
 * Pure computation: no I/O, no state, no runtime dependencies.
 */

/** SHA-256 hashes per second measured natively (Node, lab VM) in the C38 run. */
export const POW_NATIVE_HASH_RATE_PER_SEC = 457_029;
/** SHA-256 hashes per second measured with pure JS in Chromium (lab VM) in the C38 run. */
export const POW_BROWSER_JS_HASH_RATE_PER_SEC = 63_148;
/** SHA-256 hashes per second measured via SubtleCrypto per-call in Chromium (lab VM). */
export const POW_SUBTLE_CRYPTO_HASH_RATE_PER_SEC = 107_143;

/** The difficulty the frozen gate passes at (identity-creation leg). */
export const POW_IDENTITY_FRICTION_DIFFICULTY = 20;
/** Frozen gate bounds: browser median must lie in [2, 20] s. */
export const POW_GATE_BROWSER_MIN_SEC = 2;
export const POW_GATE_BROWSER_MAX_SEC = 20;
/** Frozen gate bound: native median at the same d must be >= 1 s. */
export const POW_GATE_NATIVE_MIN_SEC = 1;

interface MeasuredRow {
  nativeMedianSec: number | null;
  browserMedianSec: number | null;
}

/**
 * Measured median solve times from the C38 run. `null` means NOT
 * measured at that difficulty (browser d22/d24 completed no
 * samples); estimates for those cells come from
 * `expectedPowSolveSec`, never from this table.
 */
export const POW_MEASURED_MEDIAN_SEC: Readonly<Record<number, MeasuredRow>> = Object.freeze({
  18: { nativeMedianSec: 0.69, browserMedianSec: 3.66 },
  20: { nativeMedianSec: 2.45, browserMedianSec: 6.62 },
  22: { nativeMedianSec: 12.39, browserMedianSec: null },
  24: { nativeMedianSec: 27.47, browserMedianSec: null },
});

/** Named error thrown for every invalid PoW friction policy input. */
export class PowFrictionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowFrictionPolicyError";
  }
}

const fail = (message: string): never => {
  throw new PowFrictionPolicyError(`pow friction policy: ${message}`);
};

function checkDifficulty(d: unknown): number {
  if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 64) {
    fail("difficulty must be an integer between 0 and 64 (leading zero bits)");
  }
  return d as number;
}

function checkRate(rate: unknown): number {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    fail("hashRatePerSec must be a finite number > 0");
  }
  return rate as number;
}

/**
 * Expected (mean) solve time in seconds for difficulty `d` at a
 * given hash rate: 2^d / rate. This is the rate model the lab
 * used for its d22/d24 browser extrapolations (~66 s / ~266 s);
 * it is an expectation over a wide distribution, not a median,
 * and it is not a measurement.
 */
export function expectedPowSolveSec(difficulty: number, hashRatePerSec: number): number {
  const d = checkDifficulty(difficulty);
  const rate = checkRate(hashRatePerSec);
  return Math.pow(2, d) / rate;
}

export interface PowIdentityFrictionEvaluation {
  difficulty: number;
  /** Measured median browser solve time, or null when unmeasured at this d. */
  browserMedianSec: number | null;
  /** Measured median native solve time, or null when unmeasured at this d. */
  nativeMedianSec: number | null;
  /** Rate-implied expected browser solve time (model, not a measurement). */
  browserExpectedSec: number;
  /** Rate-implied expected native solve time (model, not a measurement). */
  nativeExpectedSec: number;
  /** True when the browser median was actually measured at this d. */
  browserMeasured: boolean;
  /** Frozen gate leg 1: measured browser median in [2, 20] s. False when unmeasured. */
  browserGatePass: boolean;
  /** Frozen gate leg 2: measured native median >= 1 s. False when unmeasured. */
  nativeGatePass: boolean;
  /** The frozen PASS-lab verdict for this difficulty (both legs, measured numbers only). */
  passLeg: boolean;
  /**
   * Browser median / native median at this d (measured pair
   * only), or null. At d20 this is ~2.70: the browser user pays
   * MORE than the native attacker - the reversed asymmetry.
   */
  asymmetryRatio: number | null;
  /** Always "reversed" when a measured pair exists: the defender-side user pays more. */
  asymmetryDirection: "reversed" | null;
  /** Native core-seconds a sybil farm pays per identity at this d (measured median; model when unmeasured). */
  nativeCoreSecPerIdentity: number;
  /** Core-hours for 10,000 identities at the native per-identity cost (lab arithmetic at d20: ~6.8). */
  coreHoursPer10000Identities: number;
  /** Mobile solve time: never measured in the lab. Always "unmeasured" in this build. */
  mobile: "unmeasured";
  notice: string;
}

const ASYMMETRY_NOTICE =
  "Reversed asymmetry (lab record): at d20 a real browser user pays 6.62 s while a native attacker pays " +
  "2.45 s for the same ticket (2.7x less), a native sybil farm pays ~2.45 core-seconds per identity " +
  "(10,000 identities ~6.8 core-hours, freely parallelisable), and a GPU attacker pays effectively " +
  "nothing (SHA-256 at 10^9-10^10 hashes/s makes d20 a fraction of a millisecond). All measured " +
  "numbers are from a server-grade CPU; mobile is unmeasured and these tax numbers do not transfer to it.";

/**
 * Evaluate one difficulty against the frozen C38 gate, on the
 * measured medians. Difficulties without a measured browser
 * median can never pass: the gate is a claim about measured
 * medians, and a rate-implied estimate is not one.
 */
export function evaluatePowIdentityFriction(difficulty: number): PowIdentityFrictionEvaluation {
  const d = checkDifficulty(difficulty);
  const row = POW_MEASURED_MEDIAN_SEC[d];
  const browserMedianSec = row ? row.browserMedianSec : null;
  const nativeMedianSec = row ? row.nativeMedianSec : null;
  const browserExpectedSec = expectedPowSolveSec(d, POW_BROWSER_JS_HASH_RATE_PER_SEC);
  const nativeExpectedSec = expectedPowSolveSec(d, POW_NATIVE_HASH_RATE_PER_SEC);
  const browserGatePass =
    browserMedianSec !== null && browserMedianSec >= POW_GATE_BROWSER_MIN_SEC && browserMedianSec <= POW_GATE_BROWSER_MAX_SEC;
  const nativeGatePass = nativeMedianSec !== null && nativeMedianSec >= POW_GATE_NATIVE_MIN_SEC;
  const perIdentity = nativeMedianSec !== null ? nativeMedianSec : nativeExpectedSec;
  return {
    difficulty: d,
    browserMedianSec,
    nativeMedianSec,
    browserExpectedSec,
    nativeExpectedSec,
    browserMeasured: browserMedianSec !== null,
    browserGatePass,
    nativeGatePass,
    passLeg: browserGatePass && nativeGatePass,
    asymmetryRatio:
      browserMedianSec !== null && nativeMedianSec !== null ? browserMedianSec / nativeMedianSec : null,
    asymmetryDirection: browserMedianSec !== null && nativeMedianSec !== null ? "reversed" : null,
    nativeCoreSecPerIdentity: perIdentity,
    coreHoursPer10000Identities: (perIdentity * 10_000) / 3600,
    mobile: "unmeasured",
    notice: ASYMMETRY_NOTICE,
  };
}

/**
 * The recommended identity-creation friction policy: the one
 * difficulty the frozen gate passes on measured numbers (d20),
 * with its full evaluation attached. This is a policy VALUE for
 * the host's own challenge wiring, not a challenge.
 */
export function powIdentityFrictionPolicy(): PowIdentityFrictionEvaluation {
  return evaluatePowIdentityFriction(POW_IDENTITY_FRICTION_DIFFICULTY);
}

export interface PowStepUpVerdict {
  /** Always "KILL": the step-up leg must not be built or wired. */
  verdict: "KILL";
  /** Always false: this module never returns a step-up difficulty. */
  allowed: false;
  reason: string;
}

/**
 * The step-up leg of C38 is KILL (trigger dependence: the
 * measured relative trigger fired on 99.9% of legitimate users
 * over 90 days and 0% of the RAMP cells, so no measured trigger
 * delivers PoW to the identities that need taxing). This
 * function exists so a host asking for a step-up difficulty gets
 * the verdict, not a number.
 */
export function evaluatePowStepUp(): PowStepUpVerdict {
  return {
    verdict: "KILL",
    allowed: false,
    reason:
      "step-up placement is KILL by trigger dependence (C38-DESIGN/C38-RESULTS): the measured relative " +
      "trigger fired on 99.9% of legitimate users over 90 days and 0% of RAMP cells, so PoW cannot be " +
      "delivered to the identities that need taxing without taxing everyone; no step-up difficulty exists",
  };
}
