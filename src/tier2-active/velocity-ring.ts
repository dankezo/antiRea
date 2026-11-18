/**
 * Velocity ring (NHS-10, antiRea 3.1.0).
 *
 * WHAT IT IS. A per-identity request ring: every request the host
 * observes for an identity is recorded, whatever its response status
 * (status-blind - a 500 counts exactly like a 200), and each request
 * is reported against the records that came BEFORE it: a request
 * never sees its own record. When the ring reaches the threshold,
 * the identity reads as exceeded; the exceeded state holds for the
 * configured exceed duration, records arriving while exceeded are
 * no-ops, and an expired exceeded state resets the ring on next
 * contact. This is a counting SIGNAL (enforcement: "none" on every
 * result): it blocks nothing, and what a host does with an exceeded
 * reading is the host's decision under its own tier rules.
 *
 * SEMANTICS (frozen in the NHS Step-0 lab, nhs-lab/nhs10.cjs,
 * RESULTS-NHS-STEP0.md; mechanism source sentinel_velocity.c over
 * the sentinel_shm.c ring, reading R-NHS-10): prune keeps events
 * with ts > now - interval; the lab zone is threshold 10, interval
 * 10 s, exceed (block in the source) 3600 s. The defaults below keep
 * those numbers, expressed in milliseconds.
 *
 * LAB EVIDENCE (Step-0, synthetic and frozen). Identity A, 12
 * requests at 1 s spacing: exceeded exactly at requests 11 and 12 -
 * request 10 is NOT exceeded, because at its check time only 9 prior
 * records exist and its own record is not yet in the ring (the 10th
 * record, made by request 10, trips the ring for request 11).
 * Identity B (3 requests, statuses 200/500/200) never exceeds and
 * its ring count is 3 including the 500: status-blind recording.
 */

export interface VelocityRingOptions {
  /** Records in the window at which the identity trips. Default 10. */
  threshold?: number;
  /** Window length in milliseconds. Default 10_000 (lab: 10 s). */
  intervalMs?: number;
  /** How long the exceeded state holds, in milliseconds. Default 3_600_000 (lab: 3600 s). */
  exceedMs?: number;
  /** Clock override, milliseconds. Default Date.now. */
  now?: () => number;
}

export interface VelocityObservation {
  kind: "velocity_ring";
  identity: string;
  /** True when this request's pre-record check found the identity exceeded. */
  exceeded: boolean;
  /** Prior in-window records this request was checked against (its own record excluded). */
  count: number;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
}

interface RingNode {
  events: number[];
  exceededUntil: number;
}

/**
 * Create a velocity ring. Opt-in signal: nothing is recorded unless
 * the host calls observe() (or check()/record()) per request.
 */
export function createVelocityRing(options: VelocityRingOptions = {}): {
  /** Check-then-record one request: the host's per-request entry point. */
  observe(identity: string, nowMs?: number): VelocityObservation;
  /** Read-only check (no record): what a request arriving now would see. */
  check(identity: string, nowMs?: number): { exceeded: boolean; count: number };
  /** Record one request without checking (log-phase wiring). */
  record(identity: string, nowMs?: number): void;
} {
  const threshold = options.threshold ?? 10;
  const intervalMs = options.intervalMs ?? 10_000;
  const exceedMs = options.exceedMs ?? 3_600_000;
  const clock = options.now ?? Date.now;
  if (!Number.isInteger(threshold) || threshold < 1) throw new TypeError("velocity ring: threshold must be a positive integer");
  const nodes = new Map<string, RingNode>();

  function node(key: string): RingNode {
    let n = nodes.get(key);
    if (!n) {
      n = { events: [], exceededUntil: 0 };
      nodes.set(key, n);
    }
    return n;
  }
  function prune(n: RingNode, now: number): void {
    const cut = now - intervalMs;
    n.events = n.events.filter((ts) => ts > cut);
  }
  function lookup(key: string, now: number): { exceeded: boolean; count: number } {
    const n = node(key);
    if (n.exceededUntil > now) return { exceeded: true, count: threshold };
    if (n.exceededUntil !== 0) {
      n.exceededUntil = 0;
      n.events = [];
    }
    prune(n, now);
    return { exceeded: false, count: n.events.length };
  }
  function record(key: string, now: number): void {
    const n = node(key);
    if (n.exceededUntil > now) return; // records while exceeded are no-ops
    if (n.exceededUntil !== 0) {
      n.exceededUntil = 0;
      n.events = [];
    }
    prune(n, now);
    n.events.push(now);
    if (n.events.length >= threshold) {
      n.exceededUntil = now + exceedMs;
      n.events = [];
    }
  }

  return {
    observe(identity, nowMs) {
      const now = nowMs ?? clock();
      const before = lookup(identity, now);
      record(identity, now);
      return {
        kind: "velocity_ring",
        identity,
        exceeded: before.exceeded,
        count: before.count,
        enforcement: "none",
      };
    },
    check: (identity, nowMs) => lookup(identity, nowMs ?? clock()),
    record: (identity, nowMs) => record(identity, nowMs ?? clock()),
  };
}
