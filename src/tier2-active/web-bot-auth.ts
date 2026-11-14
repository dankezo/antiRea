/**
 * Web Bot Auth verifier (Tier 2, server-side): RFC 9421 HTTP Message
 * Signatures profiled by the IETF Web Bot Auth draft
 * (`draft-ietf-webbotauth-httpsig-protocol-00`, September 2026; the draft
 * revision current at implementation time expires March 2027 and MAY change -
 * pin your expectations to the reason codes below, not to draft permanence).
 *
 * An automated client (search crawler, AI agent, monitoring bot) signs each
 * request with an Ed25519 key it controls and names the key directory in the
 * `Signature-Agent` header. This module verifies such a signature against keys
 * YOU supply (a parsed key directory, a static pinned key map, or an injected
 * resolver). Fetching `/.well-known/http-message-signatures-directory` over
 * the network is deliberately OUT of scope for the core verifier: supply the
 * fetched JSON through `resolveKey` or parse it with
 * `parseWebBotAuthDirectory`, so the fetch can go through your own HTTP
 * client, cache, timeout and SSRF policy.
 *
 * `Signature-Agent` is accepted in BOTH wire forms. The -00 draft mandates
 * the RFC 8941 Dictionary form for signers (`sig="https://..."`), and that
 * form is handled exactly as specified. Production has not converged on
 * it, though: Cloudflare's production verifier still requires the legacy
 * bare-string form (`Signature-Agent: "https://..."`) and production
 * signers emit it deliberately, so a dictionary-only verifier would
 * reject the deployed ecosystem. The legacy form is therefore accepted as
 * a deprecated compatibility path - §5.2.1 expressly permits this (a
 * verifier MAY accept it) - under a fail-closed guardrail: it binds only
 * when exactly one signature covers the `signature-agent` field, via the
 * whole-field covered component (no `;key`), and the verdict reports
 * which form was used (`agentForm`) so operators can watch legacy usage.
 * Revisit this acceptance when the draft becomes an RFC or Cloudflare's
 * production verifier flips to the dictionary form.
 *
 * Threat model - read before wiring this into policy:
 *
 * - A verified signature proves only that the request was signed, at signing
 *   time, by whoever holds the private key whose public half you resolved for
 *   the claimed `keyid`. Because `signature-agent` is a required covered
 *   component, the claimed agent URL is bound to that key: changing it breaks
 *   the signature. Whether that key is *authoritative for that agent* is
 *   exactly what resolving the key from the agent's own directory (over HTTPS,
 *   from the agent's origin) establishes. A static key map pins key -> keyid
 *   and skips that question entirely: only pin keys you provisioned yourself.
 * - A verified signature says NOTHING about intent. Per the draft itself, it
 *   "says nothing about who operates the Agent, whether the Agent is benign,
 *   or whether the request is authorized." A signed bot can still scrape you;
 *   the signature gives you a stable identity to apply quota and policy to,
 *   not a character reference. Conversely, an UNSIGNED request is not hostile:
 *   most legitimate bots do not sign yet. Never auto-ban on absence of a
 *   signature.
 * - Replay: when the signer includes a `nonce`, this verifier rejects nonce
 *   reuse per key within the signature's validity window (bounded in-memory
 *   store by default; multi-instance deployments need a shared atomic store -
 *   see `nonceStore`). Without a nonce, a captured signed request can be
 *   replayed until `expires`; that is why the draft recommends short validity
 *   (<= 24h, and this verifier enforces a configurable cap, default 24h -
 *   tighten it to minutes if your traffic allows).
 * - This is an identity input, not an authorization decision. Authorization,
 *   quotas and bans remain server-side policy (see `docs/LIMITATIONS.md`).
 *
 * Feeding quota-guard (the intended composition; quota-guard is NOT modified):
 * map a verified verdict onto a dedicated plan tier inside your own
 * `resolveIdentity`, and let unsigned traffic fall through to the default
 * tier. Add a `"verified-agent"` tier to the guard's `tiers` config:
 *
 * ```ts
 * const verifier = createWebBotAuthVerifier({ resolveKey: fetchDirectoryKey });
 * const guard = createQuotaGuard({
 *   tiers: { ...DEFAULT_QUOTA_TIERS, "verified-agent": { maxRequests: 600, windowMs: 60_000, maxPageSize: 100, maxPage: 50 } },
 *   resolveIdentity: async (req) => {
 *     const verdict = await verifier.verify(req);
 *     return verdict.verified
 *       ? { accountId: `bot:${verdict.agent ?? verdict.keyId}`, tier: "verified-agent" }
 *       : undefined; // unsigned or invalid -> default ("anonymous") tier
 *   },
 * });
 * ```
 *
 * Node.js builtins only (`node:crypto` Ed25519); zero runtime dependencies.
 */

export const WEB_BOT_AUTH_TAG = "web-bot-auth";
export const WEB_BOT_AUTH_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

/* ------------------------------------------------------------------------ */
/* Minimal structural view of node:crypto (no @types/node in this repo,      */
/* mirroring the lazy-require pattern used by tier3 transport-shield).      */
/* ------------------------------------------------------------------------ */

export interface Ed25519KeyObjectLike {
  asymmetricKeyType?: string;
  type?: string;
}

interface NodeHashLike {
  update(data: string | Uint8Array): NodeHashLike;
  digest(): Uint8Array;
}

interface NodeCryptoLike {
  createPublicKey(input: unknown): Ed25519KeyObjectLike;
  verify(algorithm: null, data: Uint8Array, key: Ed25519KeyObjectLike, signature: Uint8Array): boolean;
  createHash(algorithm: string): NodeHashLike;
}

declare const require: ((id: string) => NodeCryptoLike) | undefined;

function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.verify === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; the Web Bot Auth verifier requires Node.js");
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/* ------------------------------------------------------------------------ */
/* Base64 helpers (standard and URL-safe alphabets).                          */
/* ------------------------------------------------------------------------ */

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  const STEP = 0x4000;
  for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Decode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, ch => ch.charCodeAt(0));
}

function tryBase64Decode(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return undefined;
  try {
    return base64Decode(value);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------------ */
/* RFC 8941 Structured Fields - the small subset RFC 9421 signatures need:  */
/* dictionaries of items / inner lists, item parameters, and string, token, */
/* integer, decimal, byte-sequence and boolean values. Raw source slices are */
/* retained so the `@signature-params` line and component identifiers can   */
/* be re-serialized byte-for-byte as the signer sent them.                  */
/* ------------------------------------------------------------------------ */

export interface SfValue {
  kind: "string" | "token" | "integer" | "decimal" | "bytes" | "boolean";
  /** string/token text, numeric value, raw bytes, or boolean. */
  value: string | number | Uint8Array | boolean;
  /** Exact source substring of the bare item. */
  raw: string;
}

export interface SfParam {
  name: string;
  /** `true` for a bare `;name` parameter. */
  value: SfValue | true;
}

export interface SfItem {
  value: SfValue;
  params: SfParam[];
  /** Exact source substring of item + parameters. */
  raw: string;
}

export interface SfInnerList {
  items: SfItem[];
  params: SfParam[];
  /** Exact source substring of `( ... )` plus trailing parameters. */
  raw: string;
}

export interface SfMember {
  kind: "item" | "inner-list";
  item?: SfItem;
  list?: SfInnerList;
  /** Exact source substring of the member value (item or inner list). */
  raw: string;
}

class SfParser {
  private i = 0;
  constructor(private readonly s: string) {}

  get done(): boolean {
    return this.i >= this.s.length;
  }

  peek(): string {
    return this.s[this.i] ?? "";
  }

  advance(): void {
    this.i++;
  }

  error(message: string): Error {
    return new SyntaxError(`Structured Fields parse error at offset ${this.i}: ${message}`);
  }

  skipSpaces(): void {
    while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++;
  }

  skipOptionalWhitespace(): void {
    this.skipSpaces();
  }

  parseKey(): string {
    const match = /^[a-z*][a-z0-9_*.-]*/.exec(this.s.slice(this.i));
    if (!match) throw this.error("expected a key");
    this.i += match[0].length;
    return match[0];
  }

  parseString(): SfValue {
    const start = this.i;
    this.i++; // opening quote
    let out = "";
    for (;;) {
      const ch = this.s[this.i];
      if (ch === undefined) throw this.error("unterminated string");
      if (ch === "\\") {
        const next = this.s[this.i + 1];
        if (next !== "\\" && next !== '"') throw this.error("invalid escape in string");
        out += next;
        this.i += 2;
        continue;
      }
      if (ch === '"') {
        this.i++;
        break;
      }
      out += ch;
      this.i++;
    }
    return { kind: "string", value: out, raw: this.s.slice(start, this.i) };
  }

  parseBytes(): SfValue {
    const start = this.i;
    this.i++; // opening colon
    const end = this.s.indexOf(":", this.i);
    if (end < 0) throw this.error("unterminated byte sequence");
    const body = this.s.slice(this.i, end);
    if (!/^[A-Za-z0-9+/=]*$/.test(body)) throw this.error("invalid byte sequence content");
    const bytes = tryBase64Decode(body);
    if (!bytes) throw this.error("invalid base64 in byte sequence");
    this.i = end + 1;
    return { kind: "bytes", value: bytes, raw: this.s.slice(start, this.i) };
  }

  parseNumber(): SfValue {
    const start = this.i;
    const match = /^-?\d+(?:\.\d+)?/.exec(this.s.slice(this.i));
    if (!match) throw this.error("expected a number");
    this.i += match[0].length;
    const raw = match[0];
    return raw.includes(".")
      ? { kind: "decimal", value: Number(raw), raw }
      : { kind: "integer", value: Number(raw), raw };
  }

  parseToken(): SfValue {
    const start = this.i;
    const match = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*\*?/.exec(this.s.slice(this.i));
    if (!match || match[0].length === 0) throw this.error("expected a token");
    // RFC 8941 tokens allow a wider set; the regex above is a permissive subset
    // sufficient for header values seen in signature headers.
    this.i += match[0].length;
    return { kind: "token", value: match[0], raw: this.s.slice(start, this.i) };
  }

  parseBareItem(): SfValue {
    const ch = this.peek();
    if (ch === '"') return this.parseString();
    if (ch === ":") return this.parseBytes();
    if (ch === "?") {
      const start = this.i;
      const digit = this.s[this.i + 1];
      if (digit !== "0" && digit !== "1") throw this.error("invalid boolean");
      this.i += 2;
      return { kind: "boolean", value: digit === "1", raw: this.s.slice(start, this.i) };
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.parseNumber();
    if (/[A-Za-z*]/.test(ch)) return this.parseToken();
    throw this.error(`unexpected character ${JSON.stringify(ch)}`);
  }

  parseParams(): SfParam[] {
    const params: SfParam[] = [];
    const seen = new Set<string>();
    while (this.peek() === ";") {
      this.i++;
      this.skipSpaces();
      const name = this.parseKey();
      // RFC 8941 §3.1.2: parameter names are unique within an item / inner
      // list. Accepting a repeat would be a parser differential (this
      // parser's lookups are first-wins, other readers may be last-wins),
      // so a duplicate parameter is a structural parse error.
      if (seen.has(name)) throw this.error(`duplicate parameter "${name}"`);
      seen.add(name);
      if (this.peek() === "=") {
        this.i++;
        params.push({ name, value: this.parseBareItem() });
      } else {
        params.push({ name, value: true });
      }
    }
    return params;
  }

  parseItem(): SfItem {
    const start = this.i;
    const value = this.parseBareItem();
    const params = this.parseParams();
    return { value, params, raw: this.s.slice(start, this.i) };
  }

  parseInnerList(): SfInnerList {
    const start = this.i;
    this.i++; // '('
    const items: SfItem[] = [];
    for (;;) {
      this.skipSpaces();
      if (this.peek() === ")") {
        this.i++;
        break;
      }
      if (this.done) throw this.error("unterminated inner list");
      items.push(this.parseItem());
      if (this.peek() !== " " && this.peek() !== "\t" && this.peek() !== ")") {
        throw this.error("expected space between inner-list items");
      }
    }
    const params = this.parseParams();
    return { items, params, raw: this.s.slice(start, this.i) };
  }

  /** Parse the value side of one dictionary member. */
  parseMemberValue(): SfMember {
    const start = this.i;
    if (this.peek() === "(") {
      const list = this.parseInnerList();
      return { kind: "inner-list", list, raw: this.s.slice(start, this.i) };
    }
    const item = this.parseItem();
    return { kind: "item", item, raw: this.s.slice(start, this.i) };
  }
}

/** Parse an RFC 8941 dictionary, preserving member order and raw serializations. */
export function parseSfDictionary(headerValue: string): Map<string, SfMember> {
  const parser = new SfParser(headerValue);
  const members = new Map<string, SfMember>();
  parser.skipOptionalWhitespace();
  while (!parser.done) {
    const key = parser.parseKey();
    // RFC 8941 §3.2: dictionary member names are unique. A repeated key is
    // a structural parse error, not a last-wins overwrite - otherwise this
    // parser and a proxy/host reading the same header with a different
    // convention disagree about which member was signed (F-22).
    if (members.has(key)) throw parser.error(`duplicate dictionary key "${key}"`);
    parser.skipSpaces();
    if (parser.peek() === "=") {
      parser.advance();
      members.set(key, parser.parseMemberValue());
    } else {
      // Bare member: an item whose value is boolean true, with parameters.
      const params = parser.parseParams();
      members.set(key, {
        kind: "item",
        item: { value: { kind: "boolean", value: true, raw: "?1" }, params, raw: "" },
        raw: "",
      });
    }
    parser.skipOptionalWhitespace();
    if (parser.done) break;
    if (parser.peek() !== ",") throw parser.error("expected ',' between dictionary members");
    parser.advance();
    parser.skipOptionalWhitespace();
  }
  return members;
}

/**
 * Parse the legacy bare-string `Signature-Agent` form
 * (`Signature-Agent: "https://agent.example"` - one sf-string item and
 * nothing else). Returns the string value, or `undefined` when the header
 * is anything else. Strict on purpose: parameters, extra members or a
 * non-string item are not the legacy form.
 */
function parseLegacySignatureAgent(headerValue: string): string | undefined {
  const parser = new SfParser(headerValue);
  try {
    parser.skipOptionalWhitespace();
    const item = parser.parseItem();
    parser.skipOptionalWhitespace();
    if (!parser.done) return undefined;
    if (item.value.kind !== "string" || item.params.length > 0) return undefined;
    const value = String(item.value.value);
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

function serializeParamValue(value: SfValue): string {
  return value.raw;
}

/** Re-serialize a component identifier (`"name";p=v;flag`) per RFC 9421 §2.5. */
function serializeComponentIdentifier(item: SfItem): string {
  if (item.value.kind !== "string") throw new SyntaxError("component identifier is not a string");
  let out = `"${String(item.value.value)}"`;
  for (const param of item.params) {
    out += `;${param.name}`;
    if (param.value !== true) out += `=${serializeParamValue(param.value)}`;
  }
  return out;
}

function findParam(params: SfParam[], name: string): SfParam | undefined {
  return params.find(p => p.name === name);
}

function paramAsString(params: SfParam[], name: string): string | undefined {
  const param = findParam(params, name);
  if (!param || param.value === true) return undefined;
  if (param.value.kind === "string" || param.value.kind === "token") return String(param.value.value);
  return undefined;
}

function paramAsInteger(params: SfParam[], name: string): number | undefined {
  const param = findParam(params, name);
  if (!param || param.value === true) return undefined;
  if (param.value.kind === "integer" && typeof param.value.value === "number") return param.value.value;
  return undefined;
}

/* ------------------------------------------------------------------------ */
/* Request abstraction + header access (same spirit as quota-guard).        */
/* ------------------------------------------------------------------------ */

export interface WebBotAuthRequestLike {
  /** Absolute URL (preferred) or request target/path. */
  url: string;
  method?: string;
  /** Explicit authority override; defaults to the `host` header, then the URL host. */
  authority?: string;
  /** Explicit `@target-uri` override; defaults to the absolute `url`. */
  targetUri?: string;
  /** Scheme override for relative URLs (`"https"` by default when needed). */
  scheme?: string;
  headers?:
    | { get(name: string): string | null }
    | Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

function getHeaderValues(req: WebBotAuthRequestLike, name: string): string[] {
  const headers = req.headers;
  if (!headers) return [];
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(n: string): string | null }).get(name);
    return value == null ? [] : [value];
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const wanted = name.toLowerCase();
  const out: string[] = [];
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === wanted) {
      const value = record[key];
      if (Array.isArray(value)) out.push(...value);
      else if (value !== undefined) out.push(value);
    }
  }
  return out;
}

function getHeader(req: WebBotAuthRequestLike, name: string): string | undefined {
  const values = getHeaderValues(req, name);
  return values.length ? values.join(", ") : undefined;
}

/* ------------------------------------------------------------------------ */
/* Keys: JWK handling, RFC 7638 thumbprints, directory parsing.             */
/* ------------------------------------------------------------------------ */

/** Ed25519 public key in JWK form (RFC 8037), as published in key directories. */
export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid?: string;
  /** Key not-before time, seconds since epoch (directory documents may carry it). */
  nbf?: number;
  /** Key expiry time, seconds since epoch (directory documents may carry it). */
  exp?: number;
  [key: string]: unknown;
}

export interface WebBotAuthKeyEntry {
  /** Lookup id: the RFC 7638 JWK SHA-256 thumbprint for directory keys. */
  keyId: string;
  publicKey: Ed25519KeyObjectLike;
  jwk?: Ed25519Jwk;
  notBefore?: number;
  expiresAt?: number;
}

/** Anything a caller may use to hand a public key to this module. */
export type WebBotAuthKeyInput =
  | Ed25519Jwk
  | Record<string, unknown>
  | string
  | Uint8Array
  | Ed25519KeyObjectLike;

/** RFC 7638 JWK SHA-256 thumbprint of an Ed25519 public key - the draft's `keyid`. */
export function computeEd25519JwkThumbprint(jwk: { crv: string; kty: string; x: string }): string {
  const crypto = getNodeCrypto();
  // RFC 7638: required members only, lexicographic order, no whitespace.
  const json = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return base64UrlEncode(crypto.createHash("sha256").update(utf8(json)).digest());
}

function isJwkLike(value: unknown): value is Ed25519Jwk {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["x"] === "string" && typeof record["kty"] === "string";
}

/** DER prefix for an Ed25519 SubjectPublicKeyInfo wrapping a raw 32-byte key. */
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function normalizeKeyInput(input: WebBotAuthKeyInput): WebBotAuthKeyEntry | undefined {
  const crypto = getNodeCrypto();
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("-----")) {
      try {
        const key = crypto.createPublicKey(trimmed);
        return key.asymmetricKeyType === "ed25519" ? { keyId: "", publicKey: key } : undefined;
      } catch {
        return undefined;
      }
    }
    const bytes = tryBase64Decode(trimmed);
    if (bytes && bytes.length === 32) return rawKeyEntry(bytes);
    return undefined;
  }
  if (input instanceof Uint8Array) {
    return input.length === 32 ? rawKeyEntry(input) : undefined;
  }
  if (isJwkLike(input)) {
    if (input.kty !== "OKP" || input.crv !== "Ed25519") return undefined;
    const raw = tryBase64Decode(input.x);
    if (!raw || raw.length !== 32) return undefined;
    try {
      const key = crypto.createPublicKey({ key: input, format: "jwk" });
      if (key.asymmetricKeyType !== "ed25519") return undefined;
      return {
        keyId: computeEd25519JwkThumbprint(input),
        publicKey: key,
        jwk: input,
        ...(typeof input.nbf === "number" ? { notBefore: input.nbf } : {}),
        ...(typeof input.exp === "number" ? { expiresAt: input.exp } : {}),
      };
    } catch {
      return undefined;
    }
  }
  if (typeof input === "object" && input !== null && "asymmetricKeyType" in input) {
    const key = input as Ed25519KeyObjectLike;
    return key.asymmetricKeyType === "ed25519" ? { keyId: "", publicKey: key } : undefined;
  }
  return undefined;
}

function rawKeyEntry(raw: Uint8Array): WebBotAuthKeyEntry {
  const crypto = getNodeCrypto();
  const der = new Uint8Array(ED25519_SPKI_PREFIX.length + raw.length);
  der.set(ED25519_SPKI_PREFIX, 0);
  der.set(raw, ED25519_SPKI_PREFIX.length);
  const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  const jwk: Ed25519Jwk = { kty: "OKP", crv: "Ed25519", x: base64UrlEncode(raw) };
  return { keyId: computeEd25519JwkThumbprint(jwk), publicKey: key, jwk };
}

export interface ParsedWebBotAuthDirectory {
  /** Keys by `keyid` (thumbprint; a differing published `kid` is kept as an alias). */
  keys: Map<string, WebBotAuthKeyEntry>;
  entries: WebBotAuthKeyEntry[];
  /** Directory entries that were structurally invalid and skipped. */
  skipped: number;
  /** Free-form `purpose` string from the directory document, when present. */
  purpose?: string;
}

/**
 * Parse a Web Bot Auth key directory document (the JSON served from
 * `/.well-known/http-message-signatures-directory`) into lookup-ready keys.
 *
 * Accepted shapes (parsed defensively; the directory format is defined by a
 * companion draft and may still change):
 * - `{ "keys": [ <JWK>, ... ], "purpose": "..." }` - a JWK Set (RFC 7517);
 * - a bare array of JWKs;
 * - a single Ed25519 JWK object.
 * Each JWK must be `{ kty: "OKP", crv: "Ed25519", x: "<base64url 32-byte key>" }`;
 * `kid`, `nbf` and `exp` are honored when present. Structurally invalid
 * entries are skipped and counted, never silently trusted. The lookup id is
 * always the computed RFC 7638 thumbprint (the draft requires `keyid` to be
 * exactly that); a differing `kid` is additionally indexed as an alias.
 *
 * NOTE: in the full protocol the directory *response* is itself signed. This
 * parser validates shape only - response authenticity is the fetcher's job
 * (your injected resolver / HTTP layer), exactly like TLS on the fetch.
 */
export function parseWebBotAuthDirectory(document: unknown): ParsedWebBotAuthDirectory {
  let parsed: unknown = document;
  if (typeof document === "string") {
    // NV-3: reject oversized documents before paying the parse at all.
    if (document.length > MAX_DIRECTORY_DOCUMENT_LENGTH) {
      throw new TypeError(
        `Web Bot Auth directory document exceeds the maximum accepted length of ${MAX_DIRECTORY_DOCUMENT_LENGTH} characters`,
      );
    }
    try {
      parsed = JSON.parse(document);
    } catch {
      throw new TypeError("Web Bot Auth directory document is not valid JSON");
    }
  }
  let jwks: unknown[] | undefined;
  let purpose: string | undefined;
  if (Array.isArray(parsed)) {
    jwks = parsed;
  } else if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record["keys"])) {
      jwks = record["keys"];
      if (typeof record["purpose"] === "string") purpose = record["purpose"];
    } else if (isJwkLike(parsed)) {
      jwks = [parsed];
    }
  }
  if (!jwks) {
    throw new TypeError(
      "Unrecognized Web Bot Auth key directory document: expected a JWK Set ({ keys: [...] }), an array of JWKs, or a single Ed25519 JWK",
    );
  }
  // NV-3: fail fast BEFORE normalizing any key - normalization is real
  // cryptographic work per key, so an unbounded directory is an unbounded
  // synchronous CPU bill on the request path.
  if (jwks.length > MAX_DIRECTORY_KEYS) {
    throw new TypeError(
      `Web Bot Auth directory document carries ${jwks.length} keys; the maximum accepted is ${MAX_DIRECTORY_KEYS}`,
    );
  }
  const keys = new Map<string, WebBotAuthKeyEntry>();
  const entries: WebBotAuthKeyEntry[] = [];
  let skipped = 0;
  for (const candidate of jwks) {
    const entry = isJwkLike(candidate) || typeof candidate === "object"
      ? normalizeKeyInput(candidate as WebBotAuthKeyInput)
      : undefined;
    if (!entry || !entry.jwk) {
      skipped++;
      continue;
    }
    entries.push(entry);
    if (!keys.has(entry.keyId)) keys.set(entry.keyId, entry);
    const kid = (candidate as Ed25519Jwk).kid;
    if (typeof kid === "string" && kid !== entry.keyId && !keys.has(kid)) keys.set(kid, entry);
  }
  return { keys, entries, skipped, ...(purpose ? { purpose } : {}) };
}

function isParsedDirectory(value: unknown): value is ParsedWebBotAuthDirectory {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ParsedWebBotAuthDirectory).keys instanceof Map &&
    Array.isArray((value as ParsedWebBotAuthDirectory).entries)
  );
}

function looksLikeDirectoryDocument(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(v => isJwkLike(v));
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record["keys"])) return true;
  }
  return false;
}

/* ------------------------------------------------------------------------ */
/* Nonce replay guard (bounded, in-memory by default).                      */
/* ------------------------------------------------------------------------ */

/** Maximum accepted length of a signature `nonce` parameter, in characters. */
export const MAX_NONCE_LENGTH = 256;

/**
 * Maximum number of keys accepted in one Web Bot Auth directory document
 * (NV-3 cleanup). Real directories carry 1-10 keys; 256 is >25x headroom
 * and bounds one parse to a few milliseconds of key normalization.
 */
export const MAX_DIRECTORY_KEYS = 256;
/**
 * Maximum accepted size, in characters, of a directory document handed in
 * as a string (NV-3 cleanup). Checked before `JSON.parse` runs.
 */
export const MAX_DIRECTORY_DOCUMENT_LENGTH = 1_048_576;

export interface WebBotAuthNonceStore {
  /**
   * Atomically check-and-record a nonce scoped to a key. Returns `true` when
   * the nonce is fresh (and now recorded until `expiresAtMs`), `false` when
   * it was already seen (replay) OR when the store is at capacity with
   * unexpired entries and refuses to make room by forgetting a live nonce
   * (fail closed - the verifier reports both as `replay_detected`).
   * Implementations backed by Redis should use
   * `SET key 1 NX PX <ttl>` so the check is atomic across instances.
   */
  checkAndRecord(scopeKey: string, expiresAtMs: number, now: number): Promise<boolean> | boolean;
}

/**
 * Bounded in-memory nonce store: expired entries are pruned on access and
 * the key set is capped. The cap fails closed - only expired entries are
 * ever evicted; a full store refuses new nonces instead of dropping a live
 * one and reopening its replay window.
 */
export function createInMemoryNonceStore(maxEntries = 10_000): WebBotAuthNonceStore {
  const cap = Math.max(100, Math.floor(maxEntries) || 10_000);
  const seen = new Map<string, number>();
  return {
    checkAndRecord(scopeKey, expiresAtMs, now) {
      const existing = seen.get(scopeKey);
      if (existing !== undefined && existing > now) return false;
      if (existing !== undefined) seen.delete(scopeKey);
      if (seen.size >= cap) {
        // Make room only from expired entries; never evict a live nonce.
        for (const [key, expiry] of seen) {
          if (expiry <= now) seen.delete(key);
        }
        if (seen.size >= cap) return false;
      }
      seen.set(scopeKey, Math.max(expiresAtMs, now));
      return true;
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Verdict + options.                                                       */
/* ------------------------------------------------------------------------ */

export type WebBotAuthFailureReason =
  /** `Signature` / `Signature-Input` headers are absent entirely. */
  | "no_signature_headers"
  /** `Signature-Agent` header is absent or carries no usable member. */
  | "no_signature_agent"
  /** One of the three headers cannot be parsed as RFC 8941 structured fields. */
  | "malformed_headers"
  /** A required signature parameter (`keyid`, `tag`, `created`, `expires`, or `nonce` when required) is absent or ill-typed. */
  | "missing_parameter"
  /** `tag` is present but not `web-bot-auth` - the signature was made for another protocol profile. */
  | "wrong_tag"
  /** `alg` names something other than `ed25519`, or the resolved key is not Ed25519. */
  | "unsupported_algorithm"
  /** Covered components lack `@authority`/`@target-uri`, or lack the `signature-agent` member. */
  | "insufficient_coverage"
  /** The covered-component list repeats a component identifier, which RFC 9421 §2.5 forbids. */
  | "duplicate_covered_components"
  /** `expires` is in the past (beyond clock skew). */
  | "expired"
  /** `created` is in the future (beyond clock skew) - signature not yet valid. */
  | "not_yet_valid"
  /** `expires - created` exceeds the configured maximum validity window. */
  | "validity_window_too_long"
  /** `expires` is not after `created` - the validity window is empty or negative. */
  | "invalid_validity_window"
  /** The `nonce` parameter exceeds `MAX_NONCE_LENGTH` characters. */
  | "nonce_too_long"
  /** No key could be resolved for `keyid` (unknown key, or the key itself is outside its own nbf/exp window). */
  | "unknown_key"
  /** The injected key resolver threw. */
  | "key_resolution_failed"
  /** The nonce was already seen for this key (only possible when the signer sent a nonce). */
  | "replay_detected"
  /** The signature base could not be reconstructed from this request, or Ed25519 verification failed. */
  | "invalid_signature";

export interface WebBotAuthVerdict {
  verified: boolean;
  /** The signed `Signature-Agent` URL, when verification got far enough to read it. This is the agent identity to key policy/quota on. */
  agent?: string;
  /** Which `Signature-Agent` wire form the request used, when the header could be read: the draft's dictionary form, or the deprecated legacy bare-string form (accepted for production compatibility - see the module header). Lets operators measure remaining legacy usage. */
  agentForm?: "dictionary" | "legacy";
  /** The `keyid` (JWK thumbprint) the signature claims, when readable. */
  keyId?: string;
  /** The signature label that was evaluated. */
  label?: string;
  /** Signature `expires`, seconds since epoch, when readable. */
  expiresAt?: number;
  /** Machine-readable failure reason; present iff `verified` is false. */
  reason?: WebBotAuthFailureReason;
  /** Human-readable detail for logs; never surface to the client verbatim in a policy response. */
  detail?: string;
}

export interface WebBotAuthKeyResolverContext {
  /** Claimed (and signature-bound) agent URL from `Signature-Agent`, when determinable. */
  agent?: string;
  keyId: string;
  request: WebBotAuthRequestLike;
}

/**
 * What key sources may return / be configured with: a single key input, a
 * directory JSON document, a parsed directory, or a key map.
 */
export type WebBotAuthKeySource =
  | WebBotAuthKeyInput
  | ParsedWebBotAuthDirectory
  | Map<string, WebBotAuthKeyInput | WebBotAuthKeyEntry>
  | Record<string, WebBotAuthKeyInput>
  | unknown[];

export interface WebBotAuthVerifierOptions {
  /**
   * Static key source: a parsed directory, a directory JSON document, a JWK
   * array, or a map/record of `keyid -> key`. For JWK values the computed
   * thumbprint is indexed in addition to the map key. Static keys are pinned:
   * they are trusted for any claimed agent, so only pin keys you provisioned.
   */
  keys?: WebBotAuthKeySource;
  /**
   * Injected resolver for dynamic directories - fetch
   * `https://<agent>` + WEB_BOT_AUTH_DIRECTORY_PATH yourself (with your own
   * cache/TTL/SSRF policy) and return the JSON document, a parsed directory,
   * or the single key for `keyId`. Consulted after `keys` misses. Returning
   * the raw document is correct, but on hot paths prefer returning the
   * result of `parseWebBotAuthDirectory(...)` - or reuse the same fetched
   * document object/string so the verifier's parse cache applies - when
   * the directory carries many keys: normalization is per-key crypto work,
   * bounded by MAX_DIRECTORY_KEYS / MAX_DIRECTORY_DOCUMENT_LENGTH.
   */
  resolveKey?: (
    ctx: WebBotAuthKeyResolverContext,
  ) => WebBotAuthKeySource | undefined | Promise<WebBotAuthKeySource | undefined>;
  /** Maximum allowed `expires - created`, seconds. Defaults to 86_400 (24h, the draft's recommended ceiling). Tighten to minutes if you can. */
  maxValiditySeconds?: number;
  /** Clock-skew tolerance applied to `created`/`expires`, seconds. Defaults to 60. */
  clockSkewSeconds?: number;
  /** Require a `nonce` parameter. Defaults to false: the current draft does not require one (earlier revisions suggested a unique nonce). Replay protection only exists when a nonce is present. */
  requireNonce?: boolean;
  /** Shared nonce store for multi-instance deployments. Defaults to a bounded in-memory store. */
  nonceStore?: WebBotAuthNonceStore;
  /** Cap on entries in the default in-memory nonce store. Defaults to 10,000. */
  maxNonces?: number;
  /** Structured operator event sink, called with every verdict. Errors thrown here are swallowed: logging must never break request handling. */
  onVerdict?: (verdict: WebBotAuthVerdict) => Promise<void> | void;
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface WebBotAuthVerifier {
  verify(req: WebBotAuthRequestLike): Promise<WebBotAuthVerdict>;
}

/* ------------------------------------------------------------------------ */
/* Key source normalization / resolution.                                   */
/* ------------------------------------------------------------------------ */

function entryFromSourceValue(value: WebBotAuthKeyInput | WebBotAuthKeyEntry): WebBotAuthKeyEntry | undefined {
  if (typeof value === "object" && value !== null && "publicKey" in value) {
    const entry = value as WebBotAuthKeyEntry;
    return entry.publicKey ? entry : undefined;
  }
  return normalizeKeyInput(value as WebBotAuthKeyInput);
}

function buildStaticIndex(source: WebBotAuthKeySource | undefined): Map<string, WebBotAuthKeyEntry> {
  const index = new Map<string, WebBotAuthKeyEntry>();
  if (source === undefined || source === null) return index;
  if (isParsedDirectory(source)) {
    for (const [keyId, entry] of source.keys) if (!index.has(keyId)) index.set(keyId, entry);
    return index;
  }
  if (source instanceof Map) {
    for (const [keyId, value] of source) {
      const entry = entryFromSourceValue(value);
      if (!entry) continue;
      if (!index.has(keyId)) index.set(keyId, entry);
      if (entry.keyId && !index.has(entry.keyId)) index.set(entry.keyId, entry);
    }
    return index;
  }
  if (Array.isArray(source) || looksLikeDirectoryDocument(source)) {
    const directory = parseWebBotAuthDirectory(source);
    for (const [keyId, entry] of directory.keys) if (!index.has(keyId)) index.set(keyId, entry);
    return index;
  }
  if (typeof source === "object") {
    const record = source as Record<string, WebBotAuthKeyInput>;
    // A lone JWK handed in as `keys` is a one-key directory.
    if (isJwkLike(record)) {
      const directory = parseWebBotAuthDirectory(source);
      for (const [keyId, entry] of directory.keys) if (!index.has(keyId)) index.set(keyId, entry);
      return index;
    }
    for (const [keyId, value] of Object.entries(record)) {
      const entry = entryFromSourceValue(value);
      if (!entry) continue;
      if (!index.has(keyId)) index.set(keyId, entry);
      if (entry.keyId && !index.has(entry.keyId)) index.set(entry.keyId, entry);
    }
    return index;
  }
  // A bare string / bytes key input: index under its computed thumbprint.
  const entry = normalizeKeyInput(source as WebBotAuthKeyInput);
  if (entry && entry.keyId) index.set(entry.keyId, entry);
  return index;
}

/**
 * Per-verifier parse cache for resolver-supplied directory documents
 * (NV-3 cleanup). Normalizing a directory is real cryptographic work per
 * key; without a cache, a resolver returning the raw document paid that
 * cost again on EVERY verify (~215 ms per request for a 10,000-key
 * document vs ~0.2 ms for a pre-parsed one). Strings are keyed by exact
 * content, objects by identity. Deliberately NOT keyed by a content hash
 * for fresh objects: hashing requires serializing (same order as a plain
 * JSON.parse), and with MAX_DIRECTORY_KEYS bounding one parse to a few
 * milliseconds, a hash cache would be complexity without payoff - a
 * resolver that fabricates a brand-new object per call simply pays the
 * bounded parse each time.
 */
interface DirectoryParseCache {
  byString: Map<string, ParsedWebBotAuthDirectory>;
  byObject: WeakMap<object, ParsedWebBotAuthDirectory>;
}

const MAX_CACHED_DIRECTORY_STRINGS = 8;

function parseDirectoryCached(
  document: unknown,
  cache: DirectoryParseCache | undefined,
): ParsedWebBotAuthDirectory {
  if (!cache) return parseWebBotAuthDirectory(document);
  if (typeof document === "string") {
    const hit = cache.byString.get(document);
    if (hit) return hit;
    const parsedDir = parseWebBotAuthDirectory(document);
    if (cache.byString.size >= MAX_CACHED_DIRECTORY_STRINGS) {
      const oldest = cache.byString.keys().next().value;
      if (oldest !== undefined) cache.byString.delete(oldest);
    }
    cache.byString.set(document, parsedDir);
    return parsedDir;
  }
  if (typeof document === "object" && document !== null) {
    const hit = cache.byObject.get(document);
    if (hit) return hit;
    const parsedDir = parseWebBotAuthDirectory(document);
    cache.byObject.set(document, parsedDir);
    return parsedDir;
  }
  return parseWebBotAuthDirectory(document);
}

function lookupInSource(
  source: WebBotAuthKeySource,
  keyId: string,
  directoryCache?: DirectoryParseCache,
): WebBotAuthKeyEntry | undefined {
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return parseDirectoryCached(trimmed, directoryCache).keys.get(keyId);
    }
  }
  if (isParsedDirectory(source)) return source.keys.get(keyId);
  if (source instanceof Map) {
    const value = source.get(keyId);
    return value === undefined ? undefined : entryFromSourceValue(value);
  }
  if (Array.isArray(source) || looksLikeDirectoryDocument(source) || isJwkLike(source)) {
    return parseDirectoryCached(source, directoryCache).keys.get(keyId);
  }
  if (typeof source === "object" && source !== null) {
    const record = source as Record<string, WebBotAuthKeyInput>;
    const direct = record[keyId];
    if (direct !== undefined) return entryFromSourceValue(direct);
    // A resolver returning a bare JWK means "this is the key" - but only
    // accept it when it actually is the requested key.
    if (isJwkLike(record)) {
      const entry = normalizeKeyInput(record);
      return entry && entry.keyId === keyId ? entry : undefined;
    }
    return undefined;
  }
  const entry = normalizeKeyInput(source as WebBotAuthKeyInput);
  return entry && entry.keyId === keyId ? entry : undefined;
}

/* ------------------------------------------------------------------------ */
/* RFC 9421 signature-base reconstruction.                                  */
/* ------------------------------------------------------------------------ */

function parseRequestUrl(req: WebBotAuthRequestLike): URL | undefined {
  try {
    return new URL(req.url);
  } catch {
    return undefined;
  }
}

function resolveAuthority(req: WebBotAuthRequestLike, url: URL | undefined): string | undefined {
  if (req.authority) return req.authority.toLowerCase();
  const host = getHeader(req, "host");
  if (host) return host.trim().toLowerCase();
  return url?.host ? url.host.toLowerCase() : undefined;
}

function deriveComponentValue(
  req: WebBotAuthRequestLike,
  url: URL | undefined,
  component: SfItem,
): string | undefined {
  if (component.value.kind !== "string") return undefined;
  const name = String(component.value.value).toLowerCase();
  const params = component.params;
  const hasParam = (n: string) => findParam(params, n) !== undefined;
  if (hasParam("req")) return undefined; // request-of-response signing is out of scope

  if (!name.startsWith("@")) {
    // Header field.
    if (hasParam("sf")) return undefined; // strict re-serialization not implemented; fail closed
    const rawValues = getHeaderValues(req, name);
    if (rawValues.length === 0) return undefined;
    const keyParam = paramAsString(params, "key");
    if (keyParam !== undefined) {
      let members: Map<string, SfMember>;
      try {
        members = parseSfDictionary(rawValues.join(", "));
      } catch {
        return undefined;
      }
      const member = members.get(keyParam);
      if (!member) return undefined;
      return member.raw;
    }
    const joined = rawValues.join(", ");
    if (hasParam("bs")) {
      return `:${standardBase64Encode(utf8(joined.trim()))}:`;
    }
    return joined.trim();
  }

  switch (name) {
    case "@method":
      return req.method ?? "GET";
    case "@authority":
      return resolveAuthority(req, url);
    case "@target-uri": {
      if (req.targetUri) return req.targetUri;
      if (url) return url.href.replace(/#.*$/, "");
      const authority = resolveAuthority(req, url);
      if (!authority) return undefined;
      const scheme = req.scheme ?? "https";
      const target = req.url.startsWith("/") ? req.url : `/${req.url}`;
      return `${scheme}://${authority}${target}`;
    }
    case "@scheme":
      return url ? url.protocol.replace(/:$/, "").toLowerCase() : (req.scheme ?? "https").toLowerCase();
    case "@request-target": {
      if (url) return `${url.pathname || "/"}${url.search}`;
      return req.url.split("#", 1)[0] || "/";
    }
    case "@path": {
      if (url) return url.pathname || "/";
      const path = (req.url.split("?", 1)[0] ?? "").split("#", 1)[0] ?? "";
      return path === "" ? "/" : path;
    }
    case "@query": {
      if (url) return url.search === "" ? "?" : url.search;
      const idx = req.url.indexOf("?");
      return idx < 0 ? "?" : req.url.slice(idx).split("#", 1)[0]!;
    }
    case "@query-param": {
      const paramName = paramAsString(params, "name");
      if (paramName === undefined || !url) return undefined;
      for (const [rawName, rawValue] of url.searchParams) {
        if (rawName === paramName) return rawValue;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function standardBase64Encode(bytes: Uint8Array): string {
  // RFC 9421 `;bs` uses standard base64 of the raw field bytes.
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x4000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  return btoa(bin);
}

/* ------------------------------------------------------------------------ */
/* The verifier.                                                            */
/* ------------------------------------------------------------------------ */

interface ParsedSignature {
  label: string;
  components: SfItem[];
  /** Raw `@signature-params` value (inner list + params, as sent). */
  signatureParamsRaw: string;
  params: SfParam[];
  signatureBytes?: Uint8Array;
}

export function createWebBotAuthVerifier(options: WebBotAuthVerifierOptions = {}): WebBotAuthVerifier {
  const staticIndex = buildStaticIndex(options.keys);
  const maxValiditySeconds = Math.max(1, Math.floor(options.maxValiditySeconds ?? 86_400) || 86_400);
  const clockSkewSeconds = Math.max(0, Math.floor(options.clockSkewSeconds ?? 60) || 0);
  const requireNonce = options.requireNonce ?? false;
  const nonceStore = options.nonceStore ?? createInMemoryNonceStore(options.maxNonces ?? 10_000);
  const clock = options.now ?? (() => Date.now());
  // NV-3: resolver documents are parsed once per document version, not
  // once per request (see DirectoryParseCache). Instance-scoped on
  // purpose: no parse state is shared across verifiers.
  const directoryCache: DirectoryParseCache = { byString: new Map(), byObject: new WeakMap() };

  const emit = async (verdict: WebBotAuthVerdict): Promise<WebBotAuthVerdict> => {
    if (options.onVerdict) {
      try {
        await options.onVerdict(verdict);
      } catch {
        /* Operator logging must never break request handling. */
      }
    }
    return verdict;
  };

  const resolveKey = async (
    ctx: WebBotAuthKeyResolverContext,
  ): Promise<{ entry?: WebBotAuthKeyEntry; resolverFailed?: boolean }> => {
    const local = staticIndex.get(ctx.keyId);
    if (local) return { entry: local };
    if (!options.resolveKey) return {};
    let resolved: WebBotAuthKeySource | undefined;
    try {
      resolved = await options.resolveKey(ctx);
    } catch {
      return { resolverFailed: true };
    }
    if (resolved === undefined || resolved === null) return {};
    try {
      return { entry: lookupInSource(resolved, ctx.keyId, directoryCache) };
    } catch {
      return { resolverFailed: true };
    }
  };

  const evaluateLabel = async (
    req: WebBotAuthRequestLike,
    url: URL | undefined,
    agentMembers: Map<string, SfMember> | undefined,
    legacyAgent: string | undefined,
    signature: ParsedSignature,
    nowMs: number,
  ): Promise<WebBotAuthVerdict> => {
    const agentForm: "dictionary" | "legacy" = legacyAgent !== undefined ? "legacy" : "dictionary";
    const fail = (reason: WebBotAuthFailureReason, detail: string, extra?: Partial<WebBotAuthVerdict>): WebBotAuthVerdict => ({
      verified: false,
      reason,
      detail,
      label: signature.label,
      agentForm,
      ...extra,
    });
    const params = signature.params;

    // --- Signature parameters (draft profile requirements) ----------------
    const keyId = paramAsString(params, "keyid");
    if (!keyId) return fail("missing_parameter", "signature parameters lack a string `keyid`");
    const tag = paramAsString(params, "tag");
    if (tag === undefined) return fail("missing_parameter", "signature parameters lack `tag`", { keyId });
    if (tag !== WEB_BOT_AUTH_TAG) {
      return fail("wrong_tag", `\`tag\` is ${JSON.stringify(tag)}, not ${JSON.stringify(WEB_BOT_AUTH_TAG)}`, { keyId });
    }
    const alg = paramAsString(params, "alg");
    if (alg !== undefined && alg.toLowerCase() !== "ed25519") {
      return fail("unsupported_algorithm", `\`alg\` is ${JSON.stringify(alg)}; only ed25519 is supported`, { keyId });
    }
    const created = paramAsInteger(params, "created");
    if (created === undefined) return fail("missing_parameter", "signature parameters lack an integer `created`", { keyId });
    const expires = paramAsInteger(params, "expires");
    if (expires === undefined) return fail("missing_parameter", "signature parameters lack an integer `expires`", { keyId });
    const nonce = paramAsString(params, "nonce");
    if (requireNonce && nonce === undefined) {
      return fail("missing_parameter", "signature parameters lack a `nonce` (required by verifier configuration)", { keyId });
    }
    if (nonce !== undefined && nonce.length > MAX_NONCE_LENGTH) {
      return fail("nonce_too_long", `signature \`nonce\` is ${nonce.length} characters; the cap is ${MAX_NONCE_LENGTH}`, { keyId });
    }
    if (!signature.signatureBytes) {
      return fail("malformed_headers", `Signature header has no byte-sequence member for label ${JSON.stringify(signature.label)}`, { keyId });
    }

    // --- Strictness: component list and validity window ---------------------
    // RFC 9421 §2.5 forbids duplicate component identifiers in the covered
    // components list; a signer that repeats one is non-conformant even when
    // the signature itself verifies over the duplicated base.
    const seenComponents = new Set<string>();
    for (const component of signature.components) {
      const identifier = serializeComponentIdentifierSafe(component);
      if (seenComponents.has(identifier)) {
        return fail(
          "duplicate_covered_components",
          `covered components repeat ${identifier}, forbidden by RFC 9421 §2.5`,
          { keyId, expiresAt: expires },
        );
      }
      seenComponents.add(identifier);
    }
    if (expires <= created) {
      return fail(
        "invalid_validity_window",
        `\`expires\` ${expires} is not after \`created\` ${created}`,
        { keyId, expiresAt: expires },
      );
    }

    // --- Timing ------------------------------------------------------------
    const nowSec = Math.floor(nowMs / 1000);
    if (nowSec > expires + clockSkewSeconds) {
      return fail("expired", `signature expired at ${expires} (now ${nowSec})`, { keyId, expiresAt: expires });
    }
    if (created > nowSec + clockSkewSeconds) {
      return fail("not_yet_valid", `signature \`created\` ${created} is in the future (now ${nowSec})`, { keyId, expiresAt: expires });
    }
    if (expires - created > maxValiditySeconds) {
      return fail(
        "validity_window_too_long",
        `validity window ${expires - created}s exceeds the configured maximum of ${maxValiditySeconds}s`,
        { keyId, expiresAt: expires },
      );
    }

    // --- Coverage (draft: @authority or @target-uri, plus signature-agent) --
    let coversAuthorityOrTarget = false;
    let agentComponent: SfItem | undefined;
    for (const component of signature.components) {
      if (component.value.kind !== "string") continue;
      const name = String(component.value.value).toLowerCase();
      if (name === "@authority" || name === "@target-uri") coversAuthorityOrTarget = true;
      if (name === "signature-agent") agentComponent = component;
    }
    if (!coversAuthorityOrTarget) {
      return fail("insufficient_coverage", "covered components include neither `@authority` nor `@target-uri`", { keyId, expiresAt: expires });
    }
    if (!agentComponent) {
      return fail("insufficient_coverage", "covered components do not include the `signature-agent` field", { keyId, expiresAt: expires });
    }

    // --- Agent identity (bound by the signature via the covered component) --
    let agent: string | undefined;
    const agentKeyParam = paramAsString(agentComponent.params, "key");
    if (legacyAgent !== undefined) {
      // Legacy bare-string form: the whole field value IS the agent, bound
      // by the whole-field covered component. A `;key` component selects a
      // dictionary member and cannot be satisfied by a header that has no
      // members - fail closed rather than guess a binding.
      if (agentKeyParam !== undefined) {
        return fail(
          "malformed_headers",
          "covered component selects a Signature-Agent dictionary member (`;key`) but the header uses the legacy bare-string form, which has no members",
          { keyId, expiresAt: expires },
        );
      }
      agent = legacyAgent;
    } else if (agentMembers) {
      if (agentKeyParam !== undefined) {
        const member = agentMembers.get(agentKeyParam);
        if (member?.item && member.item.value.kind === "string") agent = String(member.item.value.value);
      } else if (agentMembers.size === 1) {
        const only = agentMembers.values().next().value as SfMember | undefined;
        if (only?.item && only.item.value.kind === "string") agent = String(only.item.value.value);
      }
    }
    if (agent === undefined) {
      // Fall back to the derived field value itself: when the whole
      // `signature-agent` field is covered, its value is the dictionary -
      // accept it as the agent only when it unambiguously names one member.
      const derived = deriveComponentValue(req, url, agentComponent);
      if (derived) {
        try {
          const members = parseSfDictionary(derived);
          if (members.size === 1) {
            const only = members.values().next().value as SfMember | undefined;
            if (only?.item && only.item.value.kind === "string") agent = String(only.item.value.value);
          }
        } catch {
          /* not a dictionary serialization; agent stays undetermined */
        }
      }
    }

    // --- Signature base reconstruction --------------------------------------
    const lines: string[] = [];
    for (const component of signature.components) {
      const value = deriveComponentValue(req, url, component);
      if (value === undefined) {
        return fail(
          "invalid_signature",
          `cannot derive covered component ${serializeComponentIdentifierSafe(component)} from this request`,
          { keyId, ...(agent ? { agent } : {}), expiresAt: expires },
        );
      }
      lines.push(`${serializeComponentIdentifierSafe(component)}: ${value}`);
    }
    lines.push(`"@signature-params": ${signature.signatureParamsRaw}`);
    const signatureBase = lines.join("\n");

    // --- Key resolution -------------------------------------------------------
    const { entry, resolverFailed } = await resolveKey({ ...(agent ? { agent } : {}), keyId, request: req });
    if (resolverFailed) {
      return fail("key_resolution_failed", "the injected key resolver threw", { keyId, ...(agent ? { agent } : {}), expiresAt: expires });
    }
    if (!entry) {
      return fail("unknown_key", `no key resolved for keyid ${JSON.stringify(keyId)}`, { keyId, ...(agent ? { agent } : {}), expiresAt: expires });
    }
    const nowSecForKey = nowSec;
    if (entry.notBefore !== undefined && nowSecForKey + clockSkewSeconds < entry.notBefore) {
      return fail("unknown_key", "resolved key is not yet valid (nbf)", { keyId, ...(agent ? { agent } : {}), expiresAt: expires });
    }
    if (entry.expiresAt !== undefined && nowSecForKey - clockSkewSeconds > entry.expiresAt) {
      return fail("unknown_key", "resolved key has expired (exp)", { keyId, ...(agent ? { agent } : {}), expiresAt: expires });
    }

    // --- Cryptographic verification ------------------------------------------
    let ok = false;
    try {
      ok = getNodeCrypto().verify(null, utf8(signatureBase), entry.publicKey, signature.signatureBytes);
    } catch {
      ok = false;
    }
    if (!ok) {
      return fail("invalid_signature", "Ed25519 verification failed", { keyId, ...(agent ? { agent } : {}), expiresAt: expires });
    }

    // --- Replay guard (only meaningful with a nonce) --------------------------
    if (nonce !== undefined) {
      const scopeKey = `${keyId}\n${nonce}`;
      const fresh = await nonceStore.checkAndRecord(scopeKey, (expires + clockSkewSeconds) * 1000, nowMs);
      if (!fresh) {
        return fail("replay_detected", "nonce was already used with this key", { keyId, ...(agent ? { agent } : {}), expiresAt: expires });
      }
    }

    return {
      verified: true,
      ...(agent ? { agent } : {}),
      agentForm,
      keyId,
      label: signature.label,
      expiresAt: expires,
    };
  };

  const verify = async (req: WebBotAuthRequestLike): Promise<WebBotAuthVerdict> => {
    const nowMs = clock();
    const inputHeader = getHeader(req, "signature-input");
    const signatureHeader = getHeader(req, "signature");
    if (!inputHeader || !signatureHeader) {
      return emit({ verified: false, reason: "no_signature_headers", detail: "request carries no Signature/Signature-Input headers" });
    }
    const agentHeader = getHeader(req, "signature-agent");
    if (!agentHeader) {
      return emit({ verified: false, reason: "no_signature_agent", detail: "request carries no Signature-Agent header" });
    }

    let inputMembers: Map<string, SfMember>;
    let signatureMembers: Map<string, SfMember>;
    let agentMembers: Map<string, SfMember> | undefined;
    let legacyAgent: string | undefined;
    try {
      inputMembers = parseSfDictionary(inputHeader);
      signatureMembers = parseSfDictionary(signatureHeader);
    } catch (err) {
      return emit({
        verified: false,
        reason: "malformed_headers",
        detail: `structured-fields parse failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      agentMembers = parseSfDictionary(agentHeader);
    } catch (err) {
      // Not a dictionary: fall back to the legacy bare-string form (the
      // dual-form acceptance described in the module header). A header
      // that is neither form stays `malformed_headers`, exactly as before.
      legacyAgent = parseLegacySignatureAgent(agentHeader);
      if (legacyAgent === undefined) {
        return emit({
          verified: false,
          reason: "malformed_headers",
          detail: `structured-fields parse failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    if (agentMembers !== undefined && agentMembers.size === 0) {
      return emit({ verified: false, reason: "no_signature_agent", detail: "Signature-Agent header carries no members" });
    }

    const url = parseRequestUrl(req);
    const parsed: ParsedSignature[] = [];
    for (const [label, member] of inputMembers) {
      if (member.kind !== "inner-list" || !member.list) continue;
      const signatureMember = signatureMembers.get(label);
      const signatureBytes =
        signatureMember?.kind === "item" && signatureMember.item?.value.kind === "bytes"
          ? (signatureMember.item.value.value as Uint8Array)
          : undefined;
      parsed.push({
        label,
        components: member.list.items,
        signatureParamsRaw: member.list.raw,
        params: member.list.params,
        ...(signatureBytes ? { signatureBytes } : {}),
      });
    }
    if (parsed.length === 0) {
      return emit({ verified: false, reason: "malformed_headers", detail: "Signature-Input carries no usable signature labels" });
    }

    if (legacyAgent !== undefined) {
      // Fail-closed binding guardrail for the legacy form: the bare string
      // is bound implicitly to the covering signature, which is only
      // unambiguous when exactly one signature covers the field. With
      // several covering signatures, keep rejecting instead of guessing.
      const coveringCount = parsed.filter(p =>
        p.components.some(
          c => c.value.kind === "string" && String(c.value.value).toLowerCase() === "signature-agent",
        ),
      ).length;
      if (coveringCount > 1) {
        return emit({
          verified: false,
          reason: "malformed_headers",
          agentForm: "legacy",
          detail: `legacy bare-string Signature-Agent cannot be bound unambiguously: ${coveringCount} signatures cover the signature-agent field`,
        });
      }
    }

    // Evaluate Web Bot Auth candidates first (tag present and correct), then
    // fall back to the first label so the failure reason stays precise.
    const candidates = parsed.filter(p => paramAsString(p.params, "tag") === WEB_BOT_AUTH_TAG);
    const ordered = candidates.length ? candidates : parsed.slice(0, 1);
    let firstFailure: WebBotAuthVerdict | undefined;
    for (const signature of ordered) {
      const verdict = await evaluateLabel(req, url, agentMembers, legacyAgent, signature, nowMs);
      if (verdict.verified) return emit(verdict);
      firstFailure ??= verdict;
    }
    return emit(
      firstFailure ?? { verified: false, reason: "invalid_signature", detail: "no signature label could be evaluated" },
    );
  };

  return { verify };
}

function serializeComponentIdentifierSafe(item: SfItem): string {
  try {
    return serializeComponentIdentifier(item);
  } catch {
    return '"<invalid>"';
  }
}
