/**
 * RSP-14: Crawler-impersonation prefix (advisory label, honeypot pack).
 *
 * Flags a request whose User-Agent carries a known-crawler marker
 * while the path is a secret path (a path no crawler should be
 * fetching through a browser-shaped surface). The UA is lowercased
 * before matching, so case forms flag identically.
 *
 * Measured in the RSP Step-0 lab: all 10 markers flag on a secret
 * path (10/10) and none on ordinary paths (30/30); 14/14 browser and
 * tool UAs unflagged on secret paths; case-insensitive 2/2.
 * Advisory label only, low tier: never a sole blocking key.
 */
export const RSP_CRAWLER_MARKERS = [
  "chatgpt-user", "oai-searchbot", "gptbot", "perplexitybot", "amazonbot",
  "amzn-searchbot", "cohere-ai", "claudebot", "google-extended", "bingbot",
] as const;

export const RSP_SECRET_PATH_PREFIXES = [
  "/.env", "/.git", "/wp-admin", "/wp-login", "/admin", "/.aws", "/config", "/backup",
] as const;

export function rspIsSecretPath(path: string): boolean {
  const lower = path.toLowerCase();
  return RSP_SECRET_PATH_PREFIXES.some((p) => lower.startsWith(p));
}

export interface RspCrawlerFlag { flagged: boolean; marker: string | null; secretPath: boolean }

export function rspCrawlerImpersonation(userAgent: string, path: string): RspCrawlerFlag {
  const lower = (userAgent ?? "").toLowerCase();
  const marker = RSP_CRAWLER_MARKERS.find((m) => lower.includes(m)) ?? null;
  const secretPath = rspIsSecretPath(path);
  return { flagged: marker !== null && secretPath, marker, secretPath };
}
