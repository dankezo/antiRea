/**
 * Workflow-sequence flow scorer (log-only telemetry).
 *
 * Individual requests from an automated extractor often look legal. The
 * SEQUENCE does not. A reconstruction agent's workflow has mandatory moves
 * no tooling choice can skip - authenticate, enumerate the data surface,
 * probe the boundaries to learn the limits, extract through the serving
 * path, exercise the export - and the study sessions all walked them in a
 * rigid template order (oversize page probe, sequential full-coverage
 * pagination, export attempts that persisted after rate-limit rejections)
 * that human browsing does not produce. This scorer watches the sequence
 * server-side and accumulates a per-session risk score from five signals:
 *
 * - `boundary_probe` (+10 each, capped +30): a list request rejected 429 -
 *   the caller asked for more than the page-size ceiling allows. Humans
 *   using the real UI cannot generate this; the UI never asks.
 * - `post_429_persistence` (+25 each, capped +50): further list/export
 *   attempts AFTER a 429 whose signature (route class + requested page
 *   size) DIFFERS from the attempt that was rejected. The strongest signal
 *   in the study logs: agent sessions kept extracting through 4-6 post-cap
 *   rejections; a human told "slow down" by the product simply stops.
 *   Identical repeats of the rejected attempt are discounted as client
 *   library auto-retries (an SPA's fetch layer retrying a failed page load
 *   looks exactly like that) and accrue nothing.
 * - `sequential_full_coverage` (+5 per full page beyond a 3-page streak,
 *   capped +30): consecutive list responses that return a full page every
 *   time - a sweep, not a search. Any interleaved detail view, partial
 *   page or non-list action breaks the streak.
 * - `export_burst` (+10 per attempt from the 3rd, capped +30): repeated
 *   export calls inside one window.
 * - `canary_contact` / `decoy_contact` (+50, latched): the session touched
 *   a route no real UI flow calls (a canary endpoint or a decoy mirage
 *   document). High-confidence individually, decisive in combination.
 *   Decoy hits carry a kind, classified by `createDecoyMirage` from the
 *   request's Fetch Metadata: a `programmatic` hit (a client deliberately
 *   fetching the route) latches and taints as above; an `ambient` hit (an
 *   `<img>`/navigation-style load, which any page or preview bot can cause
 *   without intent) adds only +10 and never taints.
 *
 * This module NEVER blocks, bans or alters a response. It emits
 * `onScore` when a session crosses the elevated/high thresholds and,
 * opt-in, `onTaint` when a session crosses the high threshold or touches a
 * canary/decoy route - the host decides what a taint means (the reference
 * wiring lowers that identity's `createRecordBudget` cap via
 * `setOverride`). One hard rule: `onTaint` NEVER fires for identities of
 * kind `ip` (see `identityKind`). An IP is shared - NAT gateways, offices,
 * mobile carriers - so tainting it would punish bystanders for one
 * client's behavior; IP sessions still emit `onScore` telemetry. Account
 * and API-key identities taint normally. A patient agent that browses
 * slowly and stays inside its record budget produces almost no signal
 * here: the scorer complements budgets, it does not replace them. Scores
 * are investigation telemetry, not proof of intent - see
 * docs/LIMITATIONS.md.
 *
 * The verified-bot lane: hosts with a Web Bot Auth verifier (or a
 * reverse-DNS-verified crawler lane) pass `isExempt` so verified crawlers
 * are never scored at all. Never exempt on a self-declared User-Agent.
 *
 * Per-event cost is O(1): one map lookup and counter updates. State is a
 * bounded in-memory map; no external infrastructure.
 */

import { resolveIntervalClock } from "../internal/mono-clock";

export type FlowRouteClass = "list" | "detail" | "export" | "canary" | "decoy" | "auth" | "other";

/**
 * How a canary/decoy hit was delivered, classified from Fetch Metadata by
 * `createDecoyMirage`: `ambient` for browser-driven loads (image,
 * navigation, subresource), `programmatic` for deliberate client fetches.
 */
export type FlowHitKind = "ambient" | "programmatic";

/** Identity strength behind a session key; drives the taint rules. */
export type FlowIdentityKind = "account" | "apiKey" | "ip";

export interface FlowEvent {
  /** Coarse route classification supplied by the host's routing layer. */
  routeClass: FlowRouteClass;
  /** HTTP status the request produced. */
  status: number;
  /** Page size the caller asked for, when the host knows it. */
  pageSizeRequested?: number;
  /** Records the response contained, when the host knows it (drives the coverage streak). */
  recordsReturned?: number;
  /**
   * For `routeClass: "decoy"` events: how the hit was delivered, as
   * classified by `createDecoyMirage`. `ambient` hits add a small score
   * and never taint; `programmatic` hits latch and taint. Defaults to
   * `programmatic` when the host does not classify.
   */
  hitKind?: FlowHitKind;
}

export type FlowLevel = "normal" | "elevated" | "high";

export interface FlowScoreEvent {
  sessionKey: string;
  score: number;
  /** The threshold that was crossed: `"elevated"` or `"high"`. */
  level: "elevated" | "high";
  /** Signal labels contributing to the score, with counts, e.g. `"post_429_persistence x3"`. */
  reasons: string[];
  /** ISO-8601 timestamp from the scorer clock. */
  timestamp: string;
}

export type FlowTaintTrigger = "high_threshold" | "canary_contact" | "decoy_contact";

export interface FlowTaintEvent {
  sessionKey: string;
  score: number;
  trigger: FlowTaintTrigger;
  reasons: string[];
  /** ISO-8601 timestamp from the scorer clock. */
  timestamp: string;
}

export interface FlowScorerWeights {
  canaryContact: number;
  decoyContact: number;
  decoyAmbientContact: number;
  decoyAmbientContactCap: number;
  boundaryProbe: number;
  boundaryProbeCap: number;
  post429Persistence: number;
  post429PersistenceCap: number;
  coveragePage: number;
  coveragePageCap: number;
  exportBurst: number;
  exportBurstCap: number;
}

export const DEFAULT_FLOW_WEIGHTS: FlowScorerWeights = {
  canaryContact: 50,
  decoyContact: 50,
  decoyAmbientContact: 10,
  decoyAmbientContactCap: 30,
  boundaryProbe: 10,
  boundaryProbeCap: 30,
  post429Persistence: 25,
  post429PersistenceCap: 50,
  coveragePage: 5,
  coveragePageCap: 30,
  exportBurst: 10,
  exportBurstCap: 30,
};

export interface FlowScorerOptions {
  /** Fired once per threshold crossing (elevated, then high). Errors are swallowed. */
  onScore?: (event: FlowScoreEvent) => Promise<void> | void;
  /**
   * Opt-in detection-to-throttle hook. Fired once per trigger per window:
   * when the score crosses the high threshold, and immediately on a
   * canary/decoy contact. The host decides the consequence (for example
   * lowering a record budget via `setOverride`). Errors are swallowed.
   */
  onTaint?: (event: FlowTaintEvent) => Promise<void> | void;
  /**
   * Verified-bot lane: return true for session keys the host has verified
   * out-of-band (Web Bot Auth verdict, verified crawler rDNS). Exempt
   * sessions are never scored and hold no state. A throwing predicate is
   * treated as not exempt (the error is swallowed, like every other host
   * hook in this module).
   */
  isExempt?: (sessionKey: string) => boolean;
  /**
   * Classify the identity behind a session key. `onTaint` never fires for
   * kind `"ip"` - an IP is shared, so tainting it punishes bystanders -
   * while `onScore` telemetry still fires for every kind. Defaults to
   * deriving the kind from the quota-guard key prefixes (`account:`,
   * `apikey:`, `ip:`) when present, else `"account"`.
   */
  identityKind?: (sessionKey: string) => FlowIdentityKind;
  /** Score thresholds. Defaults: elevated 40, high 70. */
  thresholds?: { elevated?: number; high?: number };
  /** Partial weight overrides over `DEFAULT_FLOW_WEIGHTS`. */
  weights?: Partial<FlowScorerWeights>;
  /**
   * Activity window: a session idle longer than this restarts with clean
   * features. Defaults to 600_000 (10 minutes).
   */
  windowMs?: number;
  /** Cap on sessions held in memory. Defaults to 10,000. */
  maxSessions?: number;
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. Display timestamps only (L-DEEP-2). */
  now?: () => number;
  /**
   * Monotonic clock for the idle-window arithmetic (L-DEEP-2). When
   * given, session expiry is measured on this clock and is immune to
   * wall-clock steps. When only `now` is given, the injected clock
   * drives both domains (pre-patch behavior).
   */
  monoNow?: () => number;
}

export interface FlowObservation {
  score: number;
  level: FlowLevel;
  /** True when `isExempt` matched and nothing was recorded. */
  exempt?: boolean;
}

export interface FlowScorer {
  /** Record one request event for a session and return its current standing. O(1). */
  observe(sessionKey: string, event: FlowEvent): FlowObservation;
  /** Current score for a session (0 when unknown, expired or exempt). */
  score(sessionKey: string): number;
  /** Current contributing signal labels for a session. */
  reasons(sessionKey: string): string[];
  /** Clear one session, or every session when called with no argument. */
  reset(sessionKey?: string): void;
}

interface SessionState {
  windowStart: number;
  lastSeen: number;
  /** Monotonic twin of `lastSeen` (L-DEEP-2): idle expiry is measured on this clock. */
  lastSeenMono: number;
  score: number;
  canary: boolean;
  decoy: boolean;
  ambientDecoyHits: number;
  ambientDecoyContribution: number;
  boundaryProbes: number;
  boundaryContribution: number;
  seen429: boolean;
  /** Signature (`routeClass:pageSizeRequested`) of the most recent 429'd attempt. */
  lastRejectedSignature?: string;
  post429: number;
  post429Contribution: number;
  fullPageStreak: number;
  coverageContribution: number;
  exportAttempts: number;
  exportContribution: number;
  emittedRank: number;
  taintsFired: Set<FlowTaintTrigger>;
}

const freshState = (now: number, nowMono: number): SessionState => ({
  windowStart: now,
  lastSeen: now,
  lastSeenMono: nowMono,
  score: 0,
  canary: false,
  decoy: false,
  ambientDecoyHits: 0,
  ambientDecoyContribution: 0,
  boundaryProbes: 0,
  boundaryContribution: 0,
  seen429: false,
  lastRejectedSignature: undefined,
  post429: 0,
  post429Contribution: 0,
  fullPageStreak: 0,
  coverageContribution: 0,
  exportAttempts: 0,
  exportContribution: 0,
  emittedRank: 0,
  taintsFired: new Set<FlowTaintTrigger>(),
});

export function createFlowScorer(options: FlowScorerOptions = {}): FlowScorer {
  const weights: FlowScorerWeights = { ...DEFAULT_FLOW_WEIGHTS, ...(options.weights ?? {}) };
  const elevated = Math.max(1, Math.floor(options.thresholds?.elevated ?? 40) || 40);
  const high = Math.max(elevated + 1, Math.floor(options.thresholds?.high ?? 70) || 70);
  const windowMs = Math.max(1, Math.floor(options.windowMs ?? 600_000) || 600_000);
  const maxSessions = Math.max(100, Math.floor(options.maxSessions ?? 10_000) || 10_000);
  const { wall: clock, mono: monoClock } = resolveIntervalClock(options);
  const sessions = new Map<string, SessionState>();

  const isExemptSafe = (sessionKey: string): boolean => {
    if (!options.isExempt) return false;
    try {
      return options.isExempt(sessionKey) === true;
    } catch {
      /* A throwing host hook is treated as not exempt, mirroring
       * kindOf below and the CUSUM tripwire's safeIsExempt (F-20):
       * telemetry must never break request handling. */
      return false;
    }
  };

  const kindOf = (sessionKey: string): FlowIdentityKind => {
    if (options.identityKind) {
      try {
        const kind = options.identityKind(sessionKey);
        if (kind === "account" || kind === "apiKey" || kind === "ip") return kind;
      } catch {
        /* A throwing host hook falls back to prefix derivation. */
      }
    }
    if (sessionKey.startsWith("ip:")) return "ip";
    if (sessionKey.startsWith("apikey:")) return "apiKey";
    return "account";
  };

  const reasonsOf = (state: SessionState): string[] => {
    const reasons: string[] = [];
    if (state.canary) reasons.push("canary_contact");
    if (state.decoy) reasons.push("decoy_contact");
    if (state.ambientDecoyHits > 0) reasons.push(`decoy_contact_ambient x${state.ambientDecoyHits}`);
    if (state.boundaryProbes > 0) reasons.push(`boundary_probe x${state.boundaryProbes}`);
    if (state.post429 > 0) reasons.push(`post_429_persistence x${state.post429}`);
    if (state.coverageContribution > 0) reasons.push("sequential_full_coverage");
    if (state.exportContribution > 0) reasons.push(`export_burst x${state.exportAttempts}`);
    return reasons;
  };

  const levelOf = (score: number): FlowLevel => (score >= high ? "high" : score >= elevated ? "elevated" : "normal");
  const rankOf = (level: FlowLevel): number => (level === "high" ? 2 : level === "elevated" ? 1 : 0);

  const fireScore = (sessionKey: string, state: SessionState, level: "elevated" | "high"): void => {
    if (!options.onScore) return;
    try {
      const result = options.onScore({
        sessionKey,
        score: state.score,
        level,
        reasons: reasonsOf(state),
        timestamp: new Date(clock()).toISOString(),
      });
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      /* Telemetry must never break request handling. */
    }
  };

  const fireTaint = (sessionKey: string, state: SessionState, trigger: FlowTaintTrigger): void => {
    if (state.taintsFired.has(trigger)) return;
    state.taintsFired.add(trigger);
    // Hard rule: an IP identity is never tainted. The trigger is still
    // recorded above (once per window) and the score event still fires;
    // only the enforcement bridge is suppressed for shared identities.
    if (kindOf(sessionKey) === "ip") return;
    if (!options.onTaint) return;
    try {
      const result = options.onTaint({
        sessionKey,
        score: state.score,
        trigger,
        reasons: reasonsOf(state),
        timestamp: new Date(clock()).toISOString(),
      });
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      /* Telemetry must never break request handling. */
    }
  };

  const liveState = (sessionKey: string): SessionState => {
    const now = clock();
    const nowMono = monoClock();
    let state = sessions.get(sessionKey);
    if (state && nowMono - state.lastSeenMono > windowMs) {
      sessions.delete(sessionKey);
      state = undefined;
    }
    if (!state) {
      if (sessions.size >= maxSessions) {
        const oldestKey = sessions.keys().next().value;
        if (oldestKey !== undefined) sessions.delete(oldestKey);
      }
      state = freshState(now, nowMono);
      sessions.set(sessionKey, state);
    } else {
      sessions.delete(sessionKey);
      sessions.set(sessionKey, state);
    }
    state.lastSeen = now;
    state.lastSeenMono = nowMono;
    return state;
  };

  const observe = (sessionKey: string, event: FlowEvent): FlowObservation => {
    if (isExemptSafe(sessionKey)) {
      return { score: 0, level: "normal", exempt: true };
    }
    const state = liveState(sessionKey);
    const { routeClass, status } = event;
    const signature = `${routeClass}:${event.pageSizeRequested ?? ""}`;

    // Persistence is judged BEFORE this event's own status is folded in:
    // the 429 itself is the probe; attempts after it are the persistence.
    // An attempt whose signature matches the rejected attempt is a client
    // library auto-retry, not persistence, and accrues nothing.
    if (
      state.seen429 &&
      (routeClass === "list" || routeClass === "export") &&
      signature !== state.lastRejectedSignature
    ) {
      state.post429 += 1;
      const add = Math.min(weights.post429Persistence, weights.post429PersistenceCap - state.post429Contribution);
      if (add > 0) {
        state.post429Contribution += add;
        state.score += add;
      }
    }

    if (routeClass === "canary" && !state.canary) {
      state.canary = true;
      state.score += weights.canaryContact;
      fireTaint(sessionKey, state, "canary_contact");
    }
    if (routeClass === "decoy") {
      if (event.hitKind === "ambient") {
        // Browser-driven load (image, navigation, subresource): weak
        // evidence, small score, never a taint.
        state.ambientDecoyHits += 1;
        const add = Math.min(
          weights.decoyAmbientContact,
          weights.decoyAmbientContactCap - state.ambientDecoyContribution,
        );
        if (add > 0) {
          state.ambientDecoyContribution += add;
          state.score += add;
        }
      } else if (!state.decoy) {
        state.decoy = true;
        state.score += weights.decoyContact;
        fireTaint(sessionKey, state, "decoy_contact");
      }
    }

    if (status === 429) {
      state.seen429 = true;
      state.lastRejectedSignature = signature;
      if (routeClass === "list") {
        state.boundaryProbes += 1;
        const add = Math.min(weights.boundaryProbe, weights.boundaryProbeCap - state.boundaryContribution);
        if (add > 0) {
          state.boundaryContribution += add;
          state.score += add;
        }
      }
    }

    const isFullPage =
      routeClass === "list" &&
      status >= 200 &&
      status < 300 &&
      event.pageSizeRequested !== undefined &&
      event.pageSizeRequested > 0 &&
      event.recordsReturned !== undefined &&
      event.recordsReturned >= event.pageSizeRequested;
    if (isFullPage) {
      state.fullPageStreak += 1;
      if (state.fullPageStreak > 3) {
        const add = Math.min(weights.coveragePage, weights.coveragePageCap - state.coverageContribution);
        if (add > 0) {
          state.coverageContribution += add;
          state.score += add;
        }
      }
    } else if (routeClass === "list" || routeClass === "detail" || routeClass === "export") {
      state.fullPageStreak = 0;
    }

    if (routeClass === "export") {
      state.exportAttempts += 1;
      if (state.exportAttempts >= 3) {
        const add = Math.min(weights.exportBurst, weights.exportBurstCap - state.exportContribution);
        if (add > 0) {
          state.exportContribution += add;
          state.score += add;
        }
      }
    }

    const level = levelOf(state.score);
    const rank = rankOf(level);
    if (rank > state.emittedRank) {
      state.emittedRank = rank;
      if (level === "elevated" || level === "high") fireScore(sessionKey, state, level);
      if (level === "high") fireTaint(sessionKey, state, "high_threshold");
    }
    return { score: state.score, level };
  };

  return {
    observe,
    score(sessionKey: string): number {
      if (isExemptSafe(sessionKey)) return 0;
      const state = sessions.get(sessionKey);
      if (!state) return 0;
      if (monoClock() - state.lastSeenMono > windowMs) {
        sessions.delete(sessionKey);
        return 0;
      }
      return state.score;
    },
    reasons(sessionKey: string): string[] {
      const state = sessions.get(sessionKey);
      if (!state) return [];
      if (monoClock() - state.lastSeenMono > windowMs) {
        sessions.delete(sessionKey);
        return [];
      }
      return reasonsOf(state);
    },
    reset(sessionKey?: string): void {
      if (sessionKey === undefined) sessions.clear();
      else sessions.delete(sessionKey);
    },
  };
}
