/**
 * Non-app path classification ahead of scanner-path scoring
 * (ABP-09 NON-APP-PATHS-MUST-BE-CLASSIFIED-BEFORE-SCORING). OPT-IN:
 * nothing in the shipped pipeline calls this unless the host wires
 * it in ahead of its scanner-path signals.
 *
 * The neighbour failure, measured in the ABP Step-0 lab: requests
 * for paths the app does not have were fed straight into scanner
 * scoring, unclassified. 11 unique typo paths requested fast scored
 * exactly 38 (the challenge band; entropy + velocity legs), a single
 * repeated typo path requested fast scored 23 on VELOCITY ALONE -
 * also the challenge band - and 11 locale-prefixed app routes
 * (/vi/home, /en/home, ...) scored the same 38 as the typos. In
 * other words, a user with a stale bookmark, a fast refresh habit,
 * or a locale-prefixed URL was indistinguishable from a scanner at
 * the scoring layer.
 *
 * antiRea form: a pure classifier the host runs FIRST. It is
 * deliberately VELOCITY-BLIND - it takes no timing, count or history
 * input, so repetition can never change a path's class - and it
 * separates the non-app shapes the lab conflated:
 *
 * - `app`: the path is one of the host's declared app paths (or
 *   under one).
 * - `locale_route`: a locale-prefixed form of an app path
 *   (/vi/home for app path /home).
 * - `asset`: a static-asset path (known asset extension or a
 *   conventional asset prefix).
 * - `probe`: a registered trap path (the ABP-08 registry) or a
 *   known probe prefix (/.git/, /wp-*, /.aws, /actuator, ...).
 *   This is the ONLY class that feeds scanner-path signals.
 * - `typo`: within a small edit distance of an app path - the
 *   stale-bookmark / fat-finger shape.
 * - `unknown_non_app`: none of the above. Recorded, not scored:
 *   the host may count these separately, but they do not feed
 *   scanner signals through this classifier.
 *
 * `feedsScannerSignal` on the result is the wiring contract: true
 * exactly for `probe`. Classification is not a verdict - a probe
 * class is a path SHAPE, and what a signal does with it stays with
 * the signal's own gates.
 */

import { isRegisteredTrapPath } from "./trap-paths";

export type NonAppPathClass = "app" | "locale_route" | "asset" | "probe" | "typo" | "unknown_non_app";

export interface PathClassifierOptions {
  /** The host's real app paths (routes the UI/API actually serves). Required. */
  appPaths: readonly string[];
  /**
   * Locale first-segments recognized for `locale_route`. Defaults to
   * a small built-in set of common ISO 639-1 codes. A first segment
   * only yields `locale_route` when the REMAINDER is an app path, so
   * a generous locale set cannot manufacture app routes.
   */
  locales?: readonly string[];
}

export interface PathClassification {
  class: NonAppPathClass;
  /** The normalized path the classification was computed on. */
  normalizedPath: string;
  /** True exactly for `probe` - the only class that feeds scanner-path signals. */
  feedsScannerSignal: boolean;
  /** For `locale_route`: the matched app path. For `typo`: the nearest app path. */
  matchedAppPath?: string;
  /** For `locale_route`: the locale first-segment. */
  locale?: string;
}

const DEFAULT_LOCALES = [
  "en", "vi", "es", "zh", "ja", "ko", "fr", "de", "it", "pt", "ru", "th", "id", "ms", "tl", "hi", "bn", "ur", "ar", "nl", "pl", "tr", "uk",
] as const;

const ASSET_EXTENSIONS = new Set([
  ".css", ".js", ".mjs", ".map", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".webp", ".avif", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm", ".mp3",
]);

const ASSET_PREFIXES = ["/assets/", "/static/", "/_next/static/", "/public/"] as const;

/** Probe prefixes beyond the ABP-08 registry (well-known scanner liturgy shapes). */
const PROBE_PREFIXES = ["/.git/", "/.aws/", "/wp-admin", "/wp-login", "/wp-content/", "/actuator/", "/cgi-bin/", "/.svn/"] as const;

function normalizePath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  let p = raw.trim().split(/[?#]/, 1)[0] || "/";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(p)) {
    const schemeEnd = p.indexOf("://") + 3;
    const slashIdx = p.indexOf("/", schemeEnd);
    p = slashIdx >= 0 ? p.slice(slashIdx) : "/";
  }
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p.toLowerCase();
}

/** Bounded Levenshtein: returns maxDist + 1 as soon as the distance provably exceeds it. */
function editDistanceWithin(a: string, b: string, maxDist: number): number {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if ((cur[j] as number) < rowMin) rowMin = cur[j] as number;
    }
    if (rowMin > maxDist) return maxDist + 1;
    prev = cur;
  }
  return prev[b.length] as number;
}

export interface PathClassifier {
  classify(rawPath: string): PathClassification;
  readonly appPaths: readonly string[];
}

/** Create an opt-in non-app path classifier over the host's declared app paths. */
export function createPathClassifier(options: PathClassifierOptions): PathClassifier {
  if (!options || !Array.isArray(options.appPaths) || options.appPaths.length === 0) {
    throw new TypeError("createPathClassifier: options.appPaths must be a non-empty array of the host's app paths");
  }
  const appPaths = [...new Set(options.appPaths.map(normalizePath))];
  const appSet = new Set(appPaths);
  const locales = new Set((options.locales ?? DEFAULT_LOCALES).map(l => l.toLowerCase()));

  const isAppPath = (p: string): boolean => {
    if (appSet.has(p)) return true;
    return appPaths.some(app => app !== "/" && p.startsWith(app + "/"));
  };

  const classify = (rawPath: string): PathClassification => {
    const p = normalizePath(rawPath);
    const done = (cls: NonAppPathClass, extra?: Partial<PathClassification>): PathClassification => ({
      class: cls,
      normalizedPath: p,
      feedsScannerSignal: cls === "probe",
      ...extra,
    });

    // 1. Probe: a registered trap path or a known probe prefix. First,
    //    so a trap path is never re-read as a typo of an app path.
    if (isRegisteredTrapPath(p) || PROBE_PREFIXES.some(prefix => p === prefix.replace(/\/$/, "") || p.startsWith(prefix))) {
      return done("probe");
    }
    // 2. App: exact or nested under a declared app path.
    if (isAppPath(p)) return done("app");
    // 3. Locale route: /<locale>/<app path...>.
    const segments = p.split("/").filter(Boolean);
    if (segments.length >= 2) {
      const [first, ...rest] = segments as [string, ...string[]];
      if (locales.has(first)) {
        const remainder = "/" + rest.join("/");
        if (isAppPath(remainder)) return done("locale_route", { matchedAppPath: remainder, locale: first });
      }
    }
    // 4. Asset: known extension or conventional asset prefix.
    const lastSegment = segments[segments.length - 1] ?? "";
    const dot = lastSegment.lastIndexOf(".");
    if ((dot > 0 && ASSET_EXTENSIONS.has(lastSegment.slice(dot))) || ASSET_PREFIXES.some(prefix => p.startsWith(prefix))) {
      return done("asset");
    }
    // 5. Typo: within a small edit distance of an app path.
    let nearest: string | undefined;
    let nearestDist = Infinity;
    for (const app of appPaths) {
      const maxDist = app.length >= 8 ? 2 : 1;
      const d = editDistanceWithin(p, app, maxDist);
      if (d <= maxDist && d < nearestDist) {
        nearest = app;
        nearestDist = d;
      }
    }
    if (nearest !== undefined) return done("typo", { matchedAppPath: nearest });
    // 6. Anything else is a non-app path of unknown shape.
    return done("unknown_non_app");
  };

  return { classify, appPaths };
}
