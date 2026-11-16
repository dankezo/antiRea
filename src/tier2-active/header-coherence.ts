/**
 * Header-coherence spoof score (UAS-01, antiRea 3.0 Item 7a) - the V1
 * form ONLY. The original V0 table is never shipped.
 *
 * WHAT IT MEASURES. A request whose User-Agent claims a mainstream
 * browser but whose headers are incoherent with that claim (no Accept,
 * no compression, no Sec-Fetch-*, no Client Hints on a modern Chromium
 * claim, HTTP/1.0, ...) is likely a UA-spoofing non-browser client.
 * The score is the SIGNALS weighted sum exactly as registered for V1
 * in the UAS Step-0 lab (uas-lab/REGISTRATION-UAS-STEP0.md, frozen
 * 2026-11-16; mechanism source: UserAgentSpy fingerprint.js @347821db):
 * `from_header` is EXCLUDED from the sum and reported as a separate
 * boolean (`hasFromHeader`); a request flags at score >= 4. The V0
 * form - which counted `from_header` (weight 4) inside the sum and
 * therefore flagged on that single signal alone - is a measured
 * defect of the source (lab shape A5: V0 = 4 and flagged, V1 = 0 and
 * not flagged) and is NOT shipped here in any form.
 *
 * ADVISORY ONLY, LOW TIER. This score is investigation telemetry
 * (`enforcement: "none"` on every result). It must never be a sole
 * blocking key and never an exemption, in either direction: a high
 * score does not prove spoofing and a zero score does not prove a
 * genuine browser.
 *
 * SCOPE. Only requests whose UA claims a mainstream browser are
 * scored (Chrome / Edge / Opera / Vivaldi / Samsung Internet /
 * Yandex Browser / UC Browser / Firefox / Safari, and not a bot).
 * Any other caller - a named bot, curl, an unknown UA - is out of
 * scope: it produces no codes and a score of 0, because header
 * coherence is meaningless against a claim that was never made.
 *
 * PHASE 4 SCOPE LIMIT (travels with this module). On the signed-in
 * (copied-profile) surface this signal is WEAKENED by construction
 * (PHASE4-SLICE1 section 1): a copied profile drives a real browser,
 * whose headers genuinely cohere with its UA, so the score reads 0
 * there. A PASS in the lab does not extend to that surface.
 *
 * MANDATORY DISCLOSURE - THE PROXY FALSE-POSITIVE CLASS. Behind
 * header-stripping proxies the score flags 75.15% of the registered
 * stratum C (seed 20308103, n=2000, RESULTS-UAS-STEP0.md). The score
 * may only be consumed where the host knows its ingress does not
 * strip headers. A deployment behind a stripping proxy, a header-
 * normalising CDN, or any middlebox that drops Accept / Sec-Fetch /
 * Client-Hints headers will flag genuine browsers at that rate.
 *
 * EXPECTED MISS, PRINTED. A header-complete spoofer scores 0 (lab
 * shape A4): a client that sends a full coherent browser header set
 * is indistinguishable from a browser by this signal, by design.
 * That is the candidate's stated boundary, not a bug.
 *
 * LAB EVIDENCE (Step-0, synthetic and frozen; not field rates).
 * Truth table 576/576 rows exact plus 5/5 gating rows; stratum A
 * (direct modern, seed 20308101) flagged 0.0%; stratum B (legacy,
 * seed 20308102) flagged 0.0% with every row scoring exactly 2;
 * attack shapes A1 = 10, A2 = 7, A3 = 11, all flagged. See
 * uas-lab/RESULTS-UAS-STEP0.md. Pure computation: no I/O, no state,
 * no runtime dependencies.
 */

/** One coherence defect code. `from_header` is deliberately NOT a member: it is reported separately. */
export type HeaderCoherenceCode =
  | "no_accept"
  | "accept_star"
  | "no_accept_encoding"
  | "weak_accept_encoding"
  | "no_accept_language"
  | "http_1_0"
  | "no_sec_fetch"
  | "no_client_hints"
  | "connection_close";

/**
 * The registered V1 weights (fingerprint.js SIGNALS, verbatim).
 * `from_header` (V0 weight 4) is absent by design: it never enters
 * the V1 sum.
 */
export const HEADER_COHERENCE_WEIGHTS: Readonly<Record<HeaderCoherenceCode, number>> = Object.freeze({
  no_accept: 3,
  accept_star: 2,
  no_accept_encoding: 3,
  weak_accept_encoding: 2,
  no_accept_language: 1,
  http_1_0: 2,
  no_sec_fetch: 2,
  no_client_hints: 2,
  connection_close: 1,
});

/** Human-readable explanation per code (fingerprint.js SIGNALS, verbatim). */
export const HEADER_COHERENCE_DESCRIPTIONS: Readonly<Record<HeaderCoherenceCode, string>> = Object.freeze({
  no_accept: "no Accept header",
  accept_star: "Accept is */* (browsers send text/html,… for navigations)",
  no_accept_encoding: "no Accept-Encoding header",
  weak_accept_encoding: "Accept-Encoding advertises no known compression",
  no_accept_language: "no Accept-Language header",
  http_1_0: "HTTP/1.0 request",
  no_sec_fetch: "no Sec-Fetch-* headers",
  no_client_hints: "Chromium ≥ 90 but no Sec-CH-UA header",
  connection_close: "Connection: close on an HTTP/1.1 request",
});

/** Flag threshold of the registered V1 form: `score >= 4` flags. */
export const HEADER_COHERENCE_THRESHOLD = 4;

/** Browsers whose UA claim puts a request in scope (fingerprint.js REAL_BROWSERS, verbatim). */
export const HEADER_COHERENCE_BROWSERS: readonly string[] = Object.freeze([
  "Chrome",
  "Microsoft Edge",
  "Opera",
  "Vivaldi",
  "Samsung Internet",
  "Yandex Browser",
  "UC Browser",
  "Firefox",
  "Safari",
]);

/** Chromium-family browsers (Client Hints are expected on claims >= 90). */
export const HEADER_COHERENCE_CHROMIUM: readonly string[] = Object.freeze([
  "Chrome",
  "Microsoft Edge",
  "Opera",
  "Vivaldi",
  "Samsung Internet",
  "Yandex Browser",
  "UC Browser",
]);

const CHROMIUM_SET = new Set<string>(HEADER_COHERENCE_CHROMIUM);
const REAL_BROWSER_SET = new Set<string>(HEADER_COHERENCE_BROWSERS);

/**
 * Browser table (UserAgentSpy ua.js BROWSERS, verbatim order): the
 * first matching row names the claimed browser and version. Used
 * only when the caller does not supply `browser` / `browserVersion`
 * explicitly.
 */
const BROWSER_TABLE: ReadonlyArray<readonly [RegExp, string]> = [
  [/edg(?:a|ios)?\/([\d.]+)/i, "Microsoft Edge"],
  [/opr\/([\d.]+)/i, "Opera"],
  [/opera[ /]([\d.]+)/i, "Opera"],
  [/vivaldi\/([\d.]+)/i, "Vivaldi"],
  [/yabrowser\/([\d.]+)/i, "Yandex Browser"],
  [/samsungbrowser\/([\d.]+)/i, "Samsung Internet"],
  [/ucbrowser\/([\d.]+)/i, "UC Browser"],
  [/firefox\/([\d.]+)/i, "Firefox"],
  [/fxios\/([\d.]+)/i, "Firefox"],
  [/(?:chrome|crios)\/([\d.]+)/i, "Chrome"],
  [/version\/([\d.]+)(?:\s\w+)*\ssafari/i, "Safari"],
  [/\bsafari\/([\d.]+)/i, "Safari"],
  [/msie\s([\d.]+)/i, "Internet Explorer"],
  [/trident.*?rv:([\d.]+)/i, "Internet Explorer"],
  [/(?:^|\s)wget\/([\d.]+)/i, "wget"],
  [/(?:^|\s)curl\/([\d.]+)/i, "curl"],
];

/** Parse the claimed browser + version out of a User-Agent string (ua.js BROWSERS order). */
export function parseClaimedBrowser(userAgent: string): { browser: string | null; browserVersion: string | null } {
  for (const [re, name] of BROWSER_TABLE) {
    const m = re.exec(userAgent);
    if (m) return { browser: name, browserVersion: m[1] ?? null };
  }
  return { browser: null, browserVersion: null };
}

export interface HeaderCoherenceRequest {
  /**
   * Request headers. Names are matched case-insensitively; a header
   * counts as present when its key exists with a string value (the
   * source's `in` semantics), even an empty one.
   */
  headers: Record<string, string | undefined>;
  /** HTTP version as the server saw it (`"1.1"` default, `"1.0"` for HTTP/1.0). */
  httpVersion?: string;
  /** Raw User-Agent, used to derive the browser claim when `browser` is not supplied. */
  userAgent?: string;
  /** Claimed browser name (e.g. `"Chrome"`); overrides UA parsing when supplied. */
  browser?: string | null;
  /** Claimed browser version (e.g. `"120.0.0.0"`); overrides UA parsing when supplied. */
  browserVersion?: string | null;
  /**
   * Whether the caller is a known bot. When true the request is out
   * of scope (no browser claim) regardless of the browser fields.
   * When omitted, the claim is judged on the browser fields / UA
   * parse alone - a UA that names no mainstream browser is out of
   * scope either way.
   */
  isBot?: boolean;
}

export interface HeaderCoherenceResult {
  kind: "header_coherence";
  /** True when the UA claims a mainstream browser and the request was scored. */
  claimsBrowser: boolean;
  /** The claimed browser the scope decision used, or null. */
  browser: string | null;
  /** Defect codes in the source's fixed evaluation order. Never contains `from_header`. */
  codes: HeaderCoherenceCode[];
  /** The V1 weighted sum (from_header excluded). */
  score: number;
  /** `score >= HEADER_COHERENCE_THRESHOLD` (and in scope). */
  flagged: boolean;
  /** Separate boolean for the `From` header - the V1 replacement for the V0 `from_header` signal. */
  hasFromHeader: boolean;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): a header-coherence score for requests claiming a " +
  "mainstream browser. It must never be a sole blocking key or an exemption. Behind " +
  "header-stripping proxies it flags 75.15% of the registered stratum C - consume it only " +
  "where the host knows its ingress does not strip headers. A header-complete spoofer " +
  "scores 0 (expected miss). On the signed-in copied-profile surface the signal is weakened " +
  "by construction (a real browser's headers cohere with its UA).";

/**
 * Score one request's header coherence (V1 form). The evaluation
 * order and conditions are fingerprint.js `analyzeRequest` verbatim,
 * with the single registered V1 change: `from_header` is excluded
 * from the codes and the sum, and reported as `hasFromHeader`.
 */
export function analyzeHeaderCoherence(request: HeaderCoherenceRequest): HeaderCoherenceResult {
  // Normalise header names to lowercase, keeping presence semantics:
  // a key with a string value (even "") is present; undefined is not.
  const h: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (typeof value === "string") h[name.toLowerCase()] = value;
  }
  const httpVersion = request.httpVersion ?? "1.1";

  let browser: string | null = request.browser ?? null;
  let browserVersion: string | null = request.browserVersion ?? null;
  if (browser === null && typeof request.userAgent === "string") {
    const parsed = parseClaimedBrowser(request.userAgent);
    browser = parsed.browser;
    if (browserVersion === null) browserVersion = parsed.browserVersion;
  }

  const claimsBrowser =
    request.isBot !== true && browser !== null && REAL_BROWSER_SET.has(browser);

  const hasFromHeader = Boolean(h["from"]);

  const codes: HeaderCoherenceCode[] = [];
  if (claimsBrowser) {
    const accept = h["accept"] ?? "";
    if (!accept) codes.push("no_accept");
    else if (accept.trim() === "*/*") codes.push("accept_star");

    const acceptEncoding = h["accept-encoding"] ?? "";
    if (!acceptEncoding) codes.push("no_accept_encoding");
    else if (!/\b(gzip|br|deflate|zstd|compress)\b/i.test(acceptEncoding)) {
      codes.push("weak_accept_encoding");
    }

    if (!h["accept-language"]) codes.push("no_accept_language");
    if (httpVersion === "1.0") codes.push("http_1_0");

    const sentSecFetch =
      "sec-fetch-mode" in h || "sec-fetch-dest" in h || "sec-fetch-site" in h;
    if (!sentSecFetch) codes.push("no_sec_fetch");

    const sentClientHints = "sec-ch-ua" in h;
    const major = browserVersion !== null ? parseInt(browserVersion, 10) : NaN;
    if (browser !== null && CHROMIUM_SET.has(browser) && major >= 90 && !sentClientHints) {
      codes.push("no_client_hints");
    }

    if ((h["connection"] ?? "").toLowerCase().includes("close") && httpVersion === "1.1") {
      codes.push("connection_close");
    }
  }

  const score = codes.reduce((sum, code) => sum + HEADER_COHERENCE_WEIGHTS[code], 0);
  return {
    kind: "header_coherence",
    claimsBrowser,
    browser,
    codes,
    score,
    flagged: claimsBrowser && score >= HEADER_COHERENCE_THRESHOLD,
    hasFromHeader,
    enforcement: "none",
    notice: ADVISORY_NOTICE,
  };
}

/** Explain codes in words (the source's `explainCodes`, over the V1 code set). */
export function explainHeaderCoherenceCodes(codes: readonly HeaderCoherenceCode[]): string[] {
  return codes.map((code) => HEADER_COHERENCE_DESCRIPTIONS[code] ?? code);
}
