/**
 * RSP-03: Tarpit escalation by grant count, COMPUTED VALUES ONLY.
 *
 * Upgrade form for 3.1.0: the delay ladder is a pure policy table a
 * host may consult. This module computes delay values on a virtual
 * clock; it contains no timer, no sleep and no response handling,
 * so antiRea itself never delays anyone. A host that chooses to act
 * on the values owns that decision and its timeout behaviour, which
 * stays CLAIM (no wall-clock hold was ever measured).
 *
 * Measured ladder (RSP Step-0 lab): readings at grant counts
 * 0,1,2,3,4,10 are 30, 60, 120, 240, 240, 240 s exactly; a 7,200 s
 * ladder entry is rejected at config load; the cap is 3,600 s and
 * an edge ladder [3500] serves at most 3,500 s.
 * Honeypot-surface only, advisory, low tier.
 */
export const RSP_TARPIT_CAP_SECONDS = 3600;
export const RSP_TARPIT_DEFAULT_LADDER: readonly number[] = [30, 60, 120, 240];

export interface RspTarpitLadder {
  delaySecondsForGrantCount(grantCount: number): number;
  ladder: readonly number[];
}

export function createRspTarpitLadder(ladder: readonly number[] = RSP_TARPIT_DEFAULT_LADDER): RspTarpitLadder {
  for (const entry of ladder) {
    if (!Number.isFinite(entry) || entry < 0 || entry > RSP_TARPIT_CAP_SECONDS) {
      throw new Error(`RSP-03 ladder entry ${entry} is outside the 0..3600 s cap and is rejected at config load`);
    }
  }
  const table = [...ladder];
  return {
    ladder: table,
    delaySecondsForGrantCount(grantCount) {
      if (table.length === 0) return 0;
      const idx = Math.min(Math.max(0, Math.floor(grantCount) || 0), table.length - 1);
      return Math.min(table[idx]!, RSP_TARPIT_CAP_SECONDS);
    },
  };
}
