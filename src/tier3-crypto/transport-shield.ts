/**
 * Authenticated payload envelopes for server-controlled boundaries.
 * IMPORTANT: If the decrypting key is accessible to the browser, a person controlling the browser
 * can recover it and plaintext; this is NOT anti-reverse-engineering protection.
 * HTTPS/TLS remains mandatory. Do not put raw global keys in frontend bundles.
 */
export interface EncryptedEnvelope {
  version: 1;
  iv: string;
  payload: string;
  ts: number;
  nonce: string;
}

export interface EnvelopeContext {
  /** Bind to the intended operation and authenticated session, never to client-provided identity. */
  purpose: string;
  method: string;
  path: string;
  sessionBinding: string;
}

export interface OpenEnvelopeOptions {
  maxSkewMs?: number;
  /** Atomic shared-store insertion: return false when key has already been seen. Required. */
  markNonceOnce: (key: string, ttlMs: number) => Promise<boolean> | boolean;
  now?: number;
}

export interface ReplayGuardOptions {
  /** Default TTL in ms when caller does not supply one (default: 300_000 = 5 minutes). */
  ttlMs?: number;
  /** Maximum cached nonces in memory before evicting oldest entries (default: 10_000). */
  maxEntries?: number;
}

declare const require: ((id: string) => { webcrypto?: Crypto }) | undefined;

function getWebCrypto(): Crypto {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
    return globalThis.crypto;
  }
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto?.webcrypto) return nodeCrypto.webcrypto;
    } catch {
      // Non-Node environment
    }
  }
  throw new Error("Web Crypto API is not available in this runtime");
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function base64url(bytes: Uint8Array): string {
  const slices: string[] = [];
  const STEP = 0x4000;
  for (let i = 0; i < bytes.length; i += STEP) slices.push(String.fromCharCode(...bytes.subarray(i, i + STEP)));
  return btoa(slices.join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unbase64url(s: string, maxLen: number): Uint8Array<ArrayBuffer> {
  if (s.length > maxLen || !/^[\w-]+$/.test(s)) throw new TypeError("Malformed envelope encoding");
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}

function aad(ts: number, nonce: string, ctx: EnvelopeContext): Uint8Array<ArrayBuffer> {
  // Canonical JSON array makes delimiter injection impossible.
  return utf8(JSON.stringify([1, ts, nonce, ctx.purpose, ctx.method.toUpperCase(), ctx.path, ctx.sessionBinding]));
}

function checkContext(ctx: EnvelopeContext) {
  if (!ctx.purpose || !ctx.method || !ctx.path.startsWith("/") || !ctx.sessionBinding)
    throw new TypeError("Provide purpose, method, absolute path, and trusted sessionBinding");
}

/** Generate a nonextractable AES-GCM key for server/session use. Persist/rotate securely as appropriate. */
export async function createEnvelopeKey(): Promise<CryptoKey> {
  const webcrypto = getWebCrypto();
  return webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptPayload<T>(data: T, key: CryptoKey, ctx: EnvelopeContext): Promise<EncryptedEnvelope> {
  checkContext(ctx);
  const webcrypto = getWebCrypto();
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const nonce = base64url(webcrypto.getRandomValues(new Uint8Array(16)));
  const ts = Date.now();
  const plain = utf8(JSON.stringify(data));
  if (plain.byteLength > 1024 * 1024) throw new RangeError("Maximum payload size is 1 MiB");
  const cipher = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(ts, nonce, ctx) }, key, plain);
  return { version: 1, iv: base64url(iv), payload: base64url(new Uint8Array(cipher)), ts, nonce };
}

export async function decryptPayload<T>(env: EncryptedEnvelope, key: CryptoKey, ctx: EnvelopeContext, opts: OpenEnvelopeOptions): Promise<T> {
  checkContext(ctx);
  const webcrypto = getWebCrypto();
  if (env.version !== 1 || !Number.isSafeInteger(env.ts) || typeof env.nonce !== "string" || !opts?.markNonceOnce)
    throw new TypeError("Invalid envelope or replay guard missing");
  const skew = opts.maxSkewMs ?? 15000;
  if (!Number.isFinite(skew) || skew <= 0 || skew > 300000) throw new RangeError("Invalid skew");
  if (Math.abs((opts.now ?? Date.now()) - env.ts) > skew) throw new Error("Envelope expired");
  const iv = unbase64url(env.iv, 32);
  if (iv.byteLength !== 12) throw new TypeError("Invalid AES-GCM IV");
  const ciphertext = unbase64url(env.payload, 1_500_000);
  const nonceBytes = unbase64url(env.nonce, 32);
  if (nonceBytes.byteLength !== 16) throw new TypeError("Invalid nonce");
  // Authentication happens before any replay store mutation.
  const plain = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(env.ts, env.nonce, ctx) }, key, ciphertext);
  if (plain.byteLength > 1024 * 1024) throw new RangeError("Maximum payload size is 1 MiB");
  const replayKey = `${ctx.sessionBinding}:${ctx.purpose}:${env.nonce}`;
  const first = await opts.markNonceOnce(replayKey, skew * 2);
  if (!first) throw new Error("Replay detected");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)) as T;
}

export const createTransportEnvelope = encryptPayload;
export const verifyTransportEnvelope = decryptPayload;

/**
 * Bounded in-memory replay guard for single-process deployments.
 * Automatically purges expired nonces by TTL and caps total entries via `maxEntries`
 * to prevent unbounded memory growth. Use Redis `SET ... NX PX` in distributed clusters.
 */
export function createInMemoryReplayGuard(options: ReplayGuardOptions = {}): OpenEnvelopeOptions["markNonceOnce"] {
  const defaultTtlMs = Math.max(1000, options.ttlMs ?? 300_000);
  const maxEntries = Math.max(100, options.maxEntries ?? 10_000);
  const seen = new Map<string, number>();
  return (key, ttlMs) => {
    const now = Date.now();
    const effectiveTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : defaultTtlMs;
    for (const [k, expiry] of seen) {
      if (expiry <= now) seen.delete(k);
    }
    if ((seen.get(key) ?? 0) > now) return false;
    while (seen.size >= maxEntries) {
      const oldestKey = seen.keys().next().value;
      if (oldestKey === undefined) break;
      seen.delete(oldestKey);
    }
    seen.set(key, now + effectiveTtl);
    return true;
  };
}
