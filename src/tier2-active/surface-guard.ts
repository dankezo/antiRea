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
  const stack: { value: unknown; path: string }[] = [{ value: payload, path: "" }];
  while (stack.length > 0) {
    const { value, path } = stack.pop() as { value: unknown; path: string };
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({ value: value[i], path: `${path}[${i}]` });
      }
      continue;
    }
    if (!isPlainObject(value)) continue;
    for (const key of Object.keys(value)) {
      nodes++;
      if (nodes > maxScanNodes) {
        truncated = true;
        stack.length = 0;
        break;
      }
      const childPath = path === "" ? key : `${path}.${key}`;
      const normalized = normalizeField(key);
      const declared = allowlist !== null && allowlist.has(normalized);
      if (!declared) {
        if (matchers.some((m) => m(normalized))) {
          violations.push({ path: childPath, field: key, kind: denyKind });
        } else if (allowlist !== null) {
          violations.push({ path: childPath, field: key, kind: "undeclared" });
        }
      }
      stack.push({ value: value[key], path: childPath });
    }
  }
  void route;
  return { violations, truncated };
}

function stripViolations(payload: unknown, violations: SurfaceViolation[]): unknown {
  if (violations.length === 0) return payload;
  const bad = new Set(violations.map((v) => v.path));
  const clone = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((v, i) => clone(v, `${path}[${i}]`));
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const childPath = path === "" ? key : `${path}.${key}`;
        if (bad.has(childPath)) continue;
        out[key] = clone(value[key], childPath);
      }
      return out;
    }
    return value;
  };
  return clone(payload, "");
}

export function createSurfaceGuard(options: SurfaceGuardOptions = {}): SurfaceGuard {
  const mode: SurfaceGuardMode = options.mode ?? "advisory";
  const maxScanNodes = options.maxScanNodes ?? 10_000;
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
        void options.onViolation({
          direction,
          route,
          violations,
          truncated,
          timestamp: new Date().toISOString(),
        });
      } catch {
        /* operator logging must never break request handling */
      }
    }
    const result: SurfaceInspection = {
      ok: !(mode === "block" && violations.length > 0),
      violations,
      truncated,
    };
    if (mode === "strip") result.sanitized = stripViolations(payload, violations);
    return result;
  }

  return {
    inspectResponse: (route, payload) => inspect("response", route, payload),
    inspectRequest: (route, payload) => inspect("request", route, payload),
  };
}
