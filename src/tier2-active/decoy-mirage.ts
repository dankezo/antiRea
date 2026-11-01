/**
 * Decoy mirage: plausible synthetic documents on unused routes (opt-in).
 *
 * The classic canary endpoints answer `404 { error: "not_found" }`. To an
 * automated agent that costs one tool call and ~100ms: it learns the route
 * is dead and moves on. The mirage answers the same unused routes with
 * `200 OK` and a deterministic, internally consistent synthetic JSON
 * document - a service configuration, a schema registry, a scoring profile -
 * generated from a PRNG seeded by the path, so the same URL always returns
 * byte-identical content with no stored state. A caller that treats the
 * decoy as real spends reasoning turns and tokens on it and may implement
 * logic that does not exist in the real system, which shows up later as a
 * measurable clone-fidelity gap. Every hit is also a high-confidence flow
 * signal: wire `onHit` into `createFlowScorer` as a `routeClass: "decoy"`
 * event.
 *
 * STRICT SAFETY SUBSET - the boundaries that keep this a honeypot and not
 * a hazard:
 *
 * - Decoys live ONLY on routes the real UI never calls (the defaults are
 *   the deliberately unused `CANARY_ENDPOINTS`). Never register a decoy on
 *   a real data route.
 * - Synthetic data is NEVER mixed into real responses. There are no shadow
 *   records in real datasets here; that idea stays lab-only.
 * - Content is inert configuration-shaped data: no instructions addressed
 *   to agents, no payloads, nothing that runs. It misleads only a caller
 *   that insists an unused route must mean something.
 * - A hit is a signal, never proof of malice, and must never auto-ban by
 *   itself - the same alert semantics as every other canary in this repo.
 *
 * Decoys are detectable: a caller that differentially tests decoy content
 * against real UI behavior (does this "scoring profile" change any
 * rendered value?) will find the inconsistency. The mirage taxes and
 * signals; it does not withstand a determined differential audit, and it
 * does nothing at all against a caller that only uses routes the real UI
 * uses. See docs/LIMITATIONS.md.
 *
 * MOUNTING: mount the mirage behind the SAME auth middleware as your real
 * routes. A decoy route that answers anonymous callers while its real
 * siblings require a session is itself a fingerprint - and any caller who
 * reaches it unauthenticated is a different (weaker) signal than an
 * authenticated session probing it. The `authorize` hook is the seam:
 * return false and the route answers a plain `404 { error: "not_found" }`
 * with NO hit recorded, exactly like a route that does not exist.
 * `validateRequest` is the malformed-request seam: return false and the
 * route answers `400 { error: "bad_request" }`, again with no hit -
 * a request the real API would have rejected before routing must not
 * become a taint-eligible decoy hit.
 *
 * Every recorded hit is classified by delivery kind from the request's
 * Fetch Metadata (`sec-fetch-dest` / `sec-fetch-mode`) and reported on the
 * payload as `hitKind`: `ambient` for browser-driven loads (image,
 * document, style, script, font, video, audio, iframe destinations, or
 * navigation mode) - which any page, preview or embed can cause without
 * intent - and `programmatic` for everything else. `createFlowScorer`
 * treats ambient hits as weak evidence and never taints on them.
 *
 * Serving cost is O(1) per hit after the first: each path's document is
 * generated once and cached in a bounded in-memory map.
 */

import {
  CANARY_ENDPOINTS,
  normalizeCanaryPath,
  type CanaryRequest,
  type HoneypotAlertPayload,
} from "./honeypot-middleware";
import type { QuotaExpressNext, QuotaExpressResponse } from "./quota-guard";

/** How a decoy hit was delivered, classified from Fetch Metadata. */
export type DecoyHitKind = "ambient" | "programmatic";

export interface DecoyHitPayload extends HoneypotAlertPayload {
  /** Always true: this hit landed on a decoy mirage route. */
  decoy: true;
  /**
   * Delivery classification from `sec-fetch-dest` / `sec-fetch-mode`:
   * `ambient` for browser-driven loads, `programmatic` for deliberate
   * client fetches. The flow scorer never taints on ambient hits.
   */
  hitKind: DecoyHitKind;
}

export interface DecoyMirageOptions {
  /**
   * Unused routes to serve decoys on. Defaults to `CANARY_ENDPOINTS`.
   * Register ONLY routes the real UI never calls.
   */
  paths?: readonly string[];
  /** Alert sink for hits. Errors thrown here are swallowed: monitoring must never break the host application. */
  onHit?: (hit: DecoyHitPayload) => Promise<void> | void;
  /** Set only if a trusted edge proxy strips/replaces untrusted copies. */
  trustedIpHeader?: string;
  /** Account identity must come from your authenticated server session, never an HTTP header. */
  resolveUserId?: () => string | undefined | Promise<string | undefined>;
  /**
   * Ignore requests carrying `sec-fetch-site: cross-site`. Default false
   * (mirrors the canary handler). That header is supplied by the client: any
   * non-browser client can send it to opt itself out of detection, so
   * enabling this is only a noise heuristic for genuine browser cross-site
   * embeds — never a trust decision.
   */
  ignoreCrossSite?: boolean;
  /** Extra seed material mixed into document generation; changing it reshapes every document. */
  seed?: string;
  /** Per-path document overrides (keys are normalized before matching). Served verbatim. */
  documents?: Record<string, Record<string, unknown>>;
  /** Custom generator replacing the built-in one. Must be deterministic per path to preserve the mirage's internal consistency. */
  generate?: (path: string, seedScope?: string) => Record<string, unknown>;
  /**
   * Authorization seam, checked before any hit is recorded. Return false
   * and the route answers a plain `404 { error: "not_found" }` with NO hit
   * fired - mount the mirage behind the same auth as real routes and use
   * this to keep unauthenticated callers indistinguishable from a missing
   * route. A throwing hook fails closed (treated as false).
   */
  authorize?: (request: CanaryRequest) => boolean | Promise<boolean>;
  /**
   * Request-shape seam, checked after `authorize`. Return false and the
   * route answers `400 { error: "bad_request" }` with NO hit fired - a
   * request the real API would reject before routing must not become a
   * taint-eligible decoy hit. A throwing hook fails closed.
   */
  validateRequest?: (request: CanaryRequest) => boolean | Promise<boolean>;
  /**
   * Per-request seed scope (for example the caller's account id), mixed
   * into document generation so different scopes see DIFFERENT synthetic
   * documents for the same path, while one scope's document stays stable.
   * Per-path `documents` overrides are scope-independent and served
   * verbatim regardless.
   */
  seedScope?: (request: CanaryRequest) => string | undefined | Promise<string | undefined>;
}

export interface DecoyMirageResult {
  isDecoy: boolean;
  status: number;
  body: Record<string, unknown>;
  ignored?: boolean;
  /**
   * True when the middleware must write `status`/`body` itself even though
   * `isDecoy` is false (the `authorize` 404 and `validateRequest` 400
   * seams). Absent for plain non-matches, which fall through to `next()`.
   */
  respond?: boolean;
}

export interface DecoyMirage {
  /** Normalized decoy paths being served. */
  readonly paths: readonly string[];
  handle: (request: CanaryRequest) => Promise<DecoyMirageResult>;
  /** Express/Connect middleware: serves the decoy on a match, otherwise calls `next()`. */
  middleware: (
    req: CanaryRequest & Record<string, unknown>,
    res: QuotaExpressResponse,
    next: QuotaExpressNext,
  ) => Promise<void>;
}

/* FNV-1a + mulberry32, the same deterministic pair the Canary Maze uses:   */
/* stable across processes, which is what makes documents reproducible.    */
const hashSeed = (input: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const mulberry32 = (seed: number): (() => number) => {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const SERVICE_WORDS = [
  "registry", "gateway", "profile", "matrix", "engine", "console",
  "ledger", "planner", "catalog", "monitor", "scheduler", "index",
] as const;

const FIELD_NAMES = [
  "account_status", "credit_limit", "risk_score", "utilization_ratio",
  "delinquency_count", "tenure_months", "payment_velocity", "exposure_band",
  "review_cycle", "segment_code", "region_code", "last_activity_at",
] as const;

const FEATURE_NAMES = [
  "deltaSync", "batchReconciliation", "tieredScoring", "manualReviewQueue",
  "scheduledExports", "auditTrail", "segmentOverrides", "currencyNormalization",
] as const;

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Build one synthetic document for a path. The archetype, names and values
 * all derive from the path-seeded PRNG, so a path's document is stable
 * across calls, instances and restarts - an agent comparing responses
 * across sessions finds them consistent, because they are.
 */
function buildDecoyDocument(normalizedPath: string, seedMaterial: string): Record<string, unknown> {
  const rand = mulberry32(hashSeed(`${seedMaterial}:${normalizedPath}`));
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const segments = normalizedPath.split("/").filter(Boolean);
  const leaf = (segments[segments.length - 1] ?? "service").replace(/[^a-z0-9-]/g, "") || "service";
  const service = `${leaf}-${pick(SERVICE_WORDS)}`;
  const version = `${1 + Math.floor(rand() * 3)}.${Math.floor(rand() * 9)}.${Math.floor(rand() * 9)}`;
  const revision = Math.floor(rand() * 0xffff_ffff).toString(16).padStart(8, "0");
  const effectiveFrom = new Date(Date.UTC(2024, Math.floor(rand() * 12), 1 + Math.floor(rand() * 28)))
    .toISOString()
    .slice(0, 10);
  const archetype = Math.floor(rand() * 3);

  if (archetype === 0) {
    const features: Record<string, boolean> = {};
    for (const name of FEATURE_NAMES) {
      if (rand() > 0.35) features[name] = rand() > 0.3;
    }
    return {
      document: "service-config",
      service,
      version,
      revision,
      effectiveFrom,
      features,
      limits: {
        maxBatchSize: 50 * (1 + Math.floor(rand() * 8)),
        syncIntervalSeconds: 60 * (1 + Math.floor(rand() * 9)),
        retentionDays: 30 * (1 + Math.floor(rand() * 11)),
        maxConcurrentSessions: 2 + Math.floor(rand() * 6),
      },
    };
  }

  if (archetype === 1) {
    const fieldCount = 6 + Math.floor(rand() * 5);
    const fields: Array<Record<string, unknown>> = [];
    const used = new Set<string>();
    for (let i = 0; i < fieldCount; i++) {
      const name = pick(FIELD_NAMES);
      if (used.has(name)) continue;
      used.add(name);
      fields.push({
        name,
        type: pick(["string", "number", "integer", "boolean", "timestamp"] as const),
        nullable: rand() > 0.5,
        indexed: rand() > 0.4,
      });
    }
    return {
      document: "schema-registry",
      service,
      version,
      revision,
      effectiveFrom,
      models: [{ name: `${leaf}_record`, fields }],
    };
  }

  const factorCount = 5 + Math.floor(rand() * 4);
  const factors: Array<Record<string, unknown>> = [];
  const usedFactors = new Set<string>();
  for (let i = 0; i < factorCount; i++) {
    const name = pick(FIELD_NAMES);
    if (usedFactors.has(name)) continue;
    usedFactors.add(name);
    factors.push({
      name: `${name}_weight`,
      weight: round(0.05 + rand() * 0.6, 3),
      decay: round(rand() * 0.9, 2),
    });
  }
  return {
    document: "scoring-profile",
    service,
    version,
    revision,
    effectiveFrom,
    factors,
    thresholds: {
      reviewAbove: 40 + Math.floor(rand() * 30),
      declineAbove: 75 + Math.floor(rand() * 20),
      stepUpIntervalDays: 7 * (1 + Math.floor(rand() * 3)),
    },
  };
}

const readFirstIp = (raw: string | null): string | undefined => {
  if (!raw) return undefined;
  const ip = raw.split(",")[0]?.trim();
  return ip && /^[\da-fA-F.:]{2,45}$/.test(ip) ? ip : undefined;
};

/** Fetch Metadata destinations that mean a browser drove this load itself. */
const AMBIENT_DESTS: ReadonlySet<string> = new Set([
  "image", "document", "style", "script", "font", "video", "audio", "iframe",
]);

/**
 * Classify a hit's delivery from Fetch Metadata: a listed destination or
 * navigation mode means the browser loaded the URL ambiently (an embed, a
 * preview, a typed navigation); anything else is a deliberate client fetch.
 */
const classifyHitKind = (request: CanaryRequest): DecoyHitKind => {
  const dest = request.headers.get("sec-fetch-dest")?.trim().toLowerCase();
  const mode = request.headers.get("sec-fetch-mode")?.trim().toLowerCase();
  if ((dest !== undefined && AMBIENT_DESTS.has(dest)) || mode === "navigate") return "ambient";
  return "programmatic";
};

export function createDecoyMirage(options: DecoyMirageOptions = {}): DecoyMirage {
  const seedMaterial = options.seed ?? "decoy-mirage";
  const pathSet = new Set<string>((options.paths ?? CANARY_ENDPOINTS).map(normalizeCanaryPath));
  const overrides = new Map<string, Record<string, unknown>>();
  if (options.documents) {
    for (const [path, doc] of Object.entries(options.documents)) {
      overrides.set(normalizeCanaryPath(path), doc);
    }
  }
  const cache = new Map<string, Record<string, unknown>>();
  const MAX_CACHED = 1_000;

  const documentFor = (normalizedPath: string, scope?: string): Record<string, unknown> => {
    const override = overrides.get(normalizedPath);
    if (override) return override;
    const cacheKey = scope !== undefined ? `${scope}\n${normalizedPath}` : normalizedPath;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const built = options.generate
      ? options.generate(normalizedPath, scope)
      : buildDecoyDocument(normalizedPath, scope !== undefined ? `${seedMaterial}|scope:${scope}` : seedMaterial);
    if (cache.size >= MAX_CACHED) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(cacheKey, built);
    return built;
  };

  /** Run a boolean host hook, failing closed on a throw. */
  const hookAllows = async (
    hook: ((request: CanaryRequest) => boolean | Promise<boolean>) | undefined,
    request: CanaryRequest,
  ): Promise<boolean> => {
    if (!hook) return true;
    try {
      return (await hook(request)) !== false;
    } catch {
      return false;
    }
  };

  const handle = async (request: CanaryRequest): Promise<DecoyMirageResult> => {
    const normalizedPath = normalizeCanaryPath(request.url);
    if (!pathSet.has(normalizedPath)) {
      return { isDecoy: false, status: 200, body: {} };
    }
    if (options.ignoreCrossSite === true && request.headers.get("sec-fetch-site") === "cross-site") {
      return { isDecoy: false, ignored: true, status: 404, body: {} };
    }
    if (!(await hookAllows(options.authorize, request))) {
      // Indistinguishable from a route that does not exist; no hit.
      return { isDecoy: false, respond: true, status: 404, body: { error: "not_found" } };
    }
    if (!(await hookAllows(options.validateRequest, request))) {
      // The real API would have rejected this before routing; no hit.
      return { isDecoy: false, respond: true, status: 400, body: { error: "bad_request" } };
    }
    const hitKind = classifyHitKind(request);
    let scope: string | undefined;
    try {
      scope = await options.seedScope?.(request);
    } catch {
      scope = undefined;
    }
    try {
      await options.onHit?.({
        path: normalizedPath,
        timestamp: new Date().toISOString(),
        method: request.method ?? "GET",
        userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? undefined,
        ip: options.trustedIpHeader ? readFirstIp(request.headers.get(options.trustedIpHeader)) : undefined,
        userId: await options.resolveUserId?.(),
        decoy: true,
        hitKind,
      });
    } catch {
      // Monitoring must never break the host application.
    }
    return { isDecoy: true, status: 200, body: documentFor(normalizedPath, scope) };
  };

  const middleware = async (
    req: CanaryRequest & Record<string, unknown>,
    res: QuotaExpressResponse,
    next: QuotaExpressNext,
  ): Promise<void> => {
    let result: DecoyMirageResult;
    try {
      result = await handle(req);
    } catch (err) {
      next(err);
      return;
    }
    if (!result.isDecoy && !result.respond) {
      next();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (typeof res.status === "function") {
      const chained = res.status(result.status);
      if (chained && typeof chained.json === "function") {
        chained.json(result.body);
        return;
      }
    }
    if (typeof res.json === "function") {
      res.json(result.body);
      return;
    }
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  };

  return { paths: [...pathSet], handle, middleware };
}
