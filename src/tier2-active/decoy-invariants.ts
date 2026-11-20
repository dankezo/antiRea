/**
 * Cross-route invariant poisoning (antiRea 3.3.0, A6) - OPT-IN
 * data helpers; nothing is served unless the host plants the
 * generated sets into its own decoy surface (see
 * `decoy-registry.ts` / `decoy-surface.ts`).
 *
 * WHAT IT DOES. Some facts in a dataset only exist as joins
 * across routes: an order's stated total vs the sum of its line
 * items on another route; a warehouse's stated stock vs the sum
 * of its per-SKU rows elsewhere. Each side looks plausible on
 * its own. This module plants decoy record sets whose two sides
 * DISAGREE by a controlled percentage, deterministically from a
 * host seed. An extractor that captures both routes (the normal
 * case - both answer 200) merges a dataset whose invariants are
 * broken, and the breakage only appears when the copier's clone
 * tries to reconcile the join. The violations live entirely
 * inside decoy data; real records are never inputs here.
 *
 * MEASURED BASIS. decoy-map trial v3, INV arm: 10 planted sets
 * (6 order totals vs line-item sums, 4 warehouse totals vs
 * per-SKU sums, mismatches -9.6% to +12.5%) - all 10 survived
 * into the extractor's capture with both sides captured, the
 * extractor reported 0 inconsistencies and 0 suspicion flags,
 * so the surviving-violation gap was 10 against a registered
 * threshold of 8. Direct value contradictions (the A3 family)
 * had already shown the same gradient in trial v2 (0 of 40
 * pairs flagged); cross-route joins are checked even less.
 *
 * DETERMINISM. Planting uses the same SHA-256 chain stream as
 * the polymorph surface, so the build-time tool
 * (tools/decoy/decoy.cjs) reproduces identical sets from the
 * same seed; the suite pins the two implementations together.
 */

interface NodeHashLike {
  update(data: string | Uint8Array, encoding?: string): NodeHashLike;
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
  throw new Error("node:crypto is not available in this runtime; decoy invariants require Node.js");
}

function sha256Bytes(data: string | Uint8Array): Uint8Array {
  const hex = getNodeCrypto().createHash("sha256").update(data as string, "utf8").digest("hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** SHA-256 chain stream - identical construction to polymorph-surface.ts and tools/decoy/decoy.cjs. */
export function decoyRng(seed: string, label: string): () => number {
  const seedHash = sha256Bytes(seed);
  let counter = 0;
  let buf: Uint8Array = new Uint8Array(0);
  let pos = 0;
  return () => {
    if (pos + 4 > buf.length) {
      const labelBytes = new TextEncoder().encode(`${label}:${counter}`);
      counter += 1;
      const block = new Uint8Array(seedHash.length + labelBytes.length);
      block.set(seedHash, 0);
      block.set(labelBytes, seedHash.length);
      buf = sha256Bytes(block);
      pos = 0;
    }
    const b0 = buf[pos] as number;
    const b1 = buf[pos + 1] as number;
    const b2 = buf[pos + 2] as number;
    const b3 = buf[pos + 3] as number;
    pos += 4;
    return (b0 * 0x1000000 + b1 * 0x10000 + b2 * 0x100 + b3) / 0x100000000;
  };
}

export class DecoyInvariantsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoyInvariantsError";
  }
}

export interface InvariantPart {
  /** Part identifier (e.g. a line-item or stock-row key). */
  partId: string;
  /** The part's amount; the parts are what the detail route serves. */
  amount: number;
}

export interface InvariantSet {
  /** Group identifier shared by both routes (e.g. an order reference or warehouse code). */
  group: string;
  /** The total the aggregate route states. */
  statedTotal: number;
  /** The detail parts the detail route serves. */
  parts: InvariantPart[];
  /** Sum of the parts (recomputed, never trusted from input). */
  partsSum: number;
  /** (partsSum - statedTotal) / statedTotal * 100, signed. */
  mismatchPct: number;
}

export interface PlantInvariantOptions {
  /** Host seed; the same seed always plants the same sets. */
  seed: string;
  /** Number of sets to plant. */
  count: number;
  /** Group id prefix, e.g. "ORD" or "WH". Groups are numbered from `startAt`. */
  groupPrefix: string;
  /** First group number (default 9101, the trial shape). */
  startAt?: number;
  /** Stated totals are drawn from [minTotal, maxTotal] (integers). */
  minTotal?: number;
  maxTotal?: number;
  /** Mismatch band in percent, [min, max] absolute values; sign is drawn per set. The trial band was about 5-12.5%. */
  mismatchPctRange?: [number, number];
  /** Parts per set are drawn from [minParts, maxParts]. */
  partsRange?: [number, number];
}

/**
 * Plant `count` invariant-violating sets. Every set's parts sum
 * differs from its stated total by a mismatch inside the band,
 * and the parts are positive integers summing exactly to the
 * (rounded) target sum, so the violation is arithmetic, not a
 * rounding artifact.
 */
export function plantInvariantViolations(opts: PlantInvariantOptions): InvariantSet[] {
  if (typeof opts.seed !== "string" || opts.seed.length === 0) throw new DecoyInvariantsError("seed must be a non-empty string");
  if (!Number.isInteger(opts.count) || opts.count < 0) throw new DecoyInvariantsError("count must be a non-negative integer");
  const startAt = opts.startAt ?? 9101;
  const minTotal = opts.minTotal ?? 500_000;
  const maxTotal = opts.maxTotal ?? 4_000_000;
  const [mmMin, mmMax] = opts.mismatchPctRange ?? [5, 12.5];
  const [pMin, pMax] = opts.partsRange ?? [2, 4];
  if (!(minTotal > 0 && maxTotal >= minTotal)) throw new DecoyInvariantsError("total range is invalid");
  if (!(mmMin > 0 && mmMax >= mmMin && mmMax < 100)) throw new DecoyInvariantsError("mismatch band must lie in (0, 100)");
  if (!(pMin >= 2 && pMax >= pMin)) throw new DecoyInvariantsError("parts range must start at >= 2 (a single part cannot hide a sum)");

  const rnd = decoyRng(opts.seed, `invariants:${opts.groupPrefix}`);
  const draw = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const sets: InvariantSet[] = [];
  for (let s = 0; s < opts.count; s++) {
    const statedTotal = draw(minTotal, maxTotal);
    const sign = rnd() < 0.5 ? -1 : 1;
    const mismatchPct = sign * (mmMin + rnd() * (mmMax - mmMin));
    const partsSum = Math.max(pMax, Math.round(statedTotal * (1 + mismatchPct / 100)));
    const partCount = draw(pMin, pMax);
    // Split partsSum into partCount positive integers summing exactly.
    const weights: number[] = [];
    let wTotal = 0;
    for (let k = 0; k < partCount; k++) { const w = 0.5 + rnd(); weights.push(w); wTotal += w; }
    const parts: InvariantPart[] = [];
    let assigned = 0;
    for (let k = 0; k < partCount; k++) {
      const w = weights[k] as number;
      const amount = k === partCount - 1 ? partsSum - assigned : Math.max(1, Math.floor((partsSum * w) / wTotal));
      assigned += amount;
      parts.push({ partId: `${opts.groupPrefix}-${startAt + s}-${k + 1}`, amount });
    }
    const actualSum = parts.reduce((acc, p) => acc + p.amount, 0);
    sets.push({
      group: `${opts.groupPrefix}-${startAt + s}`,
      statedTotal,
      parts,
      partsSum: actualSum,
      mismatchPct: ((actualSum - statedTotal) / statedTotal) * 100,
    });
  }
  return sets;
}

export interface InvariantAudit {
  partsSum: number;
  mismatchPct: number;
  /** True when the parts do not sum to the stated total. */
  violates: boolean;
}

/** Audit one aggregate/detail pair: recompute the sum and compare. Consistent data reports violates = false. */
export function auditInvariant(statedTotal: number, parts: readonly InvariantPart[]): InvariantAudit {
  const partsSum = parts.reduce((acc, p) => acc + p.amount, 0);
  return {
    partsSum,
    mismatchPct: statedTotal === 0 ? 0 : ((partsSum - statedTotal) / statedTotal) * 100,
    violates: partsSum !== statedTotal,
  };
}
