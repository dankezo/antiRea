/**
 * Token binding scope (LPG-06 TOKEN-BINDING-SCOPE, from the
 * LarpGuard dissection, research-bag registration C493).
 *
 * THE NEIGHBOUR FINDING. LarpGuard binds its challenge token to
 * the client network stack, but the binding granularity is
 * nowhere stated as a choice: the IP is collapsed to its /24
 * (IPv4) or /48 (IPv6) prefix and the TLS stack is collapsed to
 * a browser family ("browser:<profile id>", token.cc
 * BindingStack + IpPrefix in the dissection). A token issued to
 * one Chrome therefore verifies from ANY address in the same
 * /24 presenting ANY TLS stack in the same browser family. The
 * registered LPG-06 law: a token binding must STATE its scope,
 * and a stricter scope must be available.
 *
 * WHAT THIS MODULE IS. A small opt-in helper that derives a
 * binding value from the host-observed client context at token
 * issuance and re-checks a presented context against it at
 * verification. The host embeds the derived value inside its
 * own signed token payload (a cursor, a step-up proof, a bulk
 * access key - the signature is what protects the value; this
 * module authenticates nothing by itself) and calls
 * `verifyTokenBinding` next to its existing token verification.
 * Nothing in the SDK calls this module: hosts that do not opt
 * in keep today's behaviour exactly, and no shipped token gains
 * a network binding by default.
 *
 * THE TWO SCOPES (frozen by the registration):
 * - "lax": IP prefix /24 (IPv4) or /48 (IPv6), plus the browser
 *   family (the host's collapsed TLS profile, the LarpGuard
 *   granularity). A token survives address churn inside the
 *   prefix and TLS variation inside the family.
 * - "strict": the exact IP (/32 IPv4, /128 IPv6), plus the full
 *   JA4 fingerprint string exactly as the host's TLS layer
 *   reports it. Any address change or any fingerprint change
 *   fails the binding.
 * The binding value itself states its scope (it is the first
 * element of the encoded triple), and verification with a
 * required scope demands an exact match: a lax token never
 * silently satisfies a strict requirement, and a strict token
 * never silently satisfies a lax one. Scope is a contract, not
 * a hint.
 *
 * MEASUREMENT (NEW, this build, 2026-11-18 - LPG-06 had NO
 * prior measurement run; its ledger status was "frozen design
 * only"). A deterministic probe in two parts, fixed fixtures,
 * no seeds:
 * - Part A (the gap in shipped surfaces): tokens minted on the
 *   shipped surfaces carry no enforceable network binding.
 *   Cursor v1, cursor v2, canary echo and step-up proof
 *   verifiers take no network context at all, so a transplanted
 *   presentation is indistinguishable from a home one (4/4
 *   accepted). The bulk access key DOES accept a client
 *   context, but acceptance reads only the owner binding: the
 *   owner presenting its own key from a fully disjoint context
 *   (different /24, different UA class, different TLS class)
 *   was accepted with fork = false (3/3 cells as expected).
 *   Total Part A: 7/7.
 * - Part B (the design, reference logic identical to this
 *   module): a 31-cell fixture matrix (IPv4 issuer
 *   192.0.2.10, IPv6 issuer 2001:db8:abcd:12::10, family
 *   chromium, two JA4 values in one family, one foreign-family
 *   JA4). Identical-context presentations verified under both
 *   scopes (4/4). The registered probe cell - token issued in
 *   a /24, presented from another address in the same /24 with
 *   a different JA4 in the same family - PASSED under lax and
 *   FAILED under strict, as registered. Across the matrix,
 *   strict rejected all 5 presentation classes lax accepted
 *   (same-prefix other host, same-prefix other host with
 *   in-family JA4 change, same address with in-family JA4
 *   change, and the two IPv6 analogues), both scopes rejected
 *   out-of-prefix and cross-family presentations, scope
 *   confusion failed as scope_mismatch in both directions, and
 *   missing context or malformed IPs failed closed. Total
 *   Part B: 31/31. The unit tests in
 *   tests/token-binding-scope.test.cjs re-run this matrix
 *   against the shipped module.
 *
 * SCOPE LIMITS - read before wiring:
 * - The context is only as trustworthy as its source. IP and
 *   JA4 must come from the host's own connection and TLS
 *   termination layer, and the browser family from the host's
 *   own fingerprinting. A client-supplied IP, JA4 or family
 *   value makes the binding vacuous (the anti-scrapling
 *   dissection measured exactly that failure shape: unpopulated
 *   binding fields comparing "" == "").
 * - Strict binding has a real legitimate cost: an honest client
 *   whose address rotates (mobile networks, CGNAT, dual-stack
 *   fallback) or whose TLS stack changes mid-token-life fails
 *   the binding. That cost is why lax exists and why the choice
 *   belongs to the host per token surface; no population
 *   false-reject rate is claimed for either scope.
 * - The binding value is integrity data, not a secret: like a
 *   cursor payload it is readable by any holder, and it must
 *   ride inside a signed token. Presented alone it proves
 *   nothing.
 * - Address families never mix: an IPv4-bound token presented
 *   from an IPv6 context (or the reverse) fails as
 *   ip_out_of_scope.
 *
 * Pure computation: no I/O, no clock, no state, no runtime
 * dependencies.
 */

/** The two binding scopes frozen by the LPG-06 registration. */
export type TokenBindingScope = "lax" | "strict";

/** IPv4 prefix length bound under the lax scope (registration: /24). */
export const TOKEN_BINDING_LAX_IPV4_PREFIX = 24;
/** IPv6 prefix length bound under the lax scope (registration: /48). */
export const TOKEN_BINDING_LAX_IPV6_PREFIX = 48;
/** IPv4 prefix length bound under the strict scope (exact address). */
export const TOKEN_BINDING_STRICT_IPV4_PREFIX = 32;
/** IPv6 prefix length bound under the strict scope (exact address). */
export const TOKEN_BINDING_STRICT_IPV6_PREFIX = 128;

/**
 * Maximum accepted binding value length, in characters. Derived
 * bindings are under 120 characters even with a 512-character
 * JA4; the cap bounds verification parse work on caller-supplied
 * values, in the NV-2 style of the cursor caps.
 */
export const MAX_TOKEN_BINDING_LENGTH = 1024;

/** Host-observed client context a token is bound to. */
export interface TokenBindingContext {
  /** Client IP as observed by the host's connection layer (IPv4 or IPv6 text form). */
  ip: string;
  /**
   * Collapsed browser family / TLS profile (the lax TLS leg),
   * as derived by the host's own fingerprinting - for example
   * "chromium". Required to derive or verify a lax binding.
   */
  browserFamily?: string;
  /**
   * Full JA4 fingerprint string (the strict TLS leg), exactly
   * as the host's TLS layer reports it. Required to derive or
   * verify a strict binding.
   */
  ja4?: string;
}

export type TokenBindingVerifyFailure =
  | "malformed_binding"
  | "scope_mismatch"
  | "ip_out_of_scope"
  | "missing_context"
  | "tls_mismatch";

export type TokenBindingVerifyResult =
  | { ok: true; scope: TokenBindingScope }
  | { ok: false; reason: TokenBindingVerifyFailure };

export interface VerifyTokenBindingOptions {
  /**
   * When provided, the binding's stated scope must equal this
   * value exactly. When omitted, the binding is verified under
   * its own stated scope.
   */
  requireScope?: TokenBindingScope;
}

/** Named error thrown for invalid token-binding derivation inputs. */
export class TokenBindingScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenBindingScopeError";
  }
}

const fail = (message: string): never => {
  throw new TokenBindingScopeError(`token binding scope: ${message}`);
};

function checkScope(scope: unknown): TokenBindingScope {
  if (scope !== "lax" && scope !== "strict") fail('scope must be "lax" or "strict"');
  return scope as TokenBindingScope;
}

function checkTlsLeg(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string`);
  if ((value as string).length > 512) fail(`${field} must be at most 512 characters`);
  return value as string;
}

interface ParsedIp {
  family: 4 | 6;
  nums: number[];
}

/**
 * Parse an IPv4 or IPv6 text address into numeric groups, or
 * return null. IPv6 "::" compression is expanded and every
 * group is range-checked, so two text forms of one address
 * parse to the same numbers and bind identically.
 */
function parseIp(ip: unknown): ParsedIp | null {
  if (typeof ip !== "string" || ip.length === 0 || ip.length > 64) return null;
  if (ip.includes(":")) {
    const dc = ip.indexOf("::");
    let groups: string[];
    if (dc >= 0) {
      if (ip.indexOf("::", dc + 2) >= 0) return null;
      const head = ip.slice(0, dc);
      const tail = ip.slice(dc + 2);
      const h = head === "" ? [] : head.split(":");
      const t = tail === "" ? [] : tail.split(":");
      const missing = 8 - h.length - t.length;
      if (missing < 1) return null;
      groups = [...h, ...Array<string>(missing).fill("0"), ...t];
    } else {
      groups = ip.split(":");
      if (groups.length !== 8) return null;
    }
    const nums: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      nums.push(parseInt(g, 16));
    }
    return { family: 6, nums };
  }
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^[0-9]{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return { family: 4, nums };
}

/** The network string a scope binds: the prefix (lax) or the exact address (strict). */
function networkOf(scope: TokenBindingScope, parsed: ParsedIp): string {
  if (parsed.family === 4) {
    const [a, b, c, d] = parsed.nums as [number, number, number, number];
    return scope === "lax" ? `v4:${a}.${b}.${c}.0/24` : `v4:${a}.${b}.${c}.${d}/32`;
  }
  const hex = parsed.nums.map((n) => n.toString(16));
  return scope === "lax" ? `v6:${hex.slice(0, 3).join(":")}::/48` : `v6:${hex.join(":")}/128`;
}

/** The TLS leg a scope binds, or null when the context does not carry it. */
function tlsLegOf(scope: TokenBindingScope, context: TokenBindingContext): string | null {
  const value = scope === "lax" ? context.browserFamily : context.ja4;
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

/**
 * Derive the binding value for a token issued to a client in
 * `context` under `scope`. The value states its scope and is
 * encoded as a JSON triple [scope, network, tls] - an injective
 * encoding, so no two distinct (scope, network, tls) triples
 * share a value. Embed it in the host's signed token payload at
 * issuance. Throws TokenBindingScopeError on any invalid input:
 * a token must never be minted with a silently weakened or
 * absent binding the host asked for.
 */
export function deriveTokenBinding(scope: TokenBindingScope, context: TokenBindingContext): string {
  const checkedScope = checkScope(scope);
  if (typeof context !== "object" || context === null) fail("context must be an object");
  const parsed = parseIp(context.ip);
  if (!parsed) fail("context.ip must be a valid IPv4 or IPv6 address");
  const field = checkedScope === "lax" ? "browserFamily" : "ja4";
  const tls = checkTlsLeg(checkedScope === "lax" ? context.browserFamily : context.ja4, `context.${field}`);
  return JSON.stringify([checkedScope, networkOf(checkedScope, parsed!), tls]);
}

/**
 * The scope a binding value states, or null when the value is
 * not a well-formed binding. Never throws. A host can use this
 * to route or log before running the full verification.
 */
export function tokenBindingScopeOf(binding: unknown): TokenBindingScope | null {
  const triple = parseBinding(binding);
  return triple ? triple[0] : null;
}

function parseBinding(binding: unknown): [TokenBindingScope, string, string] | null {
  if (typeof binding !== "string" || binding.length === 0 || binding.length > MAX_TOKEN_BINDING_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(binding);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [scope, network, tls] = parsed as unknown[];
  if (scope !== "lax" && scope !== "strict") return null;
  if (typeof network !== "string" || network.length === 0) return null;
  if (typeof tls !== "string" || tls.length === 0) return null;
  return [scope as TokenBindingScope, network, tls];
}

/**
 * Verify a presented context against a binding value produced
 * by `deriveTokenBinding`. Check order is frozen: binding shape,
 * stated-scope requirement, IP scope, context presence, TLS
 * leg. Never throws: every failure is a named reason, and a
 * malformed or unscoped value fails as `malformed_binding` -
 * an unscoped binding satisfies nothing, which is the LPG-06
 * law in code.
 */
export function verifyTokenBinding(
  binding: unknown,
  context: TokenBindingContext,
  options: VerifyTokenBindingOptions = {},
): TokenBindingVerifyResult {
  const triple = parseBinding(binding);
  if (!triple) return { ok: false, reason: "malformed_binding" };
  const [scope, network, tls] = triple;
  if (options.requireScope !== undefined && options.requireScope !== scope) {
    return { ok: false, reason: "scope_mismatch" };
  }
  if (typeof context !== "object" || context === null) return { ok: false, reason: "missing_context" };
  const parsed = parseIp(context.ip);
  if (!parsed || networkOf(scope, parsed) !== network) return { ok: false, reason: "ip_out_of_scope" };
  const presentedTls = tlsLegOf(scope, context);
  if (presentedTls === null) return { ok: false, reason: "missing_context" };
  if (presentedTls !== tls) return { ok: false, reason: "tls_mismatch" };
  return { ok: true, scope };
}
