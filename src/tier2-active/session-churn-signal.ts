/**
 * Session-churn fingerprint count (ABG-05, Step-0 PASS-LAB, seed
 * 20321205) - port of tarrinho/AntiBotGW identity.py `_record_chal_mint`
 * (fingerprint = UA + IP-tier + JA4, window 60 s, flag iff the count
 * in the sliding window exceeds the maximum).
 *
 * WHAT IT MEASURES. Each session-cookie mint is counted against a
 * fingerprint: sha256(UA|ipTier|JA4)[:12]. The host supplies the JA4
 * fingerprint (its TLS layer computes it); JA4 is part of the
 * fingerprint by construction - the same UA + IP with the mints
 * split across two JA4 values counts as two fingerprints and does
 * not flag (lab scenario D, a binding gate).
 *
 * THRESHOLD FROZEN AT 6, CONTRADICTION ON RECORD. The source
 * contradicts itself: identity.py's enforcement path defaults
 * SESSION_CHURN_MAX to 6 (identity.py:157, flag iff count > 6),
 * while config.py:1293 defaults the same knob to 3 - a value nothing
 * on the enforcement path reads (profile G14). This module freezes
 * 6, the enforcement-path value (R-ABG-4), and exports the config
 * value as SESSION_CHURN_CONFIG_DEFAULT_ON_RECORD purely so the
 * contradiction stays visible in code. Do not "reconcile" this by
 * silently switching to 3.
 *
 * THE WINDOW SLIDES. Eviction is per-mint: entries older than the
 * 60 s window drop out as new mints land, so 7 mints whose 7th lands
 * at t = 61 s do NOT flag (the 1st is evicted, 6 remain) - measured
 * in the lab's descriptive sliding-window arm. It is not a fixed
 * 60 s bucket. Flag iff count > 6, never >= 6: exactly 6 mints do
 * not flag (lab scenario B, a binding gate), and an ordinary browser
 * at 2-3 mints never flags.
 *
 * The source's JA4 auto-deny observation on this code path is NOT
 * ported (lab discipline: measured as absent, not as a consequence).
 *
 * ADVISORY ONLY, OPT-IN. Every result carries enforcement: "none";
 * this is a counting signal for the host's scorer. Nothing runs
 * until the host constructs an instance and feeds it mints. State
 * is bounded (`maxFingerprints`, least recently active evicted).
 */

/** Sliding window in ms (source SESSION_CHURN_WINDOW_S 60). */
export const SESSION_CHURN_WINDOW_MS = 60_000;
/** Frozen flag maximum: flag iff the in-window count exceeds this (enforcement-path default, identity.py:157). */
export const SESSION_CHURN_MAX_MINTS = 6;
/**
 * The contradicting config.py:1293 default (3), exported ONLY to keep
 * the on-record contradiction visible. It is not used anywhere in
 * this module; the enforcement path's 6 is the frozen value (R-ABG-4).
 */
export const SESSION_CHURN_CONFIG_DEFAULT_ON_RECORD = 3;

interface NodeHashLike {
  update(data: string, encoding?: string): NodeHashLike;
  digest(encoding: string): string;
}

interface NodeCryptoLike {
  createHash(algorithm: string): NodeHashLike;
}

declare const require: ((id: string) => NodeCryptoLike) | undefined;

function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.createHash === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; session-churn fingerprints require Node.js");
}

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): session-cookie mints counted per UA + IP-tier + JA4 " +
  "fingerprint over a sliding 60 s window; flag iff the count exceeds 6. The threshold is frozen " +
  "at the source enforcement-path value 6; config.py's default of 3 is a recorded contradiction " +
  "(G14) and is not the value used. JA4 is part of the fingerprint: split JA4 counts separately. " +
  "Never a sole blocking key.";

/** The fingerprint of one mint context: sha256(UA|ipTier|JA4)[:12]. JA4 is supplied by the host. */
export function sessionChurnFingerprint(userAgent: string, ipTier: string, ja4: string): string {
  return getNodeCrypto()
    .createHash("sha256")
    .update(`${userAgent}|${ipTier}|${ja4}`, "utf8")
    .digest("hex")
    .slice(0, 12);
}

export interface SessionChurnOptions {
  /** Sliding window in ms. Defaults to 60,000 (source constant). */
  windowMs?: number;
  /** Flag iff the in-window count exceeds this. Defaults to 6, the frozen enforcement-path value. */
  maxMints?: number;
  /** Maximum fingerprints tracked at once (least recently active evicted). Defaults to 10,000. */
  maxFingerprints?: number;
}

export interface SessionChurnMint {
  userAgent: string;
  /** IP tier (for example the /24 or the host's tier label), as the source's IP-tier input. */
  ipTier: string;
  /** JA4 fingerprint, supplied by the host's TLS layer. Part of the fingerprint. */
  ja4: string;
  /** Mint time, ms since epoch. Defaults to Date.now(). */
  nowMs?: number;
}

export interface SessionChurnResult {
  kind: "session_churn";
  /** sha256[:12] fingerprint of (UA, IP-tier, JA4). */
  fingerprint: string;
  /** Mints for this fingerprint inside the sliding window, including this one. */
  count: number;
  /** True iff count > maxMints after sliding-window eviction. */
  flagged: boolean;
  /** The frozen maximum applied (6 by default). */
  maxMints: number;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface SessionChurnSignalInstance {
  /** Record one cookie mint; returns the fingerprint's in-window count and flag state. */
  recordMint(mint: SessionChurnMint): SessionChurnResult;
  /** Number of fingerprints currently tracked. */
  trackedFingerprints(): number;
}

export function createSessionChurnSignal(options: SessionChurnOptions = {}): SessionChurnSignalInstance {
  const windowMs = options.windowMs ?? SESSION_CHURN_WINDOW_MS;
  const maxMints = options.maxMints ?? SESSION_CHURN_MAX_MINTS;
  const maxFingerprints = options.maxFingerprints ?? 10_000;
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("createSessionChurnSignal: windowMs must be a positive finite number");
  if (!Number.isInteger(maxMints) || maxMints < 1) throw new Error("createSessionChurnSignal: maxMints must be a positive integer");
  if (!Number.isInteger(maxFingerprints) || maxFingerprints < 1) throw new Error("createSessionChurnSignal: maxFingerprints must be a positive integer");

  const queues = new Map<string, number[]>();
  let seq = 0;
  const lastSeq = new Map<string, number>();

  return {
    recordMint(mint) {
      const nowMs = mint.nowMs ?? Date.now();
      const fingerprint = sessionChurnFingerprint(mint.userAgent, mint.ipTier, mint.ja4);
      let q = queues.get(fingerprint);
      if (!q) {
        if (queues.size >= maxFingerprints) {
          let oldestFp: string | undefined;
          let oldestSeq = Infinity;
          for (const [fp, s] of lastSeq) {
            if (s < oldestSeq) {
              oldestSeq = s;
              oldestFp = fp;
            }
          }
          if (oldestFp !== undefined) {
            queues.delete(oldestFp);
            lastSeq.delete(oldestFp);
          }
        }
        q = [];
        queues.set(fingerprint, q);
      }
      lastSeq.set(fingerprint, seq++);
      q.push(nowMs);
      while (q.length > 0 && (q[0] as number) < nowMs - windowMs) q.shift();
      return {
        kind: "session_churn",
        fingerprint,
        count: q.length,
        flagged: q.length > maxMints,
        maxMints,
        enforcement: "none",
        notice: ADVISORY_NOTICE,
      };
    },
    trackedFingerprints() {
      return queues.size;
    },
  };
}
