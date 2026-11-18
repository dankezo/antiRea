/**
 * Rule-state taxonomy (WDN-09, WebDecoy rule-engine / decision port).
 *
 * Every rule outcome carries a STATE that tells the operator whether
 * the rule actually ran:
 * - RUN: the rule evaluated and its conclusion is its own.
 * - DRY_RUN: the rule evaluated in dry-run mode. Its conclusion still
 *   reports what it WOULD do (a dry-run DENY concludes DENY), but it
 *   never decides the engine outcome and `deniedBy` is false for it -
 *   "would deny" stays visible without impersonating a denial.
 * - NOT_RUN: the rule never evaluated because an input it needs was
 *   missing (for example an ip.* filter with no enrichment, or an
 *   async-store rule that was not prepared). A missing input is never
 *   reported as a run with an empty result.
 * - CACHED: the outcome is a restated copy of an earlier decision
 *   (see `asCachedRuleDecision`). A cached copy never denies:
 *   `deniedBy` is false for every CACHED result.
 *
 * Measured in the WDN Step-0 lab (wdn-lab/wdn09.cjs) on frozen
 * fixtures: plain DENY labelled RUN / conclusion DENY and decides;
 * dry-run DENY labelled DRY_RUN with action ALLOW, conclusion DENY,
 * engine not decided, deniedBy false; both missing-input rules
 * labelled NOT_RUN; asCached() restates every result CACHED with
 * deniedBy false.
 *
 * Integration: antiRea has no single central evaluate() - each module
 * evaluates its own surface - so this ships as a standalone, opt-in
 * semantics layer a host (or a future rule engine) applies to its own
 * rule results. Nothing in the SDK calls it implicitly, and it changes
 * no existing module's behaviour.
 *
 * Pure computation: no I/O, no state, no runtime dependencies.
 */

export type RuleState = "RUN" | "DRY_RUN" | "NOT_RUN" | "CACHED";
export type RuleAction = "ALLOW" | "DENY" | "CHALLENGE";
export type RuleConclusion = "ALLOW" | "DENY";

/** A raw rule result as a host rule produces it, before outcome mapping. */
export interface RawRuleResult {
  rule: string;
  action: RuleAction;
  /** An explicit state wins over the dryRun derivation (the NOT_RUN branch sets it). */
  state?: RuleState;
  reason?: string;
  metadata?: { dryRun?: boolean; [key: string]: unknown };
}

/** A rule outcome after taxonomy mapping: state and conclusion kept distinct from the raw action. */
export interface RuleOutcome {
  rule: string;
  state: RuleState;
  /** DENY when the rule is a dry-run or its action is not ALLOW; otherwise the action itself. */
  conclusion: RuleConclusion;
  action: RuleAction;
  reason?: string;
}

/**
 * Map a raw rule result to its taxonomy outcome (the lab's
 * rule-engine mapping): state is the explicit state when present, else
 * DRY_RUN for a dry-run result, else RUN; conclusion is DENY when the
 * rule is a dry-run or its action is not ALLOW.
 */
export function toRuleOutcome(result: RawRuleResult): RuleOutcome {
  const dryRun = result.metadata?.dryRun === true;
  const outcome: RuleOutcome = {
    rule: result.rule,
    state: result.state ?? (dryRun ? "DRY_RUN" : "RUN"),
    conclusion: dryRun || result.action !== "ALLOW" ? "DENY" : "ALLOW",
    action: result.action,
  };
  if (result.reason !== undefined) outcome.reason = result.reason;
  return outcome;
}

export interface RuleDecision {
  results: RuleOutcome[];
}

/**
 * The engine decision over a set of raw results: the first non-ALLOW
 * result that is not a dry-run decides. Dry-run and NOT_RUN results
 * never decide. Returns "ALLOW" when nothing decides.
 */
export function decideFromRuleResults(results: readonly RawRuleResult[]): RuleAction {
  for (const r of results) {
    if (r.state === "NOT_RUN") continue;
    if (r.action !== "ALLOW" && !(r.metadata?.dryRun === true)) return r.action;
  }
  return "ALLOW";
}

/** True exactly when some outcome for `rule` is a real denial: state RUN and conclusion DENY. */
export function deniedBy(decision: RuleDecision, rule: string): boolean {
  return decision.results.some((r) => r.rule === rule && r.state === "RUN" && r.conclusion === "DENY");
}

/** Restate every result of a decision as CACHED. A cached copy never denies (see deniedBy). */
export function asCachedRuleDecision<T extends RuleDecision>(decision: T): T {
  return { ...decision, results: decision.results.map((r) => ({ ...r, state: "CACHED" as RuleState })) };
}
