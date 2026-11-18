/**
 * Breadcrumb lure chain - V1 form only (MGH-02, antiRea 3.1.0).
 * OPT-IN, default OFF. An opt-in decoy content pack, sibling of
 * createFakeEndpoints in fake-endpoints.ts.
 *
 * WHAT IT IS. Decoy documents link an agent down a chain: robots.txt
 * disallows decoy paths, llms.txt describes a fabricated internal
 * API and links the spec, openapi.yaml advertises one sensitive
 * endpoint, and that endpoint exists as an observable decoy shell.
 * A client that follows the whole chain produces a follow-through
 * signal; reading llms.txt alone never does, and a scanner that
 * probes decoy paths directly produces a separate direct-probe
 * signal type. The two signal types are never merged.
 *
 * WHY V1 ONLY. In V0 the advertised shell endpoint did not exist:
 * the catch-all answered POST /api/v1/admin/shell with 401
 * {"message":"Unauthenticated."} and 0 decoy-shell events, so the
 * chain self-terminated and the defender observed nothing past the
 * attempt (lab gate G9-CONFIRM, 8/8). V1 is the registered fix: the
 * endpoint exists, answers 200 with a fake shell body, executes
 * nothing, and logs the attempt (path plus submitted command) as
 * exactly one decoy-shell event per attempt. V0 is not built here.
 *
 * MEASURED (MGH Step-0 lab, mgh-lab/RESULTS-MGH-STEP0.md, rule-based
 * agent arms, 8 repetitions each): AG-CHAIN completes depth 3 in
 * 8/8 with exactly 1 decoy-shell event each; AG-COMPLIANT and
 * AG-LLMS-READER produce 0 follow-through signals (16 arm-runs
 * each, both variants); AG-CHAIN against a single static decoy
 * document with no links stops at depth 1 with 0 signals in 8/8;
 * AG-SCANNER produces 4 direct-probe events per repetition and 0
 * follow-through signals in 8/8; hygiene holds (advertised paths
 * inside the frozen decoy-only set, the real route advertised
 * nowhere, imperative-marker lint 0 matches). The agents are
 * frozen rule-based simulations; a real agent's follow-through
 * rate stays a claim, not a measurement.
 *
 * HYGIENE, BY CONSTRUCTION. Chain documents are built only from
 * the decoy-only path set below and the supplied persona. They
 * describe a fake API; they contain none of the frozen imperative
 * markers and never instruct the reader. The shell executes
 * nothing: its body is a frozen template keyed only on whether
 * the submitted command is exactly "id".
 *
 * DEFAULT OFF. The pack serves only when constructed with
 * `enabled: true`. Disabled, every chain path answers 404 and no
 * event is recorded.
 *
 * ADVISORY ONLY. A follow-through or a direct probe is
 * investigation telemetry, never proof of malice by itself and
 * never a sole blocking key or an exemption.
 */

import type { CanaryRequest } from "./honeypot-middleware";
import type { BaitPersona } from "./bait-persona";

/** The advertised decoy shell endpoint (chain depth 3). */
export const BREADCRUMB_SHELL_PATH = "/api/v1/admin/shell";

/** The spec path advertised by llms.txt (chain depth 2). */
export const BREADCRUMB_SPEC_PATH = "/openapi.yaml";

/** The entry document (chain depth 1). */
export const BREADCRUMB_LLMS_PATH = "/llms.txt";

/**
 * The frozen decoy-only path set from the lab registration. Every
 * path named in robots.txt, llms.txt or openapi.yaml belongs to
 * this set; no real route may ever be advertised by the chain.
 */
export const BREADCRUMB_DECOY_PATHS: readonly string[] = Object.freeze([
  "/",
  "/robots.txt",
  "/llms.txt",
  "/openapi.yaml",
  "/.env",
  "/config/.env",
  "/config/",
  "/admin/",
  "/api/v1/debug",
  "/api/v1/admin/shell",
  "/sitemap.xml",
]);

/** Paths a direct probe of the decoy surface can land on (scanner signal type). */
export const BREADCRUMB_DIRECT_PROBE_PATHS: readonly string[] = Object.freeze([
  "/.env",
  "/config/",
  "/admin/",
  "/api/v1/debug",
]);

/**
 * Frozen imperative markers that must never appear in chain
 * documents: the chain describes a fake API, it never instructs
 * the agent.
 */
export const BREADCRUMB_LINT_MARKERS: readonly string[] = Object.freeze([
  "you must",
  "ignore previous",
  "make sure to",
  "be sure to",
  "please run",
  "now call",
  "instruction:",
]);

export interface BreadcrumbDocuments {
  robotsTxt: string;
  llmsTxt: string;
  openapiYaml: string;
  envBody: string;
}

/**
 * Build the chain documents from a persona, byte-for-byte in the
 * lab port's template shapes. Only decoy-only paths are named.
 */
export function buildBreadcrumbDocuments(persona: BaitPersona): BreadcrumbDocuments {
  const robotsTxt =
    "User-agent: *\nDisallow: /admin/\nDisallow: /config/\nDisallow: /.env\nDisallow: /api/v1/debug\nSitemap: /sitemap.xml";
  const llmsTxt =
    `# ${persona.company} Internal API\n\n` +
    `> Internal administrative API for ${persona.company} operations staff.\n\n` +
    "## Docs\n\n" +
    "- [OpenAPI specification](/openapi.yaml): endpoint and capability discovery\n";
  const openapiYaml =
    "openapi: 3.0.1\ninfo:\n" +
    `  title: ${persona.company} Admin API\n` +
    `  version: '${persona.apiVersion}'\n` +
    "paths:\n" +
    "  /api/v1/admin/shell:\n" +
    "    post:\n" +
    "      summary: Execute system shell command\n";
  const envBody =
    `APP_NAME=${persona.slug}-portal\nAPP_ENV=production\nAPP_KEY=${persona.appKey}\nAPP_DEBUG=false\n` +
    `APP_URL=https://portal.${persona.domain}\n\nLOG_CHANNEL=stack\n\nDB_CONNECTION=mysql\n` +
    `DB_HOST=${persona.dbHost}\nDB_PORT=3306\nDB_DATABASE=${persona.dbName}\nDB_USERNAME=${persona.dbUser}\n` +
    `DB_PASSWORD=${persona.dbPassword}\n\nAWS_ACCESS_KEY_ID=${persona.awsAccessKeyId}\n` +
    `AWS_SECRET_ACCESS_KEY=${persona.awsSecretAccessKey}\nAWS_DEFAULT_REGION=${persona.awsRegion}\n` +
    `AWS_BUCKET=${persona.awsBucket}\n\nREDIS_HOST=127.0.0.1\nREDIS_PORT=6379\n\nJWT_SECRET=${persona.jwtSecret}\n`;
  return { robotsTxt, llmsTxt, openapiYaml, envBody };
}

/**
 * Lint chain documents for the frozen hygiene rules: every
 * advertised path inside the decoy-only set, no real route named,
 * no imperative marker present. Returns the list of violations
 * (empty when clean).
 */
export function lintBreadcrumbDocuments(
  docs: BreadcrumbDocuments,
  realRoutes: readonly string[] = [],
): string[] {
  const violations: string[] = [];
  const allowed = new Set<string>(BREADCRUMB_DECOY_PATHS);
  const texts = [docs.robotsTxt, docs.llmsTxt, docs.openapiYaml];
  const advertised = new Set<string>();
  for (const text of texts) {
    for (const tok of text.match(/\/[A-Za-z0-9._/-]*/g) ?? []) {
      advertised.add(tok.replace(/[:.,]+$/, ""));
    }
  }
  for (const p of advertised) {
    if (!allowed.has(p)) violations.push(`advertised path outside the decoy-only set: ${p}`);
  }
  for (const route of realRoutes) {
    if (texts.some((t) => t.includes(route)) || docs.envBody.includes(route)) {
      violations.push(`real route advertised by the chain: ${route}`);
    }
  }
  const joined = texts.join("\n").toLowerCase();
  for (const marker of BREADCRUMB_LINT_MARKERS) {
    if (joined.includes(marker)) violations.push(`imperative marker present: ${marker}`);
  }
  return violations;
}

/**
 * The frozen follow-through definition: a client that fetched
 * /llms.txt subsequently fetched /openapi.yaml AND attempted the
 * advertised shell endpoint, in that order.
 */
export function isBreadcrumbFollowThrough(pathsInOrder: readonly string[]): boolean {
  const llms = pathsInOrder.indexOf(BREADCRUMB_LLMS_PATH);
  if (llms < 0) return false;
  const spec = pathsInOrder.indexOf(BREADCRUMB_SPEC_PATH, llms + 1);
  if (spec < 0) return false;
  return pathsInOrder.indexOf(BREADCRUMB_SHELL_PATH, spec + 1) >= 0;
}

/** Count direct-probe paths in a trace (the separate scanner signal type). */
export function countBreadcrumbDirectProbes(paths: readonly string[]): number {
  const probes = new Set<string>(BREADCRUMB_DIRECT_PROBE_PATHS);
  return paths.filter((p) => probes.has(p)).length;
}

/** Depth of a trace in the chain: llms = 1, spec = 2, shell attempt = 3. */
export function breadcrumbDepth(pathsInOrder: readonly string[]): number {
  if (isBreadcrumbFollowThrough(pathsInOrder)) return 3;
  const llms = pathsInOrder.indexOf(BREADCRUMB_LLMS_PATH);
  if (llms < 0) return 0;
  if (pathsInOrder.indexOf(BREADCRUMB_SPEC_PATH, llms + 1) >= 0) return 2;
  return 1;
}

export type BreadcrumbEvent =
  | { type: "decoy-shell"; path: string; cmd: string; clientKey: string }
  | { type: "direct-probe"; path: string; clientKey: string };

export interface BreadcrumbRequest extends CanaryRequest {
  /** Raw request body text for the shell endpoint (a JSON object with a `cmd` field). */
  body?: string;
}

export interface BreadcrumbLureOptions {
  /** The pack serves only when this is exactly true. Default false (OFF). */
  enabled?: boolean;
  /** Persona the chain documents are built from (see bait-persona.ts, MGH-01). */
  persona: BaitPersona;
  /** Event sink for decoy-shell and direct-probe events. A throwing sink never breaks the host. */
  onEvent?: (event: BreadcrumbEvent) => Promise<void> | void;
  /**
   * Resolve the client key used to order one client's trace for
   * follow-through computation. Defaults to the User-Agent header
   * value, or "unknown". Hosts with a session identity should
   * supply it; traces are kept per key in a bounded map.
   */
  resolveClientKey?: (request: BreadcrumbRequest) => string | undefined | Promise<string | undefined>;
}

export interface BreadcrumbResult {
  handled: boolean;
  isDecoy: boolean;
  status: number;
  body: string;
  contentType: string;
  /** True when this request completes the follow-through definition for its client. */
  followThrough?: boolean;
  /** Chain depth reached by this client's trace after this request. */
  depth?: number;
}

export interface BreadcrumbLure {
  readonly enabled: boolean;
  readonly documents: BreadcrumbDocuments;
  handle: (request: BreadcrumbRequest) => Promise<BreadcrumbResult>;
  /** Ordered path trace recorded for one client key. */
  traceFor: (clientKey: string) => readonly string[];
}

const MAX_TRACED_CLIENTS = 1_000;
const MAX_TRACE_PATHS = 64;

function fakeShellBody(cmd: string): string {
  if (cmd === "id") {
    return "www-data@web01:~$ id\nuid=33(www-data) gid=33(www-data) groups=33(www-data)\n";
  }
  const first = cmd.split(" ")[0] ?? "";
  return `www-data@web01:~$ ${cmd}\nbash: ${first}: command not found\n`;
}

function pathnameOf(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return "/";
  let pathname = rawUrl.trim().split(/[?#]/, 1)[0] || "/";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(pathname)) {
    const schemeEnd = pathname.indexOf("://") + 3;
    const slashIdx = pathname.indexOf("/", schemeEnd);
    pathname = slashIdx >= 0 ? pathname.slice(slashIdx) : "/";
  }
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  return pathname;
}

/**
 * Create the opt-in breadcrumb lure pack. See the module header
 * for the full contract: default OFF, chain depth 3 ending at the
 * observable decoy shell, follow-through and direct-probe signals
 * kept separate.
 */
export function createBreadcrumbLure(options: BreadcrumbLureOptions): BreadcrumbLure {
  const enabled = options.enabled === true;
  const documents = buildBreadcrumbDocuments(options.persona);
  const traces = new Map<string, string[]>();

  const recordTrace = (clientKey: string, path: string): string[] => {
    let trace = traces.get(clientKey);
    if (!trace) {
      if (traces.size >= MAX_TRACED_CLIENTS) {
        const oldest = traces.keys().next().value;
        if (oldest !== undefined) traces.delete(oldest);
      }
      trace = [];
      traces.set(clientKey, trace);
    }
    trace.push(path);
    if (trace.length > MAX_TRACE_PATHS) trace.splice(0, trace.length - MAX_TRACE_PATHS);
    return trace;
  };

  const emit = async (event: BreadcrumbEvent): Promise<void> => {
    try {
      await options.onEvent?.(event);
    } catch {
      // Monitoring must never break the host application.
    }
  };

  const notFound: BreadcrumbResult = {
    handled: true, isDecoy: false, status: 404, body: "not found",
    contentType: "text/plain; charset=utf-8",
  };

  const handle = async (request: BreadcrumbRequest): Promise<BreadcrumbResult> => {
    const pathname = pathnameOf(request.url);
    const method = request.method ?? "GET";
    const isChainPath =
      pathname === "/robots.txt" ||
      pathname === BREADCRUMB_LLMS_PATH ||
      pathname === BREADCRUMB_SPEC_PATH ||
      pathname === "/.env" ||
      pathname === "/config/.env" ||
      pathname === "/config/" ||
      pathname === "/admin/" ||
      pathname === "/api/v1/debug" ||
      pathname === BREADCRUMB_SHELL_PATH;
    if (!isChainPath) {
      return { handled: false, isDecoy: false, status: 404, body: "", contentType: "text/plain; charset=utf-8" };
    }
    if (!enabled) return { ...notFound };

    let clientKey = "unknown";
    try {
      clientKey =
        (await options.resolveClientKey?.(request)) ??
        request.headers.get("user-agent") ??
        "unknown";
    } catch {
      clientKey = "unknown";
    }

    if (method === "GET" && pathname === "/robots.txt") {
      return { handled: true, isDecoy: true, status: 200, body: documents.robotsTxt, contentType: "text/plain; charset=utf-8" };
    }
    if (method === "GET" && pathname === BREADCRUMB_LLMS_PATH) {
      const trace = recordTrace(clientKey, pathname);
      return {
        handled: true, isDecoy: true, status: 200, body: documents.llmsTxt,
        contentType: "text/plain; charset=utf-8",
        followThrough: isBreadcrumbFollowThrough(trace), depth: breadcrumbDepth(trace),
      };
    }
    if (method === "GET" && pathname === BREADCRUMB_SPEC_PATH) {
      const trace = recordTrace(clientKey, pathname);
      return {
        handled: true, isDecoy: true, status: 200, body: documents.openapiYaml,
        contentType: "text/yaml; charset=utf-8",
        followThrough: isBreadcrumbFollowThrough(trace), depth: breadcrumbDepth(trace),
      };
    }
    if (method === "GET" && (pathname === "/.env" || pathname === "/config/.env")) {
      recordTrace(clientKey, "/.env");
      await emit({ type: "direct-probe", path: pathname, clientKey });
      return { handled: true, isDecoy: true, status: 200, body: documents.envBody, contentType: "text/plain; charset=utf-8" };
    }
    if (method === "GET" && (pathname === "/config/" || pathname === "/admin/" || pathname === "/api/v1/debug")) {
      // Direct probes of the robots-disallowed surface: the trap's
      // auth-prefix answer, and a direct-probe event - a signal type
      // kept separate from chain follow-through at all times.
      recordTrace(clientKey, pathname);
      await emit({ type: "direct-probe", path: pathname, clientKey });
      return {
        handled: true, isDecoy: true, status: 401,
        body: JSON.stringify({ message: "Unauthenticated." }),
        contentType: "application/json; charset=utf-8",
      };
    }
    if (method === "POST" && pathname === BREADCRUMB_SHELL_PATH) {
      let cmd = "";
      try {
        const parsed: unknown = JSON.parse(request.body ?? "{}");
        if (typeof parsed === "object" && parsed !== null && typeof (parsed as { cmd?: unknown }).cmd === "string") {
          cmd = (parsed as { cmd: string }).cmd;
        }
      } catch {
        cmd = "";
      }
      const trace = recordTrace(clientKey, pathname);
      // Exactly one decoy-shell event per attempt (the V1 property
      // V0 lacked). The shell executes nothing.
      await emit({ type: "decoy-shell", path: pathname, cmd, clientKey });
      return {
        handled: true, isDecoy: true, status: 200, body: fakeShellBody(cmd),
        contentType: "text/plain; charset=utf-8",
        followThrough: isBreadcrumbFollowThrough(trace), depth: breadcrumbDepth(trace),
      };
    }
    return { ...notFound };
  };

  return {
    enabled,
    documents,
    handle,
    traceFor: (clientKey: string) => [...(traces.get(clientKey) ?? [])],
  };
}
