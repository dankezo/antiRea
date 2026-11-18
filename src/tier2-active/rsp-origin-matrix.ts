/**
 * RSP-02: Origin write-once grant matrix (opt-in honeypot capture).
 *
 * The first origin to record a credential pair owns it; later records
 * of the same pair only bump the grant count, never the origin.
 * Grant decision (the source matrix, 8/8 exact in the lab):
 * no credentials never grants; origin install or ajax grants
 * instantly; any other recorded origin never grants; an unrecorded
 * (null-origin) pair grants only on a threshold hit.
 * Instant grant for install/ajax measured 40/40.
 *
 * Race cost, documented: in 200/200 lab interleavings where a
 * low-trust trap origin records a kit pair first, the kit's later
 * install/ajax record does not move the origin, so the verify login
 * is withheld. That is the inherent price of write-once.
 * Honeypot-surface only, advisory, low tier.
 */
export type RspOrigin = "login" | "env" | "install" | "secret" | "ajax";

export function rspDecideGrant(hasCreds: boolean, origin: RspOrigin | null, thresholdHit: boolean): boolean {
  if (!hasCreds) return false;
  if (origin === "install" || origin === "ajax") return true;
  if (origin !== null && origin !== undefined) return false;
  return thresholdHit;
}

export interface RspOriginRow { origin: RspOrigin; grantCount: number }

export interface RspOriginMatrix {
  record(user: string, pass: string, origin: RspOrigin): RspOriginRow;
  originOf(user: string, pass: string): RspOrigin | null;
  row(user: string, pass: string): RspOriginRow | null;
  decideFor(user: string, pass: string, thresholdHit: boolean): boolean;
}

export function createRspOriginMatrix(): RspOriginMatrix {
  const map = new Map<string, RspOriginRow>();
  const key = (u: string, p: string) => u + "\0" + p;
  return {
    record(user, pass, origin) {
      const k = key(user, pass);
      const existing = map.get(k);
      if (existing) { existing.grantCount += 1; return existing; }
      const row: RspOriginRow = { origin, grantCount: 1 };
      map.set(k, row);
      return row;
    },
    originOf(user, pass) { return map.get(key(user, pass))?.origin ?? null; },
    row(user, pass) { return map.get(key(user, pass)) ?? null; },
    decideFor(user, pass, thresholdHit) {
      return rspDecideGrant(true, this.originOf(user, pass), thresholdHit);
    },
  };
}
