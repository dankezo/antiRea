/** Canary routes emit alerts only; do not use them for automated banning or poisoned schemas. */
export const CANARY_ENDPOINTS = [
  "/api/v1/internal/schema-export",
  "/api/v1/internal/prompt-registry",
  "/api/v2/admin/feature-flags-dump",
  "/api/v1/billing/enterprise-override",
] as const;

export interface HoneypotAlertPayload {
  path: string;
  rawPath?: string;
  timestamp: string;
  method: string;
  ip?: string;
  userId?: string;
  userAgent?: string;
  /** Set by the Canary Maze handler: the hit landed inside the maze prefix. */
  maze?: boolean;
  /** Set by the Canary Maze handler: path depth under the maze prefix (0 = prefix root). */
  depth?: number;
}

export interface CanaryOptions {
  /** Custom canary trap paths; defaults to CANARY_ENDPOINTS. */
  paths?: readonly string[];
  onAlert?: (alert: HoneypotAlertPayload) => Promise<void> | void;
  /** Set only if a trusted edge proxy strips/replaces untrusted copies. */
  trustedIpHeader?: string;
  /** Account identity must come from your authenticated server session, never an HTTP header. */
  resolveUserId?: () => string | undefined | Promise<string | undefined>;
  /** Ignore cross-site browser requests to reduce false positives. */
  ignoreCrossSite?: boolean;
}

export interface CanaryRequest {
  url: string;
  method?: string;
  headers: { get(name: string): string | null };
}

export interface CanaryResult {
  isTrapped: boolean;
  status: number;
  body: Record<string, unknown>;
  ignored?: boolean;
}

/**
 * Normalize URL or path before comparing against registered Canary endpoints:
 * - Strip query string (?...) and fragment (#...)
 * - Strip scheme + origin if a full URL is supplied
 * - Safely decode percent-encoding (e.g. %2D -> -, %5F -> _, with fallback on malformed sequences)
 * - Collapse consecutive slashes (// -> /)
 * - Remove trailing slash (except root "/")
 * - Lowercase the entire path
 */
export function normalizeCanaryPath(rawUrlOrPath: string): string {
  if (!rawUrlOrPath || typeof rawUrlOrPath !== "string") {
    return "/";
  }
  let rawPathname = rawUrlOrPath.trim().split(/[?#]/, 1)[0] || "/";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(rawPathname)) {
    const schemeEnd = rawPathname.indexOf("://") + 3;
    const slashIdx = rawPathname.indexOf("/", schemeEnd);
    rawPathname = slashIdx >= 0 ? rawPathname.slice(slashIdx) : "/";
  }
  if (!rawPathname.startsWith("/")) {
    rawPathname = "/" + rawPathname;
  }
  let decoded = rawPathname;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    decoded = rawPathname.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  }
  const collapsed = decoded.replace(/\/+/g, "/");
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
  return (trimmed || "/").toLowerCase();
}

const DEFAULT_NORMALIZED_CANARIES = new Set<string>(CANARY_ENDPOINTS.map(normalizeCanaryPath));

const readFirstIp = (raw: string | null): string | undefined => {
  if (!raw) return undefined;
  const ip = raw.split(",")[0]?.trim();
  return ip && /^[\da-fA-F.:]{2,45}$/.test(ip) ? ip : undefined;
};

export async function handleCanaryTrapRequest(request: CanaryRequest, opts: CanaryOptions = {}): Promise<CanaryResult> {
  const normalizedPath = normalizeCanaryPath(request.url);
  const canarySet = opts.paths
    ? new Set<string>(opts.paths.map(normalizeCanaryPath))
    : DEFAULT_NORMALIZED_CANARIES;

  // Exact match after canonicalization, not prefix: /schema-exported is not a trap.
  if (!canarySet.has(normalizedPath)) {
    return { isTrapped: false, status: 200, body: {} };
  }
  if (opts.ignoreCrossSite !== false && request.headers.get("sec-fetch-site") === "cross-site") {
    return { isTrapped: false, ignored: true, status: 404, body: {} };
  }
  try {
    await opts.onAlert?.({
      path: normalizedPath,
      timestamp: new Date().toISOString(),
      method: request.method ?? "GET",
      userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? undefined,
      ip: opts.trustedIpHeader ? readFirstIp(request.headers.get(opts.trustedIpHeader)) : undefined,
      userId: await opts.resolveUserId?.(),
    });
  } catch {
    // Monitoring must never break the host application.
  }
  return { isTrapped: true, status: 404, body: { error: "not_found" } };
}

/** Convenience builder for a single custom canary route handler. */
export function createCanaryRoute(config: { path: string } & Omit<CanaryOptions, "paths">) {
  const normalized = normalizeCanaryPath(config.path);
  return {
    path: normalized,
    handle: (request: CanaryRequest) => handleCanaryTrapRequest(request, { ...config, paths: [normalized] }),
  };
}

/** Returns decoy route paths for optional client-side reference; discovery is never guaranteed. */
export function getClientDecoyRoutes(): readonly string[] {
  return CANARY_ENDPOINTS;
}

/**
 * @deprecated Use getClientDecoyRoutes() instead. Kept for backward compatibility.
 */
export const registerClientBundleCanaries = getClientDecoyRoutes;

export function robotsTxtSnippet(): string {
  return ["User-agent: *", ...CANARY_ENDPOINTS.map(p => `Disallow: ${p}`)].join("\n") + "\n";
}

/* ------------------------------------------------------------------------ */
/* Canary Maze: a deterministic decoy link space under a Disallowed prefix. */
/* A hit is an investigation signal only - never proof of malice, never a   */
/* reason to auto-ban. Page content is neutral wordlist filler by design:   */
/* no poisoned text, no misleading pages, nothing that sabotages a client.  */
/* ------------------------------------------------------------------------ */

export interface CanaryMazeOptions {
  /** Trap URL prefix; every request under it is a maze page. Default "/_canary/". */
  prefix?: string;
  /** Kill switch. Default false: the maze is opt-in like every other Tier 2 feature. */
  enabled?: boolean;
  onAlert?: (alert: HoneypotAlertPayload) => Promise<void> | void;
  /** Set only if a trusted edge proxy strips/replaces untrusted copies. */
  trustedIpHeader?: string;
  /** Account identity must come from your authenticated server session, never an HTTP header. */
  resolveUserId?: () => string | undefined | Promise<string | undefined>;
  /** Ignore cross-site browser requests to reduce false positives. Default true. */
  ignoreCrossSite?: boolean;
  /** Outgoing maze links per page. Default 8, clamped to 1-32. */
  linksPerPage?: number;
  /** Per-IP request budget inside one window. Default 240. */
  maxRequestsPerIp?: number;
  /** Per-IP window length in milliseconds. Default 600_000 (10 minutes). */
  windowMs?: number;
  /** Global cap on maze responses per UTC day across all clients. Default 10_000. */
  dailyPageCap?: number;
  /** Status returned once a cap trips. Default 404; 429 is the only other supported value. */
  overCapStatus?: 404 | 429;
  /**
   * Optional response delay in milliseconds. Default 0 (off), clamped to 65_000.
   * A delay holds a server connection open: the signal value of a maze hit does
   * not need it, so enable only with the defender-side cost understood.
   */
  dripMs?: number;
  /** Extra seed material mixed into page generation; changing it reshapes the maze. */
  seed?: string;
}

export interface CanaryMazeResult extends CanaryResult {
  /** Served page markup when a maze page is returned; absent otherwise. */
  html?: string;
  contentType?: string;
  /** True when a cap (per-IP or daily) produced this response. */
  capped?: boolean;
}

/** Neutral filler vocabulary. Page text and maze path segments come only from this list. */
const MAZE_WORDS = [
  "amber", "anchor", "basket", "beacon", "breeze", "bridge", "candle", "canyon",
  "cedar", "compass", "copper", "coral", "cotton", "cradle", "desert", "ember",
  "falcon", "fern", "garden", "glacier", "harbor", "hazel", "heron", "island",
  "ivory", "juniper", "kettle", "lagoon", "lantern", "laurel", "meadow", "mirror",
  "mosaic", "needle", "oasis", "orchard", "pebble", "pioneer", "quarry", "ribbon",
  "river", "saddle", "sandal", "shadow", "summit", "temple", "timber", "valley",
  "velvet", "willow", "window", "zephyr",
] as const;

const clampInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
  const n = Math.floor(value ?? fallback);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** FNV-1a string hash: stable across processes, which is what makes pages deterministic. */
const hashMazeSeed = (input: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** mulberry32 PRNG: tiny, fast, and fully determined by its 32-bit seed. */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const encodeMazePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/**
 * Render one maze page. Everything on the page - heading, filler sentences,
 * link targets - is derived from a PRNG seeded by the page's own path, so the
 * same URL always renders byte-identical markup with no stored state. Link
 * targets only ever append one wordlist segment to the current path, so no
 * generated link can leave the maze prefix or point at real content.
 */
function buildMazePage(normalizedPath: string, seedMaterial: string, linksPerPage: number): string {
  const rand = mulberry32(hashMazeSeed(`${seedMaterial}:${normalizedPath}`));
  const pick = (): string => MAZE_WORDS[Math.floor(rand() * MAZE_WORDS.length)] as string;
  const sentence = (): string => {
    const count = 6 + Math.floor(rand() * 6);
    const words: string[] = [];
    for (let i = 0; i < count; i++) words.push(pick());
    const text = words.join(" ");
    return text.charAt(0).toUpperCase() + text.slice(1) + ".";
  };
  const paragraph = (): string => `<p>${sentence()} ${sentence()} ${sentence()}</p>`;
  const title = `${pick()} ${pick()}`;
  const links: string[] = [];
  for (let i = 0; i < linksPerPage; i++) {
    const href = encodeMazePath(`${normalizedPath}/${pick()}`);
    links.push(`<li><a href="${href}">${pick()} ${pick()}</a></li>`);
  }
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="robots" content="noindex,nofollow">',
    `<title>${title}</title>`,
    "</head>",
    "<body>",
    `<h1>${title}</h1>`,
    paragraph(),
    paragraph(),
    "<nav><ul>",
    ...links,
    "</ul></nav>",
    "</body>",
    "</html>",
  ].join("\n");
}

const readRemoteAddress = (request: CanaryRequest): string | undefined => {
  const raw = (request as { remoteAddress?: unknown }).remoteAddress;
  return typeof raw === "string" && /^[\da-fA-F.:]{2,45}$/.test(raw) ? raw : undefined;
};

/**
 * Create a Canary Maze handler for one URL prefix.
 *
 * The maze only exists when `enabled` is true; otherwise every request is
 * reported as not trapped and nothing is served or alerted. Serving budgets
 * are hard caps, not tuning hints: once the per-IP window budget or the
 * global daily budget is spent, the handler answers a plain 404 (or the
 * configured 429) so the trap can never become a self-DDoS surface.
 */
export function createCanaryMaze(opts: CanaryMazeOptions = {}): {
  prefix: string;
  handle: (request: CanaryRequest) => Promise<CanaryMazeResult>;
} {
  const root = normalizeCanaryPath(opts.prefix ?? "/_canary/");
  const prefix = root === "/" ? "/" : `${root}/`;
  const enabled = opts.enabled === true;
  const linksPerPage = clampInt(opts.linksPerPage, 8, 1, 32);
  const maxRequestsPerIp = clampInt(opts.maxRequestsPerIp, 240, 1, Number.MAX_SAFE_INTEGER);
  const windowMs = clampInt(opts.windowMs, 600_000, 1, Number.MAX_SAFE_INTEGER);
  const dailyPageCap = clampInt(opts.dailyPageCap, 10_000, 1, Number.MAX_SAFE_INTEGER);
  const overCapStatus: 404 | 429 = opts.overCapStatus === 429 ? 429 : 404;
  const dripMs = clampInt(opts.dripMs, 0, 0, 65_000);
  const seedMaterial = opts.seed ?? "canary-maze";

  // Bounded per-IP window counters, pruned with the same discipline as the
  // Web Bot Auth in-memory nonce store: expired entries go first, then the
  // oldest insertions, and the map never grows past MAX_IP_ENTRIES.
  const MAX_IP_ENTRIES = 10_000;
  const ipWindows = new Map<string, { start: number; count: number }>();
  const hitIpBudget = (key: string, now: number): boolean => {
    let entry = ipWindows.get(key);
    if (entry && now - entry.start >= windowMs) {
      ipWindows.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (ipWindows.size >= MAX_IP_ENTRIES) {
        for (const [k, v] of ipWindows) {
          if (now - v.start >= windowMs || ipWindows.size >= MAX_IP_ENTRIES) ipWindows.delete(k);
          if (ipWindows.size < MAX_IP_ENTRIES) break;
        }
      }
      entry = { start: now, count: 0 };
      ipWindows.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= maxRequestsPerIp;
  };

  let dayKey = "";
  let dayCount = 0;
  const hitDailyBudget = (now: number): boolean => {
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== dayKey) {
      dayKey = today;
      dayCount = 0;
    }
    dayCount += 1;
    return dayCount <= dailyPageCap;
  };

  const handle = async (request: CanaryRequest): Promise<CanaryMazeResult> => {
    if (!enabled) {
      return { isTrapped: false, status: 200, body: {} };
    }
    const path = normalizeCanaryPath(request.url);
    if (path !== root && !path.startsWith(prefix)) {
      return { isTrapped: false, status: 200, body: {} };
    }
    if (opts.ignoreCrossSite !== false && request.headers.get("sec-fetch-site") === "cross-site") {
      return { isTrapped: false, ignored: true, status: 404, body: {} };
    }
    const depth = path === root ? 0 : path.slice(prefix.length).split("/").length;
    const ip = opts.trustedIpHeader
      ? readFirstIp(request.headers.get(opts.trustedIpHeader))
      : readRemoteAddress(request);
    try {
      await opts.onAlert?.({
        path,
        timestamp: new Date().toISOString(),
        method: request.method ?? "GET",
        userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? undefined,
        ip,
        userId: await opts.resolveUserId?.(),
        maze: true,
        depth,
      });
    } catch {
      // Monitoring must never break the host application.
    }
    const now = Date.now();
    if (!hitIpBudget(ip ?? "unknown", now) || !hitDailyBudget(now)) {
      return {
        isTrapped: true,
        status: overCapStatus,
        body: { error: overCapStatus === 429 ? "rate_limited" : "not_found" },
        capped: true,
      };
    }
    if (dripMs > 0) {
      await new Promise(resolve => setTimeout(resolve, dripMs));
    }
    return {
      isTrapped: true,
      status: 200,
      body: {},
      html: buildMazePage(path, seedMaterial, linksPerPage),
      contentType: "text/html; charset=utf-8",
    };
  };

  return { prefix, handle };
}

const escapeHtmlAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Bait-link snippet for a maze prefix. The hiding mechanism is `display:none`
 * on the container, which removes the link from both the accessibility tree
 * and the tab order; `aria-hidden` is defense-in-depth only, and
 * `tabindex="-1"` plus `rel="nofollow"` keep the link out of keyboard
 * navigation and crawler link equity. Pair with canaryRobotsTxt().
 */
export function canaryTrapLink(prefixOrPath: string): string {
  const href = escapeHtmlAttribute(prefixOrPath.startsWith("/") ? prefixOrPath : `/${prefixOrPath}`);
  return `<span style="display:none" aria-hidden="true"><a href="${href}" tabindex="-1" rel="nofollow">archive</a></span>`;
}

/** The robots.txt line that keeps cooperative crawlers out of a maze prefix. */
export function canaryRobotsTxt(prefix: string): string {
  return `Disallow: ${normalizeCanaryPath(prefix)}/\n`;
}
