/**
 * Step-up 402 responder - the x402-format consequence of a step-up
 * trigger (RECOMB-09, measured PASS-lab in cycle C450, 2026-11-13).
 *
 * The step-up tier of the enforcement ladder (C27+C35) needs a
 * consequence that is neither a CAPTCHA nor a proof-of-work: a
 * triggered identity should be told, in a machine-readable way,
 * what is being asked and what its options are. This module shapes
 * that consequence as an HTTP 402 response in the x402 style
 * (price header + manifest link + a body carrying the full
 * manifest fields and three next steps: pay, appeal, continue
 * free).
 *
 * WHAT THIS IS NOT - read before wiring:
 * - NO settlement, NO payment processing. There is no wallet, no
 *   facilitator call, no network I/O anywhere in this module. The
 *   `facilitator` field is a label the host declares; nothing here
 *   contacts one. The price is a SIGNAL price: it prices the
 *   step-up, it does not collect anything.
 * - `checkAssertion` validates exactly one thing: that the caller
 *   presented the token the host itself issued for this session
 *   (the lab's facilitator was a deterministic stub whose only
 *   valid token was the harness-issued one). Presenting it proves
 *   possession of the issued token - it does NOT prove a payment
 *   happened, and hosts must not record it as one.
 *
 * HOST DISCIPLINE (lab gate R9-G0): call `respond` ONLY after a
 * step-up trigger has fired for the identity. Never serve it as a
 * first response to an untriggered identity, and never as a wall
 * in front of traffic that has produced no signal: in the lab's
 * control arm the shipped step-up emitted 0 responses of this
 * shape across 2,000 untriggered requests, and the 402 format is
 * only defined as the consequence of that trigger.
 *
 * WHAT THE LAB MEASURED (seeded synthetic lab, RECOMB-09 pin,
 * 2026-11-13; internal validity only - NOT real-agent behavior):
 * - Cooperative arms: the retreat arm stopped within one retry
 *   after the first 402 in 189/200 sessions (94.5%); the
 *   manifest-reading arm presented a valid assertion within 3
 *   attempts in 188/200 sessions (94.0%). Combined
 *   stop-or-assert delta over the shipped step-up control:
 *   0.6283 against a frozen bar of 0.30.
 * - Legitimate arms: 0 dead-ends in 200 browser + 200 API
 *   sessions - every legitimate client that met a 402 reached a
 *   usable next step (pay / appeal / continue-free for browsers,
 *   a parseable manifest for API clients). One dead-end would
 *   have killed the pin.
 * - Cost: shaping + assertion check measured median 0.0013 ms,
 *   p99 under 0.003 ms per request on the lab VM, far inside
 *   the frozen gate (median <= 5 ms, p99 <= 20 ms).
 * - HONEST CEILING: the ignore arm (an agent that never reads
 *   the manifest and simply retries) was essentially unaffected -
 *   the format alone cannot compel a non-cooperative agent, and
 *   PASS-lab says nothing about real agents honoring a 402, real
 *   payments, or the x402 market.
 *
 * The response shape below is byte-for-byte the lab's `shape402`:
 * same status, same two headers, same body fields in the same
 * order. The one deliberate hardening over the lab stub: the
 * assertion comparison is constant-time (node:crypto
 * timingSafeEqual over UTF-8 bytes, length-guarded) instead of a
 * plain string equality; the validity semantics are unchanged.
 * `respond` is pure: the same options, session and token always
 * produce the same response, and no state is kept between calls.
 */

/* ------------------------------------------------------------------------ */
/* Minimal structural view of node:crypto (mirroring config-provenance).    */
/* ------------------------------------------------------------------------ */

interface NodeCryptoLike {
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare const require: ((id: string) => NodeCryptoLike) | undefined;

function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.timingSafeEqual === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; step-up 402 assertion checks require Node.js");
}

export interface StepUp402Options {
  /** Signal price in USD (the lab pin used 0.001). A signal only - nothing is charged. */
  priceUsd: number;
  /** URL of the x402 manifest document (see `manifestDocument`). */
  manifestUrl: string;
  /** Facilitator label declared in the body. A label only - it is never contacted. */
  facilitator: string;
  /** Base URL of the pay next step; `?session=<id>` is appended per response. */
  payUrl: string;
  /** Base URL of the appeal next step; `?session=<id>` is appended per response. */
  appealUrl: string;
  /** Base URL of the continue-free next step; `?session=<id>` is appended per response. */
  continueFreeUrl: string;
}

export interface StepUp402NextSteps {
  pay: string;
  appeal: string;
  continue_free: string;
}

export interface StepUp402Response {
  status: 402;
  headers: {
    "X-Payment-Required": string;
    "X-X402-Manifest": string;
  };
  /** JSON string with the lab's exact field set and field order. */
  body: string;
}

export interface StepUp402Manifest {
  error: "payment_required";
  price_usd: number;
  currency: "USD";
  manifest: string;
  facilitator: string;
  /** Always "none": this format performs no settlement. */
  settlement: "none";
  note: string;
  /** Base URLs without a session; `respond` appends `?session=<id>` per session. */
  next_steps: StepUp402NextSteps;
}

export interface StepUp402Responder {
  /** Shape the 402 consequence for one triggered session. Pure; keeps no state. */
  respond(sessionId: string, token: string): StepUp402Response;
  /** Constant-time check that `presented` is exactly the token issued for the session. */
  checkAssertion(presented: unknown, issued: unknown): boolean;
  /** The manifest document for this responder's options (serve it at `manifestUrl`). */
  manifestDocument(): StepUp402Manifest;
}

function validateOptions(options: StepUp402Options, caller: string): StepUp402Options {
  if (!options || typeof options !== "object") {
    throw new TypeError(caller + ": options are required");
  }
  if (typeof options.priceUsd !== "number" || !Number.isFinite(options.priceUsd) || options.priceUsd < 0) {
    throw new TypeError(caller + ": options.priceUsd must be a finite number >= 0");
  }
  const stringFields = ["manifestUrl", "facilitator", "payUrl", "appealUrl", "continueFreeUrl"] as const;
  for (const field of stringFields) {
    if (typeof options[field] !== "string" || options[field].length === 0) {
      throw new TypeError(caller + ": options." + field + " must be a non-empty string");
    }
  }
  return {
    priceUsd: options.priceUsd,
    manifestUrl: options.manifestUrl,
    facilitator: options.facilitator,
    payUrl: options.payUrl,
    appealUrl: options.appealUrl,
    continueFreeUrl: options.continueFreeUrl,
  };
}

/**
 * The manifest document a host serves at `manifestUrl`: the same
 * fields the 402 body carries, minus the per-session values, plus
 * the explicit `settlement: "none"` honesty marker. Returns the
 * parsed object (not a JSON string) so the host can serialize or
 * extend it as it likes.
 */
export function manifestDocument(options: StepUp402Options): StepUp402Manifest {
  const opts = validateOptions(options, "manifestDocument");
  return {
    error: "payment_required",
    price_usd: opts.priceUsd,
    currency: "USD",
    manifest: opts.manifestUrl,
    facilitator: opts.facilitator,
    settlement: "none",
    note: "Signal price only. This document describes a step-up consequence in x402 format; no payment is processed and no settlement occurs.",
    next_steps: {
      pay: opts.payUrl,
      appeal: opts.appealUrl,
      continue_free: opts.continueFreeUrl,
    },
  };
}

/**
 * True iff `presented` is exactly the token that was issued for
 * the session. Constant-time over the UTF-8 bytes (length-guarded,
 * so different lengths return false without calling
 * timingSafeEqual); anything that is not a string is false. This
 * validates possession of the issued token and nothing else - see
 * the header on what it must never be recorded as.
 */
export function checkAssertion(presented: unknown, issued: unknown): boolean {
  if (typeof presented !== "string" || typeof issued !== "string") return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(presented);
  const b = encoder.encode(issued);
  if (a.length !== b.length) return false;
  return getNodeCrypto().timingSafeEqual(a, b);
}

export function createStepUp402Responder(options: StepUp402Options): StepUp402Responder {
  const opts = validateOptions(options, "createStepUp402Responder");
  return {
    respond(sessionId: string, token: string): StepUp402Response {
      // Field set and field order are the lab's shape402, unchanged.
      const body = JSON.stringify({
        error: "payment_required",
        price_usd: opts.priceUsd,
        manifest: opts.manifestUrl,
        facilitator: opts.facilitator,
        session: sessionId,
        pay_token_hint: token,
        next_steps: {
          pay: opts.payUrl + "?session=" + sessionId,
          appeal: opts.appealUrl + "?session=" + sessionId,
          continue_free: opts.continueFreeUrl + "?session=" + sessionId,
        },
      });
      return {
        status: 402,
        headers: {
          "X-Payment-Required": "price=" + opts.priceUsd + " USD; manifest=" + opts.manifestUrl,
          "X-X402-Manifest": opts.manifestUrl,
        },
        body,
      };
    },
    checkAssertion(presented: unknown, issued: unknown): boolean {
      return checkAssertion(presented, issued);
    },
    manifestDocument(): StepUp402Manifest {
      return manifestDocument(opts);
    },
  };
}
