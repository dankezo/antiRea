/**
 * Self-verification traps (antiRea 3.3.3, X33-12) - OPT-IN,
 * default OFF.
 *
 * WHAT IT DOES. A careful consumer does not trust one surface:
 * it cross-checks a fact on several channels before adopting
 * it. This module makes every channel the flagged identity can
 * check AGREE on the same decoy fact, because every channel is
 * served from the same identity-gated value: the visible DOM
 * line, the aria-label, the spec field, the stats endpoint and
 * the comment inside the source map all state the decoy number.
 * Cross-checking then manufactures false confidence - the
 * consumer reports the fact as independently verified when all
 * "independent" sources had one origin. Ported from the
 * headline twin (twin-server-x33-headline.cjs: decoy fact
 * "2,040 records" against a real 2,000, on the DOM line
 * `Catalog - 2,040 products`, the aria-label
 * `Product catalog, 2040 products`, the spec totalRecords, the
 * /api/stats totalRecords, and the source-map comment
 * `// catalog snapshot: 2040 records (config).` in the pricing
 * source of the flagged map; the real listing route always told
 * the truth).
 *
 * THE TRACE ASPECT. Verification depth is observable
 * server-side: `noteVisit` records which channels an identity
 * actually consulted, so the host can see a consumer performing
 * its cross-checks inside the trap. Visits are counted per
 * identity as DISTINCT channels; re-visiting a channel does
 * not deepen the count.
 *
 * MEASURED BASIS. X33-12 passed Wave 2 and is one of the four
 * mechanisms of the composed headline trial (composite drove
 * REA-default task-success from 100% to 0% on both lab twins,
 * real-user false positives 0). In HV-00a the agent
 * cross-checked the decoy total and still adopted the decoy
 * rule with verified: true - the poison held at the rule layer
 * even where the total was checked. All agent numbers in this
 * program are lab numbers on free models.
 *
 * CLAIM DISCIPLINE (freeze section 2.2). The channels agree
 * because they share one origin; nothing here is independent
 * corroboration, and the module must never be described as
 * providing any. It prevents no record from being read and
 * makes no cost claim.
 *
 * CONTRACT.
 * - Disabled, or for a clean identity, every channel renders
 *   the real value and `mapWithFact` returns its input string
 *   UNCHANGED (byte-identical). Clean identities receive
 *   byte-identical output with the module ON vs OFF.
 * - For a flagged identity, ALL channels render the decoy
 *   value - partial agreement would break the mechanism, so
 *   there is no per-channel switch.
 * - `mapWithFact` on a flagged identity appends the map
 *   comment to sourcesContent[mapSourceIndex] of the given
 *   map; an out-of-range index returns the input unchanged.
 */

export type SelfVerificationChannel = "dom-line" | "aria-label" | "spec-field" | "stats-endpoint" | "map-comment";

export interface SelfVerificationFact {
  realValue: number;
  decoyValue: number;
  /** Noun used by the text channels. Default "products". */
  noun?: string;
}

export interface SelfVerificationTrapOptions {
  /** The module acts only when this is exactly `true`. Default false (OFF). */
  enabled?: boolean;
  /** Flagging seam: return true for identities that receive the decoy fact. Default: nobody is flagged. */
  isFlagged?: (identity: string) => boolean;
  /** The fact: the real value and the decoy value every channel agrees on for flagged identities. */
  fact: SelfVerificationFact;
  /** Index into a source map's sourcesContent that receives the map comment. Default 2 (the trial's pricing source). */
  mapSourceIndex?: number;
  /** Called on each noted visit with the identity, the channel and the resulting distinct-channel depth. */
  onVisit?: (identity: string, channel: SelfVerificationChannel, depth: number) => void;
}

export interface SelfVerificationTrap {
  readonly enabled: boolean;
  /** The value every channel states for this identity. */
  valueFor: (identity: string) => number;
  /** DOM line channel: `Catalog - 2,040 products`. */
  domLineFor: (identity: string) => string;
  /** Aria-label channel: `Product catalog, 2,040 products`. */
  ariaLabelFor: (identity: string) => string;
  /** Spec field channel: the raw number. */
  specValueFor: (identity: string) => number;
  /** Stats endpoint channel: `{ totalRecords: value }`. */
  statsFor: (identity: string) => { totalRecords: number };
  /** Source-map comment channel: `// catalog snapshot: 2040 records (config).` */
  mapCommentFor: (identity: string) => string;
  /** The given source map with the fact comment composed in (flagged identities only). */
  mapWithFact: (mapJson: string, identity: string) => string;
  /** Record a channel visit; returns the number of DISTINCT channels this identity has visited. */
  noteVisit: (identity: string, channel: SelfVerificationChannel) => number;
}

/** The closed channel set of the module (mirrors SelfVerificationChannel). */
const KNOWN_CHANNELS: ReadonlySet<string> = new Set([
  "dom-line",
  "aria-label",
  "spec-field",
  "stats-endpoint",
  "map-comment",
]);

/** Thousands separators, en-US style: 2040 -> "2,040". */
const fmt = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Create the self-verification trap. See the module header for the full contract. */
export function createSelfVerificationTrap(opts: SelfVerificationTrapOptions): SelfVerificationTrap {
  const enabled = opts.enabled === true;
  const isFlagged = opts.isFlagged ?? (() => false);
  const noun = opts.fact.noun ?? "products";
  const mapSourceIndex = opts.mapSourceIndex ?? 2;
  const visits = new Map<string, Set<SelfVerificationChannel>>();

  const valueFor = (identity: string): number =>
    enabled && isFlagged(identity) ? opts.fact.decoyValue : opts.fact.realValue;

  const mapCommentFor = (identity: string): string =>
    `// catalog snapshot: ${valueFor(identity)} records (config).`;

  const mapWithFact = (mapJson: string, identity: string): string => {
    if (!enabled || !isFlagged(identity)) return mapJson;
    try {
      const parsed = JSON.parse(mapJson) as { sourcesContent?: unknown };
      if (!Array.isArray(parsed.sourcesContent)) return mapJson;
      const current = parsed.sourcesContent[mapSourceIndex];
      if (typeof current !== "string") return mapJson;
      parsed.sourcesContent[mapSourceIndex] = `${current}\n${mapCommentFor(identity)}`;
      return JSON.stringify(parsed);
    } catch {
      return mapJson;
    }
  };

  const noteVisit = (identity: string, channel: SelfVerificationChannel): number => {
    // Only the five real channels count toward verification depth:
    // the TS union is not enforced for JS hosts, and an arbitrary
    // string must not inflate depth past the number of channels
    // that exist. Unknown channels are ignored (current depth is
    // returned, nothing is recorded, onVisit does not fire).
    if (!KNOWN_CHANNELS.has(channel)) return visits.get(identity)?.size ?? 0;
    let seen = visits.get(identity);
    if (!seen) {
      seen = new Set<SelfVerificationChannel>();
      visits.set(identity, seen);
    }
    seen.add(channel);
    const depth = seen.size;
    try {
      opts.onVisit?.(identity, channel, depth);
    } catch {
      /* monitoring must never break the host */
    }
    return depth;
  };

  return {
    enabled,
    valueFor,
    domLineFor: (identity) => `Catalog - ${fmt(valueFor(identity))} ${noun}`,
    ariaLabelFor: (identity) => `Product catalog, ${fmt(valueFor(identity))} ${noun}`,
    specValueFor: valueFor,
    statsFor: (identity) => ({ totalRecords: valueFor(identity) }),
    mapCommentFor,
    mapWithFact,
    noteVisit,
  };
}
