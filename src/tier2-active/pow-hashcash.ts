/**
 * PoW hashcash challenge with signed cookie (NHS-09, antiRea 3.1.0)
 * - the upgraded form: the lab's measured replay hole is CLOSED.
 *
 * THE LAB FORM AND ITS HOLE. The NHS Step-0 port of sentinel_pow.c
 * (nhs-lab/nhs09.cjs, RESULTS-NHS-STEP0.md) measured: real solves at
 * difficulty 16 pass and receive a signed cookie; bad nonce, forged
 * cookie and expired cookie all re-challenge (present-but-invalid
 * cookies fail CLOSED); a bare request is challenged; the issued
 * cookie bypasses; disabled PoW passes (fail-open); challenges
 * differ across IP and across time bucket. It also measured,
 * descriptively, that REPLAY IS OPEN: the same nonce verifies again
 * in the same bucket, because the source has no single-use store.
 *
 * THE UPGRADE (the condition this build ships under). Solution
 * verification now consumes a single-use key - ip + bucket + nonce -
 * through a nonce-consume hook that follows the shipped CAP-01
 * host-side nonce hook spec (step-up-proof.ts): the hook is called
 * exactly once per verification attempt that has PASSED the
 * difficulty check, never earlier (a failing nonce never burns
 * anything), and a consumed key can never verify again. Hosts may
 * supply their own atomic consumeNonce (e.g. Redis SET NX); the
 * default is a bounded in-memory store. The shipped tests prove the
 * lab's exact fixture nonces pass once and that replaying either
 * one in the same bucket now FAILS.
 *
 * SHAPE (unchanged from the lab form):
 *   challenge = hex(HMAC-SHA256(secret, ipBytes || ascii(bucket))),
 *   bucket = floor(now / ttl), ttl 3600 s, difficulty 16;
 *   a solution is a nonce whose SHA-256(challengeHex || nonce) has
 *   at least `difficulty` leading zero bits;
 *   cookie = "<expiry>.<hex(HMAC(secret, ipBytes || ascii(expiry)))>",
 *   compared with timingSafeEqual.
 * ipBytes is the 4 dotted-quad bytes for IPv4 (the lab form); for a
 * non-IPv4 address the UTF-8 bytes of the string are used (a
 * documented extension, unmeasured in the lab).
 *
 * This module is a challenge VERIFIER in the CAP-01 sense: hosts
 * plug it into their own step-up flow; it decides nothing about who
 * gets challenged.
 */

/* Minimal structural view of node:crypto (mirroring step-up-proof). */
interface NodeHashLike {
  update(data: unknown, encoding?: string): NodeHashLike;
  digest(encoding: string): string;
  digest(): Uint8Array;
}
interface NodeHmacLike {
  update(data: unknown): NodeHmacLike;
  digest(encoding: string): string;
}
interface NodeCryptoLike {
  createHash(algorithm: string): NodeHashLike;
  createHmac(algorithm: string, key: string): NodeHmacLike;
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
  throw new Error("node:crypto is not available in this runtime; PoW hashcash requires Node.js");
}

export const POW_DEFAULT_TTL_SEC = 3600;
export const POW_DEFAULT_DIFFICULTY = 16;

export interface PowHashcashOptions {
  /** HMAC secret (host-side only, never shipped to clients). */
  secret: string;
  /** Challenge bucket length in seconds. Default 3600. */
  ttlSec?: number;
  /** Required leading zero bits. Default 16 (the lab difficulty). */
  difficulty?: number;
  /**
   * Single-use consume hook, CAP-01 style: return true exactly once
   * per key (atomically consuming it), false on any later call.
   * Called ONLY after a solution passes the difficulty check.
   * Default: a bounded in-memory store (maxConsumedKeys entries).
   */
  consumeNonce?: (key: string) => boolean;
  /** Cap for the default in-memory consumed-key store. Default 100_000. */
  maxConsumedKeys?: number;
}

export type PowDispatchOutcome =
  | { outcome: "PASS"; via: "disabled" | "cookie" | "solution"; setCookie?: string }
  | { outcome: "CHALLENGE"; via: "fail-closed" | "bad-nonce" | "replay" | "page" };

function ipBytes(ip: string): Uint8Array {
  const parts = ip.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    return new Uint8Array(parts.map(Number));
  }
  return new TextEncoder().encode(ip);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function leadingZeroBits(buf: Uint8Array): number {
  let n = 0;
  for (const b of buf) {
    if (b === 0) {
      n += 8;
      continue;
    }
    let v = b;
    while ((v & 128) === 0) {
      n++;
      v = (v << 1) & 255;
    }
    break;
  }
  return n;
}

/** Create a PoW hashcash challenge/cookie verifier with single-use solutions. Opt-in. */
export function createPowHashcash(options: PowHashcashOptions): {
  challengeFor(ip: string, nowSec: number): string;
  bucketFor(nowSec: number): number;
  /** Verify a solution nonce; consumes it on success. Replay returns false with reason "replay". */
  verifySolution(ip: string, nonce: string, nowSec: number): { ok: boolean; reason?: "bad-nonce" | "replay" };
  /** Find the first passing nonce for an IP in its current bucket (test/client helper). */
  solve(ip: string, nowSec: number): string;
  makeCookie(ip: string, expirySec: number): string;
  checkCookie(ip: string, cookie: string | null | undefined, nowSec: number): "valid" | "invalid" | "absent";
  /** The lab's dispatch: disabled passes, valid cookie passes, invalid cookie fails closed, solution passes once. */
  dispatch(req: { ip: string; nonce?: string | null; cookie?: string | null }, enabled: boolean, nowSec: number): PowDispatchOutcome;
} {
  if (typeof options?.secret !== "string" || options.secret.length === 0) {
    throw new TypeError("pow hashcash: a non-empty host secret is required");
  }
  const secret = options.secret;
  const ttlSec = options.ttlSec ?? POW_DEFAULT_TTL_SEC;
  const difficulty = options.difficulty ?? POW_DEFAULT_DIFFICULTY;
  const maxConsumedKeys = options.maxConsumedKeys ?? 100_000;

  const consumed = new Map<string, true>();
  const defaultConsume = (key: string): boolean => {
    if (consumed.has(key)) return false;
    if (consumed.size >= maxConsumedKeys) return false; // fail closed at capacity, never forget a consumed key
    consumed.set(key, true);
    return true;
  };
  const consumeNonce = options.consumeNonce ?? defaultConsume;

  const crypto = getNodeCrypto();
  const hmacHex = (msg: Uint8Array): string => crypto.createHmac("sha256", secret).update(msg).digest("hex");
  const bucketFor = (nowSec: number): number => Math.floor(nowSec / ttlSec);
  const challengeFor = (ip: string, nowSec: number): string =>
    hmacHex(concatBytes(ipBytes(ip), new TextEncoder().encode(String(bucketFor(nowSec)))));
  const cookieMac = (ip: string, expirySec: number): string =>
    hmacHex(concatBytes(ipBytes(ip), new TextEncoder().encode(String(expirySec))));
  const makeCookie = (ip: string, expirySec: number): string => `${expirySec}.${cookieMac(ip, expirySec)}`;

  function meets(ip: string, nowSec: number, nonce: string): boolean {
    const digest = crypto.createHash("sha256").update(challengeFor(ip, nowSec) + nonce, "utf8").digest();
    return leadingZeroBits(digest) >= difficulty;
  }

  function verifySolution(ip: string, nonce: string, nowSec: number): { ok: boolean; reason?: "bad-nonce" | "replay" } {
    if (!meets(ip, nowSec, nonce)) return { ok: false, reason: "bad-nonce" };
    // CAP-01 discipline: the consume hook runs only here, after every
    // other check has passed, exactly once per passing attempt.
    const key = `${ip}|${bucketFor(nowSec)}|${nonce}`;
    if (!consumeNonce(key)) return { ok: false, reason: "replay" };
    return { ok: true };
  }

  function solve(ip: string, nowSec: number): string {
    for (let n = 0; ; n++) {
      if (meets(ip, nowSec, String(n))) return String(n);
    }
  }

  function checkCookie(ip: string, cookie: string | null | undefined, nowSec: number): "valid" | "invalid" | "absent" {
    if (cookie == null) return "absent";
    const m = /^(\d+)\.([0-9a-f]{64})$/.exec(cookie);
    if (!m) return "invalid";
    const expiry = Number(m[1]);
    if (expiry <= nowSec) return "invalid";
    const hexToBytes = (hex: string): Uint8Array => {
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return out;
    };
    const want = hexToBytes(cookieMac(ip, expiry));
    const got = hexToBytes(m[2] as string);
    return crypto.timingSafeEqual(want, got) ? "valid" : "invalid";
  }

  function dispatch(
    req: { ip: string; nonce?: string | null; cookie?: string | null },
    enabled: boolean,
    nowSec: number,
  ): PowDispatchOutcome {
    if (!enabled) return { outcome: "PASS", via: "disabled" };
    const cs = checkCookie(req.ip, req.cookie, nowSec);
    if (cs === "valid") return { outcome: "PASS", via: "cookie" };
    if (cs === "invalid") return { outcome: "CHALLENGE", via: "fail-closed" };
    if (req.nonce != null) {
      const v = verifySolution(req.ip, req.nonce, nowSec);
      if (v.ok) return { outcome: "PASS", via: "solution", setCookie: makeCookie(req.ip, nowSec + ttlSec) };
      return { outcome: "CHALLENGE", via: v.reason === "replay" ? "replay" : "bad-nonce" };
    }
    return { outcome: "CHALLENGE", via: "page" };
  }

  return { challengeFor, bucketFor, verifySolution, solve, makeCookie, checkCookie, dispatch };
}
