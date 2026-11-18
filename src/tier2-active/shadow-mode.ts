/**
 * Shadow mode (NHS-14, antiRea 3.1.0): a formalized global
 * observe-only mode pattern.
 *
 * WHAT IT IS. antiRea already defaults its tier-2 signals to
 * observe; this module formalizes the OPERATING MODE the NHS lab
 * measured (nhs-lab/nhs14.cjs, RESULTS-NHS-STEP0.md; mechanism
 * source: the shadow branch of ngx_http_sentinel_module.c) as a
 * reusable wrapper the host puts around its own computed decisions:
 * in shadow mode the wrapper computes, logs and counts everything
 * and enforces NOTHING - every request is served normally, no
 * tarpit is reserved, and no ban or soft-ban state persists (the
 * wrapper holds no consequence state at all, structurally: its only
 * state is the log list and the shadow counter). In enforce mode
 * the same wrapper passes the verdict through as the outcome.
 *
 * COUNTING: shadow_total increments by exactly the shadow requests
 * whose computed verdict is tarpit or block (the same law as the
 * NHS-13 metrics surface). Every decision log carries score +
 * verdict + the shadow flag, in both modes.
 *
 * LAB EVIDENCE (Step-0, synthetic fixture scorer; the PASS certifies
 * an operating mode, not a signal). 6/6 shadow requests served
 * normally, 0 enforced; 6/6 decision logs carry score + verdict +
 * shadow flag; shadow_total increments by exactly 3 (the tarpit and
 * block rows); no soft-ban state persists, and the follow-up
 * enforce-mode request from the block-verdict identity is served.
 * Descriptive contrast: the same six decisions in enforce mode
 * produce [served, challenge, tarpit, block, tarpit, served].
 */

export type ShadowModeVerdict = "allow" | "challenge" | "tarpit" | "block";
export type ShadowMode = "shadow" | "enforce";

export interface ShadowDecisionInput {
  identity?: string;
  score: number;
  verdict: ShadowModeVerdict;
}

export interface ShadowDecisionLog {
  identity: string | null;
  score: number;
  verdict: ShadowModeVerdict;
  /** 1 in shadow mode, 0 in enforce mode (the lab's log shape). */
  shadow: 0 | 1;
}

export interface ShadowDecisionOutcome {
  /** What the client experiences: "served" in shadow mode, always. */
  outcome: "served" | ShadowModeVerdict;
  served: boolean;
  enforced: boolean;
  log: ShadowDecisionLog;
}

const VERDICTS: ReadonlySet<string> = new Set(["allow", "challenge", "tarpit", "block"]);

/**
 * Create a mode wrapper session. Opt-in: the host routes its
 * computed decisions through evaluate() and acts on `outcome`.
 * Switching mode is a host decision via setMode(); the session
 * itself persists no bans in either mode.
 */
export function createShadowMode(options: { mode?: ShadowMode } = {}): {
  evaluate(input: ShadowDecisionInput): ShadowDecisionOutcome;
  setMode(mode: ShadowMode): void;
  mode(): ShadowMode;
  /** Shadow tarpit/block count (the NHS-13 shadow_total law). */
  shadowTotal(): number;
  logs(): readonly ShadowDecisionLog[];
} {
  let mode: ShadowMode = options.mode ?? "shadow";
  let shadowTotal = 0;
  const logs: ShadowDecisionLog[] = [];

  function evaluate(input: ShadowDecisionInput): ShadowDecisionOutcome {
    if (typeof input !== "object" || input === null || !VERDICTS.has(input.verdict as string) || !Number.isFinite(input.score)) {
      throw new TypeError("shadow mode: input must carry a finite score and a known verdict");
    }
    const shadow = mode === "shadow";
    const log: ShadowDecisionLog = {
      identity: typeof input.identity === "string" ? input.identity : null,
      score: input.score,
      verdict: input.verdict,
      shadow: shadow ? 1 : 0,
    };
    logs.push(log);
    if (shadow) {
      if (input.verdict === "tarpit" || input.verdict === "block") shadowTotal++;
      return { outcome: "served", served: true, enforced: false, log };
    }
    return {
      outcome: input.verdict === "allow" ? "served" : input.verdict,
      served: input.verdict === "allow",
      enforced: input.verdict !== "allow",
      log,
    };
  }

  return {
    evaluate,
    setMode(m: ShadowMode) {
      if (m !== "shadow" && m !== "enforce") throw new TypeError("shadow mode: mode must be shadow or enforce");
      mode = m;
    },
    mode: () => mode,
    shadowTotal: () => shadowTotal,
    logs: () => [...logs],
  };
}
