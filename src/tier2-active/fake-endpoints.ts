/**
 * Fake-200 scanner-probe decoys (UAS-03, antiRea 3.0 Item 7c) -
 * OPT-IN, default OFF. A sibling of the honeypot family
 * (`honeypot-middleware.ts`), composing with it by sharing its
 * `CanaryRequest` shape; the decoy pack lives in its own module
 * because its contract (fake 200 bodies, method gate, canary-bound
 * credential) is disjoint from the canary traps' 404-and-alert
 * contract.
 *
 * WHAT IT DOES. Vulnerability scanners probe a fixed liturgy of
 * paths - WordPress login/admin, xmlrpc, `.env`, `.git/config`,
 * phpinfo, server-status, config.json - on every host they meet.
 * When (and only when) the host enables this pack, those 8 paths
 * answer a fake 200 with a format-passing junk body instead of a
 * 404, and every hit is logged with `source = "decoy"` plus the
 * path, the User-Agent and the method. A probing client that
 * believes the format comes back with second-stage requests; the
 * return visit is the observed signal. Nothing here accepts input,
 * has a working form, or collects anything; bodies contain no real
 * secrets, only format-shaped junk.
 *
 * OPT-IN IS REAL. The pack is constructed disabled unless the host
 * passes `enabled: true` (the Canary Maze precedent). Disabled, all
 * 8 paths answer 404 and nothing is logged. The pack must never be
 * mounted on a real route: it owns exactly the 8 registered paths,
 * matched exactly (case-sensitive, trailing slash significant -
 * `/wp-admin` without the slash is not a decoy), and any other path
 * is reported `handled: false` so the host's own routing continues.
 *
 * METHODS. Only GET and HEAD are served. Any other method on a
 * decoy path is rejected 405 (with `allow: GET, HEAD`) before any
 * decoy logic, and produces zero decoy log entries - the lab's
 * method gate (server.js routing semantics, 24/24 in the Step-0
 * run). Method handling for non-decoy paths stays the host's.
 *
 * THE /.env CREDENTIAL IS A CANARY-ECHO TOKEN, NOT A DUMB STRING.
 * The fake `.env` body's `APP_KEY` is minted at construction with
 * `canary-echo.ts`'s `mintEchoId`, bound to the host-declared
 * `echoMintedFor` identity. A scanner that harvests and later uses
 * or leaks that credential presents an echo token: the host runs
 * it through `verifyEchoId` / `resolveEchoFrom` and the touch
 * attributes back to the decoy surface through the CUSUM tripwire's
 * echo channel (the MGH family's G5/G7 lesson, applied here as the
 * UAS registration required). For that reason enabling the pack
 * REQUIRES a canary-echo secret: `createFakeEndpoints` throws when
 * `enabled: true` arrives without `echoSecret`, rather than
 * shipping a bait credential that attributes to nothing. The token
 * is minted once per handler instance, so the served `.env` body is
 * stable for the instance's lifetime, like a real file.
 *
 * HONESTY - REAL-SCANNER CONTINUATION IS A CLAIM. The lab evidence
 * (uas-lab/RESULTS-UAS-STEP0.md) is: format battery 8/8,
 * attribution 32/32 exact, opt-in real (OFF -> 404 on all 8),
 * methods rejected 405 on 24/24 with zero decoy entries, HEAD 200
 * on 8/8, and continuation ON 8/8 vs OFF 0/8 against a RULE-BASED
 * SIMULATION of a scanner. Continuation against real scanners
 * (nuclei, wpscan) was not measured and stays a CLAIM - the
 * continuation number comes from that simulation, and payload-level
 * second-stage behaviour is not observed by this mechanism family.
 *
 * ADVISORY ONLY. A decoy hit is investigation telemetry, like a
 * canary hit: it is never proof of malice by itself and this module
 * bans, blocks, and poisons nothing.
 */

import { mintEchoId, type EchoSecret } from "./canary-echo";
import type { CanaryRequest } from "./honeypot-middleware";

/** The 8 registered decoy paths (UserAgentSpy decoys.js, verbatim, in source order). */
export const FAKE_ENDPOINT_PATHS = [
  "/wp-login.php",
  "/wp-admin/",
  "/xmlrpc.php",
  "/.env",
  "/.git/config",
  "/phpinfo.php",
  "/server-status",
  "/config.json",
] as const;

export type FakeEndpointPath = (typeof FAKE_ENDPOINT_PATHS)[number];

const FAKE_PATH_SET = new Set<string>(FAKE_ENDPOINT_PATHS);

/**
 * One decoy hit, in the lab's attribution format exactly:
 * `{ source, path, ua, method }` - no extra fields, so a host log
 * sink can be diffed against the registered format byte-for-byte.
 */
export interface FakeEndpointLogEntry {
  source: "decoy";
  path: string;
  ua: string | null;
  method: string;
}

export interface FakeEndpointsOptions {
  /** Kill switch in reverse: the pack serves only when this is exactly `true`. Default false (OFF). */
  enabled?: boolean;
  /**
   * HMAC secret for the canary-echo token bound into the fake
   * `.env` body (see `canary-echo.ts`). REQUIRED when `enabled` is
   * true - construction throws without it, so a dumb bait
   * credential is never shipped.
   */
  echoSecret?: EchoSecret;
  /** Identity the `.env` echo token is minted FOR. Defaults to `"decoy:fake-env"`. */
  echoMintedFor?: string;
  /** Optional canary-echo scope bound into the `.env` token. */
  echoScope?: string;
  /** TTL for the `.env` echo token in milliseconds. Defaults to the canary-echo default (24 h). */
  echoTtlMs?: number;
  /** Clock override (ms since epoch) for the `.env` mint, mainly for tests. */
  now?: number;
  /** Sink for decoy hit entries. A throwing sink never breaks the host (the honeypot discipline). */
  onLog?: (entry: FakeEndpointLogEntry) => Promise<void> | void;
}

export interface FakeEndpointResult {
  /** True when the request path is one of the 8 registered decoy paths (any method, either arm). */
  handled: boolean;
  /** True when a fake-200 decoy body was served (ON arm, GET/HEAD). */
  isDecoy: boolean;
  status: number;
  /** Response body text. Empty for HEAD responses and for unhandled paths. */
  body: string;
  contentType: string;
  /** Extra response headers (the 405 `allow` header). */
  headers: Record<string, string>;
}

/** Named error thrown for invalid fake-endpoint configuration. */
export class FakeEndpointsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FakeEndpointsError";
  }
}

/**
 * Extract the pathname for decoy matching: strip the query string
 * and fragment, strip scheme + origin when a full URL is supplied.
 * Unlike `normalizeCanaryPath` this does NOT lowercase and does NOT
 * strip a trailing slash - decoy identity is the exact registered
 * path (`/wp-admin/` is a decoy, `/wp-admin` is not), exactly as the
 * source's decoy map keys it.
 */
export function fakeEndpointPathname(rawUrlOrPath: string): string {
  if (!rawUrlOrPath || typeof rawUrlOrPath !== "string") return "/";
  let pathname = rawUrlOrPath.trim().split(/[?#]/, 1)[0] || "/";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(pathname)) {
    const schemeEnd = pathname.indexOf("://") + 3;
    const slashIdx = pathname.indexOf("/", schemeEnd);
    pathname = slashIdx >= 0 ? pathname.slice(slashIdx) : "/";
  }
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  return pathname;
}

/** True when `path` (a pathname, see {@link fakeEndpointPathname}) is one of the 8 registered decoy paths. */
export function isFakeEndpointPath(path: string): boolean {
  return FAKE_PATH_SET.has(path);
}

const page = (title: string, note: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><p>${note}</p></body></html>\n`;

/**
 * The registered decoy bodies (decoys.js, verbatim) except `/.env`,
 * whose APP_KEY line carries the canary-echo token instead of the
 * source's static junk value (see the module header).
 */
function buildDecoyBodies(envEchoId: string | null): Map<string, { type: string; body: string }> {
  const envBody =
    "APP_NAME=Laravel\nAPP_ENV=production\nAPP_DEBUG=false\n" +
    `APP_KEY=base64:${envEchoId ?? ""}\n` +
    "DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_DATABASE=app\nDB_USERNAME=app\n" +
    "DB_PASSWORD=this-is-a-honeypot-not-a-real-password\n";
  return new Map<string, { type: string; body: string }>([
    ["/wp-login.php", {
      type: "text/html; charset=utf-8",
      body: page("Log In", "WordPress &rsaquo; please log in. <!-- wp-login wp-content wp-includes -->"),
    }],
    ["/wp-admin/", {
      type: "text/html; charset=utf-8",
      body: page("Dashboard", "You do not have sufficient permissions to access this page. <!-- wordpress -->"),
    }],
    ["/xmlrpc.php", {
      type: "text/xml; charset=utf-8",
      body:
        '<?xml version="1.0"?><methodResponse><params><param><value>' +
        "<string>XML-RPC server accepts POST requests only.</string>" +
        "</value></param></params></methodResponse>\n",
    }],
    ["/.env", { type: "text/plain; charset=utf-8", body: envBody }],
    ["/.git/config", {
      type: "text/plain; charset=utf-8",
      body:
        "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n" +
        '[remote "origin"]\n\turl = https://example.invalid/app.git\n',
    }],
    ["/phpinfo.php", {
      type: "text/html; charset=utf-8",
      body: page("phpinfo()", "PHP Version 8.2.0 <!-- phpinfo() -->"),
    }],
    ["/server-status", {
      type: "text/html; charset=utf-8",
      body: page("Apache Status", "Apache Server Status &mdash; access disabled."),
    }],
    ["/config.json", {
      type: "application/json; charset=utf-8",
      body: '{"env":"production","debug":false,"secret":"honeypot-not-a-real-secret"}\n',
    }],
  ]);
}

export interface FakeEndpoints {
  /** The 8 registered decoy paths, in registration order. */
  readonly paths: readonly string[];
  /** Whether the pack is enabled (constructed with `enabled: true`). */
  readonly enabled: boolean;
  /**
   * The canary-echo token served as the fake `.env` body's APP_KEY
   * credential, or null when the pack is disabled. Hosts resolve a
   * presented copy with `resolveEchoFrom` (canary-echo.ts).
   */
  readonly envEchoId: string | null;
  handle: (request: CanaryRequest) => Promise<FakeEndpointResult>;
}

/**
 * Create the fake-200 decoy pack handler. See the module header for
 * the full contract: default OFF, GET/HEAD only, method gate before
 * routing, every ON-arm hit logged as `{ source: "decoy", path, ua,
 * method }`, and the `.env` credential bound to canary-echo.
 */
export function createFakeEndpoints(opts: FakeEndpointsOptions = {}): FakeEndpoints {
  const enabled = opts.enabled === true;
  let envEchoId: string | null = null;
  if (enabled) {
    if (opts.echoSecret === undefined) {
      throw new FakeEndpointsError(
        "createFakeEndpoints: echoSecret is required when enabled - the fake /.env credential " +
          "must be a canary-echo token (canary-echo.ts), never a dumb bait string",
      );
    }
    envEchoId = mintEchoId(opts.echoSecret, {
      mintedFor: opts.echoMintedFor ?? "decoy:fake-env",
      ...(opts.echoScope ? { scope: opts.echoScope } : {}),
      ...(opts.echoTtlMs !== undefined ? { ttlMs: opts.echoTtlMs } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  }
  const bodies = buildDecoyBodies(envEchoId);

  const handle = async (request: CanaryRequest): Promise<FakeEndpointResult> => {
    const pathname = fakeEndpointPathname(request.url);
    const decoy = bodies.get(pathname);
    if (!decoy) {
      // Not one of the 8: never mounted on a real route - the host
      // continues its own routing (status is advisory only).
      return { handled: false, isDecoy: false, status: 404, body: "", contentType: "text/plain; charset=utf-8", headers: {} };
    }
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      // Method gate before routing (lab semantics): 405, and zero
      // decoy log entries from rejected methods.
      return {
        handled: true,
        isDecoy: false,
        status: 405,
        body: "method not allowed",
        contentType: "text/plain; charset=utf-8",
        headers: { allow: "GET, HEAD" },
      };
    }
    if (!enabled) {
      return { handled: true, isDecoy: false, status: 404, body: "not found", contentType: "text/plain; charset=utf-8", headers: {} };
    }
    try {
      await opts.onLog?.({
        source: "decoy",
        path: pathname,
        ua: request.headers.get("user-agent") ?? null,
        method,
      });
    } catch {
      // Monitoring must never break the host application.
    }
    return {
      handled: true,
      isDecoy: true,
      status: 200,
      body: method === "HEAD" ? "" : decoy.body,
      contentType: decoy.type,
      headers: {},
    };
  };

  return { paths: FAKE_ENDPOINT_PATHS, enabled, envEchoId, handle };
}
