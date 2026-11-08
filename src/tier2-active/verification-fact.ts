/**
 * Verified-neutral verification facts (BS-01 VerifiedNeutral,
 * lab pin bs01-lab/REGISTRATION-BS-01-STEP0.md, results in
 * BS01-RESULTS.md).
 *
 * THE PROBLEM. Identity verification (a Web Bot Auth signature,
 * an FCrDNS match, a published IP range) is seductive evidence:
 * it FEELS like it should move a suspicion score. It must not.
 * A verified signature identifies a key holder for one request -
 * it says the caller is who they claim, nothing about whether
 * their behavior is abusive; and every ambiguous failure (a DNS
 * hiccup, an unknown key, a stale range list) is compatible with
 * a perfectly legitimate caller. BS-01 freezes the semantics:
 *
 *   state        evidence delta
 *   verified     0          (identity known; behavior unchanged)
 *   no-claim     0          (no signature presented at all)
 *   unverified   0          (any ambiguity, any failure to check)
 *   spoofed      "EVIDENCE" (proof someone forged an identity)
 *
 * Only a SPOOFED fact carries evidence, and the spoof set is
 * exact and tiny: (1) a Web Bot Auth `invalid_signature` verdict
 * whose detail is the conclusive cryptographic failure
 * ("Ed25519 verification failed" - the shipped verifier's other
 * invalid-signature sites are request-shape failures and stay
 * unverified, and any FUTURE detail string defaults to
 * unverified: never key enforcement on a detail string, this
 * classifier exists so hosts do not have to); (2) an FCrDNS
 * contradiction (forward lookup does not confirm the reverse
 * claim). A `replay_detected` verdict is unverified for identity
 * purposes and surfaces separately as sideEvent "REPLAY" - the
 * replay itself is the host's tripwire input, not an identity
 * fact.
 *
 * WHAT THE LAB MEASURED (deterministic conformance over the
 * shipped verifier's mechanically extracted outcome space; no
 * traffic, no DNS): all 17 shipped failure reasons plus the
 * verified row covered, delta law exact on all 26 rows of the
 * frozen table (3 channels), spoof set exactly the 2 rows above,
 * VERIFIED / UNVERIFIED delta exactly 0 everywhere. This module
 * IS that frozen table as code; the conformance checks are
 * re-run as unit tests against it.
 *
 * The fact optionally carries the CS-02 provenance hash of the
 * verifier configuration that produced the underlying verdict
 * (the BS-01 spec hook) so an evidence pack can pin WHICH
 * verifier said this. The classifier itself is pure: it never
 * performs DNS, range lookups or signature verification - feed
 * it verdicts and host check outcomes.
 */

import type { WebBotAuthVerdict } from "./web-bot-auth";

/** The shipped verifier's conclusive cryptographic-failure detail. */
export const WEB_BOT_AUTH_CRYPTO_FAILURE_DETAIL = "Ed25519 verification failed";

export type VerificationFactState = "verified" | "unverified" | "spoofed" | "no-claim";
export type VerificationEvidenceDelta = 0 | "EVIDENCE";
export type VerificationFactSource = "web-bot-auth" | "fcrdns" | "range";

export interface VerificationFact {
  /** KT-01 channel key for every BS-01 fact. */
  channel: "bs01-verification-fact";
  source: VerificationFactSource;
  state: VerificationFactState;
  /** 0 for every state except "spoofed" - the verified-neutral law. */
  evidenceDelta: VerificationEvidenceDelta;
  /** "REPLAY" when the underlying verdict was replay_detected; otherwise null. */
  sideEvent: "REPLAY" | null;
  /** CS-02 hash of the producing verifier's effective config, when the host supplies it. */
  configHash: string | null;
}

export interface ClassifyVerificationOptions {
  /** CS-02 provenance hash of the verifier configuration that produced the verdict. */
  configHash?: string;
}

function fact(
  source: VerificationFactSource,
  state: VerificationFactState,
  sideEvent: "REPLAY" | null,
  options?: ClassifyVerificationOptions,
): VerificationFact {
  return {
    channel: "bs01-verification-fact",
    source,
    state,
    evidenceDelta: state === "spoofed" ? "EVIDENCE" : 0,
    sideEvent,
    configHash: options && typeof options.configHash === "string" ? options.configHash : null,
  };
}

/**
 * Classify a shipped Web Bot Auth verdict into a BS-01 fact.
 * Conservative by construction: anything not explicitly mapped
 * (unknown reasons, unknown future detail strings) is
 * "unverified" with delta 0.
 */
export function classifyWebBotAuthVerdict(
  verdict: WebBotAuthVerdict,
  options?: ClassifyVerificationOptions,
): VerificationFact {
  if (typeof verdict !== "object" || verdict === null) {
    return fact("web-bot-auth", "unverified", null, options);
  }
  if (verdict.verified) return fact("web-bot-auth", "verified", null, options);
  switch (verdict.reason) {
    case "no_signature_headers":
    case "no_signature_agent":
      return fact("web-bot-auth", "no-claim", null, options);
    case "invalid_signature":
      return verdict.detail === WEB_BOT_AUTH_CRYPTO_FAILURE_DETAIL
        ? fact("web-bot-auth", "spoofed", null, options)
        : fact("web-bot-auth", "unverified", null, options);
    case "replay_detected":
      return fact("web-bot-auth", "unverified", "REPLAY", options);
    default:
      return fact("web-bot-auth", "unverified", null, options);
  }
}

/**
 * Classify a host-side identity check (FCrDNS or published-range)
 * into a BS-01 fact. Outcomes are the registration's frozen
 * strings; anything unrecognized is "unverified" (a lookup
 * failure and a future outcome string are equally ambiguous).
 *
 * FCrDNS outcomes: "forward-confirmed match" | "contradiction" |
 * "lookup failure". Range outcomes: "inside published range" |
 * "outside published range" | "list unavailable or stale".
 */
export function classifyHostVerificationFact(
  source: "fcrdns" | "range",
  outcome: string,
  options?: ClassifyVerificationOptions,
): VerificationFact {
  if (source === "fcrdns") {
    if (outcome === "forward-confirmed match") return fact("fcrdns", "verified", null, options);
    if (outcome === "contradiction") return fact("fcrdns", "spoofed", null, options);
    return fact("fcrdns", "unverified", null, options);
  }
  if (outcome === "inside published range") return fact("range", "verified", null, options);
  return fact("range", "unverified", null, options);
}
