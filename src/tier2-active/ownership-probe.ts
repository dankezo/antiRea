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
 * identity normally arrive in nondecreasing `ts` order. Late touches
 * are inserted in timestamp order and evaluated at the latest observed
 * timestamp; backward reads never resurrect expired history.
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
  /** Maximum retained identities. Default 10,000; new identities report truncated at capacity. */
  maxIdentities?: number;
  /** Maximum retained touches per identity. Default 100,000. */
  maxEventsPerIdentity?: number;
  /** Maximum retained touches across this instance. Default 1,000,000. */
  maxTotalEvents?: number;
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
  /** Incomplete history due to capacity. Flags and callbacks are suppressed until the missing window expires. */
  truncated: boolean;
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
  truncatedUntil: number;
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
  function integer(value: number, name: string, min: number, max: number): number {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`ownership-probe: invalid ${name}`);
    return value;
  }
  if (cfgs.length > 16) throw new RangeError("ownership-probe: at most 16 windows");
  for (const cfg of cfgs) {
    if (!Number.isFinite(cfg.windowSeconds) || cfg.windowSeconds <= 0 || cfg.windowSeconds > 31_536_000) throw new RangeError("ownership-probe: invalid windowSeconds");
    integer(cfg.minEvents, "minEvents", 1, 1_000_000);
    integer(cfg.minDistinctOwners, "minDistinctOwners", 1, 1_000_000);
    if (!Number.isFinite(cfg.minRatio) || cfg.minRatio < 0 || cfg.minRatio > 1) throw new RangeError("ownership-probe: invalid minRatio");
  }
  const publicRoutes = new Set(options.publicRoutes ?? []);
  const maxEvidenceOwners = integer(options.maxEvidenceOwners ?? 10, "maxEvidenceOwners", 0, 10_000);
  const ownerCacheLimit = integer(options.ownerCacheLimit ?? 100_000, "ownerCacheLimit", 1, 1_000_000);
  const maxIdentities = integer(options.maxIdentities ?? 10_000, "maxIdentities", 1, 100_000);
  const maxEventsPerIdentity = integer(options.maxEventsPerIdentity ?? 100_000, "maxEventsPerIdentity", 1, 1_000_000);
  const maxTotalEvents = integer(options.maxTotalEvents ?? 1_000_000, "maxTotalEvents", 1, 10_000_000);
  const maxWindow = Math.max(...cfgs.map(cfg => cfg.windowSeconds));
  let storedEvents = 0;
  // A scalar tombstone bounds memory while keeping refused identities from
  // reappearing as apparently complete histories when a slot is released.
  let untrackedUntil = -Infinity;
  const ownerCache = new Map<string, string | null>();
  const identities = new Map<string, IdentityState>();

  function key(value: string, name: string): void {
    if (typeof value !== "string" || value.length === 0 || value.length > 1024) throw new TypeError(`ownership-probe: invalid ${name}`);
  }
  function timestamp(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 8_640_000_000_000) throw new RangeError("ownership-probe: invalid timestamp");
  }

  function resolveCached(objectId: string): string | null {
    const hit = ownerCache.get(objectId);
    if (hit !== undefined) return hit;
    const owner = options.resolveOwner(objectId) ?? null;
    if (owner !== null) key(owner, "owner");
    if (ownerCache.size >= ownerCacheLimit) ownerCache.clear();
    ownerCache.set(objectId, owner);
    return owner;
  }

  function newIdentityState(): IdentityState {
    return {
      events: [],
      lastTs: 0,
      truncatedUntil: untrackedUntil,
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

  function compact(state: IdentityState, force = false): void {
    let minHead = Infinity;
    for (const w of state.windows) if (w.head < minHead) minHead = w.head;
    if (minHead >= 1024 || (force && minHead > 0)) {
      state.events.splice(0, minHead);
      storedEvents -= minHead;
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
      if (owners.length >= maxEvidenceOwners) break;
      owners.push(key);
    }
    const ownerTouchCounts: Record<string, number> = {};
    for (const o of owners) {
      // Only this legacy setter key needs defineProperty. Ordinary own-key
      // assignment avoids descriptor allocation on the common ingest path.
      if (o === "__proto__") Object.defineProperty(ownerTouchCounts, o, { value: w.counts.get(o) ?? 0, enumerable: true, configurable: true, writable: true });
      else ownerTouchCounts[o] = w.counts.get(o) ?? 0;
    }
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
        truncated: false,
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
      if (isFlag && now > state.truncatedUntil && !w.wasFlagged && options.onEvidence) {
        try {
          void Promise.resolve(options.onEvidence({
            identity,
            result: r,
            timestamp: new Date(now * 1000).toISOString(),
          })).catch(() => { /* asynchronous logging is advisory too */ });
        } catch {
          /* operator logging must never break request handling */
        }
      }
      w.wasFlagged = isFlag && now > state.truncatedUntil;
      if (now <= state.truncatedUntil) return { ...r, verdict: "insufficient_history" as const, scored: 0 as const, evidence: null };
      return r;
    });
    return { identity, truncated: now <= state.truncatedUntil, flagged: results.some((r) => r.verdict === "flag"), windows: results };
  }

  function observe(identity: string, touch: OwnershipTouch): OwnershipCheck {
    key(identity, "identity");
    key(touch.objectId, "objectId");
    timestamp(touch.ts);
    if (touch.route !== undefined) key(touch.route, "route");
    let state = identities.get(identity);
    if (!state && touch.route !== undefined && publicRoutes.has(touch.route)) return snapshot(identity, undefined, touch.ts);
    if (!state) {
      if (identities.size >= maxIdentities) {
        untrackedUntil = Math.max(untrackedUntil, touch.ts + maxWindow);
        return { ...snapshot(identity, undefined, touch.ts), truncated: true };
      }
      state = newIdentityState();
      identities.set(identity, state);
    }
    if (touch.ts > state.lastTs) state.lastTs = touch.ts;
    const now = state.lastTs;
    for (const w of state.windows) evictWindow(state, w, now);
    compact(state);
    if (touch.route !== undefined && publicRoutes.has(touch.route)) {
      // Exempt: not stored, not counted - but time still advances eviction.
      return snapshot(identity, state, now);
    }
    if (touch.ts < now - maxWindow) return snapshot(identity, state, now);
    if (state.events.length >= maxEventsPerIdentity || storedEvents >= maxTotalEvents) compact(state, true);
    if (state.events.length >= maxEventsPerIdentity || storedEvents >= maxTotalEvents) {
      state.truncatedUntil = now + maxWindow;
      return snapshot(identity, state, now);
    }
    const ev: StoredEvent = { ts: touch.ts, owner: resolveCached(touch.objectId) };
    const late = state.events.length > 0 && touch.ts < (state.events[state.events.length - 1] as StoredEvent).ts;
    state.events.push(ev);
    storedEvents++;
    if (late) {
      state.events.sort((a, b) => a.ts - b.ts);
      for (const w of state.windows) {
        w.counts.clear(); w.counted = 0; w.unknown = 0; w.head = 0;
        for (const event of state.events) addToWindow(w, event);
        evictWindow(state, w, now);
      }
    } else {
    for (const w of state.windows) {
      addToWindow(w, ev);
      evictWindow(state, w, now);
    }
    }
    compact(state);
    return snapshot(identity, state, now);
  }

  function check(identity: string, nowTs?: number): OwnershipCheck {
    key(identity, "identity");
    if (nowTs !== undefined) timestamp(nowTs);
    const state = identities.get(identity);
    if (!state) return snapshot(identity, undefined, nowTs ?? 0);
    const now = Math.max(nowTs ?? state.lastTs, state.lastTs);
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
        storedEvents = 0;
        untrackedUntil = -Infinity;
      } else {
        const state = identities.get(identity);
        if (state) storedEvents -= state.events.length;
        identities.delete(identity);
      }
    },
    size(): { identities: number; cachedOwners: number } {
      return { identities: identities.size, cachedOwners: ownerCache.size };
    },
  };
}
