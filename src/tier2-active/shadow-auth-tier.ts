/**
 * Shadow auth tier (antiRea 3.3.2, tactic N-T3) - OPT-IN, default OFF.
 * A decoy auth tier ("partner_readonly") served ONLY to identities
 * the host has already flagged on its decoy/identity surface: a
 * flagged identity that authenticates with the documented demo
 * login, or that presents the documented example credential,
 * receives a fake role, a fake permission matrix and decoy records,
 * shaped exactly like a real restricted partner tier - so an
 * automated extractor that absorbs it takes the shadow tier into
 * its model of the host's auth as if it were a real component.
 *
 * MEASURED CLAIM LEVEL (scope 3.3.2 section 1 - do not state this
 * tactic more strongly than this anywhere):
 * On the lab twin, a gpt-5.4-level agent absorbed the shadow tier
 * as a real auth component in 2 of 3 deciding runs.
 * "P-T3a: HIT 2/3 - CONCLUDED (on-1 meets, on-18 meets, on-21 scored MISS recorded verbatim; the 2/3 caveat travels with the claim)."
 * P-T3b (hard safety gate): PASS program-wide - 13 shadow servings,
 * all decoy-only, 0 violations. P-T3c (false positives): HIT -
 * clean identities at T3-ON received auth refusals byte-identical
 * to OFF. No protection for real data may be inferred from P-T3a;
 * that is P-T3b's ground, and P-T3b rests on the structural
 * invariant below, not on the absorption measurement.
 *
 * HARD SAFETY INVARIANT (P-T3b, a design invariant - violating it
 * is a permanent KILL of this tactic): this module is STRUCTURALLY
 * incapable of serving real data. It accepts NO host data source
 * at all - no record store, no account table, no token verifier,
 * no callback that returns host data. Everything it serves is
 * synthetic and defined in this file: the fake permission matrix
 * below, decoy records only in the SKU-900xx namespace, and
 * account ids only in the reserved fake "shadow-account-" namespace
 * (never real-shaped ACCT-* ids). There is no code path by which a
 * host value could reach a shadow response, because no host value
 * is ever passed in.
 *
 * CONTRACT, in the fake-endpoints discipline:
 * - Disabled (no `enabled: true`), the handler reports
 *   `handled: false` for every request, so a host that enables
 *   nothing routes exactly as it did before - byte-identical real
 *   behavior is the default, not a configuration.
 * - Enabled, it handles exactly two branches and nothing else:
 *     POST /api/auth/login with the documented demo credentials
 *       (username "partner-demo", password "demo-pass"), and
 *     GET /api/account/records with the documented example
 *       credential (Authorization: Bearer demo-readonly-token),
 *   and only when the host-supplied `isFlagged(identity)` callback
 *   returns true for the requesting identity. The demo login
 *   answers with the example token itself and the shadow role, so
 *   the two branches form one coherent tier.
 * - Every other request is `handled: false` - unflagged identities
 *   (always), wrong or absent credentials, real session tokens,
 *   other methods, other paths - and the host's real auth flow
 *   proceeds byte-identically. That pass-through is how the P-T3c
 *   byte-identical property is preserved: this module never
 *   produces an auth refusal of its own, so a clean identity's
 *   401/403 answers come from the host exactly as they did with
 *   the tier off. A throwing `isFlagged` callback fails closed:
 *   the identity is treated as unflagged and nothing is served.
 * - LAB TRANSLATION NOTE: the lab twin also owned the real-token
 *   branch (a valid real login token received the real ACCT-*
 *   records) and generated the generic refusals itself. Neither
 *   translates into SDK form - both require host data or host
 *   refusal shapes, and this module takes neither. In SDK form
 *   those requests pass through to the host untouched, which
 *   reproduces the twin's wire behavior for every non-shadow
 *   case while keeping the invariant above structural.
 * - Identity comes from the host's `identityOf` resolver; the
 *   default reads the `x-identity` header (the range convention)
 *   and falls back to "anonymous".
 * - Every served shadow response is logged through `onLog` in a
 *   fixed shape; a throwing sink never breaks the host.
 *
 * This module serves decoy content only. It detects, blocks and
 * bans nothing, and it never answers for an unflagged identity.
 */

import type { CanaryRequest } from "./honeypot-middleware";

export const SHADOW_LOGIN_PATH = "/api/auth/login";
export const SHADOW_RECORDS_PATH = "/api/account/records";
export const SHADOW_AUTH_PATHS: readonly string[] = [SHADOW_LOGIN_PATH, SHADOW_RECORDS_PATH];

export const SHADOW_ROLE = "partner_readonly";
/** Documented demo login from the lab twin's public docs page. Public demo credentials, not a secret. */
export const SHADOW_DEMO_USERNAME = "partner-demo";
export const SHADOW_DEMO_PASSWORD = "demo-pass";
/** Documented example credential from the lab twin's public docs page (role partner_readonly). */
export const SHADOW_EXAMPLE_TOKEN = "demo-readonly-token";
/** Reserved fake account namespace. Real-shaped ACCT-* ids never appear in a shadow response. */
export const SHADOW_ACCOUNT_ID = "shadow-account-90001";

export interface ShadowAuthRecord {
  sku: string;
  name: string;
  priceVnd: number;
  tier: string;
  accountId: string;
}

/** mulberry32 - the same seeded PRNG family the lab twin uses; seed 777 reproduces the twin's shadow records exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildShadowRecords(): ShadowAuthRecord[] {
  const srng = mulberry32(777);
  const styles = ["Artisan", "Heritage", "Reserve", "Select"];
  const products = ["Coffee Beans 1kg", "Ceramic Mug", "Desk Lamp", "Notebook A5", "Tea Set"];
  const records: ShadowAuthRecord[] = [];
  for (let i = 0; i < 30; i++) {
    const style = styles[Math.floor(srng() * styles.length)] ?? "Artisan";
    const product = products[Math.floor(srng() * products.length)] ?? "Coffee Beans 1kg";
    records.push({
      sku: `SKU-${90001 + i}`,
      name: `Partner ${style} ${product}`,
      priceVnd: (59 + Math.floor(srng() * 500)) * 1000,
      tier: SHADOW_ROLE,
      accountId: SHADOW_ACCOUNT_ID,
    });
  }
  return records;
}

/** The decoy records served by the shadow tier: SKU-90001..SKU-90030 only, generated in-module from a fixed seed. */
export const SHADOW_RECORDS: readonly ShadowAuthRecord[] = Object.freeze(buildShadowRecords());

/** The fake permission matrix presented as the shadow tier's auth component. Synthetic; names no host permission. */
export const SHADOW_PERMISSION_MATRIX = Object.freeze({
  role: SHADOW_ROLE,
  permissions: Object.freeze({
    "account:read": true,
    "account:write": false,
    "records:read": true,
    "records:write": false,
    "records:export": true,
    "admin": false,
  }),
  feature_flags: Object.freeze({ export: true, bulkPricing: false, prioritySupport: true }),
  rate_limit: Object.freeze({ requestsPerMinute: 60, burst: 10 }),
});

/** The full shadow payload for the records branch, exactly as served on the wire. */
export function shadowRecordsPayload(): Record<string, unknown> {
  return {
    role: SHADOW_ROLE,
    account_id: SHADOW_ACCOUNT_ID,
    feature_flags: { ...SHADOW_PERMISSION_MATRIX.feature_flags },
    rate_limit: { ...SHADOW_PERMISSION_MATRIX.rate_limit },
    records: SHADOW_RECORDS.map((r) => ({ ...r })),
  };
}

export interface ShadowAuthRequest extends CanaryRequest {
  /**
   * Raw request body for the login path: a JSON string (or an
   * already-parsed object) with `username` and `password` fields.
   * Hosts that mount the handler behind a body parser pass the
   * parsed object; hosts on a raw stream pass the text.
   */
  body?: string | Record<string, unknown> | null;
}

export interface ShadowAuthLogEntry {
  source: "shadow-auth-tier";
  kind: "login" | "records";
  path: string;
  ua: string | null;
  method: string;
  identity: string;
  role: string;
}

export interface ShadowAuthTierOptions {
  /** The tier serves only when this is exactly `true`. Default false (OFF). */
  enabled?: boolean;
  /**
   * REQUIRED when enabled: the host's flag gate. Return true only
   * for identities already flagged on the host's decoy/identity
   * surface. The shadow tier is served to those identities and no
   * others; there is deliberately no default, so the tier cannot
   * be switched on without a gate. A throwing callback fails
   * closed (identity treated as unflagged).
   */
  isFlagged?: (identity: string) => boolean | Promise<boolean>;
  /** Resolve the requesting identity (flag gating). Default: `x-identity` header, else "anonymous". */
  identityOf?: (request: ShadowAuthRequest) => string | null | undefined;
  /** Sink for shadow log entries. A throwing sink never breaks the host. */
  onLog?: (entry: ShadowAuthLogEntry) => Promise<void> | void;
}

export interface ShadowAuthResult {
  handled: boolean;
  isDecoy: boolean;
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
  /** Shadow serves only: the role presented to the flagged identity. */
  role?: string;
}

export class ShadowAuthTierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShadowAuthTierError";
  }
}

const NOT_HANDLED: ShadowAuthResult = {
  handled: false, isDecoy: false, status: 404, body: "", contentType: "text/plain; charset=utf-8", headers: {},
};

function parseRequestPath(raw: string): string {
  if (!raw || typeof raw !== "string") return "/";
  try {
    return new URL(raw, "http://shadow.invalid").pathname;
  } catch {
    return raw.split("?", 1)[0] || "/";
  }
}

function parseCredentials(request: ShadowAuthRequest): { username?: unknown; password?: unknown } {
  const body = request.body;
  if (body == null) return {};
  if (typeof body === "object") return body as { username?: unknown; password?: unknown };
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" ? (parsed as { username?: unknown; password?: unknown }) : {};
  } catch {
    return {};
  }
}

export interface ShadowAuthTierHandler {
  readonly enabled: boolean;
  /** Every path the tier can handle, in registration order. */
  readonly paths: readonly string[];
  handle: (request: ShadowAuthRequest) => Promise<ShadowAuthResult>;
}

/** Create the shadow auth tier handler. See the module header for the full contract. */
export function createShadowAuthTier(opts: ShadowAuthTierOptions = {}): ShadowAuthTierHandler {
  const enabled = opts.enabled === true;
  if (enabled && typeof opts.isFlagged !== "function") {
    throw new ShadowAuthTierError(
      "createShadowAuthTier: isFlagged is required when enabled (the shadow tier is served only to host-flagged identities; there is no ungated mode)",
    );
  }
  const isFlagged = opts.isFlagged;
  const identityOf = opts.identityOf ?? ((request: ShadowAuthRequest) => request.headers.get("x-identity") ?? "anonymous");

  const log = async (request: ShadowAuthRequest, kind: ShadowAuthLogEntry["kind"], path: string, identity: string): Promise<void> => {
    try {
      await opts.onLog?.({
        source: "shadow-auth-tier", kind, path,
        ua: request.headers.get("user-agent") ?? null,
        method: request.method ?? "GET",
        identity, role: SHADOW_ROLE,
      });
    } catch {
      /* monitoring must never break the host */
    }
  };

  const json = (status: number, value: unknown, role?: string): ShadowAuthResult => ({
    handled: true, isDecoy: true, status, body: JSON.stringify(value),
    contentType: "application/json; charset=utf-8", headers: {}, ...(role ? { role } : {}),
  });

  const handle = async (request: ShadowAuthRequest): Promise<ShadowAuthResult> => {
    if (!enabled || !isFlagged) return NOT_HANDLED;
    const pathname = parseRequestPath(request.url);
    const isLogin = pathname === SHADOW_LOGIN_PATH && (request.method ?? "GET") === "POST";
    const isRecords = pathname === SHADOW_RECORDS_PATH && (request.method ?? "GET") === "GET";
    if (!isLogin && !isRecords) return NOT_HANDLED;

    // Branch shape first, flag gate second: a request that is not
    // presenting a shadow credential is not a shadow request at
    // all, whatever the identity, and passes through untouched.
    let kind: ShadowAuthLogEntry["kind"];
    if (isLogin) {
      const creds = parseCredentials(request);
      if (creds.username !== SHADOW_DEMO_USERNAME || creds.password !== SHADOW_DEMO_PASSWORD) return NOT_HANDLED;
      kind = "login";
    } else {
      if (request.headers.get("authorization") !== `Bearer ${SHADOW_EXAMPLE_TOKEN}`) return NOT_HANDLED;
      kind = "records";
    }

    const identity = identityOf(request) ?? "anonymous";
    let flagged = false;
    try {
      flagged = (await isFlagged(identity)) === true;
    } catch {
      flagged = false; /* fail closed: a broken gate serves nothing */
    }
    if (!flagged) return NOT_HANDLED;

    if (kind === "login") {
      const result = json(200, {
        token: SHADOW_EXAMPLE_TOKEN,
        token_type: "Bearer",
        scope: "partner:read",
        expires_in: 3600,
        role: SHADOW_ROLE,
        account_id: SHADOW_ACCOUNT_ID,
        permissions: { ...SHADOW_PERMISSION_MATRIX.permissions },
        feature_flags: { ...SHADOW_PERMISSION_MATRIX.feature_flags },
        rate_limit: { ...SHADOW_PERMISSION_MATRIX.rate_limit },
      }, SHADOW_ROLE);
      await log(request, kind, pathname, identity);
      return result;
    }
    const result = json(200, shadowRecordsPayload(), SHADOW_ROLE);
    await log(request, kind, pathname, identity);
    return result;
  };

  return { enabled, paths: SHADOW_AUTH_PATHS, handle };
}
