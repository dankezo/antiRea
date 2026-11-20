/**
 * AC-23 per-identity attribution (antiRea 3.3.1, B1) - the
 * canary-tag pattern (A4) carried onto the image channel, on
 * top of the shipped Y-DCT watermark in
 * `screenshot-watermark-ydct.ts`. OPT-IN and pure: nothing is
 * embedded unless a host calls these helpers on images it
 * serves, and extraction is a forensic lookup the host runs on
 * an image it has obtained.
 *
 * WHAT IT DOES. Instead of one fixed payload for every
 * recipient, the 32-bit AC-23 payload is derived per identity:
 * the first 32 bits of HMAC-SHA256(secret, "ac23-payload:" +
 * identity). A host watermarks the images it serves to an
 * identity with that identity's payload; when a screenshot of
 * those images surfaces later, extracting the payload and
 * matching it against the candidate identities names the
 * identity the images were served to - IF a marked copy is
 * observed (the same scoped attribution claim as the canary
 * tags, per the panel's L4 rebuttal). Keyed derivation means
 * payloads cannot be precomputed or forged without the host
 * secret, and one host's payloads teach nothing about
 * another's.
 *
 * FORM - Y-DCT ONLY. The shipped mechanism is the Y-DCT form
 * in `screenshot-watermark-ydct.ts`. The LSB form is NOT
 * shipped: it dies under JPEG compression (probe of
 * 2026-11-05) and under pure resampling; it served only as the
 * screenshot-pipeline proof in the trial below. The Blue-DCT
 * form is likewise KILL-confirmed. Do not reintroduce either.
 *
 * MEASURED BASIS, with the forms kept straight:
 * - VIS trial (2026-11-20, decoy-map lineage, REA 6.9.0): the
 *   AC-23 channel through REA's own screenshot pipeline - the
 *   trial twin carried the mark in its LSB form as the pipeline
 *   proof - recovered the 32-bit payload in full from 10/10
 *   screenshots REA itself captured (unanimous per-bit votes),
 *   the served asset measured 78.50 dB PSNR, and REA's own
 *   screenshot comparison reported the decoy deployment
 *   identical to itself in 19/19 comparisons. The trial
 *   establishes that the screenshot channel carries the mark
 *   out of a REA session; it does not by itself measure the
 *   Y-DCT form, whose record is the next item.
 * - Y-DCT lab record (ac-batch2): full 32/32 payload match at
 *   RIGHT, BOTTOM and TOP placements, and both halves still
 *   extract 32/32 after a JPEG80 re-encode - the survival
 *   property the LSB form lacks, and the reason this form is
 *   the one that ships. CENTER placement extracts 23/32 in the
 *   lab (vote starvation, a coverage fact documented in the
 *   base module).
 * - NOT MEASURED: a clean-image false-match rate (the lab's
 *   clean controls full-matched nowhere, inside the standing
 *   chance band). No false-match rate is claimed here either.
 */

import { rspHmac } from "../internal/rsp-crypto";
import {
  embedYDctWatermark,
  extractYDctWatermark,
  type LuminanceImage,
  type WatermarkRegion,
  type YDctExtraction,
} from "./screenshot-watermark-ydct";

export class WatermarkAttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatermarkAttributionError";
  }
}

/**
 * The AC-23 payload for one identity: the first 32 bits of
 * HMAC-SHA256(secret, "ac23-payload:" + identity), as an
 * unsigned 32-bit integer. Deterministic per (secret,
 * identity); different identities get different payloads.
 */
export function ac23PayloadForIdentity(secret: string | Uint8Array, identity: string): number {
  if (typeof identity !== "string" || identity.length === 0) {
    throw new WatermarkAttributionError("identity must be a non-empty string");
  }
  const h = rspHmac(secret, `ac23-payload:${identity}`);
  return (((h[0] as number) << 24) | ((h[1] as number) << 16) | ((h[2] as number) << 8) | (h[3] as number)) >>> 0;
}

/** Embed the identity's AC-23 payload (Y-DCT form) into a copy of the luminance plane. The input is never mutated. */
export function embedYDctWatermarkForIdentity(
  image: LuminanceImage,
  secret: string | Uint8Array,
  identity: string,
  seed?: number,
): Float64Array {
  return embedYDctWatermark(image, ac23PayloadForIdentity(secret, identity), seed);
}

/** Extract from a luminance plane, scoring against the identity's expected payload. */
export function extractYDctWatermarkForIdentity(
  image: LuminanceImage,
  secret: string | Uint8Array,
  identity: string,
  options: { region?: WatermarkRegion; seed?: number } = {},
): YDctExtraction {
  return extractYDctWatermark(image, { ...options, expectedPayload: ac23PayloadForIdentity(secret, identity) });
}

/**
 * Attribution by payload: return the candidate identity whose
 * derived payload equals `payload`, or null. This names the
 * serving identity IF an observed copy carries its payload -
 * a forensic lookup, not a detection.
 */
export function identifyYDctPayload(
  payload: number,
  secret: string | Uint8Array,
  candidateIdentities: readonly string[],
): string | null {
  for (const identity of candidateIdentities) {
    if (ac23PayloadForIdentity(secret, identity) === (payload >>> 0)) return identity;
  }
  return null;
}

export interface YDctAttribution {
  /** The identity the extracted payload was minted for. */
  identity: string;
  /** The extraction the attribution rests on (full match against the identity's payload). */
  extraction: YDctExtraction;
}

/**
 * Attribute an image in one call: extract the payload, then
 * match it against the candidate identities. Returns null
 * when the extraction is not a full match for any candidate -
 * a partial or foreign mark attributes nobody.
 */
export function identifyYDctWatermark(
  image: LuminanceImage,
  secret: string | Uint8Array,
  candidateIdentities: readonly string[],
  options: { region?: WatermarkRegion; seed?: number } = {},
): YDctAttribution | null {
  const extraction = extractYDctWatermark(image, options);
  const identity = identifyYDctPayload(extraction.payload, secret, candidateIdentities);
  if (identity === null) return null;
  const scored = extractYDctWatermarkForIdentity(image, secret, identity, options);
  if (!scored.fullMatch) return null;
  return { identity, extraction: scored };
}
