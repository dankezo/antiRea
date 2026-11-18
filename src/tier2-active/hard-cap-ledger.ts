/**
 * Hard-cap accounting ledger (NHS-08, antiRea 3.1.0) - the
 * accounting invariant ONLY.
 *
 * HOUSE RULE, ENCODED. Tarpit adoption is against the recorded
 * house rule for antiRea, and this module ships NO tarpit and NO
 * delay mechanism: nothing here holds, drips or slows a connection.
 * What the NHS lab measured as transferable is the ACCOUNTING
 * invariant of sentinel_tarpit.c, and that invariant alone is what
 * this standalone ledger provides, for hosts that run their own
 * (separately decided) bounded-concurrency mechanism and need the
 * counting to be exact:
 * - a global hard cap across per-worker sub-counters: the total
 *   NEVER exceeds the cap, after every event (the source's own
 *   reserve overshoots its cap by up to worker_processes - 1; that
 *   defect is recorded in the lab and is NOT reproduced here - this
 *   ledger is the corrected hard-cap form the lab gated);
 * - at cap, a reserve is refused immediately - there is no queue,
 *   and a refused id is NOT admitted later when a slot frees;
 * - exactly one decrement path: release() is guarded, so a double
 *   release (abort racing a deadline racing a close) is a no-op;
 * - a worker respawn zeroes that worker's sub-counter and drops
 *   its holds; the total falls by exactly that worker's count.
 *
 * LAB EVIDENCE (Step-0, nhs-lab/nhs08.cjs, RESULTS-NHS-STEP0.md).
 * Across the 13-event scenario at cap 4 with 2 workers: maxObserved
 * 4, the invariant holds after every event, the 5th reserve is
 * refused and stays unadmitted, abort and deadline each decrement
 * exactly once, respawn drops the total 3 to 0 with its three live
 * holds, and the counter ends at exactly 0.
 */

export interface HardCapLedgerOptions {
  /** Global hard cap on simultaneous holds. Must be a positive integer. */
  cap: number;
  /** Number of per-worker sub-counters. Default 1. */
  workers?: number;
}

export interface HardCapLedgerSnapshot {
  total: number;
  perWorker: number[];
  maxObserved: number;
  /** total == sum(perWorker) AND 0 <= total <= cap. */
  invariantOk: boolean;
}

/**
 * Create a hard-cap ledger. Pure in-memory accounting: no timers,
 * no I/O, no delay. Opt-in utility for hosts with their own
 * bounded-concurrency mechanism.
 */
export function createHardCapLedger(options: HardCapLedgerOptions): {
  /** Reserve one slot for `id` on `worker`. False at cap (immediate refusal, no queue). */
  tryReserve(id: string, worker?: number): boolean;
  /** The single decrement path. False when the id is not held (double release is a no-op). */
  release(id: string): boolean;
  /** Zero one worker's sub-counter, dropping its holds (worker respawn). */
  respawnWorker(worker: number): void;
  has(id: string): boolean;
  total(): number;
  snapshot(): HardCapLedgerSnapshot;
} {
  const cap = options?.cap;
  const workers = options?.workers ?? 1;
  if (!Number.isInteger(cap) || cap < 1) throw new TypeError("hard-cap ledger: cap must be a positive integer");
  if (!Number.isInteger(workers) || workers < 1) throw new TypeError("hard-cap ledger: workers must be a positive integer");
  const sub = new Array<number>(workers).fill(0);
  const holds = new Map<string, { worker: number; counted: boolean }>();
  let total = 0;
  let maxObserved = 0;

  function checkWorker(worker: number): void {
    if (!Number.isInteger(worker) || worker < 0 || worker >= workers) {
      throw new TypeError(`hard-cap ledger: worker must be an integer in [0, ${workers})`);
    }
  }

  return {
    tryReserve(id: string, worker = 0): boolean {
      checkWorker(worker);
      if (typeof id !== "string" || id.length === 0) throw new TypeError("hard-cap ledger: id must be a non-empty string");
      if (holds.has(id)) return true; // already held: reserving again changes nothing
      if (total >= cap) return false; // immediate refusal, no queue, no later admission
      holds.set(id, { worker, counted: true });
      sub[worker] = (sub[worker] as number) + 1;
      total++;
      if (total > maxObserved) maxObserved = total;
      return true;
    },
    release(id: string): boolean {
      const h = holds.get(id);
      if (!h || !h.counted) return false;
      h.counted = false;
      holds.delete(id);
      sub[h.worker] = (sub[h.worker] as number) - 1;
      total--;
      return true;
    },
    respawnWorker(worker: number): void {
      checkWorker(worker);
      for (const [id, h] of [...holds.entries()]) {
        if (h.worker === worker) holds.delete(id);
      }
      total -= sub[worker] as number;
      sub[worker] = 0;
    },
    has: (id: string) => holds.has(id),
    total: () => total,
    snapshot(): HardCapLedgerSnapshot {
      return {
        total,
        perWorker: [...sub],
        maxObserved,
        invariantOk: total === sub.reduce((a, b) => a + b, 0) && total <= cap && total >= 0,
      };
    },
  };
}
