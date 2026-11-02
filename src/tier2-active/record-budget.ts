/**
 * Cumulative distinct-record budget per identity (P0 control).
 *
 * `createQuotaGuard` limits how MANY requests an identity may make and how
 * LARGE each page may be, but it is memoryless about coverage: with a
 * 120-row dataset and a page-size cap of 50, three legal requests extract
 * 100% of the rows. This module tracks the other dimension - how many
 * DISTINCT records an identity has actually received inside a window - and
 * caps that. Extraction then has a hard floor: no identity can receive more
 * than `maxDistinctPerWindow` distinct records per window, however politely
 * it paginates.
 *
 * Identity is a string key resolved from your authenticated server session
 * (see `resolveRecordBudgetIdentityKey`: account > API key > IP, the same
 * precedence and key prefixes as the quota guard). A budget is only as
 * strong as the cost of an identity in YOUR app: where accounts are free
 * and unlimited, a determined extractor rotates identities (sybil) and the
 * budget dilutes to a per-account speed bump; where accounts are paid,
 * verified or invite-only, it is a hard ceiling. See docs/LIMITATIONS.md.
 *
 * Per-record state machine: every distinct record an identity receives is
 * in state 1 (viewed through list/detail responses) or state 2 (exported).
 * `used` is the SUM of states plus any count-only units burned via
 * `charge`. Transitions price the marginal value of each step, so a record
 * is never double-charged across channels: unseen -> viewed costs 1,
 * viewed -> exported costs 1 more, unseen -> exported costs 2, and
 * re-viewing or re-exporting a record costs 0. An identity's total for a
 * record tops out at 2 whatever path it took - the flat per-export
 * multiplier this replaces charged viewed records as if they were new.
 *
 * Storage is bounded three ways. Record ids are stored as fixed-length
 * FNV-1a 64-bit hex keys (16 chars), never as raw id strings, so a hostile
 * 64KB id costs the store 16 chars (a hash collision would merge two ids'
 * states; at 64 bits that is a negligible, accepted trade-off). Identities
 * are partitioned into two pools - `ip:` keys in a small pool
 * (`maxIpEntries`), account/API-key keys in the main pool (`maxEntries`) -
 * so an IP-churn flood cannot evict account state. And each entry stops
 * storing NEW record keys once it holds its effective limit + 1024 keys;
 * records consumed beyond that point still count toward `used` (and still
 * report `exceeded`), they are just not retained for de-duplication.
 *
 * Enforcement granularity is the request: `check` runs before the handler,
 * `consume` records what the handler actually returned. One in-flight page
 * can therefore overshoot the cap by at most that page's size; the
 * middleware's opt-in `reserveUnits` tightens that to in-flight
 * granularity (see `reserve`/`release`). Hosts that need a hard cut
 * mid-response should clamp the page in the handler using `check`
 * themselves. The default store is single-process in-memory - no external
 * infrastructure. Normal-path cost is O(1) for `check`/`reserve` and O(k)
 * for `consume`, where k is the number of record ids in the response being
 * recorded (inherent to distinct counting; no I/O).
 *
 * `setOverride` is the integration point for the detection-to-throttle
 * loop: when `createFlowScorer` (or any host signal) decides an identity is
 * extracting rather than browsing, the host lowers that identity's cap
 * until the window resets - normal users, whose usage sits far below the
 * default cap, never reach either threshold.
 */

import { resolveIntervalClock } from "../internal/mono-clock";
import type {
  QuotaExpressNext,
  QuotaExpressResponse,
  QuotaIdentity,
  QuotaRequestLike,
} from "./quota-guard";

export interface RecordBudgetOptions {
  /** Maximum DISTINCT records one identity may receive inside `windowMs`. Required. */
  maxDistinctPerWindow: number;
  /** Window length in milliseconds. Defaults to 86_400_000 (24 hours). */
  windowMs?: number;
  /** Cap on account/API-key identities held by the in-memory store. Defaults to 10,000. */
  maxEntries?: number;
  /**
   * Cap on `ip:` identities, held in a SEPARATE pool so IP churn can never
   * evict account state. Defaults to 2,000.
   */
  maxIpEntries?: number;
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. Display timestamps only (L-DEEP-2). */
  now?: () => number;
  /**
   * Monotonic clock for the window arithmetic (L-DEEP-2). When given,
   * window expiry is measured on this clock and is immune to wall-clock
   * steps. When only `now` is given, the injected clock drives both
   * domains (pre-patch behavior).
   */
  monoNow?: () => number;
  /**
   * Fired when a `consume`/`consumeExported`/`charge` pushes an identity's
   * usage over its effective limit. Errors thrown here are swallowed:
   * operator logging must never break request handling.
   */
  onExceeded?: (event: RecordBudgetExceededEvent) => Promise<void> | void;
}

export interface RecordBudgetExceededEvent {
  /** The budget identity key that crossed its limit. */
  identity: string;
  /** Usage after the crossing operation (record states plus charged units). */
  used: number;
  /** The effective limit that was crossed (override-aware). */
  limit: number;
  /** ISO-8601 timestamp from the budget clock. */
  timestamp: string;
}

export interface RecordBudgetUsage {
  /** Sum of per-record states (viewed = 1, exported = 2) plus charged units in the current window. */
  used: number;
  /** Effective limit for this identity (override-aware). */
  limit: number;
  /** `max(0, limit - used)`. Reserved units are not subtracted here; they gate `check`/`reserve`. */
  remaining: number;
  /** Epoch ms at which the current window resets. */
  windowResetAt: number;
}

export interface RecordBudgetCheckResult extends RecordBudgetUsage {
  allowed: boolean;
}

export interface RecordBudgetConsumeResult extends RecordBudgetUsage {
  /** True when usage after this operation exceeds the effective limit. */
  exceeded: boolean;
  /** How many of the supplied ids were new to this identity in this window. */
  newlyCounted: number;
}

export interface RecordBudget {
  /**
   * Would receiving `additionalCount` more distinct records stay within the
   * effective limit? Accounts for both consumed usage AND units currently
   * reserved by in-flight requests. Middleware gates on
   * `check(identity, 1)`: an identity already at its cap is rejected before
   * the handler runs.
   */
  check(identity: string, additionalCount?: number): RecordBudgetCheckResult;
  /**
   * Record the distinct record ids a response actually contained, as VIEW
   * transitions (unseen -> 1). Ids seen before in this window are not
   * double-counted; ids already exported stay at state 2. Never refuses -
   * pair with `check` before the handler for enforcement.
   */
  consume(identity: string, recordIds: readonly string[]): RecordBudgetConsumeResult;
  /**
   * Record record ids delivered by an EXPORT, as EXPORT transitions:
   * unseen -> 2 (cost 2), viewed -> 2 (cost 1 more), exported -> 2
   * (cost 0). This is how `createExportGuard` prices exports when the host
   * supplies the exported ids: a record's all-in cost is its highest
   * state, never the sum of both channels' full prices.
   */
  consumeExported(identity: string, recordIds: readonly string[]): RecordBudgetConsumeResult;
  /**
   * Burn `units` of budget without enumerating ids (used by
   * `createExportGuard`'s row-estimate path to price exports at a
   * multiplier, and by the middleware query floors). Counts toward `used`
   * exactly like consumed record states.
   */
  charge(identity: string, units: number): RecordBudgetConsumeResult;
  /**
   * Pre-flight reservation: hold `units` of an identity's budget for an
   * in-flight request. Returns false (and holds nothing) when
   * used + reserved + units would exceed the effective limit. While held,
   * the units count against `check` and further `reserve` calls, which
   * bounds parallel-burst overshoot to in-flight granularity. Pair every
   * successful reserve with `release` when the request settles.
   */
  reserve(identity: string, units: number): boolean;
  /** Return units previously taken by `reserve`. Releasing more than held is a no-op past zero. */
  release(identity: string, units: number): void;
  /** Current usage snapshot for an identity. */
  usage(identity: string): RecordBudgetUsage;
  /**
   * Lower one identity's cap to `maxDistinct` until its window resets
   * (detection-to-throttle integration). Only ever tightens: the effective
   * limit is `min(configured, override)`.
   */
  setOverride(identity: string, maxDistinct: number): void;
  /** Remove an identity's override early. */
  clearOverride(identity: string): void;
  /** Clear one identity, or every identity when called with no argument. */
  reset(identity?: string): void;
  readonly maxDistinctPerWindow: number;
  readonly windowMs: number;
}

type RecordState = 1 | 2;

interface BudgetEntry {
  windowStart: number;
  /** Monotonic twin of `windowStart` (L-DEEP-2): window expiry is measured on this clock. */
  windowStartMono: number;
  /** Stored record keys (fixed-length hashes) -> highest state reached. */
  records: Map<string, RecordState>;
  /** Sum of the states in `records`, plus the cost of records consumed beyond the storage cap. */
  recordUnits: number;
  /** Count-only units burned via `charge`. */
  charged: number;
  /** Units currently held by `reserve` for in-flight requests. */
  reserved: number;
  override?: number;
}

const DEFAULT_WINDOW_MS = 86_400_000;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_IP_ENTRIES = 2_000;
/** How far past its effective limit an entry may keep storing new record keys. */
const STORAGE_SLACK = 1_024;

/**
 * FNV-1a 64-bit over UTF-16 code units, rendered as 16 hex chars. Storage
 * keys are fixed-length whatever the raw id looks like - see the module
 * header for the collision note.
 */
const hashRecordKey = (id: string): string => {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < id.length; i++) {
    h ^= BigInt(id.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
};

export function createRecordBudget(options: RecordBudgetOptions): RecordBudget {
  const baseLimit = Math.max(1, Math.floor(options.maxDistinctPerWindow) || 1);
  const windowMs = Math.max(1, Math.floor(options.windowMs ?? DEFAULT_WINDOW_MS) || DEFAULT_WINDOW_MS);
  const maxEntries = Math.max(100, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES) || DEFAULT_MAX_ENTRIES);
  const maxIpEntries = Math.max(100, Math.floor(options.maxIpEntries ?? DEFAULT_MAX_IP_ENTRIES) || DEFAULT_MAX_IP_ENTRIES);
  const { wall: clock, mono: monoClock } = resolveIntervalClock(options);
  /** Account/API-key identities. */
  const accountPool = new Map<string, BudgetEntry>();
  /** `ip:` identities - a separate bounded pool, so IP churn cannot evict account state. */
  const ipPool = new Map<string, BudgetEntry>();

  const isIpIdentity = (identity: string): boolean => identity.startsWith("ip:");
  const poolFor = (identity: string): Map<string, BudgetEntry> => (isIpIdentity(identity) ? ipPool : accountPool);
  const capFor = (identity: string): number => (isIpIdentity(identity) ? maxIpEntries : maxEntries);

  const usedOf = (entry: BudgetEntry): number => entry.recordUnits + entry.charged;

  const effectiveLimit = (entry: BudgetEntry): number =>
    entry.override !== undefined ? Math.min(baseLimit, entry.override) : baseLimit;

  const emitExceeded = (identity: string, entry: BudgetEntry): void => {
    if (!options.onExceeded) return;
    try {
      const result = options.onExceeded({
        identity,
        used: usedOf(entry),
        limit: effectiveLimit(entry),
        timestamp: new Date(clock()).toISOString(),
      });
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      /* Operator logging must never break request handling. */
    }
  };

  /** Fetch the live entry for an identity, expiring (and dropping) a stale window first. */
  const liveEntry = (identity: string, create: boolean): BudgetEntry | undefined => {
    const pool = poolFor(identity);
    const now = clock();
    const nowMono = monoClock();
    let entry = pool.get(identity);
    if (entry && nowMono - entry.windowStartMono >= windowMs) {
      pool.delete(identity);
      entry = undefined;
    }
    if (!entry && create) {
      if (pool.size >= capFor(identity)) {
        const oldestKey = pool.keys().next().value;
        if (oldestKey !== undefined) pool.delete(oldestKey);
      }
      entry = {
        windowStart: now,
        windowStartMono: nowMono,
        records: new Map<string, RecordState>(),
        recordUnits: 0,
        charged: 0,
        reserved: 0,
      };
      pool.set(identity, entry);
    }
    if (entry) {
      // Refresh LRU position so active identities are evicted last.
      pool.delete(identity);
      pool.set(identity, entry);
    }
    return entry;
  };

  const snapshot = (identity: string): RecordBudgetUsage => {
    const entry = liveEntry(identity, false);
    if (!entry) {
      return { used: 0, limit: baseLimit, remaining: baseLimit, windowResetAt: clock() + windowMs };
    }
    const used = usedOf(entry);
    const limit = effectiveLimit(entry);
    return { used, limit, remaining: Math.max(0, limit - used), windowResetAt: entry.windowStart + windowMs };
  };

  const check = (identity: string, additionalCount = 0): RecordBudgetCheckResult => {
    const usage = snapshot(identity);
    const entry = liveEntry(identity, false);
    const additional = Math.max(0, Math.floor(additionalCount) || 0);
    return { ...usage, allowed: usage.used + (entry?.reserved ?? 0) + additional <= usage.limit };
  };

  /**
   * Shared transition engine for `consume` (views) and `consumeExported`
   * (exports). New keys stop being STORED once the entry holds its
   * effective limit + STORAGE_SLACK keys, but their cost is still counted
   * in `recordUnits`, so `exceeded` reporting stays truthful past the cap.
   */
  const applyTransitions = (
    identity: string,
    recordIds: readonly string[],
    exported: boolean,
  ): RecordBudgetConsumeResult => {
    const entry = liveEntry(identity, true) as BudgetEntry;
    const limit = effectiveLimit(entry);
    const wasOver = usedOf(entry) > limit;
    const storageCap = limit + STORAGE_SLACK;
    let newlyCounted = 0;
    for (const id of recordIds) {
      if (typeof id !== "string" || id.length === 0) continue;
      const key = hashRecordKey(id);
      const state = entry.records.get(key);
      if (state === undefined) {
        const cost = exported ? 2 : 1;
        if (entry.records.size < storageCap) entry.records.set(key, exported ? 2 : 1);
        entry.recordUnits += cost;
        newlyCounted += 1;
      } else if (exported && state === 1) {
        entry.records.set(key, 2);
        entry.recordUnits += 1;
      }
    }
    const usage = snapshot(identity);
    const exceeded = usage.used > usage.limit;
    if (exceeded && !wasOver) emitExceeded(identity, entry);
    return { ...usage, exceeded, newlyCounted };
  };

  const consume = (identity: string, recordIds: readonly string[]): RecordBudgetConsumeResult =>
    applyTransitions(identity, recordIds, false);

  const consumeExported = (identity: string, recordIds: readonly string[]): RecordBudgetConsumeResult =>
    applyTransitions(identity, recordIds, true);

  const charge = (identity: string, units: number): RecordBudgetConsumeResult => {
    const entry = liveEntry(identity, true) as BudgetEntry;
    const wasOver = usedOf(entry) > effectiveLimit(entry);
    const amount = Math.max(0, Math.floor(units) || 0);
    entry.charged += amount;
    const usage = snapshot(identity);
    const exceeded = usage.used > usage.limit;
    if (exceeded && !wasOver) emitExceeded(identity, entry);
    return { ...usage, exceeded, newlyCounted: 0 };
  };

  const reserve = (identity: string, units: number): boolean => {
    const amount = Math.max(0, Math.floor(units) || 0);
    if (amount === 0) return true;
    const entry = liveEntry(identity, true) as BudgetEntry;
    if (usedOf(entry) + entry.reserved + amount > effectiveLimit(entry)) return false;
    entry.reserved += amount;
    return true;
  };

  const release = (identity: string, units: number): void => {
    const entry = liveEntry(identity, false);
    if (!entry) return;
    const amount = Math.max(0, Math.floor(units) || 0);
    entry.reserved = Math.max(0, entry.reserved - amount);
  };

  return {
    check,
    consume,
    consumeExported,
    charge,
    reserve,
    release,
    usage: snapshot,
    setOverride(identity: string, maxDistinct: number): void {
      const entry = liveEntry(identity, true) as BudgetEntry;
      entry.override = Math.max(0, Math.floor(maxDistinct) || 0);
    },
    clearOverride(identity: string): void {
      const entry = liveEntry(identity, false);
      if (entry) entry.override = undefined;
    },
    reset(identity?: string): void {
      if (identity === undefined) {
        accountPool.clear();
        ipPool.clear();
      } else {
        poolFor(identity).delete(identity);
      }
    },
    maxDistinctPerWindow: baseLimit,
    windowMs,
  };
}

/* ------------------------------------------------------------------ */
/* Identity resolution + Express-style middleware                      */
/* ------------------------------------------------------------------ */

export interface RecordBudgetIdentityOptions {
  /**
   * Resolve the authenticated identity for a request. Populate `accountId` /
   * `apiKeyId` from your server auth middleware - never from unverified
   * client-supplied headers. Defaults to an empty identity (IP-only key).
   */
  resolveIdentity?: (
    req: QuotaRequestLike,
  ) => QuotaIdentity | undefined | Promise<QuotaIdentity | undefined>;
  /** Header carrying the client IP, set ONLY by a trusted edge proxy that strips untrusted copies. */
  trustedIpHeader?: string;
}

function getHeader(req: QuotaRequestLike, name: string): string | undefined {
  const headers = req.headers;
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(n: string): string | null }).get(name);
    return value ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === wanted) {
      const value = record[key];
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/**
 * Derive the budget identity key for a request, using the quota guard's
 * precedence and key prefixes: `account:<id>` beats `apikey:<id>` beats
 * `ip:<address>`. Returns `undefined` when no dimension resolves at all.
 */
export async function resolveRecordBudgetIdentityKey(
  req: QuotaRequestLike,
  options: RecordBudgetIdentityOptions = {},
): Promise<string | undefined> {
  const identity: QuotaIdentity = (await options.resolveIdentity?.(req)) ?? {};
  if (identity.accountId) return `account:${identity.accountId}`;
  if (identity.apiKeyId) return `apikey:${identity.apiKeyId}`;
  let ip = identity.ip;
  if (!ip && options.trustedIpHeader) {
    const fromHeader = getHeader(req, options.trustedIpHeader);
    if (fromHeader) ip = fromHeader.split(",")[0]?.trim() || undefined;
  }
  if (!ip) ip = req.ip ?? req.remoteAddress ?? req.socket?.remoteAddress ?? req.connection?.remoteAddress;
  return ip ? `ip:${ip}` : undefined;
}

export type RecordBudgetExpressRequest = QuotaRequestLike & {
  recordBudgetUsage?: RecordBudgetUsage;
};

export interface RecordBudgetMiddlewareOptions extends RecordBudgetOptions, RecordBudgetIdentityOptions {
  /** Shared budget instance. Supply one when the host also wires `setOverride` (detection-to-throttle loop). Created internally when omitted. */
  budget?: RecordBudget;
  /**
   * Extract the record ids a response body actually contained. Called with
   * the parsed JSON body (from `res.json`) or a JSON-parsed `res.end`
   * string. Return `undefined`/empty when the body carries no records.
   * Errors thrown here are swallowed: extraction must never break a response.
   */
  extractRecordIds: (body: unknown, req: RecordBudgetExpressRequest) => readonly string[] | undefined | null;
  /**
   * Pre-flight reservation: when > 0, the middleware synchronously
   * reserves this many budget units before the handler runs and releases
   * them once the wrapped response has been accounted. A failed
   * reservation rejects with 429 and the handler never runs. This bounds
   * parallel-burst overshoot to in-flight granularity; the default (0)
   * keeps the original post-response accounting, which can overshoot
   * under parallel bursts. Reservations are released when the wrapped
   * `res.json`/`res.end` fires; a handler that never responds through
   * those methods holds its reservation until the window resets.
   */
  reserveUnits?: number;
  /**
   * Query floor: a response from which `extractRecordIds` returns zero
   * ids (empty array, null or undefined) is charged this many units.
   * Empty-result reads are the zero-cost oracle a prober uses to map a
   * dataset's shape for free; the floor prices them. Defaults to 1.
   */
  emptyResultFloorUnits?: number;
  /**
   * Set `Cache-Control: private, no-store` on every response this
   * middleware handles (rejections included), so budget-metered responses
   * are never served from a shared or browser cache - a cached response
   * would bypass accounting entirely. Defaults to true.
   */
  noStore?: boolean;
}

const WRAPPED = Symbol("antirea.recordBudgetWrapped");

/**
 * Express/Connect middleware enforcing the distinct-record budget.
 *
 * Before the handler: an identity already at its cap is rejected with
 * `429 { error: "record_budget_exceeded", used, limit }` and the handler
 * never runs; with `reserveUnits` set, a failed reservation rejects the
 * same way. After the handler: the response's `json`/`end` are wrapped so
 * the record ids the response actually contained are consumed via
 * `extractRecordIds` (or the `emptyResultFloorUnits` floor is charged when
 * it contained none), and any reservation is released. Requests with no
 * resolvable identity pass through unbudgeted (the quota guard's IP
 * dimension remains the backstop there).
 */
export function createExpressRecordBudgetMiddleware(options: RecordBudgetMiddlewareOptions) {
  const budget = options.budget ?? createRecordBudget(options);
  const reserveUnits = Math.max(0, Math.floor(options.reserveUnits ?? 0) || 0);
  const emptyFloor = Math.max(0, Math.floor(options.emptyResultFloorUnits ?? 1) || 0);
  const noStore = options.noStore !== false;
  return async function recordBudgetMiddleware(
    req: RecordBudgetExpressRequest,
    res: QuotaExpressResponse,
    next: QuotaExpressNext,
  ): Promise<void> {
    let identityKey: string | undefined;
    try {
      identityKey = await resolveRecordBudgetIdentityKey(req, options);
    } catch (err) {
      next(err);
      return;
    }
    if (!identityKey) {
      next();
      return;
    }
    const key = identityKey;
    if (noStore) res.setHeader("Cache-Control", "private, no-store");

    const rejectAtCap = (gate: RecordBudgetCheckResult): void => {
      const body = {
        error: "record_budget_exceeded",
        message:
          "This identity has received its distinct-record budget for the current window; " +
          "narrow the query or retry after the window resets.",
        used: gate.used,
        limit: gate.limit,
      };
      res.setHeader("X-RecordBudget-Limit", String(gate.limit));
      res.setHeader("X-RecordBudget-Used", String(gate.used));
      res.setHeader("X-RecordBudget-Remaining", "0");
      if (typeof res.status === "function") {
        const chained = res.status(429);
        if (chained && typeof chained.json === "function") {
          chained.json(body);
          return;
        }
      }
      if (typeof res.json === "function") {
        res.json(body);
        return;
      }
      res.statusCode = 429;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };

    const gate = budget.check(key, 1);
    req.recordBudgetUsage = gate;
    if (!gate.allowed) {
      rejectAtCap(gate);
      return;
    }

    let reserved = 0;
    if (reserveUnits > 0) {
      if (!budget.reserve(key, reserveUnits)) {
        rejectAtCap(budget.check(key, 1));
        return;
      }
      reserved = reserveUnits;
    }

    let accounted = false;
    const recordFromBody = (body: unknown): void => {
      if (accounted) return;
      accounted = true;
      try {
        const ids = options.extractRecordIds(body, req);
        if (ids && ids.length > 0) {
          const after = budget.consume(key, ids);
          req.recordBudgetUsage = after;
          res.setHeader("X-RecordBudget-Limit", String(after.limit));
          res.setHeader("X-RecordBudget-Used", String(after.used));
          res.setHeader("X-RecordBudget-Remaining", String(after.remaining));
        } else if (emptyFloor > 0) {
          const after = budget.charge(key, emptyFloor);
          req.recordBudgetUsage = after;
          res.setHeader("X-RecordBudget-Limit", String(after.limit));
          res.setHeader("X-RecordBudget-Used", String(after.used));
          res.setHeader("X-RecordBudget-Remaining", String(after.remaining));
        }
      } catch {
        /* Extraction must never break the host response. */
      } finally {
        if (reserved > 0) {
          budget.release(key, reserved);
          reserved = 0;
        }
      }
    };

    const wrapTarget = (target: QuotaExpressResponse): void => {
      const marked = target as QuotaExpressResponse & { [WRAPPED]?: boolean };
      if (marked[WRAPPED]) return;
      marked[WRAPPED] = true;
      if (typeof target.json === "function") {
        const originalJson = target.json.bind(target);
        target.json = (body: unknown) => {
          recordFromBody(body);
          return originalJson(body);
        };
      }
      if (typeof target.end === "function") {
        const originalEnd = target.end.bind(target);
        target.end = (body?: string) => {
          if (typeof body === "string" && body.length > 0) {
            try {
              recordFromBody(JSON.parse(body));
            } catch {
              /* Non-JSON body: zero extractable ids - the floor applies. */
              recordFromBody(undefined);
            }
          } else {
            /* Bodyless end: settle the floor and any reservation. */
            recordFromBody(undefined);
          }
          return originalEnd(body);
        };
      }
    };

    wrapTarget(res);
    if (typeof res.status === "function") {
      const originalStatus = res.status.bind(res);
      res.status = (code: number) => {
        const chained = originalStatus(code);
        if (chained && chained !== res && typeof chained === "object") {
          wrapTarget(chained as QuotaExpressResponse);
          return chained;
        }
        return chained ?? res;
      };
    }
    next();
  };
}
