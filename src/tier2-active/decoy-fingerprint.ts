/**
 * Visible per-identity fingerprint on decoy content - the B6
 * family (antiRea 3.3.1) - OPT-IN, default OFF (the surface
 * that applies it is `createDecoySurface`, itself disabled by
 * default; the fingerprint additionally requires the surface's
 * `fingerprintVisible` option and a fingerprint secret).
 *
 * WHAT IT DOES. Each identity served a decoy record list gets
 * a visible fingerprint, derived deterministically from a host
 * secret and the identity (HMAC-SHA256, the canary-tag pattern
 * of A4: the lab trial's unkeyed hash is not shipped - keyed
 * derivations cannot be precomputed or forged, and one host's
 * fingerprints teach nothing about another's). Three channels,
 * all woven into the DECOY list only:
 * - a token ("Assortment <Word>-<NN>") carried in the text of
 *   the list's first text-bearing record;
 * - a stock phrase appended to every record's text;
 * - a per-identity rotation of the list order.
 * A capture or recording of the list therefore names the
 * identity it was served to, in plain visible text that any
 * inventory of the content reads back.
 *
 * MEASURED BASIS. VID-TRACE trial (2026-11-20, rea-video's
 * full deterministic + OCR pipeline run end to end on
 * recordings of a decoy twin): prediction P-VT3 HIT - all
 * three channels were legible in the tool's output packages
 * in 3/3 fingerprinted runs (the token present, the stock
 * phrase across the item cues, the rotated list head
 * identifiable), and the three recording identities produced
 * three distinct fingerprints, each read back from the package
 * the cloner receives. The trial's derivation used an unkeyed
 * SHA-256 over the identity; the shipped derivation keeps the
 * trial's word list, phrase list and moduli and keys it with
 * HMAC under the host secret, exactly the translation the
 * canary tags (A4) made from their lab twin.
 *
 * SCOPE NOTES - PART OF THE CLAIM, NOT A FOOTNOTE. The
 * VID-TRACE verdicts are from rea-video's deterministic + OCR
 * pipeline; the VLM leg did not run (the gateway was
 * unreachable in the trial window), so no verdict here covers
 * a vision-model reading. The recordings used a clean
 * CDP-compositor H.264 CRF 23 chain - kinder than an OBS or
 * re-upload chain. And the fingerprint is a contamination and
 * attribution mechanism, NOT recording prevention: it does
 * not stop screen recording, and it does not stop the cloning
 * of anything a legitimate viewer can see. It makes a copied
 * decoy list carry the name of its source, nothing more.
 *
 * HARD SCOPE. This transform exists only inside the decoy
 * surface's serving path, applied to decoy record lists of
 * live decoy endpoints. It is never applied to real content:
 * the surface serves no real content, and a host that does not
 * enable the decoy surface - or does not enable this option -
 * gets byte-identical behavior to the build without it on
 * every surface. Inputs are never mutated.
 */

import { rspHmac } from "../internal/rsp-crypto";

/** The trial's assortment word list (VID-TRACE registration, section 4). */
export const DECOY_FINGERPRINT_WORDS: readonly string[] = [
  "Alpha", "Bravo", "Cobalt", "Delta", "Ember", "Falcon", "Granite", "Harbor",
];

/** The trial's stock phrase list (VID-TRACE registration, section 4). */
export const DECOY_FINGERPRINT_PHRASES: readonly string[] = [
  "In stock", "Available now", "Ready to ship",
];

export interface VisibleDecoyFingerprint {
  /** The assortment token, e.g. "Assortment Falcon-87". */
  token: string;
  /** The stock phrase appended to every record's text. */
  stockPhrase: string;
  /** Left rotation applied to a served decoy list (byte 0 mod 7, as trialled). */
  rotation: number;
  /** Second rotation (byte 1 mod 7), for hosts whose canonical surface has two lists, as the trial's did. The surface applies `rotation`. */
  rotationAlt: number;
}

export class DecoyFingerprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoyFingerprintError";
  }
}

/**
 * The visible fingerprint for one identity: HMAC-SHA256
 * (secret, "decoy-fingerprint:" + identity), its bytes mapped
 * through the trial's lists and moduli. Deterministic per
 * (secret, identity); different identities get different
 * fingerprints.
 */
export function visibleFingerprintFor(secret: string | Uint8Array, identity: string): VisibleDecoyFingerprint {
  if (typeof identity !== "string" || identity.length === 0) {
    throw new DecoyFingerprintError("identity must be a non-empty string");
  }
  const h = rspHmac(secret, `decoy-fingerprint:${identity}`);
  const byte = (i: number): number => h[i] ?? 0;
  return {
    rotation: byte(0) % 7,
    rotationAlt: byte(1) % 7,
    token: `Assortment ${DECOY_FINGERPRINT_WORDS[byte(2) % 8] as string}-${10 + (byte(3) % 90)}`,
    stockPhrase: DECOY_FINGERPRINT_PHRASES[byte(4) % 3] as string,
  };
}

/** Rotate a list left by `rotation` positions (normalized against the list length). Pure; returns a new array. */
export function rotateDecoyRecords<T>(records: readonly T[], rotation: number): T[] {
  if (records.length === 0) return [];
  const k = ((rotation % records.length) + records.length) % records.length;
  return k === 0 ? [...records] : [...records.slice(k), ...records.slice(0, k)];
}

/**
 * The record object a text weave lands on: the record's
 * `fields` sub-object when it carries one (the canary-dose
 * convention), else the record itself.
 */
function weaveTarget(record: Record<string, unknown>): Record<string, unknown> {
  const fields = record["fields"];
  if (fields && typeof fields === "object" && !Array.isArray(fields)) return fields as Record<string, unknown>;
  return record;
}

/**
 * Resolve which field of the target carries the weave: the
 * host's declared field when it holds a string, else "title",
 * else "name", else the first string-valued field. Null when
 * the record carries no text at all (rotation still applies).
 */
function weaveField(target: Record<string, unknown>, preferred: string | undefined): string | null {
  if (preferred !== undefined && typeof target[preferred] === "string") return preferred;
  for (const name of ["title", "name"]) if (typeof target[name] === "string") return name;
  for (const key of Object.keys(target)) if (typeof target[key] === "string") return key;
  return null;
}

/**
 * Apply an identity's visible fingerprint to a decoy record
 * list: rotate the list by the identity's rotation, append the
 * stock phrase to every record's text, and weave the token
 * into the first text-bearing record's text. Returns a new
 * list; woven records are copies, inputs are never mutated.
 */
export function applyVisibleFingerprint<T extends Record<string, unknown>>(
  records: readonly T[],
  secret: string | Uint8Array,
  identity: string,
  opts: { textField?: string } = {},
): T[] {
  const fp = visibleFingerprintFor(secret, identity);
  const rotated = rotateDecoyRecords(records, fp.rotation);
  let tokenPlaced = false;
  return rotated.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return record;
    const target = weaveTarget(record);
    const field = weaveField(target, opts.textField);
    if (field === null) return record;
    let next = `${target[field] as string} - ${fp.stockPhrase}`;
    if (!tokenPlaced) {
      next = `${next} - ${fp.token}`;
      tokenPlaced = true;
    }
    if (target === record) return { ...record, [field]: next };
    return { ...record, fields: { ...target, [field]: next } };
  });
}
