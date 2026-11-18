/**
 * Bot policy publish-and-enforce (WDN-04, WebDecoy bot-policy port).
 *
 * One BotPolicy object resolves its matched set ONCE from the WDN-03
 * registry; robots.txt publication and request enforcement both read
 * that same resolved set, so the published file and the middleware
 * cannot drift apart. Allow-listing wins over denial in both halves:
 * an allow-listed agent is excluded from the matched set, gets no
 * robots.txt group, and the enforcement rule returns ALLOW for it.
 *
 * Measured in the WDN Step-0 lab (wdn-lab/wdn04.cjs) on the frozen
 * policy deny ["training_crawler"], allow ["perplexitybot"]: matched
 * set exactly 32 agents; robotsTxt() carries the GPTBot Disallow group,
 * no PerplexityBot group, and the User-agent: * allowOthers group; all
 * 9 unenforceable matched agents (those with respectsRobots !== true:
 * bytespider, webzio, sentibot, omgili, img2dataset,
 * velenpublicwebcrawler, isscyberriskcrawler, moonshotbot,
 * chatglm-spider) are NAMED in the annotation block, because the file
 * itself must say which lines are request-only; enforcement outcomes
 * exact (GPTBot DENY, ByteSpider DENY - the rule stops what robots.txt
 * cannot - PerplexityBot ALLOW, Googlebot ALLOW).
 *
 * Honesty scope: the robots.txt half binds only cooperative agents.
 * The enforcement half is a host decision surface: `evaluate` returns
 * an action, it does not block anything by itself, and a registry
 * label remains self-declared-UA telemetry - never proof of identity.
 *
 * Opt-in: nothing runs until the host creates a policy. Pure
 * computation: no I/O, no state beyond the resolved set.
 */

import {
  BOT_REGISTRY,
  BOT_REGISTRY_AI_CATEGORIES,
  BOT_REGISTRY_CATEGORIES,
  classifyBotUserAgent,
  type BotRegistryCategory,
  type BotRegistryEntry,
  type BotRegistryVerdict,
} from "./wdn-bot-registry";

export type BotPolicyAction = "ALLOW" | "DENY";

export interface BotPolicyOptions {
  /**
   * Deny selectors: category names (for example "training_crawler"),
   * the special token "ai" (all AI categories), or agent ids/names.
   */
  deny?: readonly string[];
  /** Allow selectors (agent ids or names, case-insensitive). Allow wins over deny everywhere. */
  allow?: readonly string[];
  /** Action returned on a match. Default "DENY". */
  action?: BotPolicyAction;
  /** Dry-run: a match reports ALLOW with dryRun metadata instead of the configured action. Default false. */
  dryRun?: boolean;
}

export interface BotPolicyRuleResult {
  action: BotPolicyAction;
  rule: "bots";
  matched: boolean;
  reason?: string;
  metadata?: { dryRun: true };
}

export interface BotPolicyRule {
  readonly name: "bots";
  evaluate(verdict: BotRegistryVerdict): BotPolicyRuleResult;
  evaluateUserAgent(userAgent: string | null | undefined): BotPolicyRuleResult;
}

export interface BotPolicyRobotsOptions {
  /** Emit the trailing User-agent: * group. Default true. */
  allowOthers?: boolean;
  /** Emit the annotation header naming unenforceable agents. Default true. */
  annotate?: boolean;
  /** Extra Disallow paths for the wildcard group. */
  disallow?: readonly string[];
  crawlDelay?: number;
  sitemap?: string;
}

const CATEGORY_SET: ReadonlySet<string> = new Set(BOT_REGISTRY_CATEGORIES);

export class BotPolicy {
  /** The resolved matched set: registry order, allow-listed agents excluded. Publish and enforce both read this. */
  readonly matched: readonly BotRegistryEntry[];
  /** Matched agents that do not document honouring robots.txt (respectsRobots !== true). */
  readonly unenforceable: readonly BotRegistryEntry[];
  private readonly categories: ReadonlySet<string>;
  private readonly agents: ReadonlySet<string>;
  private readonly allowSet: ReadonlySet<string>;
  private readonly ai: boolean;
  private readonly action: BotPolicyAction;
  private readonly dryRun: boolean;

  constructor(options: BotPolicyOptions = {}) {
    const deny = options.deny ?? [];
    const allowSet = new Set((options.allow ?? []).map((a) => a.toLowerCase()));
    const categories = new Set<string>();
    const agents = new Set<string>();
    let ai = false;
    for (const token of deny) {
      if (token === "ai") ai = true;
      else if (CATEGORY_SET.has(token)) categories.add(token);
      else agents.add(token.toLowerCase());
    }
    this.categories = categories;
    this.agents = agents;
    this.allowSet = allowSet;
    this.ai = ai;
    this.action = options.action ?? "DENY";
    this.dryRun = options.dryRun === true;
    this.matched = Object.freeze(
      BOT_REGISTRY.filter((agent) => {
        if (allowSet.has(agent.id) || allowSet.has(agent.name.toLowerCase())) return false;
        return (
          (ai && BOT_REGISTRY_AI_CATEGORIES.has(agent.category)) ||
          categories.has(agent.category) ||
          agents.has(agent.id) ||
          agents.has(agent.name.toLowerCase())
        );
      }),
    );
    this.unenforceable = Object.freeze(this.matched.filter((a) => a.respectsRobots !== true));
  }

  /** The enforcement rule reading this same resolved configuration. */
  rule(): BotPolicyRule {
    const { categories, agents, allowSet, ai, action, dryRun } = this;
    const evaluate = (verdict: BotRegistryVerdict): BotPolicyRuleResult => {
      if (!verdict.known) return { action: "ALLOW", rule: "bots", matched: false };
      const id = verdict.id?.toLowerCase();
      const name = verdict.name?.toLowerCase();
      if ((id && allowSet.has(id)) || (name && allowSet.has(name))) {
        return { action: "ALLOW", rule: "bots", matched: false };
      }
      const matched =
        (ai && verdict.isAI) ||
        categories.has(verdict.category) ||
        (id !== undefined && agents.has(id)) ||
        (name !== undefined && agents.has(name));
      if (!matched) return { action: "ALLOW", rule: "bots", matched: false };
      if (dryRun) {
        return {
          action: "ALLOW",
          rule: "bots",
          matched: true,
          reason: `${verdict.name} (${verdict.category}) matched a bot policy rule`,
          metadata: { dryRun: true },
        };
      }
      return {
        action,
        rule: "bots",
        matched: true,
        reason: `${verdict.name} (${verdict.category}) matched a bot policy rule`,
      };
    };
    return {
      name: "bots",
      evaluate,
      evaluateUserAgent: (ua) => evaluate(classifyBotUserAgent(ua)),
    };
  }

  /** The robots.txt publication reading this same resolved set. */
  robotsTxt(options: BotPolicyRobotsOptions = {}): string {
    const allowOthers = options.allowOthers !== false;
    const annotate = options.annotate !== false;
    const lines: string[] = [];
    if (annotate) {
      lines.push("# Managed by antiRea bot policy - published and enforced from one policy.");
      const ignoring = this.unenforceable;
      if (ignoring.length > 0) {
        lines.push(
          "# These do not document honouring robots.txt, so the lines below are a",
          "# request only. The policy enforcement rule is what actually stops them:",
          ...ignoring.map((a) => `#   ${a.name}${a.organization ? ` (${a.organization})` : ""}`),
        );
      }
      lines.push("");
    }
    for (const agent of this.matched) lines.push(`User-agent: ${agent.name}`, "Disallow: /", "");
    if (allowOthers) {
      lines.push("User-agent: *");
      const disallow = options.disallow ?? [];
      for (const p of disallow) lines.push(`Disallow: ${p}`);
      if (disallow.length === 0) lines.push("Disallow:");
      if (options.crawlDelay !== undefined) lines.push(`Crawl-delay: ${options.crawlDelay}`);
      lines.push("");
    }
    if (options.sitemap) lines.push(`Sitemap: ${options.sitemap}`, "");
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimStart();
  }
}

/** Create a bot policy from deny/allow selectors over the WDN-03 registry. */
export function createBotPolicy(options: BotPolicyOptions = {}): BotPolicy {
  return new BotPolicy(options);
}

export type { BotRegistryCategory };
