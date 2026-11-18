/**
 * Canary preload miss (ABG-02, Step-0 PASS-LAB, seed 20321202) - port
 * of tarrinho/AntiBotGW detection/canary.py `inject_canary_probe` +
 * `check_canary_probe` (CANARY_PROBE_MIN_HTML 5, CANARY_PROBE_TTL_SECS
 * 60, reset after fire) with the applied weight from
 * core/proxy_handler.py (RISK_WEIGHTS "canary-probe-miss" = 35).
 *
 * WHAT IT MEASURES. The host injects a preload probe into served HTML
 * (see `canaryPreloadProbeTag`). A client that executes / preloads
 * fetches the probe; a non-executing client never does. After an
 * identity has been served at least 5 HTML pages spanning at least
 * 60 s without ever fetching the probe, the check fires ONCE with the
 * applied weight 35, then the counter resets (the source's
 * CANARY_PROBE_SCORE 20 is only the trigger truthy value, R-ABG-5;
 * it is exported here as the trigger value, never as the weight).
 * An identity that has fetched the probe even once is confirmed and
 * never fires ("Already confirmed as browser - no signal").
 *
 * PACING SENSITIVITY (measured, descriptive). The fire page depends
 * on client pacing: over 20 seeded replicas with page interval
 * U(10,18) s, the miss fired at page 5 in 3 replicas, page 6 in 10
 * and page 7 in 7 (a 3/10/7 split), because the 5-page count and the
 * 60 s TTL interact. The frozen schedule (15 s interval) fires
 * exactly at page 5. Hosts must not read the fire page as a precise
 * behavioural measurement.
 *
 * FALSE-POSITIVE HONESTY (binding). Preload-blocked browsers -
 * browsers whose preload is blocked by an extension, an ad-blocker
 * or a policy - are a DISTINCT false-positive class. They were
 * recorded separately in the lab (client C, miss class
 * PRELOAD-BLOCKED) and were NOT measured on real browsers: no
 * real-browser false-positive rate exists for this signal. The host
 * marks identities it knows to be in that class via the
 * `preloadBlocked` hint on `noteHtml`; the result then carries
 * missClass "preload_blocked" instead of "no_execution", and hosts
 * must treat the two classes differently. Without the hint the
 * module cannot tell a blocked browser from a non-executing client.
 *
 * ADVISORY ONLY, OPT-IN. Every result carries enforcement: "none"
 * and the applied weight is a scoring input for the host's own
 * scorer (canary family), never a consequence by itself. Nothing
 * runs until the host constructs an instance and feeds it page and
 * probe events. State is bounded (`maxIdentities`, least recently
 * active evicted).
 */

/** Pages an identity must be served before a miss can fire (source CANARY_PROBE_MIN_HTML). */
export const CANARY_PRELOAD_MIN_HTML = 5;
/** Span in ms the served pages must cover before a miss can fire (source CANARY_PROBE_TTL_SECS 60). */
export const CANARY_PRELOAD_TTL_MS = 60_000;
/** The weight actually applied by the source (RISK_WEIGHTS "canary-probe-miss"). */
export const CANARY_PRELOAD_APPLIED_WEIGHT = 35;
/** The source's trigger truthy value (CANARY_PROBE_SCORE). NOT the applied weight (R-ABG-5). */
export const CANARY_PRELOAD_TRIGGER_VALUE = 20;

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): an identity was served HTML carrying a preload " +
  "probe and never fetched it. Applied weight 35 (the source trigger value 20 is not the weight). " +
  "Preload-blocked browsers are a distinct false-positive class that was NOT measured on real " +
  "browsers; no real-browser false-positive rate is claimed. The fire page is pacing-sensitive " +
  "(20 seeded replicas split 3/10/7 over pages 5/6/7). Never a sole blocking key.";

export type CanaryPreloadMissClass = "no_execution" | "preload_blocked";

export interface CanaryPreloadProbeOptions {
  /** Pages before a miss can fire. Defaults to 5 (source constant). */
  minHtml?: number;
  /** Span in ms the pages must cover. Defaults to 60,000 (source constant). */
  ttlMs?: number;
  /** Maximum identities tracked at once (least recently active evicted). Defaults to 10,000. */
  maxIdentities?: number;
}

export interface CanaryPreloadCheck {
  kind: "canary_preload_miss";
  identity: string;
  /** True exactly on the single check where the miss fires. */
  fired: boolean;
  /** The applied weight when fired (35); 0 otherwise. */
  weight: number;
  /** The source trigger value (20) when fired; 0 otherwise. Reported separately from the weight. */
  triggerValue: number;
  /** Distinct FP class: "preload_blocked" when the host marked the identity, else "no_execution". */
  missClass: CanaryPreloadMissClass;
  /** Pages counted in the current (post-reset) window at check time. */
  htmlCount: number;
  /** True once the identity has fetched the probe at least once; confirmed identities never fire. */
  confirmed: boolean;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface CanaryPreloadProbeInstance {
  /**
   * Record one served HTML page carrying the probe for `identity`.
   * `opts.preloadBlocked` marks the distinct FP class (the host
   * knows this identity's browser blocks preloads).
   */
  noteHtml(identity: string, nowMs?: number, opts?: { preloadBlocked?: boolean }): void;
  /** Record the probe being fetched by `identity` (confirms the identity; it never fires after this). */
  noteProbeFetch(identity: string, nowMs?: number): void;
  /** Run the miss check for `identity` (the host runs this after each HTML response). */
  check(identity: string, nowMs?: number): CanaryPreloadCheck;
  /** Number of identities currently tracked. */
  trackedIdentities(): number;
}

interface ProbeState {
  firstSeenMs: number | null;
  htmlCount: number;
  confirmed: boolean;
  preloadBlocked: boolean;
  lastSeenSeq: number;
}

const escapeHtmlAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The preload probe tag the host injects into served HTML. A client
 * that honours preloads fetches `probePath`; the host records that
 * fetch with `noteProbeFetch`.
 */
export function canaryPreloadProbeTag(probePath: string): string {
  return `<link rel="preload" as="fetch" href="${escapeHtmlAttribute(probePath)}">`;
}

export function createCanaryPreloadProbe(
  options: CanaryPreloadProbeOptions = {},
): CanaryPreloadProbeInstance {
  const minHtml = options.minHtml ?? CANARY_PRELOAD_MIN_HTML;
  const ttlMs = options.ttlMs ?? CANARY_PRELOAD_TTL_MS;
  const maxIdentities = options.maxIdentities ?? 10_000;
  if (!Number.isInteger(minHtml) || minHtml < 1) throw new Error("createCanaryPreloadProbe: minHtml must be a positive integer");
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("createCanaryPreloadProbe: ttlMs must be a finite number >= 0");
  if (!Number.isInteger(maxIdentities) || maxIdentities < 1) throw new Error("createCanaryPreloadProbe: maxIdentities must be a positive integer");

  const states = new Map<string, ProbeState>();
  let seq = 0;

  function stateFor(identity: string): ProbeState {
    if (typeof identity !== "string" || identity.length === 0) {
      throw new Error("canary preload probe: identity must be a non-empty string");
    }
    const existing = states.get(identity);
    if (existing) {
      existing.lastSeenSeq = seq++;
      states.delete(identity);
      states.set(identity, existing);
      return existing;
    }
    if (states.size >= maxIdentities) {
      const oldest = states.keys().next().value as string | undefined;
      if (oldest !== undefined) states.delete(oldest);
    }
    const fresh: ProbeState = { firstSeenMs: null, htmlCount: 0, confirmed: false, preloadBlocked: false, lastSeenSeq: seq++ };
    states.set(identity, fresh);
    return fresh;
  }

  return {
    noteHtml(identity, nowMs = Date.now(), opts = {}) {
      const st = stateFor(identity);
      if (st.firstSeenMs === null) st.firstSeenMs = nowMs;
      st.htmlCount += 1;
      if (opts.preloadBlocked) st.preloadBlocked = true;
    },
    noteProbeFetch(identity) {
      stateFor(identity).confirmed = true;
    },
    check(identity, nowMs = Date.now()) {
      const st = stateFor(identity);
      const base = {
        kind: "canary_preload_miss" as const,
        identity,
        missClass: (st.preloadBlocked ? "preload_blocked" : "no_execution") as CanaryPreloadMissClass,
        confirmed: st.confirmed,
        enforcement: "none" as const,
        notice: ADVISORY_NOTICE,
      };
      if (st.confirmed || st.htmlCount < minHtml || st.firstSeenMs === null || nowMs - st.firstSeenMs < ttlMs) {
        return { ...base, fired: false, weight: 0, triggerValue: 0, htmlCount: st.htmlCount };
      }
      const countAtFire = st.htmlCount;
      // Reset after fire (source canary.py:404-406): the next miss
      // needs a fresh minHtml pages over a fresh TTL span.
      st.htmlCount = 0;
      st.firstSeenMs = nowMs;
      return {
        ...base,
        fired: true,
        weight: CANARY_PRELOAD_APPLIED_WEIGHT,
        triggerValue: CANARY_PRELOAD_TRIGGER_VALUE,
        htmlCount: countAtFire,
      };
    },
    trackedIdentities() {
      return states.size;
    },
  };
}
