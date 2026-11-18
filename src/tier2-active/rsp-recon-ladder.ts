/**
 * RSP-05: Recon ladder by sweep depth, COMPUTED VALUES ONLY.
 *
 * Upgrade form for 3.1.0: a pure policy table plus a shared per-IP
 * counter over the trap families (.env / .git / secrets). This
 * module computes delay values on a virtual clock; it contains no
 * timer, no sleep and no response handling, so antiRea itself never
 * delays anyone. Real client timeout behaviour stays CLAIM.
 *
 * Measured in the RSP Step-0 lab (default step 10): rungs exact at
 * hits 1,9,10,19,20,25,30,39,40,100,10000 =
 * 0,0,2,2,5,5,10,10,20,20,20 s; the counter is SHARED across the
 * three families (the 10th mixed-family hit lands on rung 1);
 * per-IP isolation holds; 9 shared-IP hits all draw 0 s.
 * Honeypot-surface only, advisory, low tier.
 */
export type RspTrapFamily = "env" | "git" | "secrets";

const RUNGS: ReadonlyArray<readonly [number, number]> = [
  [10, 2], [20, 5], [30, 10], [40, 20],
];

export interface RspReconLadder {
  recordHit(ip: string, family: RspTrapFamily): { hits: number; delaySeconds: number };
  delaySecondsFor(ip: string): number;
  hitsFor(ip: string): number;
}

export function rspReconDelayForHits(hits: number): number {
  let delay = 0;
  for (const [threshold, rung] of RUNGS) if (hits >= threshold) delay = rung;
  return delay;
}

export function createRspReconLadder(): RspReconLadder {
  const counters = new Map<string, number>();
  return {
    recordHit(ip) {
      const hits = (counters.get(ip) ?? 0) + 1;
      counters.set(ip, hits);
      return { hits, delaySeconds: rspReconDelayForHits(hits) };
    },
    delaySecondsFor: (ip) => rspReconDelayForHits(counters.get(ip) ?? 0),
    hitsFor: (ip) => counters.get(ip) ?? 0,
  };
}
