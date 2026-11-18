/**
 * Test-trigger reserved User-Agent (WDN-08, WebDecoy test-trigger port).
 *
 * A reserved UA prefix lets a host smoke-test its own deployment through
 * the real request pipeline: a request whose User-Agent STARTS with the
 * prefix (after trimStart, case-insensitive) short-circuits BEFORE any
 * rule evaluation and returns a LABELLED test decision. The decision is
 * excluded from stats by contract (hosts must skip any decision with
 * `isTestTrigger: true` in their stats/billing accounting; the flag is
 * on the decision precisely so that exclusion is mechanical).
 *
 * Measured in the WDN Step-0 lab (wdn-lab/wdn08.cjs, frozen fixtures):
 * the exact prefix triggers with the labelled decision (bot_detected
 * true, bot_type "test_trigger", rule_enforced false); the lowercase
 * form triggers; an EMBEDDED occurrence ("Mozilla/5.0 WebDecoy-Test/1.0")
 * does NOT trigger and the normal pipeline runs; a browser UA does not
 * trigger; the test UA aimed at the tripwire path still produces only
 * the test decision - 0 rule evaluations, 0 violations, stats
 * accumulator unchanged. A UA with leading spaces triggers (trimStart).
 *
 * Opt-in: nothing in the SDK calls this by itself. The host wires
 * `checkTestTrigger` (or the `createTestTriggerGuard` wrapper) at the
 * top of its own decide() path, before its rules. The prefix is
 * configurable but defaults to the lab's reserved value; a host that
 * picks a custom prefix owns the collision risk with real clients.
 *
 * Honesty scope: the trigger is a self-declared UA string, so anyone
 * can send it. That is safe only because the test decision grants
 * nothing, enforces nothing and reports nothing as a violation - it is
 * a labelled no-op. Never attach a privilege to it.
 *
 * Pure computation: no I/O, no state, no runtime dependencies.
 */

/** The reserved test-trigger UA prefix from the lab registration. */
export const TEST_TRIGGER_UA_PREFIX = "WebDecoy-Test/";

export interface TestTriggerDecision {
  kind: "test_trigger";
  /** Marker hosts use to exclude this decision from stats/billing accounting. Always true. */
  isTestTrigger: true;
  /** The lab decision shape: conclusion DENY, but nothing was enforced. */
  conclusion: "DENY";
  botDetected: true;
  botType: "test_trigger";
  /** Always false: no rule ran, so nothing was enforced. */
  ruleEnforced: false;
  /** Present only when no apiKey is configured: an honest note that nothing reached any dashboard. */
  error?: string;
}

export interface TestTriggerOptions {
  /** Reserved prefix. Default TEST_TRIGGER_UA_PREFIX. Compared after trimStart, case-insensitively, anchored at the start. */
  prefix?: string;
  /** Whether the host has an apiKey configured for reporting. Default false, which puts the honest no-key note on the decision. */
  apiKeyConfigured?: boolean;
}

/**
 * True when the User-Agent carries the reserved prefix at its start
 * (leading whitespace ignored, case-insensitive). An occurrence
 * anywhere else in the string does NOT trigger.
 */
export function isTestTriggerUserAgent(
  userAgent: string | null | undefined,
  prefix: string = TEST_TRIGGER_UA_PREFIX,
): boolean {
  if (!userAgent) return false;
  return userAgent.trimStart().toLowerCase().startsWith(prefix.toLowerCase());
}

/** Build the labelled test decision for a triggering request. */
export function createTestTriggerDecision(opts: TestTriggerOptions = {}): TestTriggerDecision {
  const decision: TestTriggerDecision = {
    kind: "test_trigger",
    isTestTrigger: true,
    conclusion: "DENY",
    botDetected: true,
    botType: "test_trigger",
    ruleEnforced: false,
  };
  if (opts.apiKeyConfigured !== true) {
    decision.error = "Test trigger recognized, but no apiKey is configured - nothing was reported to the dashboard.";
  }
  return decision;
}

/**
 * The pipeline check: returns the labelled test decision when the UA
 * triggers, or null when the request must flow into normal rule
 * evaluation. Call this BEFORE any rule runs.
 */
export function checkTestTrigger(
  userAgent: string | null | undefined,
  opts: TestTriggerOptions = {},
): TestTriggerDecision | null {
  if (!isTestTriggerUserAgent(userAgent, opts.prefix ?? TEST_TRIGGER_UA_PREFIX)) return null;
  return createTestTriggerDecision(opts);
}

export interface TestTriggerGuard {
  isTestTrigger(userAgent: string | null | undefined): boolean;
  check(userAgent: string | null | undefined): TestTriggerDecision | null;
  /**
   * Wrap a host decide function: a triggering request returns the test
   * decision WITHOUT calling `runRules`; any other request is passed
   * through untouched. Rule evaluations, violations and stats therefore
   * stay at zero contribution on the tripwire path by construction.
   */
  guard<T>(userAgent: string | null | undefined, runRules: () => T): TestTriggerDecision | T;
}

/** Create a guard bound to one prefix / apiKey configuration. */
export function createTestTriggerGuard(opts: TestTriggerOptions = {}): TestTriggerGuard {
  const prefix = opts.prefix ?? TEST_TRIGGER_UA_PREFIX;
  return {
    isTestTrigger: (ua) => isTestTriggerUserAgent(ua, prefix),
    check: (ua) => checkTestTrigger(ua, opts),
    guard: (ua, runRules) => checkTestTrigger(ua, opts) ?? runRules(),
  };
}
