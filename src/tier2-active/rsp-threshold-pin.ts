/**
 * RSP-01: Threshold-pin new-credential gate (opt-in, honeypot pack only).
 *
 * A new credential pair grants only when the per-IP attempt counter
 * reaches a per-IP derived threshold (10..100). After a grant the
 * counter pins: re-presenting the granted pair gives 0 further grants
 * and 0 resets; the next fresh pair grants and resets the counter.
 *
 * Measured in the RSP Step-0 lab: PIN-EXACT 64/64; 200 presentations
 * of the granted pair give 0 grants, 0 resets.
 *
 * BINDING RESTRICTION, enforced BY CONSTRUCTION: legit_solo
 * first-correct grant fraction is 0/200 - on a real-login surface
 * this rejects everyone. The gate therefore cannot be constructed
 * standalone: it requires a live HoneypotPack token minted by
 * createRspHoneypotPack in this module. There is no constructor path
 * that accepts a plain options object, a string, or a host-supplied
 * flag in place of the pack, so the gate cannot be wired onto a
 * real-login surface through this API. Advisory, low tier: a grant
 * here is a honeypot event, never a sole blocking key.
 */
import { rspHmac } from "../internal/rsp-crypto";

const packRegistry = new WeakSet<object>();

export interface RspHoneypotPack {
  readonly kind: "rsp-honeypot-pack";
}

/** Mint the honeypot pack token. Only pack holders can build RSP honeypot gates. */
export function createRspHoneypotPack(): RspHoneypotPack {
  const pack: RspHoneypotPack = Object.freeze({ kind: "rsp-honeypot-pack" });
  packRegistry.add(pack);
  return pack;
}

export function isRspHoneypotPack(value: unknown): boolean {
  return typeof value === "object" && value !== null && packRegistry.has(value as object);
}

export interface RspThresholdPinResult {
  granted: boolean;
  pinned: boolean;
  attempts: number;
  threshold: number;
}

export interface RspThresholdPin {
  thresholdFor(ip: string): number;
  present(ip: string, user: string, pass: string): RspThresholdPinResult;
  attemptsFor(ip: string): number;
}

export function createRspThresholdPin(pack: RspHoneypotPack, options: { secret: string | Uint8Array }): RspThresholdPin {
  if (!isRspHoneypotPack(pack)) {
    throw new Error("RSP-01 requires a honeypot pack from createRspHoneypotPack(); it must never be constructed for a real-login surface");
  }
  const secret = options.secret;
  const state = new Map<string, { count: number; pinnedPair: string | null }>();

  function thresholdFor(ip: string): number {
    const h = rspHmac(secret, "rsp01-threshold\n" + ip);
    return 10 + ((h[0]! | (h[1]! << 8)) % 91);
  }
  function present(ip: string, user: string, pass: string): RspThresholdPinResult {
    const threshold = thresholdFor(ip);
    let s = state.get(ip);
    if (!s) { s = { count: 0, pinnedPair: null }; state.set(ip, s); }
    const pair = user + "\0" + pass;
    if (s.pinnedPair !== null) {
      if (pair === s.pinnedPair) {
        return { granted: false, pinned: true, attempts: s.count, threshold };
      }
      // Next fresh pair after a pin: grants and resets.
      s.count = 0;
      s.pinnedPair = pair;
      return { granted: true, pinned: true, attempts: 0, threshold };
    }
    s.count++;
    if (s.count >= threshold) {
      s.pinnedPair = pair;
      return { granted: true, pinned: true, attempts: s.count, threshold };
    }
    return { granted: false, pinned: false, attempts: s.count, threshold };
  }
  return { thresholdFor, present, attemptsFor: (ip) => state.get(ip)?.count ?? 0 };
}
