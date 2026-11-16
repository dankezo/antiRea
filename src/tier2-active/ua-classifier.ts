/**
 * User-Agent bot catalogue - RESTRICTED form only (UAS-02, antiRea
 * 3.0 Item 7b). Advisory-only, low tier.
 *
 * WHAT IT IS. A named-bot User-Agent catalogue plus a `botName()`
 * extractor and an empty-UA rule, ported from UserAgentSpy ua.js
 * @347821db and measured in the UAS Step-0 lab (uas-lab/
 * REGISTRATION-UAS-STEP0.md + RESULTS-UAS-STEP0.md, frozen
 * 2026-11-16): coverage 107/107 extracted alternatives, real-browser
 * corpus FP 0/36, botName battery 20/20, empty-UA rows exact.
 *
 * THE RESTRICTION (binding on this PASS, recorded in the lab
 * results). The catalogue extracted from ua.js has 107 alternatives.
 * The shipped list below is those 107 MINUS the generic set - 101
 * alternatives. The generic alternatives are NOT in the shipped
 * catalogue:
 *
 *   `bot\b`, `www.`, the bare e-mail pattern
 *   (`(?:^|\s)[\w.-]+@[\w.-]+\.[a-z]{2,}`), `whatsapp`, `pinterest`,
 *   `quora`
 *
 * They are excluded because they are a measured false-positive
 * hazard for real users in in-app webviews: in the lab's trap
 * corpus, 8/8 real-user-shaped webview UAs (WhatsApp, Pinterest and
 * Quora in-app browsers, plus browser UAs carrying an e-mail or a
 * `www.` token) were flagged, each ONLY on one of these generic
 * tokens - no trap fired any named-bot token. If a host wants the
 * generic tokens, they are a separately gated host-side addition,
 * documented here as an FP hazard for in-app webviews with that 8/8
 * trap measurement; they are never silently part of this list.
 *
 * FROZEN LIST. `UA_BOT_CATALOGUE` is a frozen exported list.
 * Updates are reviewed changes, never self-expanding: nothing in
 * this module learns, fetches, or widens the catalogue at runtime.
 *
 * EMPTY-UA RULE (ua.js:90-102, verbatim in effect). A missing,
 * empty, or whitespace-only User-Agent classifies as a bot with
 * the name `"(no user-agent)"`: no UA header at all is a strong
 * non-human signal.
 *
 * ADVISORY ONLY, LOW TIER. A classification is investigation
 * telemetry (`enforcement: "none"`). It must never be a sole
 * blocking key and never an exemption: a named-bot label does not
 * prove the caller is that bot (UA strings are self-declared), and
 * a non-match does not prove a human.
 *
 * PHASE 4 SCOPE LIMIT (travels with this module). On the signed-in
 * (copied-profile) surface this catalogue is DEFEATED by
 * construction (PHASE4-SLICE1 section 1): a copied-profile session
 * presents a genuine browser UA, and the catalogue is silent there.
 * The measured scope is non-browser callers and spoofed/absent UA
 * only; a lab PASS does not extend to the signed-in surface.
 *
 * Pure computation: no I/O, no state, no runtime dependencies.
 */

/** Bot name reported for a missing / empty / whitespace-only User-Agent (ua.js, verbatim). */
export const NO_USER_AGENT_BOT_NAME = "(no user-agent)";

/**
 * The generic alternatives extracted from ua.js but deliberately
 * NOT shipped (see the module header): each is a measured FP hazard
 * for real in-app webview users (8/8 trap corpus). Exported for
 * documentation and regression testing only - nothing in this
 * module matches on them.
 */
export const UA_CATALOGUE_EXCLUDED_GENERICS: readonly string[] = Object.freeze([
  "bot\\b",
  "www\\.",
  "(?:^|\\s)[\\w.-]+@[\\w.-]+\\.[a-z]{2,}",
  "whatsapp",
  "pinterest",
  "quora",
]);

/**
 * The shipped named-bot catalogue: the 107 alternatives extracted
 * from ua.js (BOT_RE, ua.js:7-29) MINUS the 6 generic alternatives
 * in {@link UA_CATALOGUE_EXCLUDED_GENERICS} - 101 regex fragments,
 * in source order, frozen. Each fragment is matched
 * case-insensitively, exactly as the source's combined BOT_RE does.
 */
export const UA_BOT_CATALOGUE: readonly string[] = Object.freeze([
  "crawler",
  "crawl(?:ing|er)?",
  "spider",
  "slurp",
  "scraper",
  "scrape",
  "https?://",
  "\\+http",
  "feed(?:fetcher|ly|parser)",
  "mediapartners",
  "facebookexternalhit",
  "facebot",
  "ia_archiver",
  "archive\\.org",
  "bingpreview",
  "embedly",
  "outbrain",
  "vkshare",
  "w3c_validator",
  "telegrambot",
  "discordbot",
  "slackbot",
  "twitterbot",
  "linkedinbot",
  "skypeuripreview",
  "applebot",
  "petalbot",
  "semrushbot",
  "ahrefsbot",
  "ahrefssiteaudit",
  "mj12bot",
  "dotbot",
  "dataforseobot",
  "screaming ?frog",
  "gptbot",
  "oai-searchbot",
  "chatgpt-user",
  "ccbot",
  "claudebot",
  "claude-web",
  "anthropic-ai",
  "perplexitybot",
  "google-extended",
  "googleother",
  "bytespider",
  "amazonbot",
  "yandex(?:bot|images|mobilebot)?",
  "baiduspider",
  "sogou",
  "exabot",
  "exalead",
  "duckduckbot",
  "duckduckgo",
  "seznambot",
  "qwantify",
  "curl/",
  "wget/",
  "libcurl",
  "python-requests",
  "python-urllib",
  "aiohttp",
  "httpx/",
  "go-http-client",
  "okhttp",
  "apache-httpclient",
  "jakarta",
  "libwww-perl",
  "axios/",
  "node-fetch",
  "got \\(",
  "scrapy",
  "colly",
  "guzzle",
  "headlesschrome",
  "phantomjs",
  "puppeteer",
  "playwright",
  "lighthouse",
  "pingdom",
  "uptimerobot",
  "uptime-kuma",
  "statuscake",
  "site24x7",
  "gtmetrix",
  "newrelicpinger",
  "datadog",
  "nuclei",
  "masscan",
  "zgrab",
  "censys",
  "shodan",
  "zmap",
  "nmap",
  "nikto",
  "sqlmap",
  "wpscan",
  "internet-?measurement",
  "paloaltonetworks",
  "expanse",
  "l9explore",
  "projectdiscovery",
]);

const UA_BOT_REGEX = new RegExp(UA_BOT_CATALOGUE.join("|"), "i");
const UA_BOT_REGEXES: readonly RegExp[] = UA_BOT_CATALOGUE.map((alt) => new RegExp(alt, "i"));

/**
 * Extract a bot name from a User-Agent string - the source's
 * `botName()` (ua.js:31-39) with its 3-step fallback, verbatim:
 * (1) a bot-token-bearing word (`bot|spider|crawler|slurp|scraper`
 * inside a token), (2) the first token before a version number,
 * (3) a domain in the string, then a 60-character cut of the raw UA.
 */
export function extractBotName(ua: string): string {
  let m = ua.match(/([A-Za-z0-9._-]*(?:bot|spider|crawler|slurp|scraper)[A-Za-z0-9._-]*)/i);
  if (m) return m[1] as string;
  m = ua.match(/^([A-Za-z0-9._ -]+?)[/ ]\d/);
  if (m) return (m[1] as string).trim();
  m = ua.match(/([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s;)]*)?)/i);
  if (m) return m[1] as string;
  return ua.slice(0, 60);
}

export interface UaClassification {
  kind: "ua_classification";
  /** True when the restricted catalogue matches, or the UA is missing/empty/whitespace. */
  isBot: boolean;
  /** The extracted bot name when `isBot`; null for a non-bot UA. `"(no user-agent)"` for the empty-UA rule. */
  botName: string | null;
  /** True exactly when the empty-UA rule fired (missing/empty/whitespace UA). */
  empty: boolean;
  /** The first shipped catalogue alternative that matched, in catalogue order; null when none did. */
  matchedAlternative: string | null;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): a named-bot User-Agent catalogue match (restricted " +
  "form - the generic tokens bot\\b, www., the e-mail pattern, whatsapp, pinterest and quora are " +
  "deliberately not shipped; they flagged 8/8 real in-app webview UAs in the lab trap corpus). " +
  "A label is never a sole blocking key or an exemption, and on the signed-in copied-profile " +
  "surface this catalogue is defeated by construction (a genuine browser UA is silent here).";

/**
 * Classify one User-Agent string against the restricted catalogue.
 * Mirrors ua.js `parseUA`'s bot leg: the UA is trimmed first; the
 * empty-UA rule fires on the trimmed-empty string.
 */
export function classifyUserAgent(userAgent: string | null | undefined): UaClassification {
  const ua = (userAgent ?? "").trim();
  if (!ua) {
    return {
      kind: "ua_classification",
      isBot: true,
      botName: NO_USER_AGENT_BOT_NAME,
      empty: true,
      matchedAlternative: null,
      enforcement: "none",
      notice: ADVISORY_NOTICE,
    };
  }
  const isBot = UA_BOT_REGEX.test(ua);
  let matchedAlternative: string | null = null;
  if (isBot) {
    for (let i = 0; i < UA_BOT_REGEXES.length; i++) {
      if (UA_BOT_REGEXES[i]!.test(ua)) {
        matchedAlternative = UA_BOT_CATALOGUE[i] ?? null;
        break;
      }
    }
  }
  return {
    kind: "ua_classification",
    isBot,
    botName: isBot ? extractBotName(ua) : null,
    empty: false,
    matchedAlternative,
    enforcement: "none",
    notice: ADVISORY_NOTICE,
  };
}

/** Convenience predicate: does the restricted catalogue classify this UA as a bot (empty-UA rule included)? */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  return classifyUserAgent(userAgent).isBot;
}
