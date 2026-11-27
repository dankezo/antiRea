/**
 * HV-03 dataset fingerprint trace (antiRea 3.3.3) - per-identity
 * dataset fingerprinting for leak attribution, Tardos-family,
 * binary. Ported from the frozen trial registration
 * REGISTRATION-HV03-FINGERPRINT-TRACE.md and the mechanical
 * reference hv03_sim.py in the antiRea research tree
 * (trials-333-hv03, 2026-11-25). The scheme below is the
 * registered scheme; the math was not re-invented for this port.
 *
 * WHAT THIS IS - AND WHAT IT IS NOT (claim discipline, freeze
 * section 2.2). HV-03 is ATTRIBUTION ONLY. Each identified
 * channel (an authenticated account, an API key holder) receives
 * a deliberately distinct variant of the same dataset. If a copy
 * later surfaces - leaked, resold, or scraped through that
 * channel - the variant's embedded fingerprint can accuse the
 * source identity, including after colluders merge copies or an
 * attacker erodes the copy. HV-03 does NOT prevent scraping, does
 * NOT stop a leak, and must never be described as doing either.
 * It makes a leaked copy carry a name; that is the whole claim.
 *
 * IDENTIFIED CHANNELS ONLY. The scheme presumes the operator can
 * serve per-identity variants, which requires a stable identity:
 * an authenticated session or an API key. On a fully public
 * ANONYMOUS endpoint there is no identity to fingerprint and
 * HV-03 does not apply at all. This is enforced in code, not
 * just in this header: variantFor() and codewordBit() throw on
 * an empty or missing identity.
 *
 * MEASURED BASIS (lab, 2026-11-25, HV03-TRIAL-REPORT-2026-11-25).
 * One seeded population: the catalog twin's 2,000-record dataset,
 * N = 12 identities, 36 frozen runs (12 single leaks, 16
 * collusion runs under two merge strategies, 4 erosion runs, 4
 * collusion-plus-erosion runs). Verdict PASS on all frozen gates:
 * - G1 safety: 0 false accusations across all 36 runs; the
 *   highest innocent score observed was 59.2 against Z = 90.
 * - G2 single leak: exact accusation of the source, 12/12 runs;
 *   the lowest source score was 474.
 * - G3 collusion: at least one true source accused in 16/16
 *   runs; per-source recall 1.00 (40/40 colluders named).
 * - G4 erosion: single-source erosion exact in 4/4 runs;
 *   collusion-plus-erosion named at least one source in 4/4 runs
 *   (per-source recall 0.60 - enumeration degrades under
 *   erosion even though attribution survives).
 * - G5 utility: mean record-omission rate 7.15% (max 7.9%),
 *   perturbed field cells 3.0% of all (record x 5-field) cells,
 *   max price relative deviation 1.91%, stock delta exactly 10.
 * What this does NOT license: any claim about real-world
 * datasets (the lab catalog is synthetic and semantically flat -
 * prices and stock tolerate plus/minus delta marks and records
 * are independent; datasets with checksums, cross-references or
 * exact-price semantics would reject some marks, so the utility
 * numbers are an upper bound on safety, not a transfer
 * guarantee), collusion above 3 parties, pirates that AVERAGE
 * numeric fields across copies (outside the marking assumption;
 * averaged values decode as erasures), anonymous endpoints, or
 * prevention of anything.
 *
 * THE SCHEME (registration sections 2 and 3, verbatim in
 * substance):
 * - Code length L = 600 positions on 600 distinct records:
 *   300 inclusion positions (symbol 1 = record present in the
 *   variant, symbol 0 = record omitted), 150 price positions
 *   (symbol 1 = price + delta, symbol 0 = price - delta, delta =
 *   10,000; eligible records only: base price >= 500,000, so the
 *   mark is at most 2.0% of the field value and exactly one
 *   10,000 rounding-grid unit), 150 stock positions (symbol 1 =
 *   stock + 10, symbol 0 = stock - 10; eligible only: 10 <=
 *   stock <= 230, delta = one 10 rounding-grid unit).
 * - Position assignment (deterministic): shuffle all record
 *   indices with the shuffle stream; walk the shuffled list and
 *   assign each record to the first still-open slot type it is
 *   eligible for, in the order inclusion, then price, then
 *   stock; skip records eligible for nothing still open. (The
 *   reference's if/elif chain is exactly this: inclusion has no
 *   eligibility condition, so the first inclusion-count shuffled
 *   records fill the inclusion slots.) If the dataset cannot
 *   fill every position, buildPlan() throws.
 * - Biases: for each position j, in assignment order, draw p_j
 *   by rejection sampling from the arcsine law p = sin^2(pi*u/2),
 *   u uniform on (0,1), resampling while p is outside
 *   [0.05, 0.95].
 * - Codewords: x_ij ~ Bernoulli(p_j), one bit per (identity,
 *   position) pair.
 * - Variant construction: apply the identity's marks; every
 *   non-position record and field is verbatim.
 * - Accusation (symmetric Tardos): for position j with bias p
 *   and observed pirate symbol y in {0, 1} (erasure contributes
 *   0): y = 1 gives +sqrt((1-p)/p) when x = 1 and -sqrt(p/(1-p))
 *   when x = 0; y = 0 gives +sqrt(p/(1-p)) when x = 0 and
 *   -sqrt((1-p)/p) when x = 1. S_i is the sum over positions.
 *   Accuse identity i iff S_i > Z, with Z = 90. (Sizing from the
 *   registration: each term has mean 0 and variance 1 for an
 *   innocent identity, so S_innocent is approximately N(0, L);
 *   with L = 600, sigma is about 24.5 and Z = 90 is about
 *   3.67 sigma.)
 * - Observation rules (frozen): an inclusion position observes
 *   y = 1 when the record is present in the pirate copy; when
 *   absent, y = 0 iff the pirate copy holds at least
 *   massDeletionKeepRatio * datasetSize records (default ratio
 *   0.8; the trial used 1,600 of 2,000), else erasure (absence
 *   is ambiguous once mass deletion is in play). A perturbation
 *   position observes erasure when the record is absent; when
 *   present, decode by nearest marked value: y = 1 if the value
 *   is strictly nearer base + delta, y = 0 if strictly nearer
 *   base - delta, erasure on an exact tie. (Delta equals one
 *   rounding-grid unit, so a value re-rounded to that grid stays
 *   strictly nearer its own mark.)
 *
 * DETERMINISM DEVIATION - DECLARED, the random streams. The
 * trial drew from Python random.Random streams seeded 20261125
 * (shuffle), 20261126 (biases) and 20261127 (codewords). The SDK
 * cannot reproduce Python's Mersenne Twister streams, so every
 * stream here is instead derived from the host secret via
 * HMAC-SHA256 counter streams (node:crypto createHmac): the
 * shuffle stream is HMAC(secret, "hv03:shuffle:" + counter)
 * blocks, the bias stream is HMAC(secret, "hv03:bias:" +
 * counter) blocks, and each codeword bit is keyed directly by
 * HMAC(secret, "hv03:code:" + identity + ":" + j), reduced to a
 * uniform double and compared against p_j. The concrete bits,
 * shuffle order and biases therefore DIFFER from the trial's for
 * the same dataset. What is identical is everything the frozen
 * gates depend on: the distributions (uniform shuffle, arcsine
 * biases truncated to [0.05, 0.95], Bernoulli(p_j) codeword
 * bits), the position counts and assignment rule, the deltas
 * and eligibility rules, the observation rules, the scoring and
 * Z = 90. The SDK test suite re-measures the decisive gates
 * (single-leak exactness, utility bounds, collusion and erosion
 * smoke cells) against this stream.
 * Consequence of keyed derivation, stated plainly: the same
 * (secret, identity, dataset) always produces the identical
 * variant - in-session and cross-session consistency is
 * structural, not stored - and a variant can be re-derived at
 * accusation time from the secret alone, so the host never has
 * to store per-identity copies to accuse later.
 *
 * ORDER. The trial shuffled each variant's record order with a
 * per-identity stream - a cosmetic layer the accusation
 * deliberately does not use, because accusation is
 * order-invariant (and the frozen erosion attack shuffles
 * anyway, so order must carry no load). This module therefore
 * preserves dataset order minus omissions and does not shuffle.
 *
 * HARD CONDITIONS - in the code, not just the docs:
 * 1. HOST SECRET IS MANDATORY. createFingerprintTrace() throws
 *    FingerprintTraceError without a non-empty secret. The
 *    secret never leaves the host: plans, variants and
 *    accusations are all computed host-side.
 * 2. IDENTITY IS MANDATORY. variantFor() and codewordBit()
 *    throw on an empty or missing identity - the code-level
 *    form of the identified-channels-only rule above. There is
 *    no anonymous mode and no default identity.
 * 3. ATTRIBUTION ONLY. accuse() returns scores and a boolean
 *    per candidate identity; it takes no action. What a host
 *    does with an accusation (investigate, contact, litigate)
 *    is the host's decision, and a score above Z is evidence
 *    about a channel, not proof of a person's intent.
 *
 * PERFORMANCE. buildPlan is O(N + L) for N records and L
 * positions. variantFor is O(N + L) per identity. accuse is
 * O(identities * L) after an O(N) pass to decode the observed
 * symbols once. Recommended caching: cache the plan per dataset
 * version (a plan is bound to the dataset it was built from -
 * positions are record indices into that dataset), and cache
 * the variant per (identity, dataset version). Codeword bits
 * are re-derived per call by design (see the determinism note),
 * so accusation needs no stored codewords.
 */

/* ------------------------------------------------------------------------ */
/* Minimal structural view of node:crypto (mirrors cursor.ts and            */
/* canary-echo.ts: this repo carries no @types/node, so the module declares */
/* the two HMAC shapes it uses and lazy-requires the builtin at runtime).   */
/* ------------------------------------------------------------------------ */

interface NodeHmacLike {
  update(data: string | Uint8Array): NodeHmacLike;
  digest(): Uint8Array;
}

interface NodeCryptoLike {
  createHmac(algorithm: string, key: string | Uint8Array): NodeHmacLike;
}

declare const require: ((id: string) => NodeCryptoLike) | undefined;

function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.createHmac === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new FingerprintTraceError("node:crypto is not available in this runtime; HV-03 requires Node.js");
}

function hmacSha256(key: Uint8Array, data: string): Uint8Array {
  return getNodeCrypto().createHmac("sha256", key).update(data).digest();
}

/** Error thrown for every HV-03 contract violation (missing secret, missing identity, unfillable plan, inconsistent options). */
export class FingerprintTraceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FingerprintTraceError";
  }
}

/** The three position kinds, in assignment order. */
export type FingerprintPositionType = "inclusion" | "price" | "stock";

/** Default record shape used when the host supplies no accessors. */
export interface FingerprintRecord {
  id: string;
  price: number;
  stock: number;
}

/**
 * Field accessors for host record shapes other than the default
 * { id, price, stock }. withPrice / withStock must return a NEW
 * record carrying the given value (the input record is never
 * mutated by this module).
 */
export interface FingerprintAccessors<R> {
  id(record: R): string;
  price(record: R): number;
  withPrice(record: R, value: number): R;
  stock(record: R): number;
  withStock(record: R, value: number): R;
}

export interface FingerprintTraceOptions<R = FingerprintRecord> {
  /** Host secret (string or bytes). REQUIRED; construction throws when missing or empty. */
  secret: string | Uint8Array;
  /**
   * Total code length L. When given it must equal
   * inclusionPositions + pricePositions + stockPositions;
   * a mismatch throws instead of silently re-slicing the code.
   */
  codeLength?: number;
  /** Inclusion positions. Default 300. */
  inclusionPositions?: number;
  /** Price perturbation positions. Default 150. */
  pricePositions?: number;
  /** Stock perturbation positions. Default 150. */
  stockPositions?: number;
  /** Accusation threshold Z; accuse iff score > Z. Default 90. */
  accusationThreshold?: number;
  /** Price mark delta. Default 10000. */
  priceDelta?: number;
  /** Price eligibility floor: base price must be >= this. Default 500000. */
  priceMinEligible?: number;
  /** Stock mark delta. Default 10. */
  stockDelta?: number;
  /** Stock eligibility floor (inclusive). Default 10. */
  stockMin?: number;
  /** Stock eligibility ceiling (inclusive). Default 230. */
  stockMax?: number;
  /**
   * Inclusion-absence rule: an absent inclusion record decodes
   * as y = 0 only when the pirate copy holds at least this
   * fraction of the plan's datasetSize records. Default 0.8.
   */
  massDeletionKeepRatio?: number;
  /** Field accessors. Default targets { id, price, stock } records. */
  accessors?: FingerprintAccessors<R>;
}

/** One code position: a record, a kind, and its arcsine bias. */
export interface FingerprintPosition {
  /** Position index j in [0, L). Biases and codeword bits are indexed by this. */
  index: number;
  /** Index of the marked record in the dataset the plan was built from. */
  recordIndex: number;
  /** Id of the marked record (via the accessors), for auditing. */
  recordId: string;
  type: FingerprintPositionType;
  /** Arcsine bias p_j in [0.05, 0.95]: the probability that a codeword bit at this position is 1. */
  bias: number;
  /** Base price / stock of the marked record at plan time; null for inclusion positions. */
  baseValue: number | null;
}

/** A deterministic position assignment for one dataset version. */
export interface FingerprintPlan {
  positions: FingerprintPosition[];
  /** Number of records in the dataset the plan was built from. */
  datasetSize: number;
  /** Total code length L (sum of the three position counts). */
  codeLength: number;
}

/** One identity's fingerprinted variant of a dataset. */
export interface FingerprintVariant<R> {
  /** The variant records: dataset order, minus omitted inclusion records. */
  records: R[];
  /** How many records were omitted (inclusion positions with symbol 0). */
  omittedCount: number;
  /** How many field cells were perturbed (one per price / stock position). */
  perturbedCells: number;
  /** omittedCount / datasetSize. */
  omissionRate: number;
}

/** One candidate identity's accusation result. */
export interface FingerprintAccusation {
  identity: string;
  /** Symmetric Tardos score S_i. */
  score: number;
  /** True iff score > the configured accusation threshold Z. */
  accused: boolean;
}

export interface FingerprintTrace<R = FingerprintRecord> {
  /** Deterministic position assignment for a dataset. Throws when the dataset cannot fill every position. */
  buildPlan(dataset: readonly R[]): FingerprintPlan;
  /** The fingerprinted variant for one identified channel. Throws on an empty or missing identity. */
  variantFor(identity: string, dataset: readonly R[], plan?: FingerprintPlan): FingerprintVariant<R>;
  /** Score every candidate identity against a surfaced pirate copy, sorted by score descending. */
  accuse(
    pirateRecords: readonly R[],
    dataset: readonly R[],
    plan: FingerprintPlan,
    identities: readonly string[],
  ): FingerprintAccusation[];
  /** The codeword bit of one identity at one position (exposed for tests and auditing). */
  codewordBit(identity: string, positionIndex: number, plan: FingerprintPlan): 0 | 1;
}

const DEFAULT_ACCESSORS: FingerprintAccessors<FingerprintRecord> = {
  id: (r) => r.id,
  price: (r) => r.price,
  withPrice: (r, v) => ({ ...r, price: v }),
  stock: (r) => r.stock,
  withStock: (r, v) => ({ ...r, stock: v }),
};

function requireIdentity(identity: unknown): string {
  if (typeof identity !== "string" || identity.trim().length === 0) {
    throw new FingerprintTraceError(
      "identity is required and must be a non-empty string: HV-03 fingerprints identified channels only and does not apply to anonymous endpoints",
    );
  }
  return identity;
}

function requireCount(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new FingerprintTraceError(`${name} must be a non-negative integer, got ${String(value)}`);
  }
  return value;
}

function requirePositiveFinite(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new FingerprintTraceError(`${name} must be a positive finite number, got ${String(value)}`);
  }
  return value;
}

/** Reduce the first 8 bytes of a digest to a uniform double on [0, 1) with 53 bits of resolution. */
function digestToUniform(digest: Uint8Array): number {
  let hi = 0;
  let lo = 0;
  for (let k = 0; k < 4; k += 1) hi = hi * 256 + (digest[k] as number);
  for (let k = 4; k < 8; k += 1) lo = lo * 256 + (digest[k] as number);
  return (hi * 2097152 + (lo >>> 11)) / 9007199254740992;
}

/**
 * A deterministic byte stream: consecutive HMAC-SHA256 blocks
 * over (label, counter). Used for the shuffle and bias streams.
 */
class HmacCounterStream {
  private counter = 0;
  private block: Uint8Array = new Uint8Array(0);
  private offset = 0;

  public constructor(
    private readonly key: Uint8Array,
    private readonly label: string,
  ) {}

  private nextByte(): number {
    if (this.offset >= this.block.length) {
      this.block = hmacSha256(this.key, `${this.label}:${this.counter}`);
      this.counter += 1;
      this.offset = 0;
    }
    const byte = this.block[this.offset] as number;
    this.offset += 1;
    return byte;
  }

  /** Uniform double on [0, 1) with 53 bits of resolution. */
  public nextDouble(): number {
    let hi = 0;
    let lo = 0;
    for (let k = 0; k < 4; k += 1) hi = hi * 256 + this.nextByte();
    for (let k = 0; k < 4; k += 1) lo = lo * 256 + this.nextByte();
    return (hi * 2097152 + (lo >>> 11)) / 9007199254740992;
  }
}

export function createFingerprintTrace<R = FingerprintRecord>(
  options: FingerprintTraceOptions<R>,
): FingerprintTrace<R> {
  if (options === null || typeof options !== "object") {
    throw new FingerprintTraceError("options with a non-empty secret are required");
  }
  const secret = options.secret;
  let key: Uint8Array;
  if (typeof secret === "string") {
    if (secret.length === 0) {
      throw new FingerprintTraceError("secret is required and must be non-empty");
    }
    key = new TextEncoder().encode(secret);
  } else if (secret instanceof Uint8Array) {
    if (secret.length === 0) {
      throw new FingerprintTraceError("secret is required and must be non-empty");
    }
    key = Uint8Array.from(secret);
  } else {
    throw new FingerprintTraceError("secret is required and must be a non-empty string or Uint8Array");
  }

  const inclusionCount = requireCount("inclusionPositions", options.inclusionPositions ?? 300);
  const priceCount = requireCount("pricePositions", options.pricePositions ?? 150);
  const stockCount = requireCount("stockPositions", options.stockPositions ?? 150);
  const codeLength = inclusionCount + priceCount + stockCount;
  if (codeLength <= 0) {
    throw new FingerprintTraceError("at least one fingerprint position is required");
  }
  if (options.codeLength !== undefined && options.codeLength !== codeLength) {
    throw new FingerprintTraceError(
      `codeLength ${String(options.codeLength)} does not equal inclusionPositions + pricePositions + stockPositions (${codeLength})`,
    );
  }
  const threshold = options.accusationThreshold ?? 90;
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
    throw new FingerprintTraceError(`accusationThreshold must be a finite number, got ${String(threshold)}`);
  }
  const priceDelta = requirePositiveFinite("priceDelta", options.priceDelta ?? 10000);
  const priceMinEligible = options.priceMinEligible ?? 500000;
  if (typeof priceMinEligible !== "number" || !Number.isFinite(priceMinEligible) || priceMinEligible < 0) {
    throw new FingerprintTraceError(`priceMinEligible must be a non-negative finite number, got ${String(priceMinEligible)}`);
  }
  const stockDelta = requirePositiveFinite("stockDelta", options.stockDelta ?? 10);
  const stockMin = options.stockMin ?? 10;
  const stockMax = options.stockMax ?? 230;
  if (!Number.isFinite(stockMin) || !Number.isFinite(stockMax) || stockMin > stockMax) {
    throw new FingerprintTraceError(`stockMin/stockMax must be finite with stockMin <= stockMax, got ${String(stockMin)}/${String(stockMax)}`);
  }
  const massDeletionKeepRatio = options.massDeletionKeepRatio ?? 0.8;
  if (
    typeof massDeletionKeepRatio !== "number" ||
    !Number.isFinite(massDeletionKeepRatio) ||
    massDeletionKeepRatio <= 0 ||
    massDeletionKeepRatio > 1
  ) {
    throw new FingerprintTraceError(`massDeletionKeepRatio must be in (0, 1], got ${String(massDeletionKeepRatio)}`);
  }
  const accessors = (options.accessors ?? DEFAULT_ACCESSORS) as FingerprintAccessors<R>;

  function codewordBit(identity: string, positionIndex: number, plan: FingerprintPlan): 0 | 1 {
    const id = requireIdentity(identity);
    const position = plan.positions[positionIndex];
    if (position === undefined) {
      throw new FingerprintTraceError(`positionIndex ${String(positionIndex)} is outside the plan's ${plan.positions.length} positions`);
    }
    const digest = hmacSha256(key, `hv03:code:${id}:${positionIndex}`);
    return digestToUniform(digest) < position.bias ? 1 : 0;
  }

  function buildPlan(dataset: readonly R[]): FingerprintPlan {
    if (!Array.isArray(dataset) || dataset.length === 0) {
      throw new FingerprintTraceError("dataset must be a non-empty array of records");
    }
    for (const record of dataset) {
      if (record === null || typeof record !== "object") {
        throw new FingerprintTraceError("dataset records must be non-null objects");
      }
    }
    // Fisher-Yates shuffle of the record indices, driven by the
    // secret's shuffle stream (registration: shuffle all indices,
    // then walk the shuffled list).
    const order: number[] = dataset.map((_, i) => i);
    const shuffleStream = new HmacCounterStream(key, "hv03:shuffle");
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(shuffleStream.nextDouble() * (i + 1));
      const tmp = order[i] as number;
      order[i] = order[j] as number;
      order[j] = tmp;
    }
    // Assign each shuffled record to the first still-open slot
    // type it is eligible for, in the order inclusion, price,
    // stock (the reference implementation's if/elif chain).
    let needInclusion = inclusionCount;
    let needPrice = priceCount;
    let needStock = stockCount;
    const assigned: Array<{ recordIndex: number; type: FingerprintPositionType; baseValue: number | null }> = [];
    for (const recordIndex of order) {
      if (needInclusion === 0 && needPrice === 0 && needStock === 0) break;
      const record = dataset[recordIndex] as R;
      if (needInclusion > 0) {
        assigned.push({ recordIndex, type: "inclusion", baseValue: null });
        needInclusion -= 1;
      } else if (needPrice > 0 && accessors.price(record) >= priceMinEligible) {
        assigned.push({ recordIndex, type: "price", baseValue: accessors.price(record) });
        needPrice -= 1;
      } else if (needStock > 0) {
        const stock = accessors.stock(record);
        if (stock >= stockMin && stock <= stockMax) {
          assigned.push({ recordIndex, type: "stock", baseValue: stock });
          needStock -= 1;
        }
      }
    }
    if (needInclusion > 0 || needPrice > 0 || needStock > 0) {
      throw new FingerprintTraceError(
        `dataset cannot fill all fingerprint positions: still open after the walk - inclusion ${needInclusion}, price ${needPrice}, stock ${needStock} (dataset size ${dataset.length})`,
      );
    }
    // Biases in assignment order, arcsine with rejection to
    // [0.05, 0.95], from the secret's bias stream.
    const biasStream = new HmacCounterStream(key, "hv03:bias");
    const positions: FingerprintPosition[] = assigned.map((slot, index) => {
      let p = 0;
      do {
        const u = biasStream.nextDouble();
        p = Math.sin((Math.PI * u) / 2) ** 2;
      } while (p < 0.05 || p > 0.95);
      const record = dataset[slot.recordIndex] as R;
      return {
        index,
        recordIndex: slot.recordIndex,
        recordId: accessors.id(record),
        type: slot.type,
        bias: p,
        baseValue: slot.baseValue,
      };
    });
    return { positions, datasetSize: dataset.length, codeLength };
  }

  function variantFor(identity: string, dataset: readonly R[], plan?: FingerprintPlan): FingerprintVariant<R> {
    const id = requireIdentity(identity);
    const activePlan = plan ?? buildPlan(dataset);
    if (activePlan.datasetSize !== dataset.length) {
      throw new FingerprintTraceError(
        `plan was built for a dataset of ${activePlan.datasetSize} records but variantFor received ${dataset.length}: a plan is bound to one dataset version`,
      );
    }
    const positionByRecord = new Map<number, FingerprintPosition>();
    for (const position of activePlan.positions) positionByRecord.set(position.recordIndex, position);
    const records: R[] = [];
    let omittedCount = 0;
    let perturbedCells = 0;
    for (let recordIndex = 0; recordIndex < dataset.length; recordIndex += 1) {
      const record = dataset[recordIndex] as R;
      const position = positionByRecord.get(recordIndex);
      if (position === undefined) {
        records.push(record);
        continue;
      }
      const bit = codewordBit(id, position.index, activePlan);
      if (position.type === "inclusion") {
        if (bit === 1) {
          records.push(record);
        } else {
          omittedCount += 1;
        }
      } else if (position.type === "price") {
        const base = accessors.price(record);
        records.push(accessors.withPrice(record, bit === 1 ? base + priceDelta : base - priceDelta));
        perturbedCells += 1;
      } else {
        const base = accessors.stock(record);
        records.push(accessors.withStock(record, bit === 1 ? base + stockDelta : base - stockDelta));
        perturbedCells += 1;
      }
    }
    return { records, omittedCount, perturbedCells, omissionRate: omittedCount / dataset.length };
  }

  function accuse(
    pirateRecords: readonly R[],
    dataset: readonly R[],
    plan: FingerprintPlan,
    identities: readonly string[],
  ): FingerprintAccusation[] {
    if (plan.datasetSize !== dataset.length) {
      throw new FingerprintTraceError(
        `plan was built for a dataset of ${plan.datasetSize} records but accuse received a dataset of ${dataset.length}: a plan is bound to one dataset version`,
      );
    }
    const candidateIdentities = identities.map((identity) => requireIdentity(identity));
    const pirateById = new Map<string, R>();
    for (const record of pirateRecords) pirateById.set(accessors.id(record), record);
    const noMassDeletion = pirateRecords.length >= massDeletionKeepRatio * plan.datasetSize;
    // Decode the observed symbol per position exactly once,
    // under the frozen observation rules; null means erasure.
    const observed: Array<0 | 1 | null> = plan.positions.map((position) => {
      const original = dataset[position.recordIndex] as R;
      const pirate = pirateById.get(accessors.id(original));
      if (position.type === "inclusion") {
        if (pirate !== undefined) return 1;
        return noMassDeletion ? 0 : null;
      }
      if (pirate === undefined) return null;
      const isPrice = position.type === "price";
      const base = isPrice ? accessors.price(original) : accessors.stock(original);
      const value = isPrice ? accessors.price(pirate) : accessors.stock(pirate);
      const delta = isPrice ? priceDelta : stockDelta;
      const distUp = Math.abs(value - (base + delta));
      const distDown = Math.abs(value - (base - delta));
      if (distUp < distDown) return 1;
      if (distDown < distUp) return 0;
      return null;
    });
    const results: FingerprintAccusation[] = candidateIdentities.map((identity) => {
      let score = 0;
      for (const position of plan.positions) {
        const y = observed[position.index];
        if (y === null || y === undefined) continue;
        const p = position.bias;
        const s1 = Math.sqrt((1 - p) / p);
        const s0 = Math.sqrt(p / (1 - p));
        const x = codewordBit(identity, position.index, plan);
        if (y === 1) {
          score += x === 1 ? s1 : -s0;
        } else {
          score += x === 0 ? s0 : -s1;
        }
      }
      return { identity, score, accused: score > threshold };
    });
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  return { buildPlan, variantFor, accuse, codewordBit };
}
