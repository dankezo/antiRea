/**
 * JA3 / JA4 / JA4T deny-list (NHS-02, antiRea 3.1.0).
 *
 * WHAT IT IS. An exact-match deny list over TLS fingerprints the
 * HOST's TLS layer supplies (JA3, JA4, JA4T). antiRea terminates no
 * TLS itself, so the fingerprints are inputs, never computed here.
 * Matching is exact and case-insensitive: an entry flags iff it has
 * equal length and case-insensitive equality with the presented
 * value. Advisory only (enforcement: "none" on every result): a
 * list hit is an investigation signal whose quality is exactly the
 * host's list quality; TLS fingerprints are client-influenced and
 * must never be a sole blocking key.
 *
 * FAIL OPEN, BY DESIGN. An empty or missing value, a missing kind,
 * or an empty list never flags. A near miss (last character flipped,
 * one character longer) never flags: there is no prefix, fuzzy or
 * similarity matching in this module.
 *
 * LAB EVIDENCE (Step-0, nhs-lab/nhs02.cjs, RESULTS-NHS-STEP0.md).
 * 8/8 match rows flag across JA4 / JA3 (md5 and raw forms) / JA4T,
 * including upper-case presentations and mixed-case stored entries;
 * clean rows 0/2; near-miss and empty inputs all fail open as above.
 * No legit-population false-positive rate exists beyond the list
 * itself: an entry the host should not have listed flags exactly
 * the clients presenting that fingerprint.
 */

export type TlsFingerprintKind = "ja3" | "ja4" | "ja4t";

export interface TlsFingerprintDenyLists {
  ja3?: readonly string[];
  ja4?: readonly string[];
  ja4t?: readonly string[];
}

export interface TlsFingerprintDenyResult {
  kind: "tls_fingerprint_deny";
  fingerprintKind: TlsFingerprintKind;
  /** True iff some entry of that kind's list matches exactly (case-insensitive). */
  flagged: boolean;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
}

function matchesAny(value: unknown, list: readonly string[] | undefined): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!Array.isArray(list) || list.length === 0) return false;
  const v = value.toLowerCase();
  return list.some(
    (e) => typeof e === "string" && e.length === value.length && e.toLowerCase() === v,
  );
}

/**
 * Create a deny-list checker over host-supplied JA3/JA4/JA4T lists.
 * Opt-in: with no lists supplied, every check fails open.
 */
export function createTlsFingerprintDenyList(lists: TlsFingerprintDenyLists = {}): {
  check(kind: TlsFingerprintKind, value: string | null | undefined): TlsFingerprintDenyResult;
  /** Check all three kinds; flagged iff any kind's list matches its value. */
  checkAll(values: Partial<Record<TlsFingerprintKind, string | null | undefined>>): {
    flagged: boolean;
    results: Record<TlsFingerprintKind, TlsFingerprintDenyResult>;
  };
} {
  const frozen: Record<TlsFingerprintKind, readonly string[]> = {
    ja3: Object.freeze([...(lists.ja3 ?? [])]),
    ja4: Object.freeze([...(lists.ja4 ?? [])]),
    ja4t: Object.freeze([...(lists.ja4t ?? [])]),
  };
  function check(kind: TlsFingerprintKind, value: string | null | undefined): TlsFingerprintDenyResult {
    return {
      kind: "tls_fingerprint_deny",
      fingerprintKind: kind,
      flagged: matchesAny(value, frozen[kind]),
      enforcement: "none",
    };
  }
  return {
    check,
    checkAll(values) {
      const results = {
        ja3: check("ja3", values.ja3),
        ja4: check("ja4", values.ja4),
        ja4t: check("ja4t", values.ja4t),
      };
      return { flagged: results.ja3.flagged || results.ja4.flagged || results.ja4t.flagged, results };
    },
  };
}
