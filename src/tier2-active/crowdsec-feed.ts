/**
 * CrowdSec feed importer (NHS-07, antiRea 3.1.0).
 *
 * WHAT IT IS. A parser/importer over a flat CrowdSec-style feed the
 * HOST supplies as data. antiRea is zero-dependency and performs no
 * network fetching: the host fetches (or receives) the feed text and
 * hands it to load(); this module validates and applies it. The
 * contributions it returns are ADVISORY scores only - in antiRea
 * form this feed never enforces anything by itself; the host decides
 * what a contribution means next to its other signals.
 *
 * FEED FORMAT AND VALIDATION (frozen in the NHS Step-0 lab,
 * nhs-lab/nhs07.cjs, RESULTS-NHS-STEP0.md; mechanism source
 * sentinel_feed.c):
 * - header line exactly "# sentinel-crowdsec-feed v1";
 * - decision lines "<ip> <action> <expiry-epoch>", action one of
 *   ban / captcha / throttle; CIDR lines and bad IPs count as
 *   malformed, they never match anything;
 * - trailer "%%EOF N crc32hex": N counts VALID decision lines and
 *   the CRC-32 (zlib) covers the bytes after the header line up to
 *   the trailer. A corrupt CRC or a count mismatch rejects the feed;
 * - a feed whose malformed fraction exceeds 25% is rejected;
 * - every rejection leaves the last-good table fully intact;
 * - applying a feed REPLACES the table (mark-sweep): entries absent
 *   from the new feed are gone;
 * - reload is gated on the mtime of the last SUCCESSFUL load:
 *   re-presenting the same mtime is skipped, generation unchanged;
 * - entries age out only at their own expiry: a lookup at expiry-1
 *   hits, at expiry+1 misses.
 *
 * TIER CONTRIBUTIONS (advisory): ban 100, captcha 40, throttle 65.
 *
 * LAB EVIDENCE (Step-0, synthetic feeds; no real feed touched).
 * Feed A accepted (5 valid, 1 malformed) with exact tier
 * contributions; the expired line never hits; feed B sweeps the
 * removed IP and its CIDR line never matches; corrupt-CRC and
 * over-25%-malformed feeds both rejected with last-good intact.
 */

export type CrowdsecAction = "ban" | "captcha" | "throttle";

export const CROWDSEC_TIER_CONTRIBUTIONS: Readonly<Record<CrowdsecAction, number>> = Object.freeze({
  ban: 100,
  captcha: 40,
  throttle: 65,
});

export const CROWDSEC_FEED_HEADER = "# sentinel-crowdsec-feed v1";

const ACTIONS: readonly string[] = ["ban", "captcha", "throttle"];

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** zlib CRC-32 (IEEE, reflected) of a UTF-8 string, as 8 lowercase hex chars. */
export function crowdsecFeedCrc32(text: string): string {
  const buf = new TextEncoder().encode(text);
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function validIp(s: string): boolean {
  if (s.includes("/")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.split(".").every((p) => Number(p) <= 255);
  return /^[0-9a-fA-F:]+$/.test(s) && s.includes(":");
}

interface ParsedLine {
  ip: string;
  action: CrowdsecAction;
  expiry: number;
}

function parseLine(line: string): ParsedLine | null {
  const parts = line.split(" ");
  if (parts.length !== 3) return null;
  const [ip, action, expiryRaw] = parts as [string, string, string];
  if (!validIp(ip)) return null;
  if (!ACTIONS.includes(action)) return null;
  if (!/^-?\d+$/.test(expiryRaw)) return null;
  return { ip, action: action as CrowdsecAction, expiry: Number(expiryRaw) };
}

export type CrowdsecFeedLoadResult =
  | { result: "accepted"; valid: number; malformed: number; generation: number }
  | { result: "skipped" }
  | { result: "rejected"; reason: string; valid?: number; malformed?: number };

export interface CrowdsecFeedEntry {
  action: CrowdsecAction;
  /** Advisory score contribution of the action (ban 100 / captcha 40 / throttle 65). */
  contribution: number;
  expiry: number;
}

/**
 * Create a feed importer instance holding one last-good table.
 * Opt-in: nothing is loaded until the host calls load().
 */
export function createCrowdsecFeedImporter(): {
  load(text: string, mtime: string | number): CrowdsecFeedLoadResult;
  /** The live entry for an IP at `nowSec` (epoch seconds), or null when absent or expired. */
  lookup(ip: string, nowSec: number): CrowdsecFeedEntry | null;
  /** Advisory contribution for an IP at `nowSec`, or null. Never enforces. */
  contributionFor(ip: string, nowSec: number): number | null;
  /** Deterministic "ip action expiry" join of the current table, for tests and audits. */
  snapshot(): string;
  readonly generation: number;
} {
  let entries = new Map<string, { action: CrowdsecAction; expiry: number }>();
  let generation = 0;
  let lastMtime: string | number | null = null;

  function load(text: string, mtime: string | number): CrowdsecFeedLoadResult {
    if (mtime === lastMtime) return { result: "skipped" };
    const nl = text.indexOf("\n");
    if (nl < 0 || text.slice(0, nl) !== CROWDSEC_FEED_HEADER) return { result: "rejected", reason: "header" };
    const bodyStart = nl + 1;
    const tIdx = text.indexOf("\n%%EOF ", bodyStart);
    if (tIdx < 0) return { result: "rejected", reason: "no-trailer" };
    const trailerStart = tIdx + 1;
    const body = text.slice(bodyStart, trailerStart);
    const trailerLine = text.slice(trailerStart).split("\n")[0] as string;
    const tm = /^%%EOF (\d+) ([0-9a-fA-F]+)$/.exec(trailerLine);
    if (!tm) return { result: "rejected", reason: "trailer-format" };
    let valid = 0;
    let malformed = 0;
    const parsed: ParsedLine[] = [];
    for (const line of body.split("\n")) {
      if (line === "" || line.startsWith("#")) continue;
      const p = parseLine(line);
      if (p) {
        valid++;
        parsed.push(p);
      } else {
        malformed++;
      }
    }
    if (Number(tm[1]) !== valid || (tm[2] as string).toLowerCase() !== crowdsecFeedCrc32(body)) {
      return { result: "rejected", reason: "trailer-mismatch", valid, malformed };
    }
    if (malformed > 0 && malformed * 4 > valid + malformed) {
      return { result: "rejected", reason: "malformed-fraction", valid, malformed };
    }
    generation++;
    entries = new Map(parsed.map((p) => [p.ip, { action: p.action, expiry: p.expiry }]));
    lastMtime = mtime;
    return { result: "accepted", valid, malformed, generation };
  }

  function lookup(ip: string, nowSec: number): CrowdsecFeedEntry | null {
    const e = entries.get(ip);
    if (!e || e.expiry <= nowSec) return null;
    return { action: e.action, contribution: CROWDSEC_TIER_CONTRIBUTIONS[e.action], expiry: e.expiry };
  }

  return {
    load,
    lookup,
    contributionFor: (ip, nowSec) => lookup(ip, nowSec)?.contribution ?? null,
    snapshot: () =>
      [...entries.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([ip, e]) => `${ip} ${e.action} ${e.expiry}`)
        .join("|"),
    get generation() {
      return generation;
    },
  };
}

/**
 * Build a well-formed feed text from decision lines (host tooling and
 * tests): computes the valid-line count and CRC exactly as load()
 * verifies them. `corruptCrc` flips one CRC digit, for rejection tests.
 */
export function buildCrowdsecFeed(decisionLines: readonly string[], corruptCrc = false): string {
  const body = decisionLines.join("\n") + "\n";
  const valid = decisionLines.filter((l) => l !== "" && !l.startsWith("#") && parseLine(l)).length;
  let crc = crowdsecFeedCrc32(body);
  if (corruptCrc) crc = (crc[0] === "0" ? "1" : "0") + crc.slice(1);
  return CROWDSEC_FEED_HEADER + "\n" + body + "%%EOF " + valid + " " + crc + "\n";
}
