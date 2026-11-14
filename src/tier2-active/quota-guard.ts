/**
 * Server-side quota and pagination guard (P0 control).
 *
 * Enforces per-account, per-API-key and per-IP sliding-window request quotas
 * plus per-query record (`limit`/`pageSize`) and page-depth (`page`/`offset`)
 * bounds, configured per plan tier. This is an abuse-cost control for YOUR OWN
 * API: it cannot stop a determined client, and an IP address or API key alone
 * is never proof of intent. Identity must come from your authenticated server
 * session (see `resolveIdentity`), never from unverified client claims.
 *
 * The default store is a single-process in-memory window. In a horizontally
 * scaled deployment, supply a shared `store` (for example backed by Redis
 * sorted sets: ZREMRANGEBYSCORE to prune, ZCARD to count, ZADD to record) so
 * every instance enforces the same window.
 *
 * The default store fails closed: it evicts only EXPIRED windows, and when it
 * is still full it refuses to open a new window - the guard then rejects the
 * request (429, kind `store_capacity_exceeded`) instead of silently dropping
 * an unexpired window and weakening the quota guarantee under load.
 *
 * A supplied store that THROWS (dead backend) or returns malformed data
 * fails closed the same way: `checkRequest` answers 429 with kind
 * `store_unavailable` and never propagates the store's exception into
 * the host's request path.
 *
 * Atomicity (F-02): with the bundled store - or any store implementing
 * the optional `recordIfBelow` operation - the limit check and the
 * record for a dimension are ONE store operation, so parallel requests
 * sharing a store cannot jointly overshoot the tier limit (the
 * pre-fix peek-then-record sequence let 12 of 12 parallel requests
 * through a limit of 5 against a 15 ms-latency store). A store
 * implementing only `peek`/`record` keeps that legacy sequence: it is
 * NOT atomic across concurrent requests, and the guard says so -
 * `atomicEnforcement` is false on the guard and on every result it
 * returns, so the deployment can see which guarantee it actually has.
 *
 * A request whose identity cannot be resolved at all (no account, no API key
 * and no determinable IP - for example a misnamed `trustedIpHeader` behind a
 * proxy) is NOT exempt: by default it is counted against a single shared
 * `unknown` bucket with the tier's normal limits. Set
 * `allowUnresolvedIdentity: true` only to restore the legacy skip behavior.
 *
 * Pagination: hosts must consume the guard's normalized parse
 * (`result.pagination`, attached as `req.quotaPagination` by the Express
 * middleware) instead of re-reading raw query parameters. Backends diverge on
 * duplicate parameters (first vs last value), array forms, `Number()` vs
 * `parseInt` semantics (`1e9`, `0x…`), `page` combined with `offset`, and
 * differently cased names - a handler that re-parses the raw query can serve
 * a different page than the one the guard validated.
 */

import { resolveIntervalClock } from "../internal/mono-clock";

export interface QuotaTierConfig {
  /** Maximum requests allowed inside `windowMs` per dimension (account / API key / IP). */
  maxRequests: number;
  /** Sliding-window length in milliseconds. */
  windowMs: number;
  /** Maximum records a single query may request (`limit` / `pageSize`). */
  maxPageSize: number;
  /** Maximum page depth a single query may reach (`page`, or derived from `offset`). */
  maxPage: number;
}

export interface QuotaIdentity {
  /** Authenticated account id, resolved by server-side auth. Never trust a raw client header for this. */
  accountId?: string;
  /** Authenticated API-key id, resolved by server-side auth. */
  apiKeyId?: string;
  /** Plan tier name; must match a key of the configured `tiers`. */
  tier?: string;
  /** Optional IP override when the host app already resolved the client address. */
  ip?: string;
}

export type QuotaDimension = "account" | "apiKey" | "ip" | "unknown";

export type QuotaExceededKind =
  | "rate_limit_exceeded"
  | "page_size_exceeded"
  | "max_page_exceeded"
  | "store_capacity_exceeded"
  | "store_unavailable";

export interface QuotaExceededEvent {
  kind: QuotaExceededKind;
  /** The quota dimension that rejected the request (first exceeded, in account > apiKey > ip order). */
  dimension: QuotaDimension;
  accountId?: string;
  apiKeyId?: string;
  ip?: string;
  tier: string;
  /** The configured limit that was hit (requests, page size or page depth, per `kind`). */
  limit: number;
  /** Seconds the client was told to wait (`Retry-After`). */
  retryAfterSeconds: number;
  /** ISO-8601 timestamp from the guard clock. */
  timestamp: string;
}

export interface QuotaPagination {
  page: number;
  pageSize: number;
  offset: number;
  clamped: boolean;
}

export interface QuotaCheckResult {
  allowed: boolean;
  /** HTTP status to return: 200 when allowed, 429 when rejected. */
  status: number;
  /** Response headers to merge into the host response (rate-limit metadata, `Retry-After` on rejection). */
  headers: Record<string, string>;
  /** JSON body for rejections; `undefined` when allowed. */
  body?: { error: QuotaExceededKind; message: string; retryAfterSeconds: number };
  /** Sanitized pagination for the data layer (clamped in `clamp` mode, already validated in `reject` mode). */
  pagination: QuotaPagination;
  tier: string;
  identity: QuotaIdentity;
  /**
   * True when the window store enforces the check-and-record for a
   * dimension as one atomic operation (`recordIfBelow`), so parallel
   * requests cannot jointly overshoot the limit. False for legacy
   * peek/record stores (F-02): the limit then holds only
   * sequentially, and this flag is how the deployment can tell.
   */
  atomicEnforcement: boolean;
}

/** Minimal structural request shape: Fetch `Request`, the canary-style mock, or a Node/Express request. */
export interface QuotaRequestLike {
  url: string;
  method?: string;
  headers?:
    | { get(name: string): string | null }
    | Record<string, string | string[] | undefined>;
  remoteAddress?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
  connection?: { remoteAddress?: string };
  [key: string]: unknown;
}

export interface QuotaWindowSnapshot {
  count: number;
  /** Timestamp (ms) of the oldest request still inside the window, if any. */
  oldest?: number;
}

/** Outcome of one atomic check-and-record against a sliding window. */
export interface QuotaAtomicRecordResult {
  /** True when the hit was recorded (the post-operation `count` includes it). */
  recorded: boolean;
  /**
   * Set when the hit was refused for store CAPACITY (a new window at
   * the store's key cap) rather than for the window limit; the guard
   * then rejects with `store_capacity_exceeded` instead of
   * `rate_limit_exceeded`.
   */
  refusal?: "capacity";
  /** Hits inside the window after the operation. */
  count: number;
  /** Timestamp (ms) of the oldest hit still inside the window, if any. */
  oldest?: number;
}

/**
 * Storage contract for sliding windows. Implementations must prune entries
 * older than `windowMs` relative to `now` inside both operations.
 *
 * `record` may return `false` to signal that the store REFUSED to open a new
 * window because it is at capacity with unexpired windows; the guard then
 * rejects the request fail-closed (429, `store_capacity_exceeded`). Returning
 * `true` or nothing means the hit was recorded. Stores must never make room
 * by evicting unexpired windows.
 *
 * Atomic enforcement (F-02): a store that ALSO implements
 * `recordIfBelow` gives the guard a single check-and-record operation -
 * prune, compare against `limit`, and record only when below it, as one
 * indivisible step (a Redis Lua script / ZADD-with-guard, a SQL
 * transaction). The guard prefers it whenever present. A store with
 * only `peek`/`record` is served by the legacy two-step sequence and
 * the guard reports `atomicEnforcement: false`, because two instances
 * can both peek below the limit and both record.
 */
export interface QuotaWindowStore {
  peek(key: string, now: number, windowMs: number): Promise<QuotaWindowSnapshot> | QuotaWindowSnapshot;
  record(key: string, now: number, windowMs: number): Promise<boolean | void> | boolean | void;
  recordIfBelow?(
    key: string,
    now: number,
    windowMs: number,
    limit: number,
  ): Promise<QuotaAtomicRecordResult> | QuotaAtomicRecordResult;
}

export interface QuotaGuardOptions {
  /** Plan tiers by name. Defaults to `DEFAULT_QUOTA_TIERS`. */
  tiers?: Record<string, QuotaTierConfig>;
  /** Tier used when identity resolution does not name one. Defaults to `"anonymous"`. */
  defaultTier?: string;
  /** Header carrying the client IP, set ONLY by a trusted edge proxy that strips untrusted copies (e.g. `"cf-connecting-ip"`). */
  trustedIpHeader?: string;
  /**
   * Resolve the authenticated identity for a request. Populate `accountId` /
   * `apiKeyId` from your server auth middleware - never from unverified
   * client-supplied headers.
   */
  resolveIdentity?: (
    req: QuotaRequestLike,
  ) => QuotaIdentity | undefined | Promise<QuotaIdentity | undefined>;
  /** Structured operator event sink for rejections. Errors thrown here are swallowed: logging must never break request handling. */
  onQuotaExceeded?: (event: QuotaExceededEvent) => Promise<void> | void;
  /** `"reject"` returns 429 for out-of-bounds pagination; `"clamp"` silently caps values and flags `pagination.clamped`. Defaults to `"reject"`. */
  paginationMode?: "reject" | "clamp";
  /** Page size applied when the query does not specify one. Defaults to 20 (and never above the tier maximum). */
  defaultPageSize?: number;
  /** Shared window store for multi-instance deployments. Defaults to a bounded in-memory store. */
  store?: QuotaWindowStore;
  /** Cap on distinct dimension keys held by the default in-memory store. Defaults to 10,000. */
  maxEntries?: number;
  /**
   * When identity resolution yields no account, no API key AND no determinable
   * IP, the default (`false`) counts the request against a single shared
   * `unknown` bucket with the tier's normal limits, so an unresolvable request
   * is never silently exempt. Set to `true` only to restore the legacy
   * behavior of skipping quota checks for such requests.
   */
  allowUnresolvedIdentity?: boolean;
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. Display timestamps only (L-DEEP-2). */
  now?: () => number;
  /**
   * Monotonic clock for the sliding-window arithmetic (L-DEEP-2). The
   * guard passes this clock's timestamps to the window store, so window
   * pruning, `Retry-After` and the reset header are measured on a clock
   * that never steps. When only `now` is given, the injected clock
   * drives both domains (pre-patch behavior).
   */
  monoNow?: () => number;
}

export const DEFAULT_QUOTA_TIERS: Record<string, QuotaTierConfig> = {
  anonymous: { maxRequests: 30, windowMs: 60_000, maxPageSize: 25, maxPage: 5 },
  free: { maxRequests: 60, windowMs: 60_000, maxPageSize: 50, maxPage: 20 },
  pro: { maxRequests: 300, windowMs: 60_000, maxPageSize: 200, maxPage: 100 },
  enterprise: { maxRequests: 3_000, windowMs: 60_000, maxPageSize: 1_000, maxPage: 1_000 },
};

/**
 * Bounded in-memory sliding-window store: expired timestamps are pruned on
 * every access and the key set is capped. The cap fails closed - only expired
 * windows are ever evicted; when the store is still full, `record` returns
 * `false` for a NEW window and the guard rejects the request instead of the
 * store silently dropping live accounting.
 */
export function createInMemoryQuotaStore(maxEntries = 10_000): QuotaWindowStore {
  const cap = Math.max(100, Math.floor(maxEntries) || 10_000);
  const windows = new Map<string, number[]>();

  const prune = (key: string, now: number, windowMs: number): number[] => {
    const list = windows.get(key);
    if (!list) return [];
    const fresh = list.filter(t => now - t < windowMs);
    if (fresh.length === 0) windows.delete(key);
    else if (fresh.length !== list.length) windows.set(key, fresh);
    return fresh;
  };

  return {
    peek(key, now, windowMs) {
      const fresh = prune(key, now, windowMs);
      return { count: fresh.length, oldest: fresh.length ? Math.min(...fresh) : undefined };
    },
    record(key, now, windowMs) {
      const isNewWindow = !windows.has(key);
      const fresh = prune(key, now, windowMs);
      if (isNewWindow && windows.size >= cap) {
        // Make room only from expired windows; never evict a live one.
        for (const otherKey of [...windows.keys()]) prune(otherKey, now, windowMs);
        if (windows.size >= cap) return false;
      }
      fresh.push(now);
      windows.set(key, fresh);
      return true;
    },
    recordIfBelow(key, now, windowMs, limit) {
      // One indivisible step (this store is synchronous): prune,
      // compare, record only when below the limit - the F-02 atomic
      // path. Capacity rules mirror `record` exactly: at the key cap
      // a NEW window is refused, never made room for by evicting a
      // live window.
      const isNewWindow = !windows.has(key);
      const fresh = prune(key, now, windowMs);
      const oldest = fresh.length ? Math.min(...fresh) : undefined;
      if (fresh.length >= limit) return { recorded: false, count: fresh.length, oldest };
      if (isNewWindow && windows.size >= cap) {
        // Make room only from expired windows; never evict a live one.
        for (const otherKey of [...windows.keys()]) prune(otherKey, now, windowMs);
        if (windows.size >= cap) return { recorded: false, refusal: "capacity", count: fresh.length, oldest };
      }
      fresh.push(now);
      windows.set(key, fresh);
      return { recorded: true, count: fresh.length, oldest: Math.min(...fresh) };
    },
  };
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

/** Give Fetch-style resolvers a `headers.get` view even on Node/Express requests with plain-object headers. */
function normalizeRequest(req: QuotaRequestLike): QuotaRequestLike {
  const headers = req.headers;
  if (!headers || typeof (headers as { get?: unknown }).get === "function") return req;
  const record = headers as Record<string, string | string[] | undefined>;
  return {
    ...req,
    headers: {
      get(name: string): string | null {
        const wanted = name.toLowerCase();
        for (const key of Object.keys(record)) {
          if (key.toLowerCase() === wanted) {
            const value = record[key];
            return (Array.isArray(value) ? value[0] : value) ?? null;
          }
        }
        return null;
      },
    },
  };
}

function resolveIp(
  req: QuotaRequestLike,
  identity: QuotaIdentity,
  trustedIpHeader?: string,
): string | undefined {
  if (identity.ip) return identity.ip;
  if (trustedIpHeader) {
    const fromHeader = getHeader(req, trustedIpHeader);
    if (fromHeader) return fromHeader.split(",")[0]?.trim() || undefined;
  }
  return req.ip ?? req.remoteAddress ?? req.socket?.remoteAddress ?? req.connection?.remoteAddress;
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

interface ParsedPagination {
  pagination: QuotaPagination;
  sizeExceeded: boolean;
  pageExceeded: boolean;
}

function parsePagination(
  params: URLSearchParams,
  tier: QuotaTierConfig,
  mode: "reject" | "clamp",
  defaultPageSize: number,
): ParsedPagination {
  let clamped = false;

  const rawSize = parsePositiveInt(params.get("limit") ?? params.get("pageSize"));
  let pageSize = rawSize !== undefined && rawSize >= 1 ? rawSize : Math.min(defaultPageSize, tier.maxPageSize);
  const sizeExceeded = pageSize > tier.maxPageSize;
  if (sizeExceeded) {
    if (mode === "clamp") {
      pageSize = tier.maxPageSize;
      clamped = true;
    }
  }

  const rawPage = parsePositiveInt(params.get("page"));
  const rawOffset = parsePositiveInt(params.get("offset"));
  let page: number;
  if (rawPage !== undefined && rawPage >= 1) page = rawPage;
  else if (rawOffset !== undefined && rawOffset >= 0) page = Math.floor(rawOffset / pageSize) + 1;
  else page = 1;
  const pageExceeded = page > tier.maxPage;
  if (pageExceeded && mode === "clamp") {
    page = tier.maxPage;
    clamped = true;
  }

  return {
    pagination: { page, pageSize, offset: (page - 1) * pageSize, clamped },
    sizeExceeded: sizeExceeded && mode === "reject",
    pageExceeded: pageExceeded && mode === "reject",
  };
}

export interface QuotaGuard {
  checkRequest(req: QuotaRequestLike): Promise<QuotaCheckResult>;
  readonly tiers: Record<string, QuotaTierConfig>;
  /**
   * True when the configured store enforces check-and-record
   * atomically (`recordIfBelow`); false for legacy peek/record
   * stores, whose limit holds only sequentially (F-02).
   */
  readonly atomicEnforcement: boolean;
}

export function createQuotaGuard(options: QuotaGuardOptions = {}): QuotaGuard {
  const tiers = options.tiers ?? DEFAULT_QUOTA_TIERS;
  const mode = options.paginationMode ?? "reject";
  const defaultPageSize = Math.max(1, Math.floor(options.defaultPageSize ?? 20) || 20);
  const store = options.store ?? createInMemoryQuotaStore(options.maxEntries ?? 10_000);
  // F-02: a store exposing the atomic check-and-record operation gets
  // hard parallel enforcement; anything else is flagged, not hidden.
  const atomicStore = typeof store.recordIfBelow === "function";
  const { wall: clock, mono: monoClock } = resolveIntervalClock(options);

  const tierConfig = (name: string): QuotaTierConfig => {
    const direct = tiers[name];
    if (direct) return direct;
    const anonymous = tiers["anonymous"];
    if (anonymous) return anonymous;
    const first = Object.values(tiers)[0];
    return first ?? DEFAULT_QUOTA_TIERS["anonymous"]!;
  };

  const emit = async (event: QuotaExceededEvent): Promise<void> => {
    if (!options.onQuotaExceeded) return;
    try {
      await options.onQuotaExceeded(event);
    } catch {
      /* Operator logging must never break request handling. */
    }
  };

  const checkRequest = async (rawReq: QuotaRequestLike): Promise<QuotaCheckResult> => {
    const req = normalizeRequest(rawReq);
    // Window arithmetic runs on the monotonic clock (L-DEEP-2); the wall
    // clock is read once per request for the operator event timestamp.
    const now = monoClock();
    const wallNow = clock();
    const identity: QuotaIdentity = (await options.resolveIdentity?.(req)) ?? {};
    const ip = resolveIp(req, identity, options.trustedIpHeader);
    const tierName = identity.tier ?? options.defaultTier ?? "anonymous";
    const tier = tierConfig(tierName);

    const dimensions: Array<{ dimension: QuotaDimension; key: string }> = [];
    if (identity.accountId) dimensions.push({ dimension: "account", key: `account:${identity.accountId}` });
    if (identity.apiKeyId) dimensions.push({ dimension: "apiKey", key: `apikey:${identity.apiKeyId}` });
    if (ip) dimensions.push({ dimension: "ip", key: `ip:${ip}` });
    if (dimensions.length === 0 && options.allowUnresolvedIdentity !== true) {
      // No account, no API key and no determinable IP: never silently exempt.
      // All such requests share one "unknown" bucket at the tier's limits.
      dimensions.push({ dimension: "unknown", key: "unknown:unresolved" });
    }
    const primary = dimensions[0];

    const baseIdentity: QuotaIdentity = {
      ...(identity.accountId ? { accountId: identity.accountId } : {}),
      ...(identity.apiKeyId ? { apiKeyId: identity.apiKeyId } : {}),
      tier: tierName,
      ...(ip ? { ip } : {}),
    };

    const reject = async (
      kind: QuotaExceededKind,
      dimension: QuotaDimension,
      limit: number,
      retryAfterSeconds: number,
      pagination: QuotaPagination,
    ): Promise<QuotaCheckResult> => {
      await emit({
        kind,
        dimension,
        ...(identity.accountId ? { accountId: identity.accountId } : {}),
        ...(identity.apiKeyId ? { apiKeyId: identity.apiKeyId } : {}),
        ...(ip ? { ip } : {}),
        tier: tierName,
        limit,
        retryAfterSeconds,
        timestamp: new Date(wallNow).toISOString(),
      });
      const message =
        kind === "rate_limit_exceeded"
          ? "Too many requests; slow down and retry after the indicated interval."
          : kind === "store_capacity_exceeded"
            ? "Quota store is at capacity; the request was rejected rather than admitted unaccounted."
            : kind === "store_unavailable"
              ? "Quota store unavailable; the request was rejected rather than admitted unaccounted."
              : kind === "page_size_exceeded"
                ? `Requested page size exceeds the ${tierName} tier maximum of ${tier.maxPageSize}.`
                : `Requested page exceeds the ${tierName} tier maximum depth of ${tier.maxPage}.`;
      return {
        allowed: false,
        status: 429,
        headers: {
          "Retry-After": String(retryAfterSeconds),
          "X-RateLimit-Limit": String(tier.maxRequests),
          "X-RateLimit-Remaining": "0",
        },
        body: { error: kind, message, retryAfterSeconds },
        pagination,
        tier: tierName,
        identity: baseIdentity,
        atomicEnforcement: atomicStore,
      };
    };

    // 1. Pagination bounds first: an out-of-bounds query is rejected (or was
    //    already clamped) before it may consume any request quota.
    let params = new URLSearchParams();
    try {
      params = new URL(req.url, "http://quota.invalid").searchParams;
    } catch {
      params = new URLSearchParams();
    }
    const parsed = parsePagination(params, tier, mode, defaultPageSize);
    const windowRetryAfter = Math.max(1, Math.ceil(tier.windowMs / 1000));
    if (parsed.sizeExceeded) {
      return reject(
        "page_size_exceeded",
        primary?.dimension ?? "ip",
        tier.maxPageSize,
        windowRetryAfter,
        { ...parsed.pagination, pageSize: tier.maxPageSize, offset: (parsed.pagination.page - 1) * tier.maxPageSize },
      );
    }
    if (parsed.pageExceeded) {
      return reject("max_page_exceeded", primary?.dimension ?? "ip", tier.maxPage, windowRetryAfter, parsed.pagination);
    }

    // 2. Sliding-window rate check across every resolved dimension. The first
    //    exceeded dimension (account > apiKey > ip) is the reported one.
    //    A store that throws (dead backend) or answers malformed data
    //    fails closed with a structured `store_unavailable` rejection:
    //    the exception must never escape checkRequest into the host's
    //    request path, where an unwrapped async handler would turn it
    //    into a process-killing unhandled rejection (F-06).
    const snapshots = new Map<string, QuotaWindowSnapshot>();
    for (const { dimension, key } of dimensions) {
      let snapshot: QuotaWindowSnapshot;
      try {
        snapshot = await store.peek(key, now, tier.windowMs);
        if (!snapshot || typeof snapshot.count !== "number" || !Number.isFinite(snapshot.count)) {
          throw new Error("quota store returned a malformed snapshot");
        }
      } catch {
        return reject("store_unavailable", dimension, tier.maxRequests, windowRetryAfter, parsed.pagination);
      }
      snapshots.set(key, snapshot);
      if (snapshot.count >= tier.maxRequests) {
        const oldest = snapshot.oldest ?? now;
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest + tier.windowMs - now) / 1000));
        return reject("rate_limit_exceeded", dimension, tier.maxRequests, retryAfterSeconds, parsed.pagination);
      }
    }

    // 3. Allowed so far: record one hit per dimension and report the
    //    tightest remaining headroom (the primary dimension) as
    //    rate-limit metadata. A store refusal (full of unexpired
    //    windows) fails closed: the request is rejected rather than
    //    admitted without accounting.
    //    With an atomic store (F-02) the peek above stays as the
    //    fast-path reject and the pagination/identity plumbing, but
    //    the BINDING check is repeated inside the store operation:
    //    between the peek and here, a concurrent request may have
    //    filled the window, and only `recordIfBelow` sees that.
    const atomicOutcomes = new Map<string, QuotaAtomicRecordResult>();
    for (const { dimension, key } of dimensions) {
      if (atomicStore) {
        let outcome: QuotaAtomicRecordResult;
        try {
          outcome = await store.recordIfBelow!(key, now, tier.windowMs, tier.maxRequests);
          if (
            !outcome ||
            typeof outcome.recorded !== "boolean" ||
            typeof outcome.count !== "number" ||
            !Number.isFinite(outcome.count)
          ) {
            throw new Error("quota store returned a malformed atomic record result");
          }
        } catch {
          return reject("store_unavailable", dimension, tier.maxRequests, windowRetryAfter, parsed.pagination);
        }
        atomicOutcomes.set(key, outcome);
        if (!outcome.recorded) {
          if (outcome.refusal === "capacity") {
            return reject("store_capacity_exceeded", dimension, tier.maxRequests, windowRetryAfter, parsed.pagination);
          }
          const oldest = outcome.oldest ?? now;
          const retryAfterSeconds = Math.max(1, Math.ceil((oldest + tier.windowMs - now) / 1000));
          return reject("rate_limit_exceeded", dimension, tier.maxRequests, retryAfterSeconds, parsed.pagination);
        }
        continue;
      }
      let recorded: boolean | void;
      try {
        recorded = await store.record(key, now, tier.windowMs);
      } catch {
        return reject("store_unavailable", dimension, tier.maxRequests, windowRetryAfter, parsed.pagination);
      }
      if (recorded === false) {
        return reject("store_capacity_exceeded", dimension, tier.maxRequests, windowRetryAfter, parsed.pagination);
      }
    }
    const primarySnapshot = primary ? snapshots.get(primary.key) : undefined;
    const primaryOutcome = primary ? atomicOutcomes.get(primary.key) : undefined;
    const remaining = primaryOutcome
      ? Math.max(0, tier.maxRequests - primaryOutcome.count)
      : Math.max(0, tier.maxRequests - ((primarySnapshot?.count ?? 0) + (primary ? 1 : 0)));
    const resetOldest = primaryOutcome?.oldest ?? primarySnapshot?.oldest;
    const resetEpochSeconds = resetOldest
      ? Math.ceil((resetOldest + tier.windowMs) / 1000)
      : Math.ceil((now + tier.windowMs) / 1000);
    return {
      allowed: true,
      status: 200,
      headers: {
        "X-RateLimit-Limit": String(tier.maxRequests),
        "X-RateLimit-Remaining": String(remaining),
        "X-RateLimit-Reset": String(resetEpochSeconds),
      },
      pagination: parsed.pagination,
      tier: tierName,
      identity: baseIdentity,
      atomicEnforcement: atomicStore,
    };
  };

  return { checkRequest, tiers, atomicEnforcement: atomicStore };
}

/** Minimal structural Express-style response (avoids a runtime dependency on Express). */
export interface QuotaExpressResponse {
  setHeader(name: string, value: string): void;
  status?(code: number): { json(body: unknown): void } | QuotaExpressResponse;
  json?(body: unknown): void;
  statusCode?: number;
  end(body?: string): void;
}

export type QuotaExpressNext = (err?: unknown) => void;

export type QuotaExpressRequest = QuotaRequestLike & { quotaPagination?: QuotaPagination };

/**
 * Express/Connect middleware: attaches the sanitized pagination as
 * `req.quotaPagination` and calls `next()` when the request is within quota;
 * otherwise responds `429` with `Retry-After` and a JSON error body.
 * Handlers must read pagination from `req.quotaPagination`, never by
 * re-parsing the raw query string (see the module header on parser
 * divergence between backends).
 */
export function createExpressQuotaMiddleware(options: QuotaGuardOptions = {}) {
  const guard = createQuotaGuard(options);
  return async function quotaMiddleware(
    req: QuotaExpressRequest,
    res: QuotaExpressResponse,
    next: QuotaExpressNext,
  ): Promise<void> {
    let result: QuotaCheckResult;
    try {
      result = await guard.checkRequest(req);
    } catch (err) {
      next(err);
      return;
    }
    for (const [name, value] of Object.entries(result.headers)) {
      res.setHeader(name, value);
    }
    if (result.allowed) {
      req.quotaPagination = result.pagination;
      next();
      return;
    }
    const body = result.body ?? { error: "rate_limit_exceeded" };
    if (typeof res.status === "function") {
      const chained = res.status(result.status);
      if (chained && typeof chained.json === "function") {
        chained.json(body);
        return;
      }
    }
    if (typeof res.json === "function") {
      res.json(body);
      return;
    }
    res.statusCode = result.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
}
