/**
 * Ownership probe - an advisory signal for BOLA/IDOR sweeps (WALL-03,
 * measured from the 2026-11-13 case harvest, class 2: Optus 2022,
 * First American 2019, McHire 2025, Kia 2024).
 *
 * Record budgets answer "how much may an identity take" and surface
 * guards answer "what fields may cross". Neither sees the shape of an
 * IDOR sweep: one identity walking object after object that belongs to
 * OTHER people. Authorization is the host's job and this signal never
 * replaces it - but the host's own authorization layer is exactly what
 * is broken in a BOLA incident, so an independent, cheap observation
 * helps: per identity and rolling window, how many DISTINCT OWNERS did
 * this identity touch, out of how many touches?
 *
 *   flag (per window) when countedTouches >= minEvents (default 20)
 *   AND distinctOwners >= minDistinctOwners (default 10)
 *   AND distinctOwners / countedTouches >= minRatio (default 0.5)
 *
 * Frozen semantics (from the lab registration, unchanged):
 * - Touches on host-declared public routes are excluded from BOTH the
 *   numerator and the denominator - a reader of public pages touches
 *   many owners legitimately.
 * - Touches whose owner the host cannot resolve (null) stay in the
 *   denominator and are counted separately as unknownOwnerTouches;
 *   they are never treated as strange owners.
 * - Below the event floor the verdict is `insufficient_history`,
 *   scored 0 - the probe never flags on thin data.
 * - ADVISORY ONLY: the probe reports evidence through the return value
 *   and `onEvidence`; it never blocks, strips or escalates. Ownership
 *   truth belongs to the host - a flag says "this identity is touching
 *   many strangers' objects fast", never "this is an IDOR".
 *
 * INCREMENTAL STATE (the optimization this build exists for). The lab
 * probe re-scanned the whole window on every call: at a 100,000-touch
 * window it measured median ~39-43 ms, p95 ~68-82 ms per call on the
 * lab VM. This module instead maintains, per identity and per window,
 * the owner counters as touches arrive: `observe` and `check` are
 * O(1) amortized per window (window eviction is charged to the touch
 * that entered), and owner resolutions are cached per object id (an
 * object's owner does not change between touches). Several windows
 * (e.g. 1 h and 6 h) share one event queue per identity, so the slow
 * sweep the 1 h window structurally misses is covered by the 6 h
 * window in the same state.
 *
 * WHAT THE LAB MEASURED (seeded simulation, WALL-03 pin, 2026-11-13;
 * internal validity only - NOT real-traffic performance):
 * - Sequential-ID sweep: 500/500 sessions flagged. Random-ID sweep:
 *   500/500 flagged. Slow sweep spread over 6 h: 200/200 flagged under
 *   the 6 h window (0/200 under the 1 h window - the reason the second
 *   window exists).
 * - Legitimate traffic: 0 flags in 2,000 sessions across three
 *   families (public-page readers, news aggregators, real admins
 *   touching at most 3 familiar owners).
 * - The batch lab probe's cost reference (p95 < 50 ms at a 100k-touch
 *   window) was MISSED by the batch design (~68-82 ms); the
 *   incremental design in this module is the recorded answer to that
 *   miss. Its timings, measured on the same lab VM while building:
 *   ingesting 100,000 touches (each returning a verdict) took ~290 ms
 *   in total (~0.003 ms per touch), and a verdict read at a full
 *   100,000-touch window sat at the timer floor (< 0.01 ms median),
 *   against the batch probe's ~68-82 ms p95 for a single call.
 *
 * FEEDING. Call `observe(identity, { objectId, route, ts })` for every
 * object access, server-side, with `ts` in SECONDS. Touches for one
 * identity should arrive in nondecreasing `ts` order (normal request
 * order); out-of-order touches are counted but may be evicted early.
 * `resolveOwner` runs on the server and may return null for objects
 * the host cannot attribute. `check(identity, nowTs?)` reads the
 * current verdicts without recording a touch.
 */

export interface OwnershipTouch {
  /** The object being accessed (record id, document id, ...). */
  objectId: string;
  /** Route id, matched against `publicRoutes` for the exemption. */
  route?: string;
  /** Access time, in seconds (host clock). */
  ts: number;
}

export interface OwnershipWindowOptions {
  /** Rolling window length in seconds. Default 3600 (1 h). */
  windowSeconds?: number;
  /** Minimum counted touches before the window can flag. Default 20. */
  minEvents?: number;
  /** Minimum distinct owners for a flag. Default 10. */
  minDistinctOwners?: number;
  /** Minimum distinctOwners / countedTouches ratio for a flag. Default 0.5. */
  minRatio?: number;
}

export interface OwnershipProbeOptions {
  /** Server-side owner resolution. Return null when the owner is unknown. */
  resolveOwner: (objectId: string) => string | null | undefined;
  /** Routes whose touches are exempt (excluded from numerator and denominator). */
  publicRoutes?: readonly string[];
  /**
   * Windows to maintain. Default: a single 1 h window. Pass
   * [{ windowSeconds: 3600 }, { windowSeconds: 21600 }] to also cover
   * slow sweeps in the same state.
   */
  windows?: readonly OwnershipWindowOptions[];
  /** Owner keys sampled into flag evidence. Default 10. */
  maxEvidenceOwners?: number;
  /**
   * Cap on the objectId -> owner cache. When the cap is reached the
   * cache is cleared (correctness is unaffected; owners re-resolve).
   * Default 100,000.
   */
  ownerCacheLimit?: number;
  /** Fired once per window when it TRANSITIONS into a flag. Errors are swallowed. */
  onEvidence?: (event: OwnershipEvidenceEvent) => Promise<void> | void;
}

export interface OwnershipEvidence {
  owners: string[];
  ownerTouchCounts: Record<string, number>;
  touches: number;
  windowSeconds: number;
}

export interface OwnershipWindowResult {
  windowSeconds: number;
  verdict: "insufficient_history" | "ok" | "flag";
  scored: 0 | 1;
  countedTouches: number;
  distinctOwners: number;
  ratio: number;
  unknownOwnerTouches: number;
  evidence: OwnershipEvidence | null;
}

export interface OwnershipCheck {
  identity: string;
  /** True when any configured window flags. */
  flagged: boolean;
  windows: OwnershipWindowResult[];
}

export interface OwnershipEvidenceEvent {
  identity: string;
  result: OwnershipWindowResult;
  /** ISO time derived from the touch timestamp that caused the transition. */
  timestamp: string;
}

export interface OwnershipProbe {
  /** Record one object access and return the current verdicts. */
  observe(identity: string, touch: OwnershipTouch): OwnershipCheck;
  /** Read the current verdicts; `nowTs` (seconds) advances eviction without a touch. */
  check(identity: string, nowTs?: number): OwnershipCheck;
  /** Drop one identity's state, or all state (including the owner cache) when omitted. */
  reset(identity?: string): void;
  /** Live state sizes, for operator visibility. */
  size(): { identities: number; cachedOwners: number };
}

interface WindowCfg {
  windowSeconds: number;
  minEvents: number;
  minDistinctOwners: number;
  minRatio: number;
}

interface StoredEvent {
  ts: number;
  owner: string | null;
}

interface WindowState {
  cfg: WindowCfg;
  counts: Map<string, number>;
  counted: number;
  unknown: number;
  head: number;
  wasFlagged: boolean;
}

interface IdentityState {
  events: StoredEvent[];
  windows: WindowState[];
  lastTs: number;
}

const DEFAULT_WINDOW: WindowCfg = {
  windowSeconds: 3600,
  minEvents: 20,
  minDistinctOwners: 10,
  minRatio: 0.5,
};

export function createOwnershipProbe(options: OwnershipProbeOptions): OwnershipProbe {
  if (!options || typeof options.resolveOwner !== "function") {
    throw new TypeError("createOwnershipProbe: options.resolveOwner is required");
  }
  const cfgs: WindowCfg[] = (options.windows && options.windows.length > 0
    ? options.windows
    : [{}]
  ).map((w) => ({
    windowSeconds: w.windowSeconds ?? DEFAULT_WINDOW.windowSeconds,
    minEvents: w.minEvents ?? DEFAULT_WINDOW.minEvents,
    minDistinctOwners: w.minDistinctOwners ?? DEFAULT_WINDOW.minDistinctOwners,
    minRatio: w.minRatio ?? DEFAULT_WINDOW.minRatio,
  }));
  const publicRoutes = new Set(options.publicRoutes ?? []);
  const maxEvidenceOwners = options.maxEvidenceOwners ?? 10;
  const ownerCacheLimit = options.ownerCacheLimit ?? 100_000;
  const ownerCache = new Map<string, string | null>();
  const identities = new Map<string, IdentityState>();

  function resolveCached(objectId: string): string | null {
    const hit = ownerCache.get(objectId);
    if (hit !== undefined) return hit;
    const owner = options.resolveOwner(objectId) ?? null;
    if (ownerCache.size >= ownerCacheLimit) ownerCache.clear();
    ownerCache.set(objectId, owner);
    return owner;
  }

  function newIdentityState(): IdentityState {
    return {
      events: [],
      lastTs: 0,
      windows: cfgs.map((cfg) => ({
        cfg,
        counts: new Map<string, number>(),
        counted: 0,
        unknown: 0,
        head: 0,
        wasFlagged: false,
      })),
    };
  }

  function addToWindow(w: WindowState, ev: StoredEvent): void {
    w.counted++;
    if (ev.owner === null) {
      w.unknown++;
    } else {
      w.counts.set(ev.owner, (w.counts.get(ev.owner) ?? 0) + 1);
    }
  }

  function removeFromWindow(w: WindowState, ev: StoredEvent): void {
    w.counted--;
    if (ev.owner === null) {
      w.unknown--;
    } else {
      const next = (w.counts.get(ev.owner) ?? 0) - 1;
      if (next <= 0) w.counts.delete(ev.owner);
      else w.counts.set(ev.owner, next);
    }
  }

  function evictWindow(state: IdentityState, w: WindowState, now: number): void {
    const floor = now - w.cfg.windowSeconds;
    while (w.head < state.events.length && (state.events[w.head] as StoredEvent).ts < floor) {
      removeFromWindow(w, state.events[w.head] as StoredEvent);
      w.head++;
    }
  }

  function compact(state: IdentityState): void {
    let minHead = Infinity;
    for (const w of state.windows) if (w.head < minHead) minHead = w.head;
    if (minHead >= 1024) {
      state.events.splice(0, minHead);
      for (const w of state.windows) w.head -= minHead;
    }
  }

  function windowResult(w: WindowState): OwnershipWindowResult {
    const distinct = w.counts.size;
    const ratio = w.counted > 0 ? distinct / w.counted : 0;
    const base = {
      windowSeconds: w.cfg.windowSeconds,
      countedTouches: w.counted,
      distinctOwners: distinct,
      ratio,
      unknownOwnerTouches: w.unknown,
    };
    if (w.counted < w.cfg.minEvents) {
      return { ...base, verdict: "insufficient_history", scored: 0, evidence: null };
    }
    const flagged = distinct >= w.cfg.minDistinctOwners && ratio >= w.cfg.minRatio;
    if (!flagged) {
      return { ...base, verdict: "ok", scored: 0, evidence: null };
    }
    // Take the first maxEvidenceOwners keys WITHOUT materializing the
    // whole key set: a flagged window can hold 100k owners, and observe()
    // builds this on every call - spreading all keys here made ingest
    // quadratic (measured: 100k touches in ~39 s before this fix).
    const owners: string[] = [];
    for (const key of w.counts.keys()) {
      owners.push(key);
      if (owners.length >= maxEvidenceOwners) break;
    }
    const ownerTouchCounts: Record<string, number> = {};
    for (const o of owners) ownerTouchCounts[o] = w.counts.get(o) ?? 0;
    return {
      ...base,
      verdict: "flag",
      scored: 1,
      evidence: { owners, ownerTouchCounts, touches: w.counted, windowSeconds: w.cfg.windowSeconds },
    };
  }

  function snapshot(identity: string, state: IdentityState | undefined, now: number): OwnershipCheck {
    if (!state) {
      return {
        identity,
        flagged: false,
        windows: cfgs.map((cfg) => ({
          windowSeconds: cfg.windowSeconds,
          verdict: "insufficient_history" as const,
          scored: 0 as const,
          countedTouches: 0,
          distinctOwners: 0,
          ratio: 0,
          unknownOwnerTouches: 0,
          evidence: null,
        })),
      };
    }
    const results = state.windows.map((w) => {
      const r = windowResult(w);
      const isFlag = r.verdict === "flag";
      if (isFlag && !w.wasFlagged && options.onEvidence) {
        try {
          void options.onEvidence({
            identity,
            result: r,
            timestamp: new Date(now * 1000).toISOString(),
          });
        } catch {
          /* operator logging must never break request handling */
        }
      }
      w.wasFlagged = isFlag;
      return r;
    });
    return { identity, flagged: results.some((r) => r.verdict === "flag"), windows: results };
  }

  function observe(identity: string, touch: OwnershipTouch): OwnershipCheck {
    let state = identities.get(identity);
    if (!state) {
      state = newIdentityState();
      identities.set(identity, state);
    }
    if (touch.ts > state.lastTs) state.lastTs = touch.ts;
    if (touch.route !== undefined && publicRoutes.has(touch.route)) {
      // Exempt: not stored, not counted - but time still advances eviction.
      for (const w of state.windows) evictWindow(state, w, touch.ts);
      compact(state);
      return snapshot(identity, state, touch.ts);
    }
    const ev: StoredEvent = { ts: touch.ts, owner: resolveCached(touch.objectId) };
    state.events.push(ev);
    for (const w of state.windows) {
      addToWindow(w, ev);
      evictWindow(state, w, touch.ts);
    }
    compact(state);
    return snapshot(identity, state, touch.ts);
  }

  function check(identity: string, nowTs?: number): OwnershipCheck {
    const state = identities.get(identity);
    if (!state) return snapshot(identity, undefined, nowTs ?? 0);
    const now = nowTs ?? state.lastTs;
    if (nowTs !== undefined && nowTs > state.lastTs) state.lastTs = nowTs;
    for (const w of state.windows) evictWindow(state, w, now);
    compact(state);
    return snapshot(identity, state, now);
  }

  return {
    observe,
    check,
    reset(identity?: string): void {
      if (identity === undefined) {
        identities.clear();
        ownerCache.clear();
      } else {
        identities.delete(identity);
      }
    },
    size(): { identities: number; cachedOwners: number } {
      return { identities: identities.size, cachedOwners: ownerCache.size };
    },
  };
}
