/**
 * Fingerprint correlation counts (WDN-06, WebDecoy fingerprint detector
 * port) - an opt-in counting signal in tier2-active.
 *
 * The host supplies a fingerprint string per request (derived from
 * whatever fingerprint inputs the host collects; this module never
 * collects anything itself). The counter records the fingerprint for
 * the IP first, then reports:
 * - an ip-fingerprint detection (score 0.6 / confidence 0.6) when the
 *   number of DISTINCT fingerprints seen from one IP is strictly
 *   greater than 5 - it fires exactly on the 6th distinct fingerprint;
 * - a fingerprint-ip detection (score 0.5 / confidence 0.5) when the
 *   number of DISTINCT IPs seen presenting one fingerprint is strictly
 *   greater than 10 - it fires exactly on the 11th distinct IP.
 * Repeats never move either count: the same IP with the same
 * fingerprint repeated any number of times fires nothing.
 *
 * Measured in the WDN Step-0 lab (wdn-lab/wdn06.cjs) on frozen
 * fixtures: fires exactly on the 6th distinct fingerprint and the 11th
 * distinct IP, never at 5 or 10, repeats never fire. That is mechanics
 * on frozen fixtures - NO legitimate population was measured, so no
 * false-positive rate is claimed and the signal is advisory only
 * (enforcement: "none"), never a sole blocking key. Shared IPs (NAT,
 * corporate egress) presenting many real fingerprints are the obvious
 * unmeasured risk group; hosts must weigh that before acting on a hit.
 *
 * State is in-process memory, bounded by caps on tracked IPs and
 * fingerprints (oldest-inserted entries are evicted past the cap, and
 * the snapshot reports live sizes). Horizontally scaled hosts get
 * per-instance counts; that bound is stated, not hidden.
 */

export interface FingerprintCorrelationDetection {
  kind: "ip_fingerprint" | "fingerprint_ip";
  score: number;
  confidence: number;
  reason: string;
  /** Distinct fingerprints counted for the IP after this observation. */
  distinctFingerprintsForIp: number;
  /** Distinct IPs counted for the fingerprint after this observation. */
  distinctIpsForFingerprint: number;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
}

export interface FingerprintCorrelationOptions {
  /** Distinct-fingerprints-per-IP threshold; fires when the count is strictly greater. Default 5 (lab-frozen). */
  ipFingerprintThreshold?: number;
  /** Distinct-IPs-per-fingerprint threshold; fires when the count is strictly greater. Default 10 (lab-frozen). */
  fingerprintIpThreshold?: number;
  /** Cap on tracked IPs. Default 10,000. */
  maxIps?: number;
  /** Cap on tracked fingerprints. Default 10,000. */
  maxFingerprints?: number;
}

export interface FingerprintCorrelationSignal {
  /** Record one (fingerprint, ip) observation; returns the detections it produced (possibly none, possibly both). */
  observe(input: { fingerprint: string; ip: string }): FingerprintCorrelationDetection[];
  /** Current distinct counts without recording anything. */
  counts(input: { fingerprint: string; ip: string }): { distinctFingerprintsForIp: number; distinctIpsForFingerprint: number };
  snapshot(): { trackedIps: number; trackedFingerprints: number; ipFingerprintThreshold: number; fingerprintIpThreshold: number };
}

const clampCap = (value: number | undefined, fallback: number): number => {
  const n = Math.floor(value ?? fallback);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
};

/** Create the opt-in fingerprint correlation counter. */
export function createFingerprintCorrelationSignal(
  options: FingerprintCorrelationOptions = {},
): FingerprintCorrelationSignal {
  const ipThreshold = clampCap(options.ipFingerprintThreshold, 5);
  const fpThreshold = clampCap(options.fingerprintIpThreshold, 10);
  const maxIps = clampCap(options.maxIps, 10_000);
  const maxFingerprints = clampCap(options.maxFingerprints, 10_000);

  const fingerprintsByIp = new Map<string, Set<string>>();
  const ipsByFingerprint = new Map<string, Set<string>>();

  const evictOldest = <K, V>(map: Map<K, V>, cap: number): void => {
    while (map.size > cap) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  };

  const observe = (input: { fingerprint: string; ip: string }): FingerprintCorrelationDetection[] => {
    const { fingerprint, ip } = input;
    if (typeof fingerprint !== "string" || fingerprint.length === 0 || typeof ip !== "string" || ip.length === 0) {
      return [];
    }
    let fpSet = fingerprintsByIp.get(ip);
    if (!fpSet) {
      fpSet = new Set<string>();
      fingerprintsByIp.set(ip, fpSet);
    }
    fpSet.add(fingerprint);
    let ipSet = ipsByFingerprint.get(fingerprint);
    if (!ipSet) {
      ipSet = new Set<string>();
      ipsByFingerprint.set(fingerprint, ipSet);
    }
    ipSet.add(ip);
    evictOldest(fingerprintsByIp, maxIps);
    evictOldest(ipsByFingerprint, maxFingerprints);

    const distinctFingerprintsForIp = fingerprintsByIp.get(ip)?.size ?? 0;
    const distinctIpsForFingerprint = ipsByFingerprint.get(fingerprint)?.size ?? 0;
    const detections: FingerprintCorrelationDetection[] = [];
    if (distinctFingerprintsForIp > ipThreshold) {
      detections.push({
        kind: "ip_fingerprint",
        score: 0.6,
        confidence: 0.6,
        reason: "IP has used many different fingerprints",
        distinctFingerprintsForIp,
        distinctIpsForFingerprint,
        enforcement: "none",
      });
    }
    if (distinctIpsForFingerprint > fpThreshold) {
      detections.push({
        kind: "fingerprint_ip",
        score: 0.5,
        confidence: 0.5,
        reason: "Fingerprint seen from many IPs",
        distinctFingerprintsForIp,
        distinctIpsForFingerprint,
        enforcement: "none",
      });
    }
    return detections;
  };

  return {
    observe,
    counts: (input) => ({
      distinctFingerprintsForIp: fingerprintsByIp.get(input.ip)?.size ?? 0,
      distinctIpsForFingerprint: ipsByFingerprint.get(input.fingerprint)?.size ?? 0,
    }),
    snapshot: () => ({
      trackedIps: fingerprintsByIp.size,
      trackedFingerprints: ipsByFingerprint.size,
      ipFingerprintThreshold: ipThreshold,
      fingerprintIpThreshold: fpThreshold,
    }),
  };
}
