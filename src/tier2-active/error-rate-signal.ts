/**
 * Error-rate burst signal (NHS-11, antiRea 3.1.0) - the ADVISORY
 * variant. The measured lab form is enforcement and is NOT built.
 *
 * WHAT WAS MEASURED (NHS Step-0 lab, nhs-lab/nhs11.cjs,
 * RESULTS-NHS-STEP0.md; mechanism source sentinel errrate ring over
 * sentinel_shm.c): only responses with status >= 400 are recorded;
 * at the 5th recorded error in the window the source sets
 * blocked_until = now + 3600; records arriving while blocked do not
 * extend blocked_until; stale events prune at the window edge; the
 * block lifts after its TTL.
 *
 * THE UPGRADE PATH TAKEN HERE. That block is enforcement, so this
 * build ships the same ring mechanics as a counting SIGNAL with the
 * block replaced by a burst flag: at the 5th recorded error the
 * signal reports burst with burstUntil = now + burstMs (the lab's
 * 3600 s); records while burst do not extend burstUntil; after
 * burstUntil the burst clears and the ring resets on next contact.
 * The module blocks nothing, sets nothing on any response, and
 * carries enforcement: "none" on every result. Hosts that consume a
 * burst reading do so under their own tier rules. The advisory
 * variant's fixture behaviour is measured by this module's own
 * suite, which replays the lab's A/B/C sequences exactly.
 *
 * Zone defaults keep the lab numbers: threshold 5, window 300 s,
 * burst 3600 s (expressed in milliseconds).
 */

export interface ErrorRateSignalOptions {
  /** Recorded errors in the window that trip the burst flag. Default 5. */
  threshold?: number;
  /** Window length in milliseconds. Default 300_000 (lab: 300 s). */
  intervalMs?: number;
  /** Burst hold length in milliseconds. Default 3_600_000 (lab: 3600 s). */
  burstMs?: number;
  /** Clock override, milliseconds. Default Date.now. */
  now?: () => number;
}

export interface ErrorRateObservation {
  kind: "error_rate";
  identity: string;
  /** True when this request carried status >= 400 and was recorded. */
  recorded: boolean;
  /** In-window recorded errors this request was checked against, before its own record. */
  count: number;
  /**
   * The burst flag as this request found it (pre-record, the lab's
   * lookup order): requests 1-5 of a burst sequence read false, the
   * requests after the 5th recorded error read true.
   */
  burst: boolean;
  /** The burst flag after this request's own record was applied. */
  burstAfter: boolean;
  /** When the burst clears, in the clock's milliseconds; 0 when not burst. */
  burstUntil: number;
  /** Always "none": this signal enforces nothing. */
  enforcement: "none";
}

interface ErrorNode {
  events: number[];
  burstUntil: number;
}

/** Create an advisory error-rate burst signal. Opt-in counting signal. */
export function createErrorRateSignal(options: ErrorRateSignalOptions = {}): {
  /** Observe one completed request: records it iff status >= 400. */
  observe(identity: string, status: number, nowMs?: number): ErrorRateObservation;
  /** Read-only snapshot for an identity. */
  snapshot(identity: string, nowMs?: number): { count: number; burst: boolean; burstUntil: number };
} {
  const threshold = options.threshold ?? 5;
  const intervalMs = options.intervalMs ?? 300_000;
  const burstMs = options.burstMs ?? 3_600_000;
  const clock = options.now ?? Date.now;
  if (!Number.isInteger(threshold) || threshold < 1) throw new TypeError("error-rate signal: threshold must be a positive integer");
  const nodes = new Map<string, ErrorNode>();

  function node(key: string): ErrorNode {
    let n = nodes.get(key);
    if (!n) {
      n = { events: [], burstUntil: 0 };
      nodes.set(key, n);
    }
    return n;
  }
  function prune(n: ErrorNode, now: number): void {
    const cut = now - intervalMs;
    n.events = n.events.filter((ts) => ts > cut);
  }
  /** Shared state step for reads: an expired burst resets the ring. */
  function settle(n: ErrorNode, now: number): void {
    if (n.burstUntil !== 0 && n.burstUntil <= now) {
      n.burstUntil = 0;
      n.events = [];
    }
    prune(n, now);
  }

  function snapshot(identity: string, nowMs?: number): { count: number; burst: boolean; burstUntil: number } {
    const now = nowMs ?? clock();
    const n = node(identity);
    settle(n, now);
    const burst = n.burstUntil > now;
    return { count: burst ? threshold : n.events.length, burst, burstUntil: burst ? n.burstUntil : 0 };
  }

  return {
    observe(identity: string, status: number, nowMs?: number): ErrorRateObservation {
      const now = nowMs ?? clock();
      const n = node(identity);
      const recorded = status >= 400;
      if (n.burstUntil > now) {
        // While burst, records do not extend burstUntil (lab law).
        return {
          kind: "error_rate",
          identity,
          recorded,
          count: threshold,
          burst: true,
          burstAfter: true,
          burstUntil: n.burstUntil,
          enforcement: "none",
        };
      }
      settle(n, now);
      const countBefore = n.events.length;
      if (recorded) {
        n.events.push(now);
        if (n.events.length >= threshold) {
          n.burstUntil = now + burstMs;
          n.events = [];
        }
      }
      const burstAfter = n.burstUntil > now;
      return {
        kind: "error_rate",
        identity,
        recorded,
        count: countBefore,
        burst: false,
        burstAfter,
        burstUntil: burstAfter ? n.burstUntil : 0,
        enforcement: "none",
      };
    },
    snapshot,
  };
}
