/**
 * Throttle / shield response fork (NHS-16, antiRea 3.1.0) - the
 * egress-cap shield fork only. The tarpit drip leg is DROPPED.
 *
 * WHAT WAS MEASURED (NHS Step-0 lab, nhs-lab/nhs16.cjs,
 * RESULTS-NHS-STEP0.md; mechanism source: the verdict dispatch in
 * ngx_http_sentinel_module.c): three forks, in precedence order -
 *   throttle: serve with throttled=1 and an egress cap (the native
 *     rate limit), the request proceeds, origin touched, no drip;
 *   shield: serve from cache with shield=1, origin UNTOUCHED, no
 *     drip;
 *   neither: fall through to a tarpit drip.
 * Both-set rows take the throttle fork.
 *
 * THE UPGRADE AND ITS GAP. This build ships the two serve forks as
 * an opt-in response-shaping decision (a pure function returning
 * the fork shape; the host's server performs the actual capping or
 * cache service - antiRea shapes the decision, it does not sit in
 * the response path). The neither-row does NOT fall through to a
 * tarpit drip here: tarpit mechanisms are against the recorded
 * house rule, so the neither fork is an explicit "fallthrough"
 * result with drip permanently false, and the host decides what its
 * own default response is. That dropped leg is a deliberate,
 * documented gap relative to the lab form, not an oversight.
 */

export interface ResponseForkInput {
  /** Egress cap in bytes per second; a positive value selects the throttle fork. */
  throttleRate?: number;
  /** True when the host's shield (cache-only service) is engaged. */
  shield?: boolean;
}

export interface ResponseForkResult {
  kind: "response_fork";
  action: "serve" | "serve-cache" | "fallthrough";
  throttled: 0 | 1;
  shield: 0 | 1;
  /** The egress cap for the throttle fork; null otherwise. */
  egressCapBytesPerSec: number | null;
  /** False exactly on the shield fork (cache service never touches origin). */
  originTouched: boolean;
  /** Always false in antiRea form: the lab's tarpit drip leg is dropped (house rule). */
  drip: false;
}

/**
 * Resolve the response fork for one request. Pure, opt-in decision
 * shaping: throttle wins over shield, shield wins over fallthrough.
 */
export function resolveResponseFork(input: ResponseForkInput): ResponseForkResult {
  const rate = input?.throttleRate ?? 0;
  if (typeof rate === "number" && rate > 0) {
    return {
      kind: "response_fork",
      action: "serve",
      throttled: 1,
      shield: 0,
      egressCapBytesPerSec: rate,
      originTouched: true,
      drip: false,
    };
  }
  if (input?.shield === true) {
    return {
      kind: "response_fork",
      action: "serve-cache",
      throttled: 0,
      shield: 1,
      egressCapBytesPerSec: null,
      originTouched: false,
      drip: false,
    };
  }
  return {
    kind: "response_fork",
    action: "fallthrough",
    throttled: 0,
    shield: 0,
    egressCapBytesPerSec: null,
    originTouched: true,
    drip: false,
  };
}
