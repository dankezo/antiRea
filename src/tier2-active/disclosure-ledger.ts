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

/* ------------------------------------------------------------------------ */
/* Exact bitmap helpers (record ids are non-negative integers).             */
/* ------------------------------------------------------------------------ */

function bitmapByteLength(maxId: number): number {
  return Math.floor(maxId / 8) + 1;
}

function bitmapFromBase64(value: string | undefined): Uint8Array {
  if (!value) return new Uint8Array(0);
  try {
    const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, ch => ch.charCodeAt(0));
  } catch {
    return new Uint8Array(0);
  }
}

function bitmapToBase64(bytes: Uint8Array): string {
  let bin = "";
  const STEP = 0x4000;
  for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bitmapHas(bytes: Uint8Array, id: number): boolean {
  const byte = bytes[Math.floor(id / 8)];
  return byte !== undefined && (byte & (1 << (id % 8))) !== 0;
}

function bitmapWithIds(base: Uint8Array, ids: readonly number[]): Uint8Array {
  if (ids.length === 0) return base;
  let max = 0;
  for (const id of ids) if (id > max) max = id;
  const needed = bitmapByteLength(max);
  const out = new Uint8Array(Math.max(needed, base.length));
  out.set(base);
  for (const id of ids) {
    const idx = Math.floor(id / 8);
    out[idx] = (out[idx] ?? 0) | (1 << (id % 8));
  }
  return out;
}

function bitmapPopcount(bytes: Uint8Array): number {
  let n = 0;
  for (const byte of bytes) {
    let b = byte;
    while (b) {
      b &= b - 1;
      n++;
    }
  }
  return n;
}

/** Ids present in `ids` but not in `bitmap` - the genuinely new disclosure. */
function bitmapNewIds(bitmap: Uint8Array, ids: readonly number[]): number[] {
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
}

export interface DisclosureLedger {
  readonly mode: LedgerMode;
  /** Plain-language statement of what this ledger does and does not guarantee. */
  readonly enforcementNote: string;
  declareRegistry(subjects: string[]): Promise<{ registered: number }>;
  checkRegistryCompleteness(expected?: string[]): Promise<{
    declared: boolean;
    complete: boolean;
    registered: number;
    missing: string[];
  }>;
  reserveDisclosure(request: ReserveDisclosureRequest): Promise<ReserveDisclosureResult>;
  commitReservation(reservationId: string): Promise<{ committed: boolean; reason?: string }>;
  releaseReservation(reservationId: string): Promise<{ released: boolean }>;
  /** Eagerly expire reservations whose TTL has passed. */
  sweepExpired(): Promise<{ expired: number }>;
  /** Accumulate a named evidence value inside the same CAS transaction. */
  recordEvidence(key: string, delta: number): Promise<{ value: number; enforced: boolean }>;
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
    const parsed = JSON.parse(raw) as DisclosureLedgerState;
    return parsed;
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
        const result = await store.transactLedger(ledgerId, current.version, state => {
          const base = state ?? emptyState(initialBucket());
          const outcome = fn(cloneState(base));
          captured = outcome.value;
          if (outcome.state === null) return null;
          wrote = true;
          return outcome.state;
        });
        if (result.conflict) continue;
        void wrote;
        return captured as T;
      }
      throw new Error("disclosure ledger: transaction kept conflicting after retries");
    }
    const state = await readState();
    const outcome = fn(state);
    if (outcome.state !== null) await store.put(storeKey(ledgerId), JSON.stringify(outcome.state));
    return outcome.value;
  }

  function expireReservations(state: DisclosureLedgerState, atMs: number): number {
    let expired = 0;
    for (const [id, reservation] of Object.entries(state.reservations)) {
      if (reservation.expiresAtMs <= atMs) {
        delete state.reservations[id];
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

  function effectiveBitmap(state: DisclosureLedgerState): Uint8Array {
    let bitmap = bitmapFromBase64(state.unionBitmap);
    for (const reservation of Object.values(state.reservations)) {
      const held = bitmapFromBase64(reservation.idsBitmap);
      const merged = new Uint8Array(Math.max(bitmap.length, held.length));
      for (let i = 0; i < merged.length; i++) merged[i] = (bitmap[i] ?? 0) | (held[i] ?? 0);
      bitmap = merged;
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
    const elapsedMs = Math.max(0, atMs - bucket.lastRefillMs);
    if (elapsedMs > 0 && bucket.refillPerSecond > 0) {
      bucket.tokens = Math.min(bucket.burst, bucket.tokens + (elapsedMs / 1000) * bucket.refillPerSecond);
    }
    bucket.lastRefillMs = atMs;
  }

  return {
    mode,
    enforcementNote,

    async declareRegistry(subjects) {
      const unique = [...new Set(subjects)];
      return mutate(state => {
        state.registry = unique;
        return { state, value: { registered: unique.length } };
      });
    },

    async checkRegistryCompleteness(expected) {
      const state = await readState();
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
      const enforced = mode === "enforce";
      return mutate<ReserveDisclosureResult>(state => {
        const refuse = (reason: ReserveRefusalReason, extra?: Partial<ReserveDisclosureResult>): { state: DisclosureLedgerState | null; value: ReserveDisclosureResult } => ({
          state: null,
          value: { allowed: false, enforced, mode, reason, ...extra },
        });

        expireReservations(state, atMs);

        if (request.idempotencyKey) {
          const existingId = state.idempotency[request.idempotencyKey];
          const existing = existingId ? state.reservations[existingId] : undefined;
          if (existing) {
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

        const long = request.longReservation === true;
        if (long && !request.hostAuthorizedLong) return refuse("long_reservation_not_authorized");

        const requestedIds = [...new Set((request.recordIds ?? []).filter(id => Number.isFinite(id) && id >= 0).map(id => Math.floor(id)))];
        const anonymousRequested = Math.max(0, Math.floor(request.count ?? 0));

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
          idsBitmap: bitmapToBase64(bitmapWithIds(new Uint8Array(0), newIds)),
          count: newRecords,
          createdAtMs: atMs,
          expiresAtMs: atMs + (long ? longTtlMs : ttlMs),
          long,
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
    },

    async commitReservation(reservationId) {
      return mutate<{ committed: boolean; reason?: string }>(state => {
        expireReservations(state, now());
        const reservation = state.reservations[reservationId];
        if (!reservation) return { state: null, value: { committed: false, reason: "unknown_or_expired_reservation" } };
        const held = bitmapFromBase64(reservation.idsBitmap);
        const union = bitmapFromBase64(state.unionBitmap);
        const merged = new Uint8Array(Math.max(union.length, held.length));
        for (let i = 0; i < merged.length; i++) merged[i] = (union[i] ?? 0) | (held[i] ?? 0);
        state.unionBitmap = bitmapToBase64(merged);
        state.anonymousServed += reservation.count - bitmapPopcount(held);
        delete state.reservations[reservationId];
        return { state, value: { committed: true } };
      });
    },

    async releaseReservation(reservationId) {
      return mutate<{ released: boolean }>(state => {
        if (!state.reservations[reservationId]) return { state: null, value: { released: false } };
        delete state.reservations[reservationId];
        return { state, value: { released: true } };
      });
    },

    async sweepExpired() {
      return mutate(state => {
        const expired = expireReservations(state, now());
        return { state: expired > 0 ? state : null, value: { expired } };
      });
    },

    async recordEvidence(key, delta) {
      return mutate(state => {
        const value = (state.evidence[key] ?? 0) + delta;
        state.evidence[key] = value;
        return { state, value: { value, enforced: mode === "enforce" } };
      });
    },

    async snapshot() {
      const state = await readState();
      const atMs = now();
      const view = cloneState(state);
      expireReservations(view, atMs);
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
    },
  };
}
