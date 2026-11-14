/**
 * Surface guard - field-level control of what ENTERS and LEAVES the server
 * (WALL-01/WALL-02, measured from the 2026-11-13 case harvest).
 *
 * Budgets answer "how much may an identity take". They cannot answer "WHAT
 * may leave in this response": the recurring real-world failure is a route
 * whose handler returns the whole record - password hash, 2FA secret,
 * password-reset code, national id, bank account - because the data layer
 * handed it the whole row (Spoutible 2024, the eHUST student-search leak,
 * Microsoft Power Apps 2021). The mirror failure on the way in is mass
 * assignment: a write handler that binds every submitted field lets the
 * caller set `role`, `is_superuser` or `owner_id` (GitHub 2012,
 * Rocket.Chat, Langflow). Both are FIELD-surface failures, and both are
 * visible in one place: the payload, server-side, before it crosses.
 *
 * `createSurfaceGuard` inspects JSON-shaped payloads in both directions
 * against two layers:
 *
 * - A built-in DENYLIST of field-name patterns (sensitive on the way out,
 *   privileged on the way in). This layer needs no configuration and is
 *   what catches an over-broad response on a route nobody declared.
 * - A per-route SCHEMA allowlist the host declares. Any field outside the
 *   allowlist is an `undeclared` violation. A field the host DID declare
 *   is exempt from the denylist layer: declaration is the host's own
 *   deliberate act (a login response legitimately returns a token).
 *
 * Consequences follow the tiering law: the default mode is `advisory` -
 * violations are reported through `onViolation` and the payload is never
 * touched. `strip` returns a sanitized deep copy with violating fields
 * removed. `block` marks the result not-ok so the host (or the bundled
 * middleware) can refuse. The guard never escalates a mode on its own.
 *
 * Field names are normalized before matching (lowercased, `_`/`-`/spaces
 * removed), so `password_hash`, `passwordHash` and `Password-Hash` are the
 * same field to both layers; renaming games do not slip past.
 *
 * Cost is bounded against hostile payloads: traversal is iterative with a
 * node cap (`maxScanNodes`, default 10,000); past the cap the result is
 * flagged `truncated` instead of scanning forever. Non-object payloads
 * (strings, numbers, null) carry no fields and always pass. Only plain
 * JSON-shaped data is inspected - class instances are treated as opaque.
 *
 * What this is NOT: it sees field NAMES, not values or ownership. It
 * cannot tell that a declared field was filled with the wrong user's data
 * (that is the host's authorization logic), and it does not replace
 * least-data response building - it is the tripwire that catches the day
 * the data layer starts returning more than the route ever declared.
 */

export type SurfaceGuardMode = "advisory" | "strip" | "block";
export type SurfaceGuardDirection = "response" | "request";
export type SurfaceViolationKind = "sensitive" | "privileged" | "undeclared";

export interface SurfaceRouteSchema {
  /** Field names allowed in RESPONSE payloads for this route. */
  responseFields?: readonly string[];
  /** Field names allowed in REQUEST payloads for this route. */
  requestFields?: readonly string[];
}

export interface SurfaceGuardOptions {
  /** Per-route field allowlists, keyed by any route id the host chooses. */
  routes?: Record<string, SurfaceRouteSchema>;
  /** Extra sensitive field-name patterns for responses (RegExp or substring, matched against the normalized name). */
  sensitivePatterns?: readonly (RegExp | string)[];
  /** Extra privileged field-name patterns for requests. */
  privilegedPatterns?: readonly (RegExp | string)[];
  /** Consequence mode. Defaults to "advisory" (report only, payload untouched). */
  mode?: SurfaceGuardMode;
  /** Traversal node cap per payload. Defaults to 10,000. */
  maxScanNodes?: number;
  /** Fired once per inspection that found violations. Errors are swallowed. */
  onViolation?: (event: SurfaceViolationEvent) => Promise<void> | void;
}

export interface SurfaceViolation {
  /** Dotted path of the offending field, e.g. "students[3].bankAccount". */
  path: string;
  /** The field name as it appeared in the payload. */
  field: string;
  kind: SurfaceViolationKind;
}

export interface SurfaceInspection {
  /** False only in "block" mode when violations were found. */
  ok: boolean;
  violations: SurfaceViolation[];
  /** True when the node cap stopped the scan early; unscanned fields were not judged. */
  truncated: boolean;
  /** Sanitized deep copy (violating fields removed). Present only in "strip" mode. */
  sanitized?: unknown;
}

export interface SurfaceViolationEvent {
  direction: SurfaceGuardDirection;
  route: string;
  violations: SurfaceViolation[];
  truncated: boolean;
  timestamp: string;
}

export interface SurfaceGuard {
  inspectResponse(route: string, payload: unknown): SurfaceInspection;
  inspectRequest(route: string, payload: unknown): SurfaceInspection;
}

const DEFAULT_SENSITIVE: readonly string[] = [
  "password", "passwd", "pwdhash", "passwordhash", "credential",
  "secret", "token", "apikey", "privatekey", "sessionkey",
  "ssn", "socialsecurity", "nationalid", "citizenid", "cccd", "idnumber",
  "passport", "driverlicense", "taxid",
  "bankaccount", "accountnumber", "iban", "cardnumber", "cvv", "cvc", "pin",
  "insurancenumber", "bhyt",
  "otp", "totp", "2fa", "mfasecret", "resetcode", "recoverycode",
  "salary", "payroll",
];

const DEFAULT_PRIVILEGED: readonly string[] = [
  "role", "roles", "isadmin", "admin", "issuperuser", "superuser",
  "permissions", "permission", "scopes", "isstaff", "isverified",
  "ownerid", "userid", "accountid", "tenantid", "createdby",
  "balance", "creditbalance", "isapproved", "approvedby",
];

function normalizeField(name: string): string {
  return name.toLowerCase().replace(/[_\-\s]/g, "");
}

function compilePatterns(extra: readonly (RegExp | string)[] | undefined, defaults: readonly string[]): ((normalized: string) => boolean)[] {
  const matchers: ((normalized: string) => boolean)[] = defaults.map(
    (d) => (n: string) => n === d || n.startsWith(d) || n.endsWith(d) || n.includes(d),
  );
  for (const p of extra ?? []) {
    if (typeof p === "string") {
      const needle = normalizeField(p);
      matchers.push((n: string) => n.includes(needle));
    } else {
      matchers.push((n: string) => p.test(n));
    }
  }
  return matchers;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

interface ScanOutcome {
  violations: SurfaceViolation[];
  truncated: boolean;
}

function scanPayload(
  payload: unknown,
  route: string,
  direction: SurfaceGuardDirection,
  allowlist: ReadonlySet<string> | null,
  matchers: ((normalized: string) => boolean)[],
  denyKind: SurfaceViolationKind,
  maxScanNodes: number,
): ScanOutcome {
  const violations: SurfaceViolation[] = [];
  let nodes = 0;
  let truncated = false;
  const seen = new WeakSet<object>();
  function* fields(value: Record<string, unknown> | unknown[]): Generator<string> {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) yield String(i);
    } else {
      for (const key in value) if (Object.prototype.hasOwnProperty.call(value, key)) yield key;
    }
  }
  const stack: { value: Record<string, unknown> | unknown[]; path: string; keys: Generator<string> }[] = [];
  const enter = (value: unknown, path: string): void => {
    if (!Array.isArray(value) && !isPlainObject(value)) return;
    if (seen.has(value)) { truncated = true; return; }
    seen.add(value);
    stack.push({ value, path, keys: fields(value) });
  };
  enter(payload, "");
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const next = frame.keys.next();
    if (next.done) { seen.delete(frame.value); stack.pop(); continue; }
    const { value, path } = frame;
    const key = next.value;
      nodes++;
      if (nodes > maxScanNodes) {
        truncated = true;
        break;
      }
      const childPath = Array.isArray(value) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`;
      if (childPath.length > 8192) { truncated = true; continue; }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && !("value" in descriptor)) { truncated = true; continue; }
      const normalized = normalizeField(key);
      const declared = allowlist !== null && allowlist.has(normalized);
      if (!Array.isArray(value) && !declared) {
        if (matchers.some((m) => m(normalized))) {
          violations.push({ path: childPath, field: key, kind: denyKind });
        } else if (allowlist !== null) {
          violations.push({ path: childPath, field: key, kind: "undeclared" });
        }
      }
      enter(descriptor?.value, childPath);
  }
  void route;
  return { violations, truncated };
}

function stripViolations(payload: unknown, violations: SurfaceViolation[]): unknown {
  if (violations.length === 0) return payload;
  const bad = new Set(violations.map((v) => v.path));
  if (!Array.isArray(payload) && !isPlainObject(payload)) return payload;
  const root: Record<string, unknown> | unknown[] = Array.isArray(payload) ? new Array(payload.length) : {};
  const stack = [{ source: payload, target: root, path: "" }];
  while (stack.length) {
    const { source, target, path } = stack.pop()!;
    for (const key of Object.keys(source)) {
      const childPath = Array.isArray(source) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`;
      if (bad.has(childPath)) continue;
      const value: unknown = Object.getOwnPropertyDescriptor(source, key)?.value;
      const composite = Array.isArray(value) || isPlainObject(value);
      const copy: unknown = composite ? (Array.isArray(value) ? new Array(value.length) : {}) : value;
      Object.defineProperty(target, key, { value: copy, enumerable: true, writable: true, configurable: true });
      if (composite) stack.push({ source: value, target: copy as Record<string, unknown> | unknown[], path: childPath });
    }
  }
  return root;
}

export function createSurfaceGuard(options: SurfaceGuardOptions = {}): SurfaceGuard {
  const mode: SurfaceGuardMode = options.mode ?? "advisory";
  const maxScanNodes = options.maxScanNodes ?? 10_000;
  if (!["advisory", "strip", "block"].includes(mode)) throw new TypeError("surface-guard: invalid mode");
  if (!Number.isSafeInteger(maxScanNodes) || maxScanNodes < 1 || maxScanNodes > 1_000_000) throw new RangeError("surface-guard: invalid maxScanNodes");
  const sensitiveMatchers = compilePatterns(options.sensitivePatterns, DEFAULT_SENSITIVE);
  const privilegedMatchers = compilePatterns(options.privilegedPatterns, DEFAULT_PRIVILEGED);
  const routes = new Map<string, { response: ReadonlySet<string> | null; request: ReadonlySet<string> | null }>();
  for (const [route, schema] of Object.entries(options.routes ?? {})) {
    routes.set(route, {
      response: schema.responseFields ? new Set(schema.responseFields.map(normalizeField)) : null,
      request: schema.requestFields ? new Set(schema.requestFields.map(normalizeField)) : null,
    });
  }

  function inspect(direction: SurfaceGuardDirection, route: string, payload: unknown): SurfaceInspection {
    const entry = routes.get(route);
    const allowlist = direction === "response" ? (entry?.response ?? null) : (entry?.request ?? null);
    const matchers = direction === "response" ? sensitiveMatchers : privilegedMatchers;
    const denyKind: SurfaceViolationKind = direction === "response" ? "sensitive" : "privileged";
    const { violations, truncated } = scanPayload(payload, route, direction, allowlist, matchers, denyKind, maxScanNodes);
    if (violations.length > 0 && options.onViolation) {
      try {
        void Promise.resolve(options.onViolation({
          direction,
          route,
          violations,
          truncated,
          timestamp: new Date().toISOString(),
        })).catch(() => { /* operator logging remains advisory */ });
      } catch {
        /* operator logging must never break request handling */
      }
    }
    const result: SurfaceInspection = {
      ok: !(mode === "block" && (violations.length > 0 || truncated)) && !(mode === "strip" && truncated),
      violations,
      truncated,
    };
    if (mode === "strip" && !truncated) result.sanitized = stripViolations(payload, violations);
    return result;
  }

  return {
    inspectResponse: (route, payload) => inspect("response", route, payload),
    inspectRequest: (route, payload) => inspect("request", route, payload),
  };
}
