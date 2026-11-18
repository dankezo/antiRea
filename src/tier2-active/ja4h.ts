/**
 * JA4H in-module fingerprint (NHS-01, antiRea 3.1.0).
 *
 * WHAT IT IS. A pure hash of a request's JA4H shape: method, HTTP
 * version, the header-name SET (sorted, lowercased, cookie and
 * referer excluded and reported as bits), and the first
 * Accept-Language tag. The host supplies the header set as ordered
 * name/value pairs; this module performs no I/O and keeps no state.
 * Advisory only (enforcement: "none" on every result): a fingerprint
 * identifies a client shape, it never proves intent, and it must
 * never be a sole blocking key.
 *
 * SEMANTICS (frozen in the NHS Step-0 lab, nhs-lab/nhs01.cjs,
 * RESULTS-NHS-STEP0.md; mechanism source sentinel_ja4h.c):
 * - ORDER DOES NOT MATTER. The research bag claimed the hash changes
 *   when header order changes; that claim was a defect. The source
 *   sorts header names before hashing, so the measured behaviour is
 *   order-INVARIANCE (the reversed-order request hashes identically
 *   to the base, for GET and POST alike), and the sensitivity axis
 *   is the header-name SET: 6/6 single-component changes (method,
 *   version, cookie bit, referer bit, language, one new header name)
 *   alter the hash.
 * - Header VALUES do not matter either: changing the User-Agent or
 *   Accept value leaves the hash identical. Only the first
 *   Accept-Language tag enters (everything from the first comma,
 *   semicolon or space on is ignored, tag capped at 32 chars).
 * - At most 64 header names are collected, in wire order; the 65th
 *   and later names are silently truncated (a 66-header request
 *   hashes exactly like its own first-64 truncation).
 * - The all-zero hash (24 zeros) occurs only on canonical-buffer
 *   overflow (4096 bytes), never merely from the 64-name cap.
 *
 * LAB EVIDENCE (Step-0, synthetic and frozen; not field rates). Base
 * hash stable across recomputation; ORDER and VALUE strata identical
 * to base; SENS 6/6 differ; LANG first-tag-only identical; CAP64 and
 * OVERFLOW per the corrected readings above. No legit-population
 * false-positive rate exists for this fingerprint: it is a shape
 * identifier for correlation, not a classifier.
 */

/* Minimal structural view of node:crypto (mirroring config-provenance). */
interface NodeHashLike {
  update(data: string, encoding: string): NodeHashLike;
  digest(): { subarray(start: number, end: number): { toString(encoding: string): string } };
}
interface NodeCryptoLike {
  createHash(algorithm: string): NodeHashLike;
}
declare const require: ((id: string) => NodeCryptoLike) | undefined;
function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.createHash === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; JA4H requires Node.js");
}

const ZERO_HASH = "0".repeat(24);
const CANONICAL_LENGTH = 4096;
const MAX_HEADER_NAMES = 64;

const METHOD_CODES: Readonly<Record<string, string>> = Object.freeze({
  GET: "ge",
  POST: "po",
  PUT: "pu",
  DELETE: "de",
  HEAD: "he",
  OPTIONS: "op",
  PATCH: "pa",
});

export interface Ja4hRequest {
  /** HTTP method, any case (unknown methods hash as "xx"). */
  method: string;
  /** HTTP version as a number (1.0, 1.1, 2) or a string ("1.1", "2"). */
  httpVersion?: number | string;
  /**
   * Header name/value pairs in wire order. Order does not affect the
   * hash except at the 64-name collection cap, which truncates in
   * wire order exactly as the source does.
   */
  headers: ReadonlyArray<readonly [string, string]>;
}

export interface Ja4hResult {
  kind: "ja4h";
  /** 24-char lowercase hex (first 12 bytes of the SHA-256 of the canonical form), or 24 zeros on overflow. */
  hash: string;
  /** Number of header names collected (after the 64 cap, cookie/referer excluded). */
  headerCount: number;
  hasCookie: boolean;
  hasReferer: boolean;
  /** The first Accept-Language tag that entered the hash, or empty. */
  language: string;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
}

function versionCode(httpVersion: number | string | undefined): string {
  const v = typeof httpVersion === "string" ? Number.parseFloat(httpVersion) : (httpVersion ?? 1.1);
  if (v >= 2) return "20";
  if (v >= 1.1) return "11";
  return "10";
}

/** ja4h_strcmp: case-insensitive compare over the min length, then length difference. */
function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  const m = Math.min(la.length, lb.length);
  const pa = la.slice(0, m);
  const pb = lb.slice(0, m);
  if (pa < pb) return -1;
  if (pa > pb) return 1;
  return a.length - b.length;
}

/**
 * Compute the JA4H fingerprint of one request. Pure: same input,
 * same hash, no state. Returns the zero hash only on canonical
 * overflow, exactly as the source does.
 */
export function computeJa4h(request: Ja4hRequest): Ja4hResult {
  const method = METHOD_CODES[(request.method ?? "").toUpperCase()] ?? "xx";
  const ver = versionCode(request.httpVersion);
  let hasCookie = false;
  let hasReferer = false;
  const names: string[] = [];
  for (const [name] of request.headers ?? []) {
    const ln = String(name).toLowerCase();
    if (ln === "cookie") hasCookie = true;
    else if (ln === "referer") hasReferer = true;
    if (ln !== "cookie" && ln !== "referer" && names.length < MAX_HEADER_NAMES) names.push(String(name));
  }
  names.sort(compareNames);

  let lang = "";
  for (const [name, value] of request.headers ?? []) {
    if (String(name).toLowerCase() === "accept-language") {
      const v = String(value ?? "");
      let j = 0;
      while (j < v.length && v[j] !== "," && v[j] !== ";" && v[j] !== " ") j++;
      lang = v.slice(0, Math.min(j, 32));
      break;
    }
  }

  const end = CANONICAL_LENGTH - 1;
  let canon = "";
  const app = (s: string): boolean => {
    if (canon.length + s.length >= end) return false;
    canon += s;
    return true;
  };
  const overflow = (): Ja4hResult => ({
    kind: "ja4h",
    hash: ZERO_HASH,
    headerCount: names.length,
    hasCookie,
    hasReferer,
    language: lang,
    enforcement: "none",
  });

  if (!app(method)) return overflow();
  if (!app("|")) return overflow();
  if (!app(ver)) return overflow();
  if (!app("|")) return overflow();
  canon += (hasCookie ? "1" : "0") + (hasReferer ? "1" : "0");
  if (!app("|")) return overflow();
  const cnt = Math.min(names.length, 99);
  canon += String(Math.floor(cnt / 10)) + String(cnt % 10);
  if (!app("|")) return overflow();
  for (let i = 0; i < names.length; i++) {
    if (i > 0 && !app(",")) return overflow();
    const nm = (names[i] as string).toLowerCase();
    if (canon.length + nm.length >= end) return overflow();
    canon += nm;
  }
  if (!app("|")) return overflow();
  if (lang && !app(lang)) return overflow();

  const hash = getNodeCrypto().createHash("sha256").update(canon, "utf8").digest().subarray(0, 12).toString("hex");
  return { kind: "ja4h", hash, headerCount: names.length, hasCookie, hasReferer, language: lang, enforcement: "none" };
}
