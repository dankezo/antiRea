/** Canary routes emit alerts only; do not use them for automated banning or poisoned schemas. */
export const CANARY_ENDPOINTS = [
  "/api/v1/internal/schema-export",
  "/api/v1/internal/prompt-registry",
  "/api/v2/admin/feature-flags-dump",
  "/api/v1/billing/enterprise-override",
] as const;
export interface HoneypotAlertPayload {
  path: string;
  timestamp: string;
  method: string;
  ip?: string;
  userId?: string;
  userAgent?: string;
}
export interface CanaryOptions {
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
const readFirstIp = (raw: string | null): string | undefined => {
  if (!raw) return undefined;
  const ip = raw.split(",")[0]?.trim();
  return ip && /^[\da-fA-F.:]{2,45}$/.test(ip) ? ip : undefined;
};
export async function handleCanaryTrapRequest(request: CanaryRequest, opts: CanaryOptions = {}): Promise<CanaryResult> {
  const path = new URL(request.url, "http://localhost").pathname;
  // Exact match, not prefix: /schema-exported is not a trap.
  if (!(CANARY_ENDPOINTS as readonly string[]).includes(path)) return { isTrapped: false, status: 200, body: {} };
  if (opts.ignoreCrossSite !== false && request.headers.get("sec-fetch-site") === "cross-site")
    return { isTrapped: false, ignored: true, status: 404, body: {} };
  try {
    await opts.onAlert?.({
      path,
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
/** Optional bait reference; bundlers can remove unused code, and discovery is never guaranteed. */
export function registerClientBundleCanaries(): readonly string[] {
  return CANARY_ENDPOINTS;
}
export function robotsTxtSnippet(): string {
  return ["User-agent: *", ...CANARY_ENDPOINTS.map(p => `Disallow: ${p}`)].join("\n") + "\n";
}
