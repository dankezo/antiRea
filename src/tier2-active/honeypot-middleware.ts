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
