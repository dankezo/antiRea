/**
 * Decoy images + surface-wide image watermarking - the B5
 * family (antiRea 3.3.1) - OPT-IN, default OFF (the surface
 * that serves these images is `createDecoySurface`, itself
 * disabled by default; watermarking additionally requires the
 * surface's `watermarkImages` option and a watermark secret).
 *
 * WHAT IT DOES. A host declares decoy images in the registry
 * as raw luminance planes (the form the AC-23 stack works on;
 * hosts convert their assets once, at build time). The decoy
 * surface serves every declared image at its path as a
 * grayscale PNG. With the watermark option on, EVERY image the
 * surface serves - not only a hero image - is first embedded
 * with the requesting identity's AC-23 Y-DCT payload
 * (`embedYDctWatermarkForIdentity`), so a copy of any served
 * image that surfaces later can be attributed to the identity
 * it was served to, if a marked copy is observed. With the
 * option off, the declared plane is served exactly as declared.
 *
 * MEASURED BASIS. VID-TRACE trial (2026-11-20, rea-video's
 * full deterministic + OCR pipeline run end to end on
 * recordings of a decoy twin): prediction P-VT2 HIT - the
 * AC-23 payload decoded in full (32/32 bits) from inside
 * rea-video's own output packages in 3/3 watermarked runs, in
 * BOTH image classes served (hero 720x360 and banner 480x320),
 * and again 3/3 in the fingerprint arm's packages. P-VT4 HIT:
 * no clean package ever decoded a full payload (best clean
 * extraction 19/32, inside the chance band), so the channel
 * does not manufacture false attributions. The per-identity
 * payload and the Y-DCT form are B1's, unchanged; this family
 * is the surface-wide application of that measured mechanism.
 *
 * SCOPE NOTES - PART OF THE CLAIM, NOT A FOOTNOTE. The
 * VID-TRACE verdicts are from rea-video's deterministic + OCR
 * pipeline; the VLM leg did not run (the gateway was
 * unreachable in the trial window), so no verdict here covers
 * a vision-model reading of the frames. The recordings used a
 * clean CDP-compositor H.264 CRF 23 chain - kinder than an
 * OBS or re-upload chain - so "survives" is not extended to
 * harsher recorders or platform re-encodes. And the watermark
 * is an attribution mechanism, NOT recording prevention: it
 * does not stop screen recording, and it does not stop the
 * cloning of anything a legitimate viewer can see. It names
 * the source of a marked copy after the fact, nothing more.
 *
 * FORM. The PNG encoder is minimal and deterministic (8-bit
 * grayscale, filterless scanlines, zlib via node:zlib - a Node
 * built-in, so runtime dependencies remain zero). Declared
 * planes are never mutated; watermarking embeds into a copy.
 */

import {
  AC23_BITS,
  AC23_REPEATS_PER_BIT,
  type LuminanceImage,
} from "../tier4-forensic/screenshot-watermark-ydct";

/* ------------------------------------------------------------------------ */
/* Declaration.                                                             */
/* ------------------------------------------------------------------------ */

export interface DecoyImageDecl {
  /** Absolute path the image is served at, e.g. "/img/hero.png". Exact match, like endpoint paths. */
  path: string;
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** Row-major luminance plane, width * height values in [0, 255]. The SDK's native image form (see the AC-23 modules). */
  y: readonly number[] | Uint8Array;
  /** One-line summary used in the generated spec and docs page. */
  summary?: string;
}

export class DecoyImagesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoyImagesError";
  }
}

/**
 * True when a plane of this size can carry the AC-23 payload:
 * dimensions in whole 8x8 blocks and at least 32 x 48 blocks
 * for the payload's repeats. The surface checks this at
 * construction when watermarking is enabled, so an image that
 * cannot carry the mark fails fast instead of at serve time.
 */
export function decoyImageCarriesAc23(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width % 8 === 0 &&
    height % 8 === 0 &&
    Math.floor(width / 8) * Math.floor(height / 8) >= AC23_BITS * AC23_REPEATS_PER_BIT
  );
}

/**
 * Structural validation of one image declaration. Returns the
 * list of problems (empty = valid); never throws. Path
 * collisions with the rest of the surface are the registry's
 * check, not this one.
 */
export function validateDecoyImageDecl(decl: unknown): string[] {
  const errors: string[] = [];
  if (!decl || typeof decl !== "object") return ["image declaration must be an object"];
  const d = decl as DecoyImageDecl;
  if (typeof d.path !== "string" || !d.path.startsWith("/") || d.path.includes(" ") || d.path.includes("?")) {
    errors.push(`image path must be an absolute path without query: ${String(d.path)}`);
  }
  if (!Number.isInteger(d.width) || d.width <= 0) errors.push(`image ${String(d.path)}: width must be a positive integer`);
  if (!Number.isInteger(d.height) || d.height <= 0) errors.push(`image ${String(d.path)}: height must be a positive integer`);
  const y = d.y as ArrayLike<number> | undefined;
  if (!y || typeof y.length !== "number") {
    errors.push(`image ${String(d.path)}: y must be a luminance plane (array of width * height values)`);
  } else if (Number.isInteger(d.width) && Number.isInteger(d.height) && d.width > 0 && d.height > 0 && y.length !== d.width * d.height) {
    errors.push(`image ${String(d.path)}: plane length ${y.length} does not equal width * height (${d.width * d.height})`);
  } else {
    for (let i = 0; i < y.length; i++) {
      const v = y[i] as number;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 255) {
        errors.push(`image ${String(d.path)}: plane value at ${i} is not a luminance value in [0, 255]: ${String(v)}`);
        break;
      }
    }
  }
  return errors;
}

/* ------------------------------------------------------------------------ */
/* Minimal deterministic grayscale PNG encoder.                             */
/* ------------------------------------------------------------------------ */

/* node:zlib through the lazy-require pattern used by
 * internal/rsp-crypto.ts (this repo has no @types/node). */
interface NodeZlibLike {
  deflateSync(data: Uint8Array, options?: { level?: number }): Uint8Array;
}
declare const require: ((id: string) => NodeZlibLike) | undefined;

function deflate(data: Uint8Array): Uint8Array {
  if (typeof require === "function") {
    try {
      const z = require("node:zlib");
      if (z && typeof z.deflateSync === "function") return z.deflateSync(data, { level: 9 });
    } catch { /* fall through */ }
  }
  throw new DecoyImagesError("node:zlib is not available in this runtime; decoy image serving requires Node.js");
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) crcInput[i] = type.charCodeAt(i);
  crcInput.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/**
 * Encode a luminance plane as a grayscale PNG (8-bit, color
 * type 0, filterless scanlines). Deterministic: the same plane
 * always encodes to the same bytes. Values are rounded and
 * clamped to [0, 255]; the input is never mutated.
 */
export function encodeGrayscalePng(image: LuminanceImage): Uint8Array {
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new DecoyImagesError(`encodeGrayscalePng: width and height must be positive integers, got ${String(width)}x${String(height)}`);
  }
  if (image.y.length !== width * height) {
    throw new DecoyImagesError(`encodeGrayscalePng: plane length ${image.y.length} does not equal width * height (${width * height})`);
  }
  const raw = new Uint8Array(height * (width + 1));
  for (let row = 0; row < height; row++) {
    raw[row * (width + 1)] = 0;
    for (let col = 0; col < width; col++) {
      const v = image.y[row * width + col] ?? 0;
      raw[row * (width + 1) + 1 + col] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0: grayscale
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflate(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
