/**
 * AC-23 - Screenshot watermark, Y-DCT form ONLY (PASS-LAB).
 *
 * Lab record (ac-batch2-lab, RESULTS-AC-BATCH2.md, ac23-results.json;
 * scheme from C54/C56: payload 32 bits, 48 blocks per bit, 8x8 block
 * DCT on the Y (luminance) channel, bit = sign of C[2,1] - C[1,2],
 * majority vote over a region's repeats per bit, quorum 10 repeats,
 * tie = wrong):
 *   RIGHT placement (x >= 390):   extracts 32/32 full match
 *   BOTTOM placement (y >= 180):  extracts 32/32 full match
 *   TOP placement:                extracts 32/32 full match
 *   CENTER placement:             extracts 23/32 - the binding
 *     constraint there is quorum (vote starvation: 9 bits below
 *     the quorum of 10 repeats), not signal death. A clone that
 *     keeps only the center quarter cannot be attributed; that is
 *     a coverage fact, documented here, not a defect to hide.
 *   Both halves still extract 32/32 after a JPEG80 re-encode.
 *
 * BINDING: the Blue-DCT form and the LSB form are KILL-confirmed
 * (Blue-DCT dies under JPEG80 at every width; LSB dies under
 * JPEG80 and under pure resampling) and must NOT be built. Only
 * the Y-DCT form exists in this module.
 *
 * NOT IN THE RECORD: the false-match rate on clean images was not
 * measured as a rate (the lab's clean controls full-matched
 * nowhere, inside the standing 10-22 of 32 chance band). This
 * module claims NO clean-image false-match rate, in code or docs.
 *
 * Form: operates on a raw luminance plane (width and height must
 * be multiples of 8). Embed adjusts each selected block's DCT so
 * C[2,1] - C[1,2] carries the payload bit with a signed margin;
 * extract votes over the blocks fully inside a region, exactly
 * the lab's region law. Pure computation, no I/O. Opt-in,
 * forensic tier, advisory attribution only.
 */

export const AC23_BITS = 32;
export const AC23_REPEATS_PER_BIT = 48;
export const AC23_QUORUM = 10;
/** Signed DCT margin the embed writes, matching the lab's observed margins (about 32). */
export const AC23_MARGIN = 32;

export interface LuminanceImage {
  width: number;
  height: number;
  /** Row-major luminance values, width * height entries. */
  y: ArrayLike<number>;
}

export interface WatermarkRegion {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function dctMatrix(): number[][] {
  const m: number[][] = [];
  for (let k = 0; k < 8; k++) {
    const row: number[] = [];
    const c = k === 0 ? Math.sqrt(1 / 8) : Math.sqrt(2 / 8);
    for (let n = 0; n < 8; n++) row.push(c * Math.cos((Math.PI * k * (2 * n + 1)) / 16));
    m.push(row);
  }
  return m;
}
const M = dctMatrix();

function dct2(block: number[][]): number[][] {
  // C = M * block * M^T
  const tmp: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) {
      let s = 0;
      for (let k = 0; k < 8; k++) s += (M[i]?.[k] ?? 0) * (block[k]?.[j] ?? 0);
      (tmp[i] as number[])[j] = s;
    }
  const out: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) {
      let s = 0;
      for (let k = 0; k < 8; k++) s += (tmp[i]?.[k] ?? 0) * (M[j]?.[k] ?? 0);
      (out[i] as number[])[j] = s;
    }
  return out;
}

function idct2(coef: number[][]): number[][] {
  // block = M^T * C * M
  const tmp: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) {
      let s = 0;
      for (let k = 0; k < 8; k++) s += (M[k]?.[i] ?? 0) * (coef[k]?.[j] ?? 0);
      (tmp[i] as number[])[j] = s;
    }
  const out: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) {
      let s = 0;
      for (let k = 0; k < 8; k++) s += (tmp[i]?.[k] ?? 0) * (M[k]?.[j] ?? 0);
      (out[i] as number[])[j] = s;
    }
  return out;
}

/** Deterministic block selection: a seeded shuffle of all block indices, first 32 * 48 taken in bit order. */
export function ac23BlockSelection(width: number, height: number, seed = 20285354): number[] {
  const nbx = Math.floor(width / 8);
  const total = nbx * Math.floor(height / 8);
  const indices = Array.from({ length: total }, (_, i) => i);
  let state = seed >>> 0;
  const next = (): number => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const tmp = indices[i] as number;
    indices[i] = indices[j] as number;
    indices[j] = tmp;
  }
  return indices.slice(0, AC23_BITS * AC23_REPEATS_PER_BIT);
}

function readBlock(y: ArrayLike<number>, width: number, bx: number, by: number): number[][] {
  const block: number[][] = [];
  for (let r = 0; r < 8; r++) {
    const row: number[] = [];
    for (let c = 0; c < 8; c++) row.push(y[(by * 8 + r) * width + bx * 8 + c] ?? 0);
    block.push(row);
  }
  return block;
}

function writeBlock(out: Float64Array, width: number, bx: number, by: number, block: number[][]): void {
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const v = block[r]?.[c] ?? 0;
      out[(by * 8 + r) * width + bx * 8 + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
}

/**
 * Embed a 32-bit payload into a copy of the luminance plane.
 * Returns a new Float64Array; the input is never mutated.
 */
export function embedYDctWatermark(image: LuminanceImage, payload: number, seed = 20285354): Float64Array {
  const { width, height } = image;
  if (width % 8 !== 0 || height % 8 !== 0) throw new RangeError("embedYDctWatermark: width and height must be multiples of 8");
  const blocks = ac23BlockSelection(width, height, seed);
  if (blocks.length < AC23_BITS * AC23_REPEATS_PER_BIT) throw new RangeError("embedYDctWatermark: image too small for 32 x 48 blocks");
  const out = Float64Array.from(image.y as ArrayLike<number>);
  const nbx = Math.floor(width / 8);
  for (let bit = 0; bit < AC23_BITS; bit++) {
    const want = (payload >>> (31 - bit)) & 1;
    const target = want === 1 ? AC23_MARGIN : -AC23_MARGIN;
    for (let k = 0; k < AC23_REPEATS_PER_BIT; k++) {
      const idx = blocks[bit * AC23_REPEATS_PER_BIT + k] as number;
      const bx = idx % nbx;
      const by = Math.floor(idx / nbx);
      const coef = dct2(readBlock(out, width, bx, by));
      const current = (coef[2]?.[1] ?? 0) - (coef[1]?.[2] ?? 0);
      const delta = target - current;
      (coef[2] as number[])[1] = (coef[2]?.[1] ?? 0) + delta / 2;
      (coef[1] as number[])[2] = (coef[1]?.[2] ?? 0) - delta / 2;
      writeBlock(out, width, bx, by, idct2(coef));
    }
  }
  return out;
}

export interface YDctExtraction {
  /** Recovered 32-bit payload value (undecidable bits read as 0, per the lab law). */
  payload: number;
  /** Bits whose region repeats reached quorum and whose vote was not tied. */
  decidedBits: number;
  /** Repeats counted per bit inside the region. */
  repeatsPerBit: number[];
  /** Bits below quorum inside the region (vote starvation). */
  belowQuorumBits: number[];
  /** When an expected payload is supplied: bits matching it, and the full-match flag. */
  correctBits?: number;
  fullMatch?: boolean;
}

/**
 * Extract the payload from a luminance plane, voting only over
 * blocks fully inside `region` (the whole frame when omitted).
 * Quorum and tie law are the lab's: fewer than 10 repeats makes a
 * bit undecidable (read as 0); a tied vote is wrong (read as 0
 * unless the majority says otherwise - ties never count correct).
 */
export function extractYDctWatermark(
  image: LuminanceImage,
  options: { region?: WatermarkRegion; expectedPayload?: number; seed?: number } = {},
): YDctExtraction {
  const { width, height } = image;
  const region: WatermarkRegion = options.region ?? { x0: 0, x1: width, y0: 0, y1: height };
  const blocks = ac23BlockSelection(width, height, options.seed ?? 20285354);
  const nbx = Math.floor(width / 8);
  const repeatsPerBit: number[] = [];
  const belowQuorumBits: number[] = [];
  let payload = 0;
  let decided = 0;
  let correct = 0;
  const expected = options.expectedPayload;
  for (let bit = 0; bit < AC23_BITS; bit++) {
    let ones = 0;
    let vis = 0;
    for (let k = 0; k < AC23_REPEATS_PER_BIT; k++) {
      const idx = blocks[bit * AC23_REPEATS_PER_BIT + k] as number;
      const bx = idx % nbx;
      const by = Math.floor(idx / nbx);
      if (!(bx * 8 >= region.x0 && (bx + 1) * 8 <= region.x1 && by * 8 >= region.y0 && (by + 1) * 8 <= region.y1)) continue;
      vis++;
      const coef = dct2(readBlock(image.y, width, bx, by));
      if ((coef[2]?.[1] ?? 0) - (coef[1]?.[2] ?? 0) > 0) ones++;
    }
    repeatsPerBit.push(vis);
    let recovered = 0;
    let isDecided = false;
    if (vis < AC23_QUORUM) {
      belowQuorumBits.push(bit);
    } else if (ones * 2 !== vis) {
      recovered = ones > vis / 2 ? 1 : 0;
      isDecided = true;
    }
    if (isDecided) decided++;
    payload = (payload << 1) | recovered;
    if (expected !== undefined && isDecided && recovered === ((expected >>> (31 - bit)) & 1)) correct++;
  }
  return {
    payload: payload >>> 0,
    decidedBits: decided,
    repeatsPerBit,
    belowQuorumBits,
    ...(expected !== undefined
      ? { correctBits: correct, fullMatch: (payload >>> 0) === (expected >>> 0) && correct === AC23_BITS }
      : {}),
  };
}
