/**
 * Transactional exact disclosure ledger + shared campaign ceiling.
 *
 * Productized from the overnight session's SDK contract review
 * (CHATGPT-R7/R8, 02/11/2026). Governing rule: **no enforcement without a
 * transaction.** A shared ceiling ("a cohort of linked identities may
 * receive at most N distinct records in total, however they rotate") is
 * only enforceable if the check-and-reserve step is atomic: over a plain
 * get/put store, two parallel reservations can both read the pre-check
 * state and jointly overspend the ceiling. This module therefore splits
 * stores into two honesty classes:
 *
 * - A store that implements `transactLedger(ledgerId, expectedVersion,
 *   updater)` - a compare-and-swap on `ledgerVersion` covering the union
 *   bitmap, outstanding reservations, the ceiling, the rate bucket and
 *   the evidence accumulators in ONE transaction - gets `mode:
 *   "enforce"`.
 * - A store with only `get`/`put` gets `mode: "audit_only"`. Decisions
 *   are still computed and returned (so hosts can log and measure), but
 *   every result carries `enforced: false` and the module NEVER claims
 *   the ceiling held. Hosts that need the guarantee must supply a
 *   transactional store.
 *
 * `reserveDisclosure` is the single atomic enforcement point: it lazily
 * expires stale reservations, applies the reservation bounds (TTL,
 * per-subject outstanding and reserved-record caps, optional cohort-wide
 * outstanding cap), checks the shared ceiling against the exact union
 * (committed records PLUS records held by outstanding reservations, so
 * reservations count against the ceiling while they are open), debits
 * the cohort rate bucket, and only then records the reservation.
 * `commit` moves a reservation's records into the committed union;
 * `release` frees them. Bucket tokens spent by a reservation are NOT
 * refunded on release - pacing is a cost, not a deposit.
 *
 * Cohort registry (lab round 6, arm B lesson): the campaign-guard
 * mechanism is correct only conditional on registry completeness - a
 * partial registry silently degraded the guard to per-member protection
 * while unregistered identities extracted freely. When a registry is
 * declared for a ledger, `checkRegistryCompleteness` reports missing
 * members, and subjects outside the registry are refused by default
 * (`unregisteredPolicy: "fail_closed"`); the `"audit_only"` policy is an
 * explicit opt-out that flags the decision instead of refusing.
 *
 * The bundled in-memory transactional store serializes transactions per
 * ledger with a promise chain, so its CAS guarantee is real inside one
 * process. It is NOT a distributed store: horizontally scaled hosts must
 * supply an adapter over their own atomic store (a SQL transaction, a
 * Redis Lua script, ...) implementing the same contract.
 *
 * Zero runtime dependencies; Node.js builtins are not required (the
 * bitmap/base64 helpers below are runtime-agnostic).
 */

import { monoNowMs } from "../internal/mono-clock";

/* ------------------------------------------------------------------------ */
/* Store failure type: every public entry converts store problems into a   */
/* structured `store_conflict` refusal instead of throwing (F-06).         */
/* ------------------------------------------------------------------------ */

class LedgerStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerStoreError";
  }
}

/* ------------------------------------------------------------------------ */
/* Exact bitmap helpers (record ids are non-negative integers).             */
/*                                                                          */
/* The bitmap is SPARSE and chunked (F-07): a Map from chunk index to a     */
/* fixed 1024-byte chunk covering 8192 ids. Stored size and reserve latency */
/* therefore grow with the number of ids actually present - never with the  */
/* VALUE of the largest id. The <= 2.6.0 dense encoding (one byte per 8 ids */
/* up to the max id, so a single id of 10^8 produced a 16.7 MB state and    */
/* id 2^53-1 threw RangeError) made state size a host-killing function of   */
/* the host's id space; snowflake/int64 ids now cost one chunk each.        */
/*                                                                          */
/* Wire formats: new states serialize as "s1." + base64url of             */
/* [uint32LE chunkIndex | 1024 chunk bytes]*. States written by older       */
/* versions (plain base64url of the dense byte array) still decode.         */
/* ------------------------------------------------------------------------ */

const BITMAP_CHUNK_BITS = 8192;
const BITMAP_CHUNK_BYTES = BITMAP_CHUNK_BITS / 8;
const SPARSE_BITMAP_PREFIX = "s1.";

type Bitmap = Map<number, Uint8Array>;

function emptyBitmap(): Bitmap {
  return new Map();
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  const STEP = 0x4000;
  for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytesStrict(value: string): Uint8Array {
  try {
    const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, ch => ch.charCodeAt(0));
  } catch {
    throw new LedgerStoreError("store_conflict: unparsable bitmap in stored ledger state");
  }
}

function bitmapFromBase64(value: string | undefined): Bitmap {
  const out: Bitmap = new Map();
  if (!value) return out;
  if (value.startsWith(SPARSE_BITMAP_PREFIX)) {
    const payload = base64UrlToBytesStrict(value.slice(SPARSE_BITMAP_PREFIX.length));
    const stride = 4 + BITMAP_CHUNK_BYTES;
    if (payload.length % stride !== 0) {
      throw new LedgerStoreError("store_conflict: malformed sparse bitmap in stored ledger state");
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    for (let offset = 0; offset < payload.length; offset += stride) {
      out.set(view.getUint32(offset, true), payload.slice(offset + 4, offset + stride));
    }
    return out;
  }
  // Legacy dense encoding written by <= 2.6.0: byte i holds ids 8i..8i+7.
  let dense: Uint8Array;
  try {
    const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    dense = Uint8Array.from(bin, ch => ch.charCodeAt(0));
  } catch {
    return out;
  }
  for (let start = 0; start < dense.length; start += BITMAP_CHUNK_BYTES) {
    const slice = dense.subarray(start, Math.min(start + BITMAP_CHUNK_BYTES, dense.length));
    let any = false;
    for (const byte of slice) if (byte !== 0) { any = true; break; }
    if (!any) continue;
    const chunk = new Uint8Array(BITMAP_CHUNK_BYTES);
    chunk.set(slice);
    out.set(start / BITMAP_CHUNK_BYTES, chunk);
  }
  return out;
}

function bitmapToBase64(bitmap: Bitmap): string {
  if (bitmap.size === 0) return "";
  const entries = [...bitmap.entries()].sort((a, b) => a[0] - b[0]);
  const stride = 4 + BITMAP_CHUNK_BYTES;
  const payload = new Uint8Array(entries.length * stride);
  const view = new DataView(payload.buffer);
  let offset = 0;
  for (const [index, chunk] of entries) {
    view.setUint32(offset, index, true);
    offset += 4;
    payload.set(chunk, offset);
    offset += BITMAP_CHUNK_BYTES;
  }
  return SPARSE_BITMAP_PREFIX + bytesToBase64Url(payload);
}

function bitmapHas(bitmap: Bitmap, id: number): boolean {
  const chunk = bitmap.get(Math.floor(id / BITMAP_CHUNK_BITS));
  if (!chunk) return false;
  const bit = id % BITMAP_CHUNK_BITS;
  return ((chunk[Math.floor(bit / 8)] ?? 0) & (1 << (bit % 8))) !== 0;
}

function bitmapWithIds(base: Bitmap, ids: readonly number[]): Bitmap {
  if (ids.length === 0) return base;
  const out: Bitmap = new Map(base);
  const copied = new Set<number>();
  for (const id of ids) {
    const chunkIndex = Math.floor(id / BITMAP_CHUNK_BITS);
    let chunk = out.get(chunkIndex);
    if (!chunk) {
      chunk = new Uint8Array(BITMAP_CHUNK_BYTES);
      out.set(chunkIndex, chunk);
    } else if (!copied.has(chunkIndex)) {
      // Copy-on-write: never mutate a chunk shared with `base`.
      chunk = chunk.slice();
      out.set(chunkIndex, chunk);
      copied.add(chunkIndex);
    }
    const bit = id % BITMAP_CHUNK_BITS;
    chunk[Math.floor(bit / 8)] = (chunk[Math.floor(bit / 8)] ?? 0) | (1 << (bit % 8));
  }
  return out;
}

function bitmapUnion(a: Bitmap, b: Bitmap): Bitmap {
  if (a.size === 0) return b;
  if (b.size === 0) return a;
  const out: Bitmap = new Map(a);
  for (const [index, chunkB] of b) {
    const chunkA = out.get(index);
    if (!chunkA) {
      out.set(index, chunkB);
      continue;
    }
    const merged = new Uint8Array(BITMAP_CHUNK_BYTES);
    for (let i = 0; i < BITMAP_CHUNK_BYTES; i++) merged[i] = (chunkA[i] ?? 0) | (chunkB[i] ?? 0);
    out.set(index, merged);
  }
  return out;
}

function bitmapPopcount(bitmap: Bitmap): number {
  let n = 0;
  for (const chunk of bitmap.values()) {
    for (const byte of chunk) {
      let b = byte;
      while (b) {
        b &= b - 1;
        n++;
      }
    }
  }
  return n;
}

/** Ids present in `ids` but not in `bitmap` - the genuinely new disclosure. */
function bitmapNewIds(bitmap: Bitmap, ids: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of ids) {
    if (!bitmapHas(bitmap, id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Fingerprint of the request an idempotency key was first used with
 * (F-01): subject + long flag + count-only amount + the exact record id
 * set, hashed with 64-bit FNV-1a over a canonical string. A replay is
 * honored only when its fingerprint matches the stored one exactly.
 */
function reserveRequestFingerprint(
  subject: string,
  ids: readonly number[],
  anonymousCount: number,
  long: boolean,
): string {
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = `${subject}\n${long ? "long" : "std"}\n${anonymousCount}\n${sorted.join(",")}`;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

/* ------------------------------------------------------------------------ */
/* Store contract                                                           */
/* ------------------------------------------------------------------------ */

export interface LedgerReservation {
  id: string;
  subject: string;
  /** Base64url bitmap of the NEW record ids this reservation holds. */
  idsBitmap: string;
  /** Total records held (new bitmap ids + anonymous count-only records). */
  count: number;
  createdAtMs: number;
  expiresAtMs: number;
  /** Long reservations (slow exports) live on the host-authorized path. */
  long: boolean;
  /**
   * Fingerprint of the reserve request that created this reservation
   * under an idempotency key (F-01). A replay of the key is honored
   * only when its own fingerprint matches; reservations written by
   * older versions carry no fingerprint and their keys fail closed
   * (`idempotency_conflict`) for the rest of their short TTL.
   */
  idemFingerprint?: string;
}

export interface LedgerBucketState {
  tokens: number;
  lastRefillMs: number;
  burst: number;
  refillPerSecond: number;
}

export interface DisclosureLedgerState {
  version: number;
  /** Base64url bitmap of committed (actually served) distinct record ids. */
  unionBitmap: string;
  /** Committed records reserved by count only (no ids supplied). */
  anonymousServed: number;
  reservations: Record<string, LedgerReservation>;
  bucket: LedgerBucketState;
  /** Free-form evidence accumulators, covered by the same transaction. */
  evidence: Record<string, number>;
  /** Idempotency key -> reservation id. */
  idempotency: Record<string, string>;
  /** Declared cohort members, or null when no registry was declared. */
  registry: string[] | null;
  nextReservationSeq: number;
}

export type LedgerUpdater = (
  state: DisclosureLedgerState | null,
) => DisclosureLedgerState | null;

export interface LedgerTransactResult {
  committed: boolean;
  conflict: boolean;
  version: number;
}

export interface LedgerStoreAdapter {
  /** True only when `transactLedger` provides real CAS semantics. */
  readonly supportsTransactions: boolean;
  get(key: string): Promise<string | null> | string | null;
  put(key: string, value: string): Promise<void> | void;
  /**
   * Atomically: if the stored state's version differs from
   * `expectedVersion`, fail with `conflict: true` and change nothing.
   * Otherwise run `updater` (null state = no ledger yet, version 0) and,
   * when it returns a state, persist it with version + 1. Returning null
   * from the updater aborts without a version bump.
   */
  transactLedger?(
    ledgerId: string,
    expectedVersion: number,
    updater: LedgerUpdater,
  ): Promise<LedgerTransactResult>;
}

const storeKey = (ledgerId: string): string => `antirea:ledger:${ledgerId}`;

function emptyState(bucket: LedgerBucketState): DisclosureLedgerState {
  return {
    version: 0,
    unionBitmap: "",
    anonymousServed: 0,
    reservations: {},
    bucket,
    evidence: {},
    idempotency: {},
    registry: null,
    nextReservationSeq: 1,
  };
}

function cloneState(state: DisclosureLedgerState): DisclosureLedgerState {
  return JSON.parse(JSON.stringify(state)) as DisclosureLedgerState;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Shape validation for state read back from a store (F-06): a store
 * holding truncated JSON, valid JSON of the wrong shape, or a bitmap
 * payload that does not decode must surface as a structured
 * `store_conflict` refusal from every public entry - never as a
 * SyntaxError/TypeError escaping into the host.
 */
function isValidLedgerState(value: unknown): value is DisclosureLedgerState {
  if (!isPlainRecord(value)) return false;
  if (!isFiniteNumber(value.version)) return false;
  if (typeof value.unionBitmap !== "string") return false;
  if (!isFiniteNumber(value.anonymousServed)) return false;
  if (!isPlainRecord(value.reservations)) return false;
  for (const reservation of Object.values(value.reservations)) {
    if (!isPlainRecord(reservation)) return false;
    if (typeof reservation.id !== "string" || typeof reservation.subject !== "string") return false;
    if (typeof reservation.idsBitmap !== "string") return false;
    if (!isFiniteNumber(reservation.count)) return false;
    if (!isFiniteNumber(reservation.createdAtMs) || !isFiniteNumber(reservation.expiresAtMs)) return false;
    try {
      bitmapFromBase64(reservation.idsBitmap);
    } catch {
      return false;
    }
  }
  if (!isPlainRecord(value.bucket)) return false;
  if (!isFiniteNumber(value.bucket.tokens) || !isFiniteNumber(value.bucket.lastRefillMs)) return false;
  if (!isFiniteNumber(value.bucket.burst) || !isFiniteNumber(value.bucket.refillPerSecond)) return false;
  if (!isPlainRecord(value.evidence)) return false;
  for (const evidenceValue of Object.values(value.evidence)) {
    if (!isFiniteNumber(evidenceValue)) return false;
  }
  if (!isPlainRecord(value.idempotency)) return false;
  for (const reservationId of Object.values(value.idempotency)) {
    if (typeof reservationId !== "string") return false;
  }
  if (value.registry !== null) {
    if (!Array.isArray(value.registry)) return false;
    for (const member of value.registry) if (typeof member !== "string") return false;
  }
  if (!isFiniteNumber(value.nextReservationSeq)) return false;
  try {
    bitmapFromBase64(value.unionBitmap);
  } catch {
    return false;
  }
  return true;
}

function parseStoredState(raw: string): DisclosureLedgerState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LedgerStoreError("store_conflict: stored ledger state is not valid JSON");
  }
  if (!isValidLedgerState(parsed)) {
    throw new LedgerStoreError("store_conflict: stored ledger state has an invalid shape");
  }
  return parsed;
}

/**
 * Bundled in-memory store with real per-ledger transaction serialization.
 * `ioDelayMs` simulates a slow async backend INSIDE the transaction, so
 * conformance tests prove the mutex - not the absence of awaits - is
 * what makes parallel reservations safe.
 */
export function createInMemoryTransactionalStore(options: { ioDelayMs?: number } = {}): LedgerStoreAdapter {
  const data = new Map<string, string>();
  const chains = new Map<string, Promise<unknown>>();
  const ioDelayMs = Math.max(0, options.ioDelayMs ?? 0);
  const delay = (): Promise<void> =>
    ioDelayMs > 0 ? new Promise(resolve => setTimeout(resolve, ioDelayMs)) : Promise.resolve();

  const enqueue = <T>(ledgerId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(ledgerId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(ledgerId, run.then(() => undefined, () => undefined));
    return run;
  };

  return {
    supportsTransactions: true,
    get(key: string) {
      return data.get(key) ?? null;
    },
    put(key: string, value: string) {
      data.set(key, value);
    },
    transactLedger(ledgerId, expectedVersion, updater) {
      return enqueue(ledgerId, async () => {
        const key = storeKey(ledgerId);
        const raw = data.get(key) ?? null;
        const current = raw ? (JSON.parse(raw) as DisclosureLedgerState) : null;
        const currentVersion = current ? current.version : 0;
        await delay();
        if (currentVersion !== expectedVersion) {
          return { committed: false, conflict: true, version: currentVersion };
        }
        const next = updater(current ? cloneState(current) : null);
        if (next === null) return { committed: false, conflict: false, version: currentVersion };
        next.version = currentVersion + 1;
        data.set(key, JSON.stringify(next));
        return { committed: true, conflict: false, version: next.version };
      });
    },
  };
}

/** Bundled get/put-only store: the audit-only honesty class. */
export function createInMemoryGetPutStore(): LedgerStoreAdapter {
  const data = new Map<string, string>();
  return {
    supportsTransactions: false,
    get(key: string) {
      return data.get(key) ?? null;
    },
    put(key: string, value: string) {
      data.set(key, value);
    },
  };
}

/** Wrap any host get/put store; the wrapped store stays audit-only. */
export function createGetPutStoreAdapter(store: {
  get(key: string): Promise<string | null> | string | null;
  put(key: string, value: string): Promise<void> | void;
}): LedgerStoreAdapter {
  return { supportsTransactions: false, get: store.get.bind(store), put: store.put.bind(store) };
}

/**
 * Min-merge for cohort rate buckets (lab round 6 wiring fix): when two
 * cohorts merge, the merged bucket takes the MINIMUM token balance and
 * refill rate - never a reset upward, which would hand the merged cohort
 * a fresh burst it did not earn.
 */
export function mergeCohortBucketStates(a: LedgerBucketState, b: LedgerBucketState): LedgerBucketState {
  return {
    tokens: Math.min(a.tokens, b.tokens),
    lastRefillMs: Math.max(a.lastRefillMs, b.lastRefillMs),
    burst: Math.min(a.burst, b.burst),
    refillPerSecond: Math.min(a.refillPerSecond, b.refillPerSecond),
  };
}

/* ------------------------------------------------------------------------ */
/* The ledger                                                               */
/* ------------------------------------------------------------------------ */

export type LedgerMode = "enforce" | "audit_only";

export interface DisclosureLedgerOptions {
  store: LedgerStoreAdapter;
  /** Ledger (cohort) id. Defaults to "default". */
  ledgerId?: string;
  /** Shared ceiling on distinct records for the whole ledger. Default 2000. */
  ceilingLimit?: number;
  bucket?: { burst?: number; refillPerSecond?: number };
  reservation?: {
    /** Default 60_000 ms (CHATGPT-R8 bound). */
    ttlMs?: number;
    /** Default 2 outstanding reservations per subject. */
    maxOutstandingPerSubject?: number;
    /** Default 500 reserved records per subject. */
    maxReservedRecordsPerSubject?: number;
    /** Optional host-set cap on records held by ALL open reservations. */
    cohortOutstandingCap?: number;
    /** TTL for host-authorized long reservations. Default 15 minutes. */
    longTtlMs?: number;
  };
  /** Default "fail_closed" once a registry is declared. */
  unregisteredPolicy?: "fail_closed" | "audit_only";
  now?: () => number;
  /**
   * Monotonic clock for the hybrid interval rules (L-DEEP-2): the
   * bucket refill's credited interval is clamped to the time the
   * bucket needs to fill (a no-op on a healthy clock), and a
   * reservation created BY THIS PROCESS also dies at its monotonic
   * TTL, whichever of wall-expiry / mono-TTL comes first. Persisted
   * state keeps wall-clock deadlines only - a reservation restored
   * from the store or written by another process has no monotonic
   * mirror and follows the wall clock alone. When only `now` is
   * given, the injected clock drives both domains (pre-patch
   * behavior).
   */
  monoNow?: () => number;
}

export interface ReserveDisclosureRequest {
  subject: string;
  /** Exact record ids about to be served (preferred - the ledger is exact). */
  recordIds?: number[];
  /** Count-only reservation when ids are not available (cruder accounting). */
  count?: number;
  /** Ask for the long-reservation path; refused unless host-authorized. */
  longReservation?: boolean;
  /** Host authorization for the long path (slow exports). */
  hostAuthorizedLong?: boolean;
  /**
   * Idempotency key for safe retries of the same logical serve. Keys
   * MUST be generated by the host and be unguessable (e.g. a random
   * UUID per serve): a replay is honored - `duplicate: true`, charged
   * once - ONLY when subject and payload (record ids, count, long
   * flag) match the original request exactly. A replay whose subject
   * or payload differs is refused `idempotency_conflict` and is never
   * charged to the original subject, so a guessed key buys an
   * attacker nothing (F-01).
   */
  idempotencyKey?: string;
}

export type ReserveRefusalReason =
  | "ceiling_exceeded"
  | "rate_limited"
  | "too_many_outstanding"
  | "subject_reservation_cap"
  | "cohort_reservation_cap"
  | "unregistered_subject"
  | "long_reservation_not_authorized"
  | "idempotency_conflict"
  | "store_conflict";

export interface ReserveDisclosureResult {
  allowed: boolean;
  /** False in audit-only mode: the decision was computed, not guaranteed. */
  enforced: boolean;
  mode: LedgerMode;
  reservationId?: string;
  /** Genuinely new records this reservation holds. */
  newRecords?: number;
  reason?: ReserveRefusalReason;
  /** Set on rate_limited: when the bucket will hold enough tokens. */
  retryAfterMs?: number;
  /** Set when the decision carries a non-fatal audit note. */
  auditFlag?: string;
  /** True when an idempotency key returned an earlier reservation. */
  duplicate?: boolean;
}

export interface LedgerSnapshot {
  ledgerId: string;
  mode: LedgerMode;
  version: number;
  ceilingLimit: number;
  committedRecords: number;
  reservedRecords: number;
  outstandingReservations: number;
  bucketTokens: number;
  registry: { declared: boolean; members: number };
  evidence: Record<string, number>;
  /**
   * Set when the snapshot could not be read from the store (F-06):
   * the remaining fields then describe an EMPTY ledger and must not
   * be trusted as the real state.
   */
  storeError?: string;
}

export interface DisclosureLedger {
  readonly mode: LedgerMode;
  /** Plain-language statement of what this ledger does and does not guarantee. */
  readonly enforcementNote: string;
  declareRegistry(subjects: string[]): Promise<{ registered: number; reason?: string }>;
  checkRegistryCompleteness(expected?: string[]): Promise<{
    declared: boolean;
    complete: boolean;
    registered: number;
    missing: string[];
    /** Set when the registry could not be read from the store (F-06). */
    storeError?: string;
  }>;
  reserveDisclosure(request: ReserveDisclosureRequest): Promise<ReserveDisclosureResult>;
  commitReservation(reservationId: string): Promise<{ committed: boolean; reason?: string }>;
  releaseReservation(reservationId: string): Promise<{ released: boolean; reason?: string }>;
  /** Eagerly expire reservations whose TTL has passed. */
  sweepExpired(): Promise<{ expired: number; reason?: string }>;
  /** Accumulate a named evidence value inside the same CAS transaction. */
  recordEvidence(key: string, delta: number): Promise<{ value: number; enforced: boolean; reason?: string }>;
  snapshot(): Promise<LedgerSnapshot>;
}

const MAX_TRANSACT_ATTEMPTS = 16;

export function createDisclosureLedger(options: DisclosureLedgerOptions): DisclosureLedger {
  const store = options.store;
  const ledgerId = options.ledgerId ?? "default";
  const ceilingLimit = Math.max(1, Math.floor(options.ceilingLimit ?? 2000));
  const burst = Math.max(1, options.bucket?.burst ?? 150);
  const refillPerSecond = Math.max(0, options.bucket?.refillPerSecond ?? 2);
  const ttlMs = Math.max(1, options.reservation?.ttlMs ?? 60_000);
  const maxOutstanding = Math.max(1, options.reservation?.maxOutstandingPerSubject ?? 2);
  const maxReservedPerSubject = Math.max(1, options.reservation?.maxReservedRecordsPerSubject ?? 500);
  const cohortOutstandingCap = options.reservation?.cohortOutstandingCap;
  const longTtlMs = Math.max(ttlMs, options.reservation?.longTtlMs ?? 900_000);
  const unregisteredPolicy = options.unregisteredPolicy ?? "fail_closed";
  const now = options.now ?? Date.now;
  const monoNowFn = options.monoNow ?? (options.now ? now : monoNowMs);
  /**
   * Monotonic creation stamps for reservations THIS process created
   * (L-DEEP-2 hybrid rule): reservation id -> { creation instant on
   * the monotonic clock, TTL granted }. Never persisted - a
   * reservation restored from the store or written by another process
   * has no entry and follows its wall expiry alone.
   */
  const ownReservationMono = new Map<string, { createdMonoMs: number; ttlMs: number }>();
  const mode: LedgerMode = store.supportsTransactions && store.transactLedger ? "enforce" : "audit_only";
  const enforcementNote =
    mode === "enforce"
      ? "Ceiling, reservations and bucket are mutated under a CAS transaction on ledgerVersion; parallel reservations cannot jointly overspend the ceiling."
      : "audit only - the backing store has no transaction/CAS primitive, so decisions are computed best-effort and are NOT guaranteed under concurrency. Supply a transactional store to enforce the ceiling.";

  const initialBucket = (): LedgerBucketState => ({
    tokens: burst,
    lastRefillMs: now(),
    burst,
    refillPerSecond,
  });

  async function readState(): Promise<DisclosureLedgerState> {
    const raw = await store.get(storeKey(ledgerId));
    if (!raw) return emptyState(initialBucket());
    return parseStoredState(raw);
  }

  /**
   * Run `fn` against the state atomically when the store supports it
   * (with conflict retry), or best-effort (read-compute-put) when it
   * does not. `fn` returns the next state (or the same state object
   * unmodified to skip the write) plus the value to hand back.
   */
  async function mutate<T>(
    fn: (state: DisclosureLedgerState) => { state: DisclosureLedgerState | null; value: T },
  ): Promise<T> {
    if (mode === "enforce" && store.transactLedger) {
      for (let attempt = 0; attempt < MAX_TRANSACT_ATTEMPTS; attempt++) {
        const current = await readState();
        let captured: T | undefined;
        let wrote = false;
        let corruptState = false;
        const result = await store.transactLedger(ledgerId, current.version, state => {
          const base = state ?? emptyState(initialBucket());
          if (!isValidLedgerState(base)) {
            // The store's own copy of the state is corrupt even though
            // the get-path read looked fine (or raced): abort without
            // writing and surface a structured store failure (F-06).
            corruptState = true;
            return null;
          }
          const outcome = fn(cloneState(base));
          captured = outcome.value;
          if (outcome.state === null) return null;
          wrote = true;
          return outcome.state;
        });
        if (corruptState) {
          throw new LedgerStoreError("store_conflict: stored ledger state has an invalid shape");
        }
        if (result.conflict) continue;
        void wrote;
        return captured as T;
      }
      throw new LedgerStoreError("store_conflict: transaction kept conflicting after retries");
    }
    const state = await readState();
    const outcome = fn(state);
    if (outcome.state !== null) await store.put(storeKey(ledgerId), JSON.stringify(outcome.state));
    return outcome.value;
  }

  function expireReservations(
    state: DisclosureLedgerState,
    atMs: number,
    atMonoMs: number,
    pruneMono: boolean,
  ): number {
    let expired = 0;
    for (const [id, reservation] of Object.entries(state.reservations)) {
      // Hybrid rule (L-DEEP-2): a reservation created by this process
      // dies at whichever comes first - its wall expiry, or its TTL
      // measured on the monotonic clock.
      const own = ownReservationMono.get(id);
      const monoExpired = own !== undefined && atMonoMs - own.createdMonoMs >= own.ttlMs;
      if (reservation.expiresAtMs <= atMs || monoExpired) {
        delete state.reservations[id];
        if (pruneMono) ownReservationMono.delete(id);
        expired++;
      }
    }
    if (expired > 0) {
      for (const [key, reservationId] of Object.entries(state.idempotency)) {
        if (!state.reservations[reservationId]) delete state.idempotency[key];
      }
    }
    return expired;
  }

  function effectiveBitmap(state: DisclosureLedgerState): Bitmap {
    let bitmap = bitmapFromBase64(state.unionBitmap);
    for (const reservation of Object.values(state.reservations)) {
      bitmap = bitmapUnion(bitmap, bitmapFromBase64(reservation.idsBitmap));
    }
    return bitmap;
  }

  function reservedTotals(state: DisclosureLedgerState): { total: number; anonymous: number } {
    let total = 0;
    let anonymous = 0;
    for (const reservation of Object.values(state.reservations)) {
      total += reservation.count;
      anonymous += reservation.count - bitmapPopcount(bitmapFromBase64(reservation.idsBitmap));
    }
    return { total, anonymous };
  }

  function refillBucket(state: DisclosureLedgerState, atMs: number): void {
    const bucket = state.bucket;
    let elapsedMs = Math.max(0, atMs - bucket.lastRefillMs);
    if (elapsedMs > 0 && bucket.refillPerSecond > 0) {
      // L-DEEP-2 hybrid clamp: never credit more elapsed time than
      // the bucket needs to reach full. A no-op on a healthy clock
      // (tokens cap at burst either way); it makes the step behavior
      // explicit instead of implicit.
      const msToFull = ((bucket.burst - bucket.tokens) / bucket.refillPerSecond) * 1000;
      elapsedMs = Math.min(elapsedMs, Math.max(0, msToFull));
      bucket.tokens = Math.min(bucket.burst, bucket.tokens + (elapsedMs / 1000) * bucket.refillPerSecond);
    }
    bucket.lastRefillMs = atMs;
  }

  return {
    mode,
    enforcementNote,

    async declareRegistry(subjects) {
      const unique = [...new Set(subjects)];
      try {
        return await mutate(state => {
          state.registry = unique;
          return { state, value: { registered: unique.length } };
        });
      } catch {
        return { registered: 0, reason: "store_conflict" };
      }
    },

    async checkRegistryCompleteness(expected) {
      let state: DisclosureLedgerState;
      try {
        state = await readState();
      } catch {
        return {
          declared: false,
          complete: false,
          registered: 0,
          missing: expected ? [...expected] : [],
          storeError: "store_conflict",
        };
      }
      if (!state.registry) {
        return { declared: false, complete: false, registered: 0, missing: expected ? [...expected] : [] };
      }
      const registered = new Set(state.registry);
      const missing = (expected ?? []).filter(subject => !registered.has(subject));
      return {
        declared: true,
        complete: expected ? missing.length === 0 : true,
        registered: state.registry.length,
        missing,
      };
    },

    async reserveDisclosure(request) {
      const atMs = now();
      const atMonoMs = monoNowFn();
      const enforced = mode === "enforce";
      try {
        const result = await mutate<ReserveDisclosureResult>(state => {
        const refuse = (reason: ReserveRefusalReason, extra?: Partial<ReserveDisclosureResult>): { state: DisclosureLedgerState | null; value: ReserveDisclosureResult } => ({
          state: null,
          value: { allowed: false, enforced, mode, reason, ...extra },
        });

        expireReservations(state, atMs, atMonoMs, true);

        // Normalized request payload (state-independent, computed once):
        // the idempotency fingerprint below is taken over exactly these
        // values, and the reservation created later stores it.
        const requestedIds = [...new Set((request.recordIds ?? []).filter(id => Number.isFinite(id) && id >= 0).map(id => Math.floor(id)))];
        const anonymousRequested = Math.max(0, Math.floor(request.count ?? 0));
        const long = request.longReservation === true;
        const idemFingerprint = request.idempotencyKey
          ? reserveRequestFingerprint(request.subject, requestedIds, anonymousRequested, long)
          : undefined;

        if (request.idempotencyKey) {
          const existingId = state.idempotency[request.idempotencyKey];
          const existing = existingId ? state.reservations[existingId] : undefined;
          if (existing) {
            // F-01: a replay is honored ONLY when it is the same
            // subject presenting the same payload. Any mismatch -
            // including a reservation written before fingerprints
            // existed - is refused and never charged to the original
            // subject; the registry and ceiling checks below are not
            // what protects this branch.
            if (
              existing.subject !== request.subject ||
              existing.idemFingerprint === undefined ||
              existing.idemFingerprint !== idemFingerprint
            ) {
              return refuse("idempotency_conflict");
            }
            return {
              state: null,
              value: {
                allowed: true,
                enforced,
                mode,
                reservationId: existing.id,
                newRecords: existing.count,
                duplicate: true,
              },
            };
          }
        }

        let auditFlag: string | undefined;
        if (state.registry && !state.registry.includes(request.subject)) {
          if (unregisteredPolicy === "fail_closed") return refuse("unregistered_subject");
          auditFlag = "unregistered_subject";
        }

        if (long && !request.hostAuthorizedLong) return refuse("long_reservation_not_authorized");

        const subjectReservations = Object.values(state.reservations).filter(r => r.subject === request.subject);
        if (subjectReservations.length >= maxOutstanding) return refuse("too_many_outstanding");
        const subjectReserved = subjectReservations.reduce((sum, r) => sum + r.count, 0);

        const effective = effectiveBitmap(state);
        const newIds = bitmapNewIds(effective, requestedIds);
        const newRecords = newIds.length + anonymousRequested;
        if (newRecords === 0 && requestedIds.length > 0) {
          // Re-delivery of already-counted records is free, mirroring the
          // record budget's per-record state machine.
          return {
            state: null,
            value: { allowed: true, enforced, mode, newRecords: 0, ...(auditFlag ? { auditFlag } : {}) },
          };
        }
        if (subjectReserved + newRecords > maxReservedPerSubject) return refuse("subject_reservation_cap");

        const totals = reservedTotals(state);
        if (cohortOutstandingCap !== undefined && totals.total + newRecords > cohortOutstandingCap) {
          return refuse("cohort_reservation_cap");
        }

        const effectiveTotal = bitmapPopcount(effective) + state.anonymousServed + totals.anonymous;
        if (effectiveTotal + newRecords > ceilingLimit) {
          return refuse("ceiling_exceeded");
        }

        refillBucket(state, atMs);
        if (Math.floor(state.bucket.tokens) < newRecords) {
          const deficit = newRecords - state.bucket.tokens;
          const retryAfterMs =
            state.bucket.refillPerSecond > 0 ? Math.ceil((deficit / state.bucket.refillPerSecond) * 1000) : Number.MAX_SAFE_INTEGER;
          return refuse("rate_limited", { retryAfterMs });
        }
        state.bucket.tokens -= newRecords;

        const seq = state.nextReservationSeq++;
        const reservation: LedgerReservation = {
          id: `res_${seq}`,
          subject: request.subject,
          idsBitmap: bitmapToBase64(bitmapWithIds(emptyBitmap(), newIds)),
          count: newRecords,
          createdAtMs: atMs,
          expiresAtMs: atMs + (long ? longTtlMs : ttlMs),
          long,
          ...(idemFingerprint !== undefined ? { idemFingerprint } : {}),
        };
        state.reservations[reservation.id] = reservation;
        if (request.idempotencyKey) state.idempotency[request.idempotencyKey] = reservation.id;
        return {
          state,
          value: {
            allowed: true,
            enforced,
            mode,
            reservationId: reservation.id,
            newRecords,
            ...(auditFlag ? { auditFlag } : {}),
          },
        };
        });
        if (result.allowed && result.reservationId && !result.duplicate) {
          // This process created the reservation: stamp its monotonic
          // creation instant so the hybrid expiry rule can see it.
          ownReservationMono.set(result.reservationId, {
            createdMonoMs: atMonoMs,
            ttlMs: request.longReservation === true ? longTtlMs : ttlMs,
          });
        }
        return result;
      } catch {
        // F-06: store failures (dead backend, corrupt content, CAS
        // exhaustion) refuse fail-closed instead of throwing into the
        // host's request path.
        return { allowed: false, enforced, mode, reason: "store_conflict" };
      }
    },

    async commitReservation(reservationId) {
      const atMonoMs = monoNowFn();
      try {
        const result = await mutate<{ committed: boolean; reason?: string }>(state => {
          expireReservations(state, now(), atMonoMs, true);
          const reservation = state.reservations[reservationId];
          if (!reservation) return { state: null, value: { committed: false, reason: "unknown_or_expired_reservation" } };
          const held = bitmapFromBase64(reservation.idsBitmap);
          state.unionBitmap = bitmapToBase64(bitmapUnion(bitmapFromBase64(state.unionBitmap), held));
          state.anonymousServed += reservation.count - bitmapPopcount(held);
          delete state.reservations[reservationId];
          return { state, value: { committed: true } };
        });
        if (result.committed) ownReservationMono.delete(reservationId);
        return result;
      } catch {
        return { committed: false, reason: "store_conflict" };
      }
    },

    async releaseReservation(reservationId) {
      try {
        const result = await mutate<{ released: boolean; reason?: string }>(state => {
          if (!state.reservations[reservationId]) return { state: null, value: { released: false } };
          delete state.reservations[reservationId];
          return { state, value: { released: true } };
        });
        if (result.released) ownReservationMono.delete(reservationId);
        return result;
      } catch {
        return { released: false, reason: "store_conflict" };
      }
    },

    async sweepExpired() {
      try {
        return await mutate(state => {
          const expired = expireReservations(state, now(), monoNowFn(), true);
          return { state: expired > 0 ? state : null, value: { expired } };
        });
      } catch {
        return { expired: 0, reason: "store_conflict" };
      }
    },

    async recordEvidence(key, delta) {
      try {
        return await mutate(state => {
          const value = (state.evidence[key] ?? 0) + delta;
          state.evidence[key] = value;
          return { state, value: { value, enforced: mode === "enforce" } };
        });
      } catch {
        return { value: 0, enforced: mode === "enforce", reason: "store_conflict" };
      }
    },

    async snapshot() {
      const buildSnapshot = (state: DisclosureLedgerState): LedgerSnapshot => {
        const atMs = now();
        const view = cloneState(state);
        // View-only expiry: the monotonic mirror map is NOT pruned here.
        expireReservations(view, atMs, monoNowFn(), false);
        refillBucket(view, atMs);
        const totals = reservedTotals(view);
        return {
          ledgerId,
          mode,
          version: view.version,
          ceilingLimit,
          committedRecords: bitmapPopcount(bitmapFromBase64(view.unionBitmap)) + view.anonymousServed,
          reservedRecords: totals.total,
          outstandingReservations: Object.keys(view.reservations).length,
          bucketTokens: Math.floor(view.bucket.tokens),
          registry: { declared: view.registry !== null, members: view.registry?.length ?? 0 },
          evidence: { ...view.evidence },
        };
      };
      try {
        return buildSnapshot(await readState());
      } catch {
        // F-06: never throw out of a read path; the snapshot is marked
        // so the host can tell it describes an empty ledger, not theirs.
        return { ...buildSnapshot(emptyState(initialBucket())), storeError: "store_conflict" };
      }
    },
  };
}
