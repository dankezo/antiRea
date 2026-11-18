/**
 * RSP-04: Slow-response budget (opt-in resource guard, decoy slow paths).
 *
 * Bounded concurrent held responses, accounted on a VIRTUAL clock:
 * this module never sleeps and never holds a real response; it only
 * accounts for slots a host chooses to hold. Denials are immediate
 * (a decision value, delay 0). An abort frees the slot at the abort
 * instant recorded by the host.
 *
 * Measured in the RSP Step-0 lab: budget 2 admits exactly 2; budget 0
 * admits 0/50; aborts free the slot at the abort instant; stress at
 * budget 8 peaks at concurrency 8 with immediate denials.
 * Honeypot-surface only, advisory, low tier.
 */
export interface RspSlowBudget {
  acquire(nowMs: number): { admitted: boolean; slotId: number | null; delayMs: number };
  release(slotId: number, nowMs: number): boolean;
  abort(slotId: number, nowMs: number): boolean;
  activeCount(): number;
  maxConcurrencySeen(): number;
  budget: number;
}

export function createRspSlowBudget(options: { budget: number }): RspSlowBudget {
  const budget = Math.max(0, Math.floor(options.budget) || 0);
  const active = new Map<number, number>();
  let nextId = 1;
  let maxSeen = 0;
  return {
    budget,
    acquire(nowMs) {
      if (active.size >= budget) return { admitted: false, slotId: null, delayMs: 0 };
      const slotId = nextId++;
      active.set(slotId, nowMs);
      if (active.size > maxSeen) maxSeen = active.size;
      return { admitted: true, slotId, delayMs: 0 };
    },
    release(slotId) { return active.delete(slotId); },
    abort(slotId) { return active.delete(slotId); },
    activeCount: () => active.size,
    maxConcurrencySeen: () => maxSeen,
  };
}
