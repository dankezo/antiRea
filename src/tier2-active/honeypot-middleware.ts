/** Canary routes emit alerts only; do not use them for automated banning or poisoned schemas. */
import { resolveIntervalClock } from "../internal/mono-clock";


/* Minimal structural view of node:crypto (mirrors canary-echo.ts). */
interface HoneypotNodeHmacLike {
  update(data: string | Uint8Array): HoneypotNodeHmacLike;
  digest(): Uint8Array;
}
interface HoneypotNodeCryptoLike {
  createHmac(algorithm: string, key: string | Uint8Array): HoneypotNodeHmacLike;
}
declare const require: ((id: string) => HoneypotNodeCryptoLike) | undefined;
function getHoneypotNodeCrypto(): HoneypotNodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.createHmac === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; honeytoken paths require Node.js");
}
import { CANARY_TRAP_PATHS } from "./trap-paths";

/**
 * The canary trap paths. The single source of truth is the ABP-08
 * registry in `trap-paths.ts`; this constant is a re-export of that
 * array (same object), so bait surfaces and detectors cannot drift.
 */
export const CANARY_ENDPOINTS = CANARY_TRAP_PATHS;

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
  /** Set by the Canary Maze handler: `true` when a serving cap (per-IP or daily) produced this hit's response, `false` when a page was served. Alerts fire after the cap checks, so this always reflects the enforced outcome. */
  capped?: boolean;
}

export interface CanaryOptions {
  /** Custom canary trap paths; defaults to CANARY_ENDPOINTS. */
  paths?: readonly string[];
  onAlert?: (alert: HoneypotAlertPayload) => Promise<void> | void;
  /** Set only if a trusted edge proxy strips/replaces untrusted copies. */
  trustedIpHeader?: string;
  /** Account identity must come from your authenticated server session, never an HTTP header. */
  resolveUserId?: () => string | undefined | Promise<string | undefined>;
  /**
   * Ignore requests carrying `sec-fetch-site: cross-site`. Default false.
   * That header is supplied by the client: any non-browser client can send
   * it to opt itself out of detection, so enabling this is only a noise
   * heuristic for genuine browser cross-site embeds - never a trust decision.
   */
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
  if (opts.ignoreCrossSite === true && request.headers.get("sec-fetch-site") === "cross-site") {
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
  /**
   * Ignore requests carrying `sec-fetch-site: cross-site`. Default false.
   * That header is supplied by the client: any non-browser client can send
   * it to opt itself out of detection, so enabling this is only a noise
   * heuristic for genuine browser cross-site embeds - never a trust decision.
   */
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
  /** Wall clock override - mainly for tests. Feeds the UTC daily budget only (L-DEEP-2). */
  now?: () => number;
  /**
   * Monotonic clock for the per-IP window arithmetic (L-DEEP-2). The maze
   * previously read `Date.now()` directly with no injection point; the
   * per-IP window now runs on this clock and is immune to wall-clock
   * steps. When only `now` is given, the injected clock drives both
   * domains (pre-patch behavior).
   */
  monoNow?: () => number;
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
    "<main>",
    `<h1>${title}</h1>`,
    paragraph(),
    paragraph(),
    "<nav><ul>",
    ...links,
    "</ul></nav>",
    "</main>",
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
  const { wall: wallClock, mono: monoClock } = resolveIntervalClock(opts);

  // Bounded per-IP window counters, pruned with the same discipline as the
  // Web Bot Auth in-memory nonce store: only expired entries are ever
  // evicted, and the map never grows past MAX_IP_ENTRIES. A map full of
  // live entries refuses the new IP (reported as capped) instead of
  // forgetting a live entry and resetting that IP's per-IP budget (F-24).
  const MAX_IP_ENTRIES = 10_000;
  const ipWindows = new Map<string, { start: number; startMono: number; count: number }>();
  const hitIpBudget = (key: string, now: number, nowMono: number): boolean => {
    let entry = ipWindows.get(key);
    if (entry && nowMono - entry.startMono >= windowMs) {
      ipWindows.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (ipWindows.size >= MAX_IP_ENTRIES) {
        for (const [k, v] of ipWindows) {
          if (nowMono - v.startMono >= windowMs) ipWindows.delete(k);
        }
        if (ipWindows.size >= MAX_IP_ENTRIES) return false;
      }
      entry = { start: now, startMono: nowMono, count: 0 };
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
    if (opts.ignoreCrossSite === true && request.headers.get("sec-fetch-site") === "cross-site") {
      return { isTrapped: false, ignored: true, status: 404, body: {} };
    }
    const depth = path === root ? 0 : path.slice(prefix.length).split("/").length;
    const ip = opts.trustedIpHeader
      ? readFirstIp(request.headers.get(opts.trustedIpHeader))
      : readRemoteAddress(request);
    // Caps are evaluated BEFORE the alert fires, so the alert payload's
    // `capped` flag always reflects the enforced outcome of this hit.
    // The wall clock feeds only the UTC daily budget (a calendar rule);
    // the per-IP window runs on the monotonic clock (L-DEEP-2).
    const now = wallClock();
    const nowMono = monoClock();
    const capped = !hitIpBudget(ip ?? "unknown", now, nowMono) || !hitDailyBudget(now);
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
        capped,
      });
    } catch {
      // Monitoring must never break the host application.
    }
    if (capped) {
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

/* ------------------------------------------------------------------------ */
/* Prefix-trap corroboration layer (ABE-02, PASS-LAB Step 0, abe-lab        */
/* REGISTRATION-ABE-STEP0.md and RESULTS-ABE-STEP0.md, cycle C572).         */
/*                                                                          */
/* This layer deliberately does NOT match paths. Prefix matching for       */
/* scanner paths is one mechanism with one home (the NHS-12 form); this    */
/* layer starts where a matcher (or the exact-match canary handler above)  */
/* has already decided a hit occurred, and answers the question the lab    */
/* showed the path layer cannot: is this hit corroborated?                 */
/*                                                                          */
/* THE MEASURED PROBLEM (seeded simulation, abe02.cjs, seed 20321102):     */
/* - the `/.env` prefix hits all 5 env-variant paths (/.env.example,       */
/*   /.envrc, /.env.local, /.env.bak, /.env.sample): over-broad by         */
/*   construction, so a hit alone cannot separate a developer or a typo    */
/*   from a scanner.                                                       */
/* - TYPO: a Chrome user requesting `/.env` once is tainted 5/5 under a    */
/*   single-hit rule - the path layer cannot distinguish typo from        */
/*   scanner (registration R-ABE-4).                                       */
/* - CRAWLER-SPOOF: a Googlebot user agent with a spoofed reverse-DNS      */
/*   name is tainted 10/10: the rDNS half of the crawler exclusion is      */
/*   load-bearing, and a UA string alone never exempts.                    */
/* - Verified crawlers (UA plus matching rDNS suffix) and internal         */
/*   health checks (internal IP plus probe UA) counted 0 taint in the      */
/*   lab; an external IP carrying the probe UA counted 10/10 - both        */
/*   halves of each exclusion are load-bearing.                            */
/*                                                                          */
/* THE RULE BUILT HERE. A non-excluded hit records UNCORROBORATED taint    */
/* for its identity: visible, counted, and consequenceEligible: false.     */
/* Taint becomes corroborated only by a second, independent fact: a        */
/* repeat hit inside the window, or an independent signal the host         */
/* reports through noteIndependentSignal (or on the hit itself). Only      */
/* corroborated taint reports consequenceEligible: true - and even then    */
/* this layer enforces nothing (enforcement: "none"); eligibility is an    */
/* input to the host's own policy, never a consequence itself.             */
/* ------------------------------------------------------------------------ */

export interface TrapCorroborationEvent {
  /** Identity the hit is attributed to (host-resolved; never a raw header value the client chose freely). */
  identity: string;
  /** Millisecond timestamp of the hit. */
  ts: number;
  /** The trap path that hit, carried as evidence only. This layer never matches paths. */
  path?: string;
  /** User agent of the hitting request, for the crawler exclusion. */
  userAgent?: string;
  /** Reverse-DNS name of the hitting IP, resolved by the host, for the crawler exclusion. */
  rdns?: string;
  /** Source IP of the hitting request, for the health-check exclusion. */
  ip?: string;
  /** True when an independent signal already fired for this identity at hit time. */
  independentSignalFired?: boolean;
}

export interface TrapCorroborationState {
  identity: string;
  /** Non-excluded trap hits inside the window. */
  hits: number;
  /** Hits excluded as verified crawler or internal health check (all time, this identity). */
  excludedHits: number;
  taint: "none" | "uncorroborated" | "corroborated";
  /** True only for corroborated taint. Uncorroborated taint is never eligible. */
  consequenceEligible: boolean;
  firstHitTs: number | null;
  lastHitTs: number | null;
  /** Always "none": this layer enforces nothing. */
  enforcement: "none";
}

export interface TrapCorroborationOptions {
  /** Window in ms over which hits corroborate each other. Default 3600000 (1 h). */
  windowMs?: number;
  /** Maximum identities retained (least recently seen evicted). Default 10000. */
  maxIdentities?: number;
}

export interface TrapCorroborationSnapshot {
  enforcement: "none";
  windowMs: number;
  identities: number;
  counters: {
    hits: number;
    excludedHits: number;
    independentSignals: number;
    invalidTs: number;
    evictedIdentities: number;
  };
}

/**
 * The lab's frozen verified-crawler rule: the UA must name the
 * crawler AND the reverse-DNS name must carry the crawler's own
 * suffix. Either half alone exempts nothing (spoofed rDNS tainted
 * 10/10 in the lab).
 */
export function isVerifiedCrawlerTrapExempt(userAgent?: string, rdns?: string): boolean {
  if (!userAgent || !rdns) return false;
  const ua = userAgent.toLowerCase();
  if (ua.includes("googlebot") && rdns.endsWith(".googlebot.com")) return true;
  if (ua.includes("bingbot") && rdns.endsWith(".search.msn.com")) return true;
  return false;
}

/**
 * The lab's frozen internal health-check rule: an internal
 * (10.0.0.0/8) source IP AND the probe user agent. An external IP
 * carrying the probe UA exempted nothing in the lab (10/10 tainted).
 */
export function isInternalHealthTrapExempt(ip?: string, userAgent?: string): boolean {
  if (!ip || !userAgent) return false;
  return ip.startsWith("10.") && userAgent.startsWith("kube-probe/");
}

export interface TrapCorroborationTracker {
  /** Record one trap hit (already matched by the caller's matcher) and return the identity state. */
  recordHit(event: TrapCorroborationEvent): TrapCorroborationState;
  /** Report an independent signal for an identity; corroborates any uncorroborated taint it holds. */
  noteIndependentSignal(identity: string, ts?: number): TrapCorroborationState;
  /** Current state for one identity, without recording anything. */
  check(identity: string, asOfTs?: number): TrapCorroborationState;
  snapshot(): TrapCorroborationSnapshot;
  reset(identity?: string): void;
}

export function createTrapCorroborationTracker(
  options: TrapCorroborationOptions = {},
): TrapCorroborationTracker {
  const windowMs = options.windowMs ?? 3_600_000;
  if (typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError("createTrapCorroborationTracker: windowMs must be a positive finite number");
  }
  const maxIdentities = options.maxIdentities ?? 10_000;
  if (!Number.isSafeInteger(maxIdentities) || maxIdentities < 1 || maxIdentities > 1_000_000) {
    throw new RangeError("createTrapCorroborationTracker: maxIdentities must be an integer between 1 and 1000000");
  }

  interface IdentityState {
    hitTs: number[];
    excludedHits: number;
    corroboratedBySignal: boolean;
    lastSeen: number;
  }
  const identities = new Map<string, IdentityState>();
  const counters = { hits: 0, excludedHits: 0, independentSignals: 0, invalidTs: 0, evictedIdentities: 0 };

  const requireIdentity = (value: unknown): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
      throw new TypeError("trap-corroboration: identity must be a string of 1 to 1024 characters");
    }
    return value;
  };
  const isValidTs = (ts: unknown): ts is number =>
    typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8.64e15;

  function stateFor(identity: string, ts: number): IdentityState {
    let state = identities.get(identity);
    if (!state) {
      while (identities.size >= maxIdentities) {
        let oldestId: string | null = null;
        let oldestTs = Infinity;
        for (const [id, s] of identities) if (s.lastSeen < oldestTs) { oldestTs = s.lastSeen; oldestId = id; }
        if (oldestId === null) break;
        identities.delete(oldestId);
        counters.evictedIdentities++;
      }
      state = { hitTs: [], excludedHits: 0, corroboratedBySignal: false, lastSeen: ts };
      identities.set(identity, state);
    }
    return state;
  }

  function toState(identity: string, state: IdentityState | undefined, asOfTs: number): TrapCorroborationState {
    if (!state) {
      return {
        identity, hits: 0, excludedHits: 0, taint: "none",
        consequenceEligible: false, firstHitTs: null, lastHitTs: null, enforcement: "none",
      };
    }
    const floor = asOfTs - windowMs;
    const inWindow = state.hitTs.filter((t) => t >= floor && t <= asOfTs);
    const hits = inWindow.length;
    const corroborated = hits >= 2 || (hits >= 1 && state.corroboratedBySignal);
    return {
      identity,
      hits,
      excludedHits: state.excludedHits,
      taint: hits === 0 ? "none" : corroborated ? "corroborated" : "uncorroborated",
      consequenceEligible: corroborated,
      firstHitTs: hits > 0 ? (inWindow[0] as number) : null,
      lastHitTs: hits > 0 ? (inWindow[inWindow.length - 1] as number) : null,
      enforcement: "none",
    };
  }

  return {
    recordHit(event: TrapCorroborationEvent): TrapCorroborationState {
      const identity = requireIdentity(event && event.identity);
      if (!isValidTs(event.ts)) {
        counters.invalidTs++;
        return toState(identity, identities.get(identity), identities.get(identity)?.lastSeen ?? 0);
      }
      const state = stateFor(identity, event.ts);
      state.lastSeen = Math.max(state.lastSeen, event.ts);
      if (
        isVerifiedCrawlerTrapExempt(event.userAgent, event.rdns) ||
        isInternalHealthTrapExempt(event.ip, event.userAgent)
      ) {
        state.excludedHits++;
        counters.excludedHits++;
        return toState(identity, state, event.ts);
      }
      state.hitTs.push(event.ts);
      state.hitTs.sort((a, b) => a - b);
      counters.hits++;
      if (event.independentSignalFired === true) {
        state.corroboratedBySignal = true;
        counters.independentSignals++;
      }
      return toState(identity, state, event.ts);
    },
    noteIndependentSignal(identity: string, ts?: number): TrapCorroborationState {
      requireIdentity(identity);
      const at = ts !== undefined ? ts : (identities.get(identity)?.lastSeen ?? 0);
      if (ts !== undefined && !isValidTs(ts)) {
        counters.invalidTs++;
        return toState(identity, identities.get(identity), at);
      }
      const state = stateFor(identity, at);
      state.corroboratedBySignal = true;
      state.lastSeen = Math.max(state.lastSeen, at);
      counters.independentSignals++;
      return toState(identity, state, at);
    },
    check(identity: string, asOfTs?: number): TrapCorroborationState {
      requireIdentity(identity);
      const state = identities.get(identity);
      const at = asOfTs !== undefined ? asOfTs : (state?.lastSeen ?? 0);
      return toState(identity, state, at);
    },
    snapshot(): TrapCorroborationSnapshot {
      return {
        enforcement: "none",
        windowMs,
        identities: identities.size,
        counters: { ...counters },
      };
    },
    reset(identity?: string): void {
      if (identity === undefined) identities.clear();
      else identities.delete(identity);
    },
  };
}
/* Scanner-path prefix matching (NHS-12, antiRea 3.1.0): the chosen form   */
/* of the NHS-12 / ABE-02 pair. The canary traps above deliberately use    */
/* EXACT match after canonicalization; this is a separate, advisory        */
/* counting surface over a small built-in prefix table, in the form the    */
/* NHS Step-0 lab measured (nhs-lab/nhs12.cjs, RESULTS-NHS-STEP0.md;       */
/* mechanism source sentinel_errrate.c is_scanner_path).                   */
/*                                                                         */
/* Semantics: prefix match, case-insensitive, anchored at the path start,  */
/* on the URI with the query string stripped. Prefix means /.env also      */
/* matches /.env.bak - that breadth is the measured behaviour, and it is   */
/* exactly why the output is a count for corroboration, never a verdict:   */
/* a prefix hit alone must never ban or block. Near misses do not match:   */
/* /x/.env is not anchored, /environment has no dot after the slash.       */
/*                                                                         */
/* Lab evidence (Step-0, synthetic and frozen): 8/8 match rows (the six    */
/* prefixes, uppercase /WP-LOGIN, /.env.bak by prefix, query-stripped      */
/* /.env?x=1); 0/4 near-miss rows (/x/.env, /environment, /, /about).      */
/* ------------------------------------------------------------------------ */

/** The six built-in scanner-path prefixes (NHS-12 frozen table). */
export const SCANNER_PATH_PREFIXES = [
  "/.env",
  "/.git",
  "/wp-login",
  "/wp-admin",
  "/.aws",
  "/phpinfo",
] as const;

/**
 * The built-in prefix a raw path matches, or null. The query string
 * is stripped first; matching is case-insensitive and anchored.
 */
export function matchScannerPathPrefix(rawPath: string): string | null {
  if (typeof rawPath !== "string") return null;
  const uri = (rawPath.split("?")[0] as string).toLowerCase();
  for (const p of SCANNER_PATH_PREFIXES) {
    if (uri.startsWith(p)) return p;
  }
  return null;
}

/** True when a raw path hits the NHS-12 scanner-path prefix table. */
export function isScannerPath(rawPath: string): boolean {
  return matchScannerPathPrefix(rawPath) !== null;
}

export interface ScannerPathObservation {
  matched: boolean;
  /** The matched prefix, or null. */
  prefix: string | null;
  /** Total matches this counter has recorded, including this one when matched. */
  total: number;
  /** Always "none": counting only, this surface enforces nothing. */
  enforcement: "none";
}

/**
 * Advisory counter over scanner-path hits. Opt-in: the host calls
 * observe() per request it wants counted; hits feed investigation
 * and corroboration, never a consequence by themselves.
 */
export function createScannerPathCounter(): {
  observe(rawPath: string): ScannerPathObservation;
  total(): number;
  byPrefix(): Record<string, number>;
} {
  let total = 0;
  const perPrefix = new Map<string, number>();
  return {
    observe(rawPath: string): ScannerPathObservation {
      const prefix = matchScannerPathPrefix(rawPath);
      if (prefix !== null) {
        total++;
        perPrefix.set(prefix, (perPrefix.get(prefix) ?? 0) + 1);
      }
      return { matched: prefix !== null, prefix, total, enforcement: "none" };
    },
    total: () => total,
    byPrefix: () => Object.fromEntries(perPrefix),
  };
}


/* ------------------------------------------------------------------------ */
/* Site honeytoken HMAC path (WDN-02, WebDecoy honeytoken-site port).       */
/*                                                                          */
/* A trap path derived from a server secret with HMAC-SHA256: no stored     */
/* state, stable within a UTC day, rotating daily, with EXACTLY one day of  */
/* grace (yesterday's path stays armed, the day-before path does not).      */
/* Arming is SET MEMBERSHIP in the derived set {today, yesterday} - never   */
/* a pattern - so a random path of the same shape is never armed and the    */
/* false-positive surface is nil by construction: only a caller that was   */
/* shown (or guessed) an actually derived path can hit it, and a hit is a   */
/* pure investigation signal, never proof of malice and never a sole        */
/* blocking key. Measured in the WDN Step-0 lab (wdn-lab/wdn02.cjs):        */
/* derivation deterministic, rotation and secret change both change the     */
/* path, grace exactly 1 day, random never-derived path never armed.        */
/*                                                                          */
/* Opt-in and default OFF: nothing is armed or served until the host        */
/* creates the site AND passes enabled: true. The secret is server-side     */
/* only; rotating it retires every outstanding path at once.                */
/* ------------------------------------------------------------------------ */

/** Default base path the derived honeytoken segment hangs under. */
export const HONEYTOKEN_DEFAULT_BASE_PATH = "/__wd";

const DAY_MS = 86_400_000;

const utcDayLabel = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

/**
 * Derive one honeytoken path from a secret and a label:
 * `basePath + "/" + HMAC-SHA256(secret, label).hex.slice(0, 12)`.
 * Stateless and deterministic: the same secret and label always derive
 * the same path, in any process, with nothing stored.
 */
export function deriveHoneytokenPath(secret: string, label: string, basePath: string = HONEYTOKEN_DEFAULT_BASE_PATH): string {
  const base = basePath.length > 1 ? basePath.replace(/\/+$/, "") : basePath;
  const digestBytes = getHoneypotNodeCrypto().createHmac("sha256", secret).update(label).digest();
  let hex = "";
  for (const byte of digestBytes) hex += byte.toString(16).padStart(2, "0");
  return `${base}/${hex.slice(0, 12)}`;
}

export interface HoneytokenSiteOptions {
  /** Server-side HMAC secret. Required; never ship it to a client. */
  secret: string;
  /** Base path for derived paths. Default "/__wd". */
  basePath?: string;
  /** Kill switch. Default false: the site serves nothing until enabled. Derivation helpers still work. */
  enabled?: boolean;
  /** Daily rotation. Default true. When false, a single stable path is derived from the label "stable". */
  rotate?: boolean;
  onAlert?: (alert: HoneypotAlertPayload) => Promise<void> | void;
  /** Set only if a trusted edge proxy strips/replaces untrusted copies. */
  trustedIpHeader?: string;
  /** Account identity must come from your authenticated server session, never an HTTP header. */
  resolveUserId?: () => string | undefined | Promise<string | undefined>;
  /** Wall clock override (ms since epoch), mainly for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface HoneytokenSite {
  /** Derive the path for an explicit label (for example "day:2026-01-15" or "stable"). */
  derivePath(label: string): string;
  /** The armed path set at `nowMs` (default: the site clock): today plus yesterday when rotating, else the stable path. */
  activePaths(nowMs?: number): string[];
  /** True exactly when `path` is a member of the armed set at `nowMs`. Set membership only - no pattern matching. */
  isArmed(path: string, nowMs?: number): boolean;
  /** Request handler: an armed hit alerts and answers 404; anything else is not trapped. Inert while disabled. */
  handle(request: CanaryRequest): Promise<CanaryResult>;
}

/**
 * Create a site honeytoken: a secret-derived, daily-rotating trap path.
 * Hits are pure signal (see the section header): alert for investigation,
 * do not auto-ban.
 */
export function createHoneytokenSite(opts: HoneytokenSiteOptions): HoneytokenSite {
  if (!opts || typeof opts.secret !== "string" || opts.secret.length === 0) {
    throw new Error("createHoneytokenSite requires a non-empty server-side secret");
  }
  const secret = opts.secret;
  const basePath = opts.basePath ?? HONEYTOKEN_DEFAULT_BASE_PATH;
  const rotate = opts.rotate !== false;
  const enabled = opts.enabled === true;
  const clock = opts.now ?? (() => Date.now());

  const derivePath = (label: string): string => deriveHoneytokenPath(secret, label, basePath);

  const activePaths = (nowMs: number = clock()): string[] => {
    if (!rotate) return [derivePath("stable")];
    const today = derivePath(`day:${utcDayLabel(nowMs)}`);
    const yesterday = derivePath(`day:${utcDayLabel(nowMs - DAY_MS)}`);
    return today === yesterday ? [today] : [today, yesterday];
  };

  const isArmed = (path: string, nowMs: number = clock()): boolean => activePaths(nowMs).includes(path);

  const handle = async (request: CanaryRequest): Promise<CanaryResult> => {
    if (!enabled) return { isTrapped: false, status: 200, body: {} };
    // Compare the path portion verbatim: the derived path is already in
    // canonical form, and arming is exact set membership by design.
    const rawPath = (request.url ?? "").split(/[?#]/, 1)[0] ?? "";
    let pathname = rawPath;
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(pathname)) {
      const schemeEnd = pathname.indexOf("://") + 3;
      const slashIdx = pathname.indexOf("/", schemeEnd);
      pathname = slashIdx >= 0 ? pathname.slice(slashIdx) : "/";
    }
    if (!isArmed(pathname)) return { isTrapped: false, status: 200, body: {} };
    try {
      await opts.onAlert?.({
        path: pathname,
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
  };

  return { derivePath, activePaths, isArmed, handle };
}
/* ------------------------------------------------------------------------ */
/* Tripwire path canonicalization (WDN-01, WebDecoy tripwire-rule port).    */
/*                                                                          */
/* Canonicalizing BOTH the request path and the configured trap paths       */
/* (strip query/fragment, percent-decode ASCII with a BOUNDED multi-pass    */
/* decoder - at most 4 passes - collapse duplicate slashes, resolve dot     */
/* segments clamped at the root) makes disguised scanner paths match the    */
/* trap set WITHOUT widening the match surface: matching stays an exact     */
/* set membership test on canonical forms.                                  */
/*                                                                          */
/* Measured in the WDN Step-0 lab (wdn-lab/wdn01.cjs): disguised paths      */
/* 4/4 canonicalize and match (//.env, /x/..%2f.git/config, /%2Eenv,         */
/* /%252Eenv); clean paths 4/4; query/fragment stripped 2/2; near-miss      */
/* paths 0/2 (/.env.bak and /x/.env never match); the corrected 5-level      */
/* encoding /%252525252Eenv does NOT match (the 4-pass bound bites exactly   */
/* there); /a/../../.env canonicalizes to /.env, clamped in-root with no     */
/* residual dot segments (the same reduction a web server applies).         */
/*                                                                          */
/* Advisory and opt-in: a tripwire hit is an investigation signal like a    */
/* canary hit, never proof of malice and never a sole blocking key. This    */
/* canonicalizer is deliberately separate from normalizeCanaryPath: it      */
/* does NOT lowercase (paths are case-sensitive on most servers) and it     */
/* resolves dot segments, which the canary normalizer does not.             */
/* ------------------------------------------------------------------------ */

/** The lab's default tripwire path set (18 entries, frozen). */
export const DEFAULT_TRIPWIRE_PATHS: readonly string[] = Object.freeze([
  "/.git/config", "/.git/HEAD", "/.env", "/.env.local", "/.env.production",
  "/wp-config.php", "/config.php", "/.aws/credentials", "/.ssh/id_rsa",
  "/backup.zip", "/backup.sql", "/database.sql", "/dump.sql", "/.DS_Store",
  "/phpinfo.php", "/server-status", "/actuator/env", "/.vscode/sftp.json",
]);

const unhexNibble = (code: number): number => {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 97 + 10;
  if (code >= 65 && code <= 70) return code - 65 + 10;
  return -1;
};

/** One percent-decode pass over ASCII escapes only (bytes >= 0x80 stay encoded). */
function decodePercentAsciiOnce(s: string): string {
  if (!s.includes("%")) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%" && i + 2 < s.length) {
      const hi = unhexNibble(s.charCodeAt(i + 1));
      const lo = unhexNibble(s.charCodeAt(i + 2));
      if (hi >= 0 && lo >= 0) {
        const v = (hi << 4) | lo;
        if (v < 0x80) {
          out += String.fromCharCode(v);
          i += 2;
          continue;
        }
      }
    }
    out += s[i];
  }
  return out;
}

/** Bounded multi-pass decode: at most 4 passes, stopping early once stable. */
function decodePercentAscii(s: string): string {
  for (let i = 0; i < 4; i++) {
    const next = decodePercentAsciiOnce(s);
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Collapse duplicate slashes and resolve "." / ".." segments, clamped at the root (a ".." at the root is dropped, never an escape). */
function cleanSlashesAndDots(s: string): string {
  if (s === "") return s;
  const hadTrailing = s.length > 1 && s[s.length - 1] === "/";
  const stack: string[] = [];
  for (const part of s.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  let res = "/" + stack.join("/");
  if (hadTrailing && res !== "/") res += "/";
  return res;
}

/**
 * Canonicalize a path for tripwire matching: strip query and fragment,
 * percent-decode ASCII (max 4 passes), collapse slashes and resolve dot
 * segments clamped at the root.
 */
export function canonicalizeTripwirePath(path: string): string {
  const noQuery = (path ?? "").split("?")[0]!.split("#")[0]!;
  return cleanSlashesAndDots(decodePercentAscii(noQuery));
}

/** Exact-match test: canonicalize the request path and the trap set, then set membership. Near-miss paths never match. */
export function isTripwirePath(path: string, trapPaths: readonly string[] = DEFAULT_TRIPWIRE_PATHS): boolean {
  const canonical = canonicalizeTripwirePath(path);
  for (const trap of trapPaths) {
    if (canonicalizeTripwirePath(trap) === canonical) return true;
  }
  return false;
}

export interface TripwireMatcher {
  /** The canonical trap set this matcher tests against. */
  readonly paths: ReadonlySet<string>;
  canonicalize(path: string): string;
  matches(path: string): boolean;
}

/**
 * Create a tripwire matcher over a pre-canonicalized trap set (the set is
 * canonicalized once at construction, not per request). Opt-in: creating
 * the matcher is the opt-in; it enforces nothing by itself.
 */
export function createTripwireMatcher(trapPaths: readonly string[] = DEFAULT_TRIPWIRE_PATHS): TripwireMatcher {
  const paths = new Set<string>(trapPaths.map(canonicalizeTripwirePath));
  return {
    paths,
    canonicalize: canonicalizeTripwirePath,
    matches: (path: string) => paths.has(canonicalizeTripwirePath(path)),
  };
}

/* ------------------------------------------------------------------------ */
/* Browser-path prefixes (ABS-07).                                          */
/*                                                                          */
/* A host may declare path prefixes that count as "browser paths" (paths    */
/* a real browser UI navigates to) so API-shaped traffic outside them is    */
/* not mis-scored as browser traffic, and vice versa. The neighbour         */
/* failure this rule is measured against: the source's prefix list          */
/* contained "/" itself, so EVERY path matched as a browser path and        */
/* python-requests on /api/data scored exactly 40 via that prefix (20       */
/* without it; real browser headers scored 0). A root prefix is therefore   */
/* forbidden by construction here: validation rejects it, and the matcher   */
/* validates before matching, so a "/" entry can never silently widen the   */
/* match surface to the whole origin.                                       */
/* ------------------------------------------------------------------------ */

/** Named error thrown when a browser-path prefix list is invalid (ABS-07). */
export class BrowserPathPrefixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserPathPrefixError";
  }
}

/**
 * Validate a browser-path prefix list and return its normalized form.
 * Throws `BrowserPathPrefixError` when any entry normalizes to "/"
 * (the root prefix matches every path - ABS-07) or is not a string.
 * Entries are normalized with `normalizeCanaryPath`, so "//" and "/"
 * are the same forbidden entry, and "/api/" and "/api" dedupe.
 */
export function validateBrowserPathPrefixes(prefixes: readonly string[]): string[] {
  if (!Array.isArray(prefixes)) {
    throw new BrowserPathPrefixError("browser path prefixes must be an array of path strings");
  }
  const out: string[] = [];
  for (const entry of prefixes) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new BrowserPathPrefixError("browser path prefix entries must be non-empty strings");
    }
    const normalized = normalizeCanaryPath(entry);
    if (normalized === "/") {
      throw new BrowserPathPrefixError(
        'browser path prefix "/" is forbidden: it matches every path on the origin (ABS-07)',
      );
    }
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * True when `path` falls under one of the declared browser-path
 * prefixes. The list is validated first (ABS-07), so a list carrying
 * "/" throws instead of matching everything. Matching is on a path
 * segment boundary: the prefix itself, or the prefix followed by "/"
 * ("/api" matches "/api/data" but not "/apiary").
 */
export function isBrowserPath(path: string, prefixes: readonly string[]): boolean {
  const validated = validateBrowserPathPrefixes(prefixes);
  const normalized = normalizeCanaryPath(path);
  return validated.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}
