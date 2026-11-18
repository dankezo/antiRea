/**
 * UA-map classifier - UA leg only (MGH-03, antiRea 3.1.0).
 * OPT-IN, advisory label only. A small addition beside
 * ua-classifier.ts (classifyUserAgent): that module answers "is
 * this UA in the named-bot catalogue"; this one answers "which
 * agent or scanner family does this UA declare itself to be",
 * using the frozen 10-entry map of the Mirage-HoneyPot
 * detect_llm_signature mechanism (trap.py:130-155).
 *
 * THE MAP. Ten entries, frozen, matched as lowercase substrings
 * of the lowercased User-Agent, first entry in insertion order
 * wins:
 *   gptbot, claudebot, ccbot, bytespider, amazonbot, googlebot,
 *   bingbot, langchain, python-requests, go-http-client.
 * Insertion-order precedence is load-bearing: a UA carrying both
 * "langchain" and "python-requests" labels as the LangChain
 * agent, because langchain precedes python-requests in the map.
 * Updates are reviewed changes, never self-expanding: nothing
 * here learns, fetches, or widens the map at runtime.
 *
 * BINDING RESTRICTION - THE PAYLOAD-MARKER LEG IS NOT BUILT. The
 * source mechanism has a second leg: a payload containing
 * "assistant:" / "human:" / "system:" / "user:" labels as
 * "Possible LLM Prompt Interaction". In the lab that leg tripped
 * 10/16 legitimate payloads, and every natural-language class
 * tripped in full (YAML config text 2/2, chat and support
 * transcripts 3/3, documentation markdown 3/3, log lines 2/2;
 * only structured JSON and form bodies stayed clean, because a
 * quoted JSON key never yields the bare substring). The marker
 * leg is therefore not usable as registered and is deliberately
 * absent here: this classifier takes no payload input at all, so
 * no payload a host carries can trip it. Do not re-add a payload
 * leg without a structural context check and a fresh FP
 * measurement.
 *
 * MEASURED (MGH Step-0 lab, mgh-lab/RESULTS-MGH-STEP0.md, frozen
 * corpora): UA battery 10/10 labels exact; precedence 2/2 exact;
 * 12/12 real browser UAs fall through unlabelled (to the default
 * label below); no-consequence 47/47 battery requests produced
 * identical escalation outcomes with and without this label
 * under the frozen consumer that escalates only when at least 2
 * independent detector families flag the same request - this
 * classifier is one family, so alone it escalates nothing.
 *
 * FALL-THROUGH. A UA matching no map entry carries no map label
 * (`mapLabel: null`, `matched: false`). Its `label` is the source
 * mechanism's default, "Generic Automated Scanner", retained for
 * lab compatibility; hosts should key only on `mapLabel` and
 * `matched`, never on the default string.
 *
 * ADVISORY ONLY, LOW TIER. Labels are self-declared-UA
 * classifications, spoofable in one line in both directions: a
 * curl client presenting a GPTBot UA receives the GPTBot label
 * (labelling works; that is all it does). A label is never a
 * sole blocking key and never an exemption.
 *
 * Pure computation: no I/O, no state, no runtime dependencies.
 */

/** Default label for a UA matching no map entry (source mechanism, verbatim). */
export const UA_MAP_DEFAULT_LABEL = "Generic Automated Scanner";

/**
 * The frozen 10-entry UA-to-label map, in insertion order. Order
 * is semantics: the first matching entry wins.
 */
export const UA_MAP_ENTRIES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  Object.freeze(["gptbot", "OpenAI GPTBot"] as const),
  Object.freeze(["claudebot", "Anthropic ClaudeBot"] as const),
  Object.freeze(["ccbot", "CommonCrawl Bot"] as const),
  Object.freeze(["bytespider", "ByteDance/TikTok Bot"] as const),
  Object.freeze(["amazonbot", "Amazon Crawler"] as const),
  Object.freeze(["googlebot", "Google Search/AI"] as const),
  Object.freeze(["bingbot", "Bing Search/AI"] as const),
  Object.freeze(["langchain", "LangChain Agent"] as const),
  Object.freeze(["python-requests", "Python Automation"] as const),
  Object.freeze(["go-http-client", "Go-based Scanner"] as const),
]);

/** The same map as a frozen record, for hosts that want key lookup. Iteration order follows UA_MAP_ENTRIES. */
export const UA_MAP: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(UA_MAP_ENTRIES),
);

export interface UaMapClassification {
  kind: "ua_map_classification";
  /** The map label, or the default label when no entry matches. Key host logic on `mapLabel`, not this field. */
  label: string;
  /** The map label when an entry matched; null when the UA fell through unlabelled. */
  mapLabel: string | null;
  /** The map key that matched, in insertion-order precedence; null on fall-through. */
  matchedKey: string | null;
  /** True exactly when a map entry matched. */
  matched: boolean;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): a frozen 10-entry User-Agent map label " +
  "(MGH-03 UA leg only; the source payload-marker leg is not built - it tripped 10/16 " +
  "legitimate payloads in the lab, every natural-language class in full). UA strings " +
  "are self-declared and spoofable in both directions; a label is never a sole " +
  "blocking key or an exemption.";

/**
 * Classify one User-Agent string against the frozen map.
 * Lowercase substring match, first entry in insertion order wins.
 * There is deliberately no payload parameter (see the binding
 * restriction in the module header).
 */
export function classifyByUaMap(userAgent: string | null | undefined): UaMapClassification {
  const ua = (userAgent ?? "").toLowerCase();
  for (const [key, label] of UA_MAP_ENTRIES) {
    if (ua.includes(key)) {
      return {
        kind: "ua_map_classification",
        label,
        mapLabel: label,
        matchedKey: key,
        matched: true,
        enforcement: "none",
        notice: ADVISORY_NOTICE,
      };
    }
  }
  return {
    kind: "ua_map_classification",
    label: UA_MAP_DEFAULT_LABEL,
    mapLabel: null,
    matchedKey: null,
    matched: false,
    enforcement: "none",
    notice: ADVISORY_NOTICE,
  };
}
