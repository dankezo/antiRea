/**
 * The single source of truth for trap paths (ABP-08
 * BAIT-PATHS-AND-TRAP-DETECTION-MUST-SHARE-ONE-SOURCE).
 *
 * The neighbour failure, measured in the ABP Step-0 lab: its bait
 * paths and its trap detectors were separate lists that had drifted
 * apart - 1 of its 3 default and 2 of its 3 custom example bait
 * paths were invisible to its own detectors, and /api/v2/users was
 * undetected by all three example detectors while being served as
 * bait. A bait path no detector can see produces no signal; a
 * detector path never served as bait is dead weight; and the drift
 * is invisible until someone diffs the lists by hand.
 *
 * antiRea form: ONE registry. `honeypot-middleware.ts` re-exports
 * `CANARY_TRAP_PATHS` as its `CANARY_ENDPOINTS`, and
 * `fake-endpoints.ts` re-exports `FAKE_TRAP_PATHS` as its
 * `FAKE_ENDPOINT_PATHS` - the bait surfaces and the detectors read
 * the very same arrays (same object identity, not copies), so the
 * lists cannot drift. Host-supplied custom paths stay host
 * configuration (CanaryOptions.paths, DecoyMirageOptions.paths);
 * this registry is the shipped default surface, and
 * `isRegisteredTrapPath` is the shared lookup a host audit can
 * check any path against.
 */

/** The canary trap paths (served by the canary handler and the decoy mirage defaults). */
export const CANARY_TRAP_PATHS = [
  "/api/v1/internal/schema-export",
  "/api/v1/internal/prompt-registry",
  "/api/v2/admin/feature-flags-dump",
  "/api/v1/billing/enterprise-override",
] as const;

/** The fake-endpoint decoy paths (UserAgentSpy decoys.js, verbatim, in source order). */
export const FAKE_TRAP_PATHS = [
  "/wp-login.php",
  "/wp-admin/",
  "/xmlrpc.php",
  "/.env",
  "/.git/config",
  "/phpinfo.php",
  "/server-status",
  "/config.json",
] as const;

export type TrapPathSurface = "canary" | "fake-endpoint";

export interface TrapPathEntry {
  path: string;
  surface: TrapPathSurface;
}

/** Every shipped trap path with the surface that serves and detects it. */
export const TRAP_PATH_REGISTRY: readonly TrapPathEntry[] = [
  ...CANARY_TRAP_PATHS.map((path): TrapPathEntry => ({ path, surface: "canary" })),
  ...FAKE_TRAP_PATHS.map((path): TrapPathEntry => ({ path, surface: "fake-endpoint" })),
];

const CANARY_SET = new Set<string>(CANARY_TRAP_PATHS);
const FAKE_SET = new Set<string>(FAKE_TRAP_PATHS);

/**
 * Shared trap-path lookup. Canary paths compare after the light
 * normalization their registry form already assumes (strip query /
 * fragment, lowercase, drop a trailing slash - the full
 * canonicalization lives in `normalizeCanaryPath`); fake-endpoint
 * paths compare EXACTLY, because their identity is exact (case and
 * trailing slash significant, as `fake-endpoints.ts` documents).
 */
export function isRegisteredTrapPath(rawPath: string): boolean {
  if (typeof rawPath !== "string" || rawPath.length === 0) return false;
  if (FAKE_SET.has(rawPath)) return true;
  let p = rawPath.split(/[?#]/, 1)[0] || "/";
  if (!p.startsWith("/")) p = "/" + p;
  p = p.toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return CANARY_SET.has(p);
}
