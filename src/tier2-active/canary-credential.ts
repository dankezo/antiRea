/**
 * Honey-credential injection (ABG-03, Step-0 PASS-LAB, seed
 * 20321203) - port of tarrinho/AntiBotGW detection/honey_cred.py
 * (`_make_honey_key` / `lookup_honey_key` / `inject_honey_creds`) and
 * core/proxy_handler.py `honey_probe_endpoint`.
 *
 * WHAT IT MEASURES. The host plants a fake API key in an identity's
 * HTML (see `honeyCredentialSnippet`). The key is
 * HMAC-SHA256(secret, "hc|identity|hour-bucket")[:32] (hex), stored
 * server-side against its OWNER with a 2 h TTL (7,200 s; store cap
 * 4,096 entries, expired entries evicted first at capacity). When
 * any client later presents the key to the probe endpoint, the
 * endpoint answers a bland 200 either way; the signal is who the
 * risk lands on.
 *
 * BINDING BUILD REQUIREMENTS (from the lab, structural here):
 *
 * 1. OWNER AND PRESENTER ARE SEPARATED. The flag lands on the key
 *    OWNER, never on the presenter: `presentKey` returns both
 *    `keyOwner` and `presenterIdentity` as distinct fields, and
 *    `flaggedOwner` is always the owner. A presenter presenting
 *    someone else's key after the owner was already flagged still
 *    lands the risk on the owner (lab control (c), record-only arm).
 *
 * 2. THE CURIOSITY GUARD IS COOKIE-BASED, NOT OWNERSHIP-BASED. The
 *    only exemption is a valid challenge ("chal") cookie bound to
 *    the presenter's (userAgent, ipTier, ja4) triple, minted by the
 *    host's natural page flow (`mintCuriosityCookie`). Ownership
 *    confers NO exemption: the owner presenting its own key WITHOUT
 *    the cookie DOES flag (lab descriptive arm B2, measured). Hosts
 *    must not "fix" this by exempting owners - that would change
 *    the measured semantics; the natural browser flow carries the
 *    cookie, which is what keeps the honest owner safe.
 *
 * 3. EXPIRED KEYS NEVER FLAG. A key presented after its 2 h TTL
 *    resolves to nothing, exactly like a random never-issued key.
 *
 * The source's hard consequence (a ban on the owner) is NOT ported:
 * this module only reports the flag. ADVISORY / opt-in canary
 * feature: every result carries enforcement: "none", the endpoint
 * status is always 200, and nothing runs until the host issues keys
 * and feeds presentations. Node.js builtins only (node:crypto).
 */

/** Key time-to-live in ms (source TTL 7,200 s = 2 h). */
export const HONEY_CREDENTIAL_TTL_MS = 7_200_000;
/** Store capacity in entries (source store cap 4,096). */
export const HONEY_CREDENTIAL_STORE_MAX = 4_096;

interface NodeHmacLike {
  update(data: string | Uint8Array): NodeHmacLike;
  digest(encoding: string): string;
}

interface NodeCryptoLike {
  createHmac(algorithm: string, key: string | Uint8Array): NodeHmacLike;
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare const require: ((id: string) => NodeCryptoLike) | undefined;

function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.createHmac === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; honey credentials require Node.js");
}

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): a planted honey credential was presented. The flag " +
  "lands on the key OWNER, not the presenter; owner and presenter are reported separately. The " +
  "curiosity guard is cookie-based, not ownership-based: the owner without a valid challenge " +
  "cookie DOES flag. Expired keys (2 h TTL) and never-issued keys never flag. The probe endpoint " +
  "answers a bland 200 either way. Never a sole blocking key.";

/** The presenter context a challenge cookie is bound to. */
export interface HoneyPresenterContext {
  userAgent: string;
  ipTier: string;
  ja4: string;
  /** The presented challenge cookie value, when the presenter carries one. */
  cookie?: string;
}

export interface HoneyPresentation {
  /** The presented key string. */
  key: string;
  /** The identity presenting the key. Kept separate from the key owner in every result. */
  presenterIdentity: string;
  /** The presenter's cookie-binding context (userAgent / ipTier / ja4 / cookie). */
  presenter: HoneyPresenterContext;
  /** Presentation time, ms since epoch. Defaults to Date.now(). */
  nowMs?: number;
}

export type HoneyPresentationReason =
  | "flagged_owner"
  | "curiosity_cookie"
  | "unknown_key"
  | "expired_key";

export interface HoneyPresentationResult {
  kind: "canary_credential";
  /** The probe endpoint status: always a bland 200, flagged or not. */
  status: 200;
  /** True when the presentation flags (risk lands on the key owner). */
  flagged: boolean;
  /** The identity the key was issued FOR. Null when the key resolves to no owner. */
  keyOwner: string | null;
  /** The identity that presented the key. Always reported separately from `keyOwner`. */
  presenterIdentity: string;
  /** The flagged identity when flagged: always the key owner, never the presenter. Null otherwise. */
  flaggedOwner: string | null;
  reason: HoneyPresentationReason;
  /** Always "none": this module reports the flag; it bans nobody. */
  enforcement: "none";
  notice: string;
}

export interface HoneyCredentialAuthorityOptions {
  /** Key TTL in ms. Defaults to 7,200,000 (2 h, source constant). */
  ttlMs?: number;
  /** Store capacity. Defaults to 4,096 (source constant). */
  storeMax?: number;
}

export interface HoneyCredentialAuthority {
  /** Issue (and store) the honey key for `ownerIdentity` at `nowMs`. Deterministic per hour bucket. */
  issueKey(ownerIdentity: string, nowMs?: number): string;
  /** An HTML snippet planting the owner's honey key as a fake API key (inert, names no real credential). */
  honeyCredentialSnippet(ownerIdentity: string, nowMs?: number): string;
  /**
   * Mint the curiosity-guard challenge cookie for a presenter
   * context. The host mints this in its natural page flow; a
   * presenter carrying the cookie matching its own context is
   * exempt from flagging.
   */
  mintCuriosityCookie(presenter: HoneyPresenterContext): string;
  /** Feed one key presentation to the probe endpoint model. Always status 200. */
  presentKey(presentation: HoneyPresentation): HoneyPresentationResult;
  /** Number of keys currently stored. */
  storedKeys(): number;
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function createHoneyCredentialAuthority(
  secret: string | Uint8Array,
  options: HoneyCredentialAuthorityOptions = {},
): HoneyCredentialAuthority {
  if ((typeof secret !== "string" && !(secret instanceof Uint8Array)) || (typeof secret === "string" && secret.length === 0)) {
    throw new Error("createHoneyCredentialAuthority: a non-empty secret is required");
  }
  const ttlMs = options.ttlMs ?? HONEY_CREDENTIAL_TTL_MS;
  const storeMax = options.storeMax ?? HONEY_CREDENTIAL_STORE_MAX;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("createHoneyCredentialAuthority: ttlMs must be a positive finite number");
  if (!Number.isInteger(storeMax) || storeMax < 1) throw new Error("createHoneyCredentialAuthority: storeMax must be a positive integer");

  const hmacHex = (data: string): string => getNodeCrypto().createHmac("sha256", secret).update(data).digest("hex");

  interface StoredKey {
    owner: string;
    expiresAtMs: number;
  }
  const store = new Map<string, StoredKey>();

  function makeKey(ownerIdentity: string, nowMs: number): string {
    const bucket = Math.floor(nowMs / 3_600_000);
    return hmacHex(`hc|${ownerIdentity}|${bucket}`).slice(0, 32);
  }

  function lookup(key: string, nowMs: number): { owner: string; expired: boolean } | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (nowMs > entry.expiresAtMs) {
      store.delete(key);
      return { owner: entry.owner, expired: true };
    }
    return { owner: entry.owner, expired: false };
  }

  function cookieFor(p: HoneyPresenterContext): string {
    return hmacHex(`chal|${p.userAgent}|${p.ipTier}|${p.ja4}`).slice(0, 32);
  }

  function hasValidCookie(p: HoneyPresenterContext): boolean {
    if (!p.cookie) return false;
    const expected = cookieFor(p);
    if (p.cookie.length !== expected.length) return false;
    const a = new TextEncoder().encode(p.cookie);
    const b = new TextEncoder().encode(expected);
    return getNodeCrypto().timingSafeEqual(a, b);
  }

  return {
    issueKey(ownerIdentity, nowMs = Date.now()) {
      if (typeof ownerIdentity !== "string" || ownerIdentity.length === 0) {
        throw new Error("issueKey: ownerIdentity must be a non-empty string");
      }
      const key = makeKey(ownerIdentity, nowMs);
      if (store.size >= storeMax) {
        for (const [k, v] of store) if (nowMs > v.expiresAtMs) store.delete(k);
      }
      store.set(key, { owner: ownerIdentity, expiresAtMs: nowMs + ttlMs });
      return key;
    },
    honeyCredentialSnippet(ownerIdentity, nowMs = Date.now()) {
      const key = this.issueKey(ownerIdentity, nowMs);
      return `<script type="application/json" data-antirea-honey-credential>{"apiKey":"${escapeHtml(key)}"}</script>`;
    },
    mintCuriosityCookie(presenter) {
      return cookieFor(presenter);
    },
    presentKey(presentation) {
      const nowMs = presentation.nowMs ?? Date.now();
      const base = {
        kind: "canary_credential" as const,
        status: 200 as const,
        presenterIdentity: presentation.presenterIdentity,
        enforcement: "none" as const,
        notice: ADVISORY_NOTICE,
      };
      const key = presentation.key;
      if (!key || key.length > 64) {
        return { ...base, flagged: false, keyOwner: null, flaggedOwner: null, reason: "unknown_key" as const };
      }
      const found = lookup(key, nowMs);
      if (!found) {
        return { ...base, flagged: false, keyOwner: null, flaggedOwner: null, reason: "unknown_key" as const };
      }
      if (found.expired) {
        return { ...base, flagged: false, keyOwner: null, flaggedOwner: null, reason: "expired_key" as const };
      }
      if (hasValidCookie(presentation.presenter)) {
        return { ...base, flagged: false, keyOwner: found.owner, flaggedOwner: null, reason: "curiosity_cookie" as const };
      }
      // Risk lands on the KEY OWNER, never on the presenter.
      return { ...base, flagged: true, keyOwner: found.owner, flaggedOwner: found.owner, reason: "flagged_owner" as const };
    },
    storedKeys() {
      return store.size;
    },
  };
}
