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
 */

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

export type QuotaDimension = "account" | "apiKey" | "ip";

export type QuotaExceededKind =
  | "rate_limit_exceeded"
  | "page_size_exceeded"
  | "max_page_exceeded";

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

/**
 * Storage contract for sliding windows. Implementations must prune entries
 * older than `windowMs` relative to `now` inside both operations.
 */
export interface QuotaWindowStore {
  peek(key: string, now: number, windowMs: number): Promise<QuotaWindowSnapshot> | QuotaWindowSnapshot;
  record(key: string, now: number, windowMs: number): Promise<void> | void;
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
   * `apiKeyId` from your server auth middleware — never from unverified
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
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export const DEFAULT_QUOTA_TIERS: Record<string, QuotaTierConfig> = {
  anonymous: { maxRequests: 30, windowMs: 60_000, maxPageSize: 25, maxPage: 5 },
  free: { maxRequests: 60, windowMs: 60_000, maxPageSize: 50, maxPage: 20 },
  pro: { maxRequests: 300, windowMs: 60_000, maxPageSize: 200, maxPage: 100 },
  enterprise: { maxRequests: 3_000, windowMs: 60_000, maxPageSize: 1_000, maxPage: 1_000 },
};

/** Bounded in-memory sliding-window store: expired timestamps are pruned on every access and the key set is capped. */
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
      const fresh = prune(key, now, windowMs);
      fresh.push(now);
      windows.delete(key);
      windows.set(key, fresh);
      while (windows.size > cap) {
        const oldestKey = windows.keys().next().value;
        if (oldestKey === undefined) break;
        windows.delete(oldestKey);
      }
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
}

export function createQuotaGuard(options: QuotaGuardOptions = {}): QuotaGuard {
  const tiers = options.tiers ?? DEFAULT_QUOTA_TIERS;
  const mode = options.paginationMode ?? "reject";
  const defaultPageSize = Math.max(1, Math.floor(options.defaultPageSize ?? 20) || 20);
  const store = options.store ?? createInMemoryQuotaStore(options.maxEntries ?? 10_000);
  const clock = options.now ?? (() => Date.now());

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
    const now = clock();
    const identity: QuotaIdentity = (await options.resolveIdentity?.(req)) ?? {};
    const ip = resolveIp(req, identity, options.trustedIpHeader);
    const tierName = identity.tier ?? options.defaultTier ?? "anonymous";
    const tier = tierConfig(tierName);

    const dimensions: Array<{ dimension: QuotaDimension; key: string }> = [];
    if (identity.accountId) dimensions.push({ dimension: "account", key: `account:${identity.accountId}` });
    if (identity.apiKeyId) dimensions.push({ dimension: "apiKey", key: `apikey:${identity.apiKeyId}` });
    if (ip) dimensions.push({ dimension: "ip", key: `ip:${ip}` });
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
        timestamp: new Date(now).toISOString(),
      });
      const message =
        kind === "rate_limit_exceeded"
          ? "Too many requests; slow down and retry after the indicated interval."
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
    const snapshots = new Map<string, QuotaWindowSnapshot>();
    for (const { dimension, key } of dimensions) {
      const snapshot = await store.peek(key, now, tier.windowMs);
      snapshots.set(key, snapshot);
      if (snapshot.count >= tier.maxRequests) {
        const oldest = snapshot.oldest ?? now;
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest + tier.windowMs - now) / 1000));
        return reject("rate_limit_exceeded", dimension, tier.maxRequests, retryAfterSeconds, parsed.pagination);
      }
    }

    // 3. Allowed: record one hit per dimension and report the tightest
    //    remaining headroom (the primary dimension) as rate-limit metadata.
    for (const { key } of dimensions) {
      await store.record(key, now, tier.windowMs);
    }
    const primarySnapshot = primary ? snapshots.get(primary.key) : undefined;
    const remaining = Math.max(0, tier.maxRequests - ((primarySnapshot?.count ?? 0) + (primary ? 1 : 0)));
    const resetEpochSeconds = primarySnapshot?.oldest
      ? Math.ceil((primarySnapshot.oldest + tier.windowMs) / 1000)
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
    };
  };

  return { checkRequest, tiers };
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
