/**
 * Per-subject action budget with cohort ceilings (feature-abuse layer).
 *
 * Threat model (FEATURE-PROTECTION-SPEC 2.6.0, section 1): the attacker
 * controls many cheap identities and uses features CORRECTLY - valid
 * requests, real sessions, no protocol violations. The abuse is
 * aggregate: each identity stays inside its individual limits while the
 * herd, summed, drains a shared resource (host compute/bandwidth, a
 * finite promo/trial pool, fairness on one expensive endpoint). The
 * record budget meters RECORDS; this module meters the OPERATION
 * itself, priced in the host's own abstract cost units (the price table
 * is host-declared - the SDK never invents prices). Both layers apply;
 * neither replaces the other. An action with NO price anywhere (not in
 * the table, no explicit cost on the request) is refused
 * `unknown_action` by default rather than silently costing 0 (F-05);
 * a host that prefers a fallback price sets `unknownActionCost` and
 * sees `unpriced: true` on every result it touches.
 *
 * Construction mirrors the disclosure ledger's discipline exactly,
 * because the hard problem is the same: a per-subject allowance plus a
 * declared-cohort aggregate ceiling are only enforceable if the
 * check-and-reserve step is atomic. This module therefore runs on the
 * SAME `LedgerStoreAdapter` contract as `disclosure-ledger.ts` (the
 * adapter and the bundled stores are imported, never forked):
 *
 * - A store that implements `transactLedger` gets `mode: "enforce"`.
 * - A get/put-only store gets `mode: "audit_only"`: decisions are
 *   computed best-effort, every result carries `enforced: false`, and
 *   parallel reserves CAN jointly overspend - the module reports this
 *   instead of hiding it.
 *
 * Technical note on the adapter: `transactLedger` is typed against
 * `DisclosureLedgerState`. The runtime contract is shape-agnostic (the
 * store JSON-serializes whatever the updater returns and CAS-checks
 * its `version` field), so this module casts its own state through
 * that signature internally - the cast is the seam, documented here,
 * not a fork of the store. Key namespacing keeps the two ledgers from
 * colliding on a shared store: transactions run under ledger id
 * `action-budget:<budgetId>`, and the get/put (audit-only) path uses
 * the key `antirea:action-budget:<budgetId>`.
 *
 * Reservations follow the ledger's bounds, renamed for actions:
 * reserve -> commit / release, TTL with lazy expiry inside the
 * transaction, per-subject outstanding and reserved-cost caps, an
 * optional cohort-wide outstanding cap, idempotency keys, and a
 * host-authorized long-reservation path. Bucket tokens spent by a
 * reservation are NOT refunded on release - pacing is a cost, not a
 * deposit (ledger parity).
 *
 * Declared cohort ceilings are ARMED AT DECLARATION (the 2.5.0
 * declared-ceiling law applied to actions): a member's reserves count
 * against the cohort's per-window ceiling from the first action, with
 * no flag or crossing needed, and a non-member reserving under the
 * cohort id is refused `unregistered_subject` (fail closed); an
 * undeclared cohort id is refused `unknown_cohort`.
 *
 * The derived soft floor: `derivedSoftFloorCost` is the maximum
 * single-action price in the host's table - the direct transpose of
 * `SOFT_BUDGET_FLOOR_RECORDS` (the ledger's per-subject reservation
 * bound). A stepped-down subject always keeps exactly ONE maximal
 * legitimate action per window: friction, never strangulation.
 * `clampActionStepDown` delegates the tier decision to
 * `clampEnforcement` and applies this floor for inferred cohorts;
 * host-declared cohorts (or ceiling-tier manifests) may go to 0.
 *
 * Per-subject allowance overrides (the step-down landing point) are
 * kept in a process-local map, exactly like `createRecordBudget`'s
 * `setOverride`: the spec'd API is synchronous, so the override cannot
 * live behind an async transaction. The map is mirrored into the
 * transactional state (the `allowanceOverrides` field) by any
 * mutation on the setting instance that actually persists state -
 * a successful reserve/commit/release, a cohort declaration or a
 * pacing change - so snapshots stay auditable; a refused reserve,
 * a `snapshot()` call and `sweepExpired()` do not persist the mirror.
 * On a shared store, a second budget instance reads the mirrored
 * overrides for subjects it has not locally touched (see
 * `effectiveAllowance`), but an override with no subsequent
 * persisting mutation on the setting instance never reaches shared
 * state on its own. `flushOverrides()` closes that gap: it writes
 * the local map (sets and clears) into shared state explicitly,
 * without needing a reserve. Measured contract and regression tests:
 * `tests/action-budget-overrides.test.cjs`.
 *
 * Clock discipline (L-DEEP-2 hybrid rule, ported from the released
 * tree): persisted state keeps wall-clock fields only, but intervals
 * are defended against wall-clock steps - bucket refill credits are
 * clamped to the time a bucket needs to fill, a reservation created
 * BY THIS PROCESS also dies at its monotonic TTL (whichever of
 * wall-expiry / mono-TTL comes first), and a subject/cohort window
 * created or rolled BY THIS PROCESS also rolls at its monotonic
 * length (whichever comes first). Reservations and windows restored
 * from the store or written by another process have no monotonic
 * mirror and follow the wall clock alone.
 *
 * Subject-window pruning (F-13; NEW in this tree - the released tree
 * has no equivalent): a subject window whose window has fully rolled
 * (wall or anchored monotonic length) and which holds no open
 * reservation is deleted on persisting mutation paths (reserve /
 * commit / release / sweep / cohort and pacing writes / override
 * flush), so one-shot subjects cannot accumulate in persisted state
 * forever. `snapshot()` is read-only by the override contract above
 * and never persists; it reflects whatever the last persisting
 * mutation left behind. Declared cohorts are never pruned: their
 * membership is a host declaration, not accounting.
 *
 * Anti-claims, stated plainly (see docs/LIMITATIONS.md discipline):
 * under open registration + free unlimited feature use, absolute
 * blocking is impossible - a patient herd is behaviorally
 * indistinguishable from a genuine flash crowd. This layer can tax
 * (budgets, pacing, step-up via the tiering clamp), detect (the
 * action-cohort tracker's evidence) and bound (declared ceilings). It
 * cannot make feature abuse impossible, it says nothing about
 * business-logic correctness (pricing math, inventory races, IDOR,
 * injection, payment logic are host code defects a metering layer
 * cannot fix), and over a non-transactional store it guarantees
 * nothing under concurrency.
 */

import type {
  DisclosureLedgerState,
  LedgerStoreAdapter,
  LedgerTransactResult,
  LedgerUpdater,
} from "./disclosure-ledger";
import {
  clampEnforcement,
  type EnforcementContext,
  type SoftBudgetStepDownResult,
} from "./enforcement-tiering";
import { monoNowMs } from "../internal/mono-clock";

/* ------------------------------------------------------------------------ */
/* State (all of it lives inside the one CAS transaction)                    */
/* ------------------------------------------------------------------------ */

export interface ActionBucketState {
  tokens: number;
  lastRefillMs: number;
  burst: number;
  refillPerSecond: number;
}

export interface ActionSubjectWindow {
  windowStartMs: number;
  committedCost: number;
  reservedCost: number;
}

export interface ActionReservation {
  id: string;
  subject: string;
  action: string;
  cost: number;
  cohortId?: string;
  createdAtMs: number;
  expiresAtMs: number;
  /** Long reservations live on the host-authorized path. */
  long: boolean;
  idempotencyKey?: string;
}

export interface DeclaredActionCohortState {
  subjects: string[];
  ceilingCostPerWindow: number;
  windowStartMs: number;
  committedCost: number;
  reservedCost: number;
}

export interface ActionCohortPacingState {
  subjects: string[];
  bucket: ActionBucketState;
}

export interface ActionBudgetState {
  version: number;
  subjects: Record<string, ActionSubjectWindow>;
  reservations: Record<string, ActionReservation>;
  /** Idempotency key -> reservation id. */
  idempotency: Record<string, string>;
  declaredCohorts: Record<string, DeclaredActionCohortState>;
  cohortPacing: Record<string, ActionCohortPacingState>;
  /** Mirror of the process-local override map (see the header). */
  allowanceOverrides: Record<string, number>;
  /** Global pacing bucket over ALL reserves on this budget. */
  bucket: ActionBucketState;
  /** Free-form evidence accumulators, covered by the same transaction. */
  evidence: Record<string, number>;
  nextReservationSeq: number;
}

/* ------------------------------------------------------------------------ */
/* API                                                                       */
/* ------------------------------------------------------------------------ */

export type ActionBudgetMode = "enforce" | "audit_only";

export interface ActionBudgetOptions {
  store: LedgerStoreAdapter;
  /** Budget id; namespaces the store keys. Defaults to "default". */
  budgetId?: string;
  /** Host-declared price table: abstract cost units per action type. */
  prices: Record<string, number>;
  /**
   * Cost charged for an action with NO price - absent from `prices`
   * and with no explicit `cost` on the request (F-05). When unset
   * (the default), such actions are REFUSED with reason
   * `unknown_action`: an unpriced action must never sail through
   * every gate at cost 0 because the host forgot to price it. When
   * set, unpriced actions are charged this cost and the result
   * carries `unpriced: true` so the gap stays visible in audit.
   */
  unknownActionCost?: number;
  /** Per-subject committed + reserved cost allowance per window. Default 100. */
  subjectAllowance?: number;
  /** Subject/cohort window length. Default 60_000 ms. */
  windowMs?: number;
  /** Global pacing bucket over all reserves. */
  bucket?: { burst?: number; refillPerSecond?: number };
  reservation?: {
    /** Default 60_000 ms. */
    ttlMs?: number;
    /** Default 2 outstanding reservations per subject. */
    maxOutstandingPerSubject?: number;
    /** Default 500 reserved cost per subject. */
    maxReservedCostPerSubject?: number;
    /** Optional cap on cost held by ALL open reservations. */
    cohortOutstandingCap?: number;
    /** TTL for host-authorized long reservations. Default 15 minutes. */
    longTtlMs?: number;
  };
  now?: () => number;
  /**
   * Monotonic clock for the hybrid interval rules (L-DEEP-2): bucket
   * refill credits are clamped to the time a bucket needs to fill (a
   * no-op on a healthy clock); a reservation created BY THIS PROCESS
   * also dies at its monotonic TTL, whichever of wall-expiry /
   * mono-TTL comes first; and a subject/cohort window created or
   * rolled BY THIS PROCESS also rolls at its monotonic length,
   * whichever comes first. Persisted state keeps wall-clock fields
   * only - reservations and windows restored from the store or
   * written by another process have no monotonic mirror and follow
   * the wall clock alone. When only `now` is given, the injected
   * clock drives both domains (pre-patch behavior).
   */
  monoNow?: () => number;
}

export interface ReserveActionRequest {
  subject: string;
  action: string;
  /** Explicit host-computed cost; defaults to the price table entry. */
  cost?: number;
  cohortId?: string;
  /**
   * Idempotency key for safe retries of the same logical action. Keys
   * MUST be generated by the host and be unguessable (e.g. a random
   * UUID per action): a replay is honored - `duplicate: true`, charged
   * once - ONLY when subject, action, cost and cohort match the
   * original request exactly. A mismatched replay is refused
   * `idempotency_conflict` and is never charged to the original
   * subject, so a guessed key buys an attacker nothing (F-01).
   */
  idempotencyKey?: string;
  /** Ask for the long-reservation path; refused unless host-authorized. */
  longReservation?: boolean;
  /** Host authorization for the long path (slow exports). */
  hostAuthorizedLong?: boolean;
}

export type ReserveActionRefusalReason =
  | "subject_budget_exceeded"
  | "cohort_ceiling_exceeded"
  | "rate_limited"
  | "too_many_outstanding"
  | "subject_reservation_cap"
  | "cohort_reservation_cap"
  | "unregistered_subject"
  | "unknown_cohort"
  | "unknown_action"
  | "long_reservation_not_authorized"
  | "idempotency_conflict"
  | "store_conflict";

export interface ReserveActionResult {
  allowed: boolean;
  /** False in audit-only mode: the decision was computed, not guaranteed. */
  enforced: boolean;
  mode: ActionBudgetMode;
  reservationId?: string;
  /** The cost charged (price-table default or the explicit cost). */
  cost?: number;
  /**
   * True when the action had no price anywhere (not in the table, no
   * explicit request cost) and was charged the configured
   * `unknownActionCost` fallback instead (F-05). Never set for a
   * deliberately zero-priced action.
   */
  unpriced?: boolean;
  reason?: ReserveActionRefusalReason;
  /** Set on rate_limited: when a bucket will hold enough tokens. */
  retryAfterMs?: number;
  /** True when an idempotency key returned an earlier reservation. */
  duplicate?: boolean;
}

export interface ActionBudgetSnapshot {
  budgetId: string;
  mode: ActionBudgetMode;
  version: number;
  subjectAllowance: number;
  derivedSoftFloorCost: number;
  outstandingReservations: number;
  /** Total cost held by open reservations. */
  reservedCost: number;
  /** Total committed cost across subject windows (current windows). */
  committedCost: number;
  bucketTokens: number;
  declaredCohorts: number;
  subjects: Record<string, ActionSubjectWindow>;
  evidence: Record<string, number>;
  /**
   * Set when the snapshot could not be read from the store (F-06):
   * the remaining fields then describe an EMPTY budget and must not
   * be trusted as the real state.
   */
  storeError?: string;
}

export interface ActionStepDownContext extends EnforcementContext {
  /**
   * The action soft floor (a budget's `derivedSoftFloorCost`). The
   * budget's own `clampActionStepDown` method supplies it from its
   * price table; standalone callers pass it here (or as the 4th
   * argument). Without it the floor is 0 - the tiering clamp still
   * applies, but no floor protects the step-down.
   */
  derivedSoftFloorCost?: number;
}

export interface FlushOverridesResult {
  /** Subjects whose local override entry (a set value, or a clear) was written to shared state. */
  flushed: number;
  mode: ActionBudgetMode;
  /** False in audit_only mode: the write happened best-effort over a get/put store, with no CAS guarantee. */
  enforced: boolean;
  /**
   * Set to `store_conflict` when the flush could not reach the store
   * (F-06): `flushed` is then 0 and no override was published.
   */
  reason?: string;
}

export interface ActionBudget {
  readonly mode: ActionBudgetMode;
  /** Plain-language statement of what this budget does and does not guarantee. */
  readonly enforcementNote: string;
  /** Maximum single-action price in the host's table (see the header). */
  readonly derivedSoftFloorCost: number;
  reserveAction(req: ReserveActionRequest): Promise<ReserveActionResult>;
  commitAction(reservationId: string): Promise<{ committed: boolean; reason?: string }>;
  releaseAction(reservationId: string): Promise<{ released: boolean; reason?: string }>;
  /** Eagerly expire reservations whose TTL has passed. */
  sweepExpired(): Promise<{ expired: number; reason?: string }>;
  declareActionCohort(req: {
    cohortId: string;
    subjects: string[];
    ceilingCostPerWindow: number;
  }): Promise<{ registered: number; reason?: string }>;
  /**
   * Apply (or re-apply) inferred-cohort pacing for one scope.
   * Re-calling with the same `cohortKey` - e.g. with a grown subject
   * list - updates membership and bucket parameters but preserves
   * the bucket's spent token state; it never resets the burst.
   */
  setCohortPacing(req: {
    cohortKey: string;
    subjects: string[];
    burst: number;
    refillPerSecond: number;
  }): Promise<{ applied: boolean; reason?: string }>;
  clearCohortPacing(cohortKey: string): Promise<{ cleared: boolean; reason?: string }>;
  /** Per-subject allowance override (the step-down landing point). Synchronous, process-local - see the header. */
  setAllowanceOverride(subject: string, allowance: number | null): void;
  /**
   * Write this instance's local override map (sets AND clears) into
   * shared transactional state, without a reserve or any other
   * mutation. After it resolves, a second budget instance on the
   * same store/budgetId respects the flushed overrides for subjects
   * it has not locally touched. Safe to call with nothing pending
   * (a no-op reporting `flushed: 0`); in `audit_only` mode it still
   * writes through the get/put path and reports `enforced: false`.
   */
  flushOverrides(): Promise<FlushOverridesResult>;
  /** `clampActionStepDown` bound to this budget's derived soft floor. */
  clampActionStepDown(
    currentAllowance: number,
    targetAllowance: number,
    context: ActionStepDownContext,
  ): SoftBudgetStepDownResult;
  snapshot(): Promise<ActionBudgetSnapshot>;
}

/**
 * Compute the lawful result of stepping a subject's action allowance
 * down to `targetAllowance`, under the tiering law. The tier decision
 * is delegated to `clampEnforcement("budget_step_down", context)`:
 * when the context permits no step-down at all (an inferred cohort
 * whose gated signal never fired), the current allowance comes back
 * unchanged. For an inferred cohort the result may not fall below the
 * derived soft floor - a request for a hard cut (target 0) comes back
 * clamped to the floor with the tiering reason, refused in code even
 * when configuration demands it. A host-declared cohort, or
 * ceiling-tier calibrated evidence, may reach 0. A limit already lower
 * than the result is never raised.
 */
export function clampActionStepDown(
  currentAllowance: number,
  targetAllowance: number,
  context: ActionStepDownContext,
  derivedSoftFloorCostArg?: number,
): SoftBudgetStepDownResult {
  const clamp = clampEnforcement("budget_step_down", context);
  const current = Math.max(0, Math.floor(currentAllowance));
  if (clamp.action !== "budget_step_down") {
    return {
      limit: current,
      applied: false,
      floored: false,
      reason: `budget step-down is not available in this context: ${clamp.reason}`,
    };
  }
  const floorCost =
    context.origin === "host_declared" || context.calibrationTier === "ceiling"
      ? 0
      : Math.max(0, derivedSoftFloorCostArg ?? context.derivedSoftFloorCost ?? 0);
  const desired = Math.max(0, Math.floor(targetAllowance));
  const limit = Math.min(Math.max(desired, floorCost), current);
  return {
    limit,
    applied: limit < current,
    floored: desired < floorCost && limit === floorCost,
    reason:
      limit === current
        ? "no step-down applied: the current limit is already at or below the requested target/floor"
        : desired < floorCost
          ? `stepped down to the derived soft floor ${floorCost}: an inferred cohort always keeps one maximal legitimate action per window (tiering law, 09:44 revision)`
          : "stepped down within the tiering law",
  };
}

/* ------------------------------------------------------------------------ */
/* The budget                                                                */
/* ------------------------------------------------------------------------ */

const MAX_TRANSACT_ATTEMPTS = 16;

class StoreConflictError extends Error {
  constructor() {
    super("action budget: transaction kept conflicting after retries");
    this.name = "StoreConflictError";
  }
}

/**
 * The backing store failed or its content is unusable (F-06): a dead
 * backend, truncated JSON, or valid JSON of the wrong shape. Every
 * public entry converts this into a structured `store_conflict`
 * refusal instead of letting the exception escape into the host.
 */
class StoreDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreDataError";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidBucketShape(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    isFiniteNumber(value.tokens) &&
    isFiniteNumber(value.lastRefillMs) &&
    isFiniteNumber(value.burst) &&
    isFiniteNumber(value.refillPerSecond)
  );
}

/** Shape validation for state read back from a store (F-06). */
function isValidActionBudgetState(value: unknown): value is ActionBudgetState {
  if (!isPlainRecord(value)) return false;
  if (!isFiniteNumber(value.version)) return false;
  if (!isPlainRecord(value.subjects)) return false;
  for (const window_ of Object.values(value.subjects)) {
    if (!isPlainRecord(window_)) return false;
    if (!isFiniteNumber(window_.windowStartMs)) return false;
    if (!isFiniteNumber(window_.committedCost) || !isFiniteNumber(window_.reservedCost)) return false;
  }
  if (!isPlainRecord(value.reservations)) return false;
  for (const reservation of Object.values(value.reservations)) {
    if (!isPlainRecord(reservation)) return false;
    if (typeof reservation.id !== "string" || typeof reservation.subject !== "string") return false;
    if (typeof reservation.action !== "string") return false;
    if (!isFiniteNumber(reservation.cost)) return false;
    if (!isFiniteNumber(reservation.createdAtMs) || !isFiniteNumber(reservation.expiresAtMs)) return false;
  }
  if (!isPlainRecord(value.idempotency)) return false;
  for (const reservationId of Object.values(value.idempotency)) {
    if (typeof reservationId !== "string") return false;
  }
  if (!isPlainRecord(value.declaredCohorts)) return false;
  for (const cohort of Object.values(value.declaredCohorts)) {
    if (!isPlainRecord(cohort)) return false;
    if (!Array.isArray(cohort.subjects)) return false;
    if (!isFiniteNumber(cohort.ceilingCostPerWindow)) return false;
    if (!isFiniteNumber(cohort.windowStartMs)) return false;
    if (!isFiniteNumber(cohort.committedCost) || !isFiniteNumber(cohort.reservedCost)) return false;
  }
  if (!isPlainRecord(value.cohortPacing)) return false;
  for (const pacing of Object.values(value.cohortPacing)) {
    if (!isPlainRecord(pacing)) return false;
    if (!Array.isArray(pacing.subjects)) return false;
    if (!isValidBucketShape(pacing.bucket)) return false;
  }
  if (!isPlainRecord(value.allowanceOverrides)) return false;
  for (const allowance of Object.values(value.allowanceOverrides)) {
    if (!isFiniteNumber(allowance)) return false;
  }
  if (!isValidBucketShape(value.bucket)) return false;
  if (!isPlainRecord(value.evidence)) return false;
  for (const evidenceValue of Object.values(value.evidence)) {
    if (!isFiniteNumber(evidenceValue)) return false;
  }
  if (!isFiniteNumber(value.nextReservationSeq)) return false;
  return true;
}

function parseActionBudgetState(raw: string): ActionBudgetState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StoreDataError("store_conflict: stored action-budget state is not valid JSON");
  }
  if (!isValidActionBudgetState(parsed)) {
    throw new StoreDataError("store_conflict: stored action-budget state has an invalid shape");
  }
  return parsed;
}

export function createActionBudget(options: ActionBudgetOptions): ActionBudget {
  const store = options.store;
  const budgetId = options.budgetId ?? "default";
  const prices: Record<string, number> = { ...(options.prices ?? {}) };
  const unknownActionCost =
    options.unknownActionCost !== undefined && Number.isFinite(options.unknownActionCost)
      ? Math.max(0, options.unknownActionCost)
      : undefined;
  const subjectAllowance = Math.max(0, options.subjectAllowance ?? 100);
  const windowMs = Math.max(1, options.windowMs ?? 60_000);
  const burst = Math.max(1, options.bucket?.burst ?? 150);
  const refillPerSecond = Math.max(0, options.bucket?.refillPerSecond ?? 2);
  const ttlMs = Math.max(1, options.reservation?.ttlMs ?? 60_000);
  const maxOutstanding = Math.max(1, options.reservation?.maxOutstandingPerSubject ?? 2);
  const maxReservedPerSubject = Math.max(1, options.reservation?.maxReservedCostPerSubject ?? 500);
  const cohortOutstandingCap = options.reservation?.cohortOutstandingCap;
  const longTtlMs = Math.max(ttlMs, options.reservation?.longTtlMs ?? 900_000);
  const now = options.now ?? Date.now;
  const monoNowFn = options.monoNow ?? (options.now ? now : monoNowMs);
  /**
   * Monotonic creation stamps for reservations THIS process created
   * (L-DEEP-2 hybrid rule): reservation id -> { creation instant on
   * the monotonic clock, TTL granted }. Never persisted.
   */
  const ownReservationMono = new Map<string, { createdMonoMs: number; ttlMs: number }>();
  /**
   * Monotonic anchors for windows THIS process created or rolled
   * (L-DEEP-2): `subject:<id>` / `cohort:<id>` -> { wall start,
   * monotonic start }. An anchor applies only while the persisted
   * window still starts at the anchored wall instant; a window
   * another process rolled is foreign and follows the wall alone.
   */
  const windowAnchors = new Map<string, { startWallMs: number; startMonoMs: number }>();
  const mode: ActionBudgetMode =
    store.supportsTransactions && store.transactLedger ? "enforce" : "audit_only";
  const enforcementNote =
    mode === "enforce"
      ? "Allowances, cohort ceilings, reservations and buckets are mutated under a CAS transaction on the budget version; parallel reservations cannot jointly overspend a subject allowance or a declared cohort ceiling."
      : "audit only - the backing store has no transaction/CAS primitive, so decisions are computed best-effort and are NOT guaranteed under concurrency. Supply a transactional store to enforce allowances and ceilings.";
  const derivedSoftFloorCost = Math.max(
    0,
    ...Object.values(prices).map(value => (Number.isFinite(value) ? value : 0)),
  );

  /** Store key for the get/put (audit-only) path. Transactional writes go through `txLedgerId`. */
  const directKey = `antirea:action-budget:${budgetId}`;
  /** Ledger id for `transactLedger` - namespaced so a disclosure ledger and an action budget can share one store. */
  const txLedgerId = `action-budget:${budgetId}`;
  /** CAS version as last observed by THIS instance; resynced from every transact result (including conflicts). */
  let lastKnownVersion = 0;
  /** Process-local allowance overrides (see the header). */
  const overrideMap = new Map<string, number>();
  /**
   * Subjects this instance has explicitly set OR cleared an override
   * for. For those, the local decision is authoritative - a cleared
   * override must not fall back to the stale state mirror below.
   */
  const overrideTouched = new Set<string>();

  const initialBucket = (): ActionBucketState => ({
    tokens: burst,
    lastRefillMs: now(),
    burst,
    refillPerSecond,
  });

  function emptyState(): ActionBudgetState {
    return {
      version: 0,
      subjects: {},
      reservations: {},
      idempotency: {},
      declaredCohorts: {},
      cohortPacing: {},
      allowanceOverrides: {},
      bucket: initialBucket(),
      evidence: {},
      nextReservationSeq: 1,
    };
  }

  const cloneState = (state: ActionBudgetState): ActionBudgetState =>
    JSON.parse(JSON.stringify(state)) as ActionBudgetState;

  /** Store-originated failures map to structured refusals (F-06). */
  const isStoreFailure = (error: unknown): boolean =>
    error instanceof StoreConflictError || error instanceof StoreDataError;

  async function readAuditState(): Promise<ActionBudgetState> {
    let raw: string | null;
    try {
      raw = await store.get(directKey);
    } catch {
      throw new StoreDataError("store_conflict: action-budget store read failed");
    }
    if (!raw) return emptyState();
    return parseActionBudgetState(raw);
  }

  /**
   * Run `fn` against the state atomically when the store supports it
   * (with conflict retry, as in the disclosure ledger), or best-effort
   * (read-compute-put) when it does not. `fn` returns the next state
   * (or null to skip the write) plus the value to hand back.
   */
  async function mutate<T>(
    fn: (state: ActionBudgetState) => { state: ActionBudgetState | null; value: T },
  ): Promise<T> {
    if (mode === "enforce" && store.transactLedger) {
      const transact = store.transactLedger.bind(store);
      for (let attempt = 0; attempt < MAX_TRANSACT_ATTEMPTS; attempt++) {
        let captured: T | undefined;
        let corruptState = false;
        // The adapter's updater is typed for DisclosureLedgerState; the
        // runtime contract is shape-agnostic JSON + a version field, so
        // the action-budget state is cast through that signature here
        // (and only here).
        const updater = ((raw: DisclosureLedgerState | null) => {
          const base = (raw as unknown as ActionBudgetState | null) ?? emptyState();
          if (!isValidActionBudgetState(base)) {
            // Corrupt stored content (F-06): abort without writing;
            // the caller converts this into a store_conflict refusal.
            corruptState = true;
            return null;
          }
          const outcome = fn(cloneState(base));
          captured = outcome.value;
          if (outcome.state === null) return null;
          return outcome.state as unknown as DisclosureLedgerState;
        }) as unknown as LedgerUpdater;
        let result: LedgerTransactResult;
        try {
          result = await transact(txLedgerId, lastKnownVersion, updater);
        } catch {
          // A dead or corrupt-backed store throws out of the
          // transaction itself (its own JSON.parse included).
          throw new StoreDataError("store_conflict: action-budget store transaction failed");
        }
        lastKnownVersion = result.version;
        if (corruptState) {
          throw new StoreDataError("store_conflict: stored action-budget state has an invalid shape");
        }
        if (result.conflict) continue;
        return captured as T;
      }
      throw new StoreConflictError();
    }
    const state = await readAuditState();
    const outcome = fn(cloneState(state));
    if (outcome.state !== null) {
      try {
        await store.put(directKey, JSON.stringify(outcome.state));
      } catch {
        throw new StoreDataError("store_conflict: action-budget store write failed");
      }
    }
    return outcome.value;
  }

  /* ------------------------- state helpers ------------------------- */

  /** Tokens a bucket holds at `atMs`, without mutating it. */
  function refilledTokens(bucket: ActionBucketState, atMs: number): number {
    let elapsedMs = Math.max(0, atMs - bucket.lastRefillMs);
    if (elapsedMs <= 0 || bucket.refillPerSecond <= 0) return bucket.tokens;
    // L-DEEP-2 hybrid clamp: never credit more elapsed time than the
    // bucket needs to reach full (no-op on a healthy clock).
    const msToFull = ((bucket.burst - bucket.tokens) / bucket.refillPerSecond) * 1000;
    elapsedMs = Math.min(elapsedMs, Math.max(0, msToFull));
    return Math.min(bucket.burst, bucket.tokens + (elapsedMs / 1000) * bucket.refillPerSecond);
  }

  function refillBucket(bucket: ActionBucketState, atMs: number): void {
    bucket.tokens = refilledTokens(bucket, atMs);
    bucket.lastRefillMs = atMs;
  }

  function sumReserved(state: ActionBudgetState, pick: (r: ActionReservation) => boolean): number {
    let sum = 0;
    for (const reservation of Object.values(state.reservations)) if (pick(reservation)) sum += reservation.cost;
    return sum;
  }

  /** Roll a subject's window if it has expired; reserved cost is recomputed from open reservations. */
  function ensureSubjectWindow(
    state: ActionBudgetState,
    subject: string,
    atMs: number,
    atMonoMs: number,
    trackAnchor: boolean,
  ): ActionSubjectWindow {
    const anchorKey = `subject:${subject}`;
    let window_ = state.subjects[subject];
    if (!window_) {
      window_ = { windowStartMs: atMs, committedCost: 0, reservedCost: 0 };
      state.subjects[subject] = window_;
      if (trackAnchor) windowAnchors.set(anchorKey, { startWallMs: atMs, startMonoMs: atMonoMs });
      return window_;
    }
    // Hybrid roll (L-DEEP-2): the wall deadline, or - for a window
    // this process anchored - its monotonic length, whichever first.
    const anchor = windowAnchors.get(anchorKey);
    const monoExpired =
      anchor !== undefined &&
      anchor.startWallMs === window_.windowStartMs &&
      atMonoMs - anchor.startMonoMs >= windowMs;
    if (atMs - window_.windowStartMs >= windowMs || monoExpired) {
      window_.windowStartMs = atMs;
      window_.committedCost = 0;
      window_.reservedCost = sumReserved(state, r => r.subject === subject);
      if (trackAnchor) windowAnchors.set(anchorKey, { startWallMs: atMs, startMonoMs: atMonoMs });
    }
    return window_;
  }

  /** Roll a declared cohort's window if it has expired (same recompute discipline). */
  function ensureCohortWindow(
    state: ActionBudgetState,
    cohortId: string,
    cohort: DeclaredActionCohortState,
    atMs: number,
    atMonoMs: number,
    trackAnchor: boolean,
  ): void {
    const anchorKey = `cohort:${cohortId}`;
    const anchor = windowAnchors.get(anchorKey);
    const monoExpired =
      anchor !== undefined &&
      anchor.startWallMs === cohort.windowStartMs &&
      atMonoMs - anchor.startMonoMs >= windowMs;
    if (atMs - cohort.windowStartMs >= windowMs || monoExpired) {
      cohort.windowStartMs = atMs;
      cohort.committedCost = 0;
      cohort.reservedCost = sumReserved(state, r => r.cohortId !== undefined && state.declaredCohorts[r.cohortId] === cohort);
      if (trackAnchor) windowAnchors.set(anchorKey, { startWallMs: atMs, startMonoMs: atMonoMs });
    }
  }

  function expireReservations(
    state: ActionBudgetState,
    atMs: number,
    atMonoMs: number,
    pruneMono: boolean,
  ): number {
    let expired = 0;
    for (const [id, reservation] of Object.entries(state.reservations)) {
      // Hybrid rule (L-DEEP-2): a reservation created by this process
      // dies at whichever comes first - wall expiry or monotonic TTL.
      const own = ownReservationMono.get(id);
      const monoExpired = own !== undefined && atMonoMs - own.createdMonoMs >= own.ttlMs;
      if (reservation.expiresAtMs <= atMs || monoExpired) {
        const window_ = state.subjects[reservation.subject];
        if (window_) window_.reservedCost = Math.max(0, window_.reservedCost - reservation.cost);
        if (reservation.cohortId) {
          const cohort = state.declaredCohorts[reservation.cohortId];
          if (cohort) cohort.reservedCost = Math.max(0, cohort.reservedCost - reservation.cost);
        }
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

  /**
   * F-13 (NEW in this tree, not a port - the released tree never
   * prunes subject windows): delete subject windows that have fully
   * rolled - by the wall deadline or, for a window this process
   * anchored, by its monotonic length - and hold no open reservation.
   * A rolled window's committed cost is dead accounting either way
   * (the next touch would reset it to 0), so deleting it changes no
   * decision; a window with an open reservation is kept, because
   * `ensureSubjectWindow` still needs it to recompute reserved cost
   * at the roll. Called only on paths that persist state, plus the
   * sweep (whose return now also reports a prune-only write). Also
   * drops the window's monotonic anchor so the anchor map cannot
   * grow with the subjects it mirrors.
   */
  function pruneStaleSubjects(state: ActionBudgetState, atMs: number, atMonoMs: number): number {
    let pruned = 0;
    for (const [subject, window_] of Object.entries(state.subjects)) {
      const anchorKey = `subject:${subject}`;
      const anchor = windowAnchors.get(anchorKey);
      const monoExpired =
        anchor !== undefined &&
        anchor.startWallMs === window_.windowStartMs &&
        atMonoMs - anchor.startMonoMs >= windowMs;
      if (atMs - window_.windowStartMs < windowMs && !monoExpired) continue;
      if (Object.values(state.reservations).some(r => r.subject === subject)) continue;
      delete state.subjects[subject];
      windowAnchors.delete(anchorKey);
      pruned++;
    }
    return pruned;
  }

  function dropReservation(state: ActionBudgetState, reservation: ActionReservation): void {
    delete state.reservations[reservation.id];
    for (const [key, reservationId] of Object.entries(state.idempotency)) {
      if (reservationId === reservation.id) delete state.idempotency[key];
    }
  }

  /** Mirror the process-local overrides into the state (called inside mutations). */
  function syncOverrides(state: ActionBudgetState): void {
    for (const subject of overrideTouched) {
      const allowance = overrideMap.get(subject);
      if (allowance === undefined) delete state.allowanceOverrides[subject];
      else state.allowanceOverrides[subject] = allowance;
    }
  }

  function effectiveAllowance(state: ActionBudgetState, subject: string): number {
    if (overrideTouched.has(subject)) return overrideMap.get(subject) ?? subjectAllowance;
    return state.allowanceOverrides[subject] ?? subjectAllowance;
  }

  const retryAfterFor = (tokens: number, cost: number, refillPerSecond: number): number =>
    refillPerSecond > 0
      ? Math.ceil(((cost - tokens) / refillPerSecond) * 1000)
      : Number.MAX_SAFE_INTEGER;

  /* --------------------------- the budget --------------------------- */

  return {
    mode,
    enforcementNote,
    derivedSoftFloorCost,

    async reserveAction(req) {
      const atMs = now();
      const atMonoMs = monoNowFn();
      const enforced = mode === "enforce";
      // Price resolution (F-05): an explicit finite host cost wins,
      // then the price table. An action with NEITHER used to fall
      // through to cost 0 - free forever, through every gate, with no
      // signal - so a host that forgot to price a new action failed
      // open in silence. The unpriced case is now explicit: refused
      // `unknown_action` by default, or charged the configured
      // `unknownActionCost` with `unpriced: true` on the result. A
      // DELIBERATE zero stays possible (an explicit `cost: 0`, or a
      // table entry priced at 0): only the absent price is refused.
      // A non-finite explicit cost is not a price either - it falls
      // through to the table / unpriced path instead of silently
      // becoming 0.
      const tablePrice = prices[req.action];
      const explicitCost =
        typeof req.cost === "number" && Number.isFinite(req.cost) ? Math.max(0, req.cost) : undefined;
      let cost: number;
      let unpriced = false;
      if (explicitCost !== undefined) {
        cost = explicitCost;
      } else if (tablePrice !== undefined) {
        cost = Number.isFinite(tablePrice) ? Math.max(0, tablePrice) : 0;
      } else if (unknownActionCost !== undefined) {
        cost = unknownActionCost;
        unpriced = true;
      } else {
        // Pure input validation: no state is read or written, so the
        // refusal returns without opening a store transaction.
        return { allowed: false, enforced, mode, reason: "unknown_action", cost: 0 };
      }
      try {
        const result = await mutate<ReserveActionResult>(state => {
          const refuse = (
            reason: ReserveActionRefusalReason,
            extra?: Partial<ReserveActionResult>,
          ): { state: ActionBudgetState | null; value: ReserveActionResult } => ({
            state: null,
            value: {
              allowed: false,
              enforced,
              mode,
              reason,
              cost,
              ...(unpriced ? { unpriced: true } : {}),
              ...extra,
            },
          });

          syncOverrides(state);

          // Lazy sweep: stale reservations free their subject/cohort
          // reserved cost before any check runs (ledger discipline).
          expireReservations(state, atMs, atMonoMs, true);
          // F-13: fully-rolled windows with no open reservation are
          // dead accounting; drop them before the checks below (the
          // requesting subject's own window is recreated fresh by
          // ensureSubjectWindow when it was pruned).
          pruneStaleSubjects(state, atMs, atMonoMs);

          if (req.idempotencyKey) {
            const existingId = state.idempotency[req.idempotencyKey];
            const existing = existingId ? state.reservations[existingId] : undefined;
            if (existing) {
              // F-01: a replay is honored ONLY when it is the same
              // subject repeating the same action at the same cost in
              // the same cohort. Any mismatch is refused and never
              // charged to the original subject.
              const samePayload =
                existing.subject === req.subject &&
                existing.action === req.action &&
                existing.cost === cost &&
                existing.cohortId === req.cohortId;
              if (!samePayload) return refuse("idempotency_conflict");
              return {
                state: null,
                value: {
                  allowed: true,
                  enforced,
                  mode,
                  reservationId: existing.id,
                  cost: existing.cost,
                  duplicate: true,
                  ...(unpriced ? { unpriced: true } : {}),
                },
              };
            }
          }

          // Declared cohort: armed at declaration, fail closed.
          let cohort: DeclaredActionCohortState | undefined;
          if (req.cohortId !== undefined) {
            cohort = state.declaredCohorts[req.cohortId];
            if (!cohort) return refuse("unknown_cohort");
            if (!cohort.subjects.includes(req.subject)) return refuse("unregistered_subject");
            ensureCohortWindow(state, req.cohortId, cohort, atMs, atMonoMs, true);
            if (cohort.committedCost + cohort.reservedCost + cost > cohort.ceilingCostPerWindow) {
              return refuse("cohort_ceiling_exceeded");
            }
          }

          // Inferred-cohort pacing: every pacing entry listing this
          // subject must hold enough tokens. Pacing is a rate, never a
          // permanent denial, and never touches unlisted subjects.
          const pacingDebits: { entry: ActionCohortPacingState; refilled: number }[] = [];
          for (const entry of Object.values(state.cohortPacing)) {
            if (!entry.subjects.includes(req.subject)) continue;
            const refilled = refilledTokens(entry.bucket, atMs);
            if (Math.floor(refilled) < cost) {
              return refuse("rate_limited", {
                retryAfterMs: retryAfterFor(refilled, cost, entry.bucket.refillPerSecond),
              });
            }
            pacingDebits.push({ entry, refilled });
          }

          // Per-subject allowance for this window.
          const subjectWindow = ensureSubjectWindow(state, req.subject, atMs, atMonoMs, true);
          const allowance = effectiveAllowance(state, req.subject);
          if (subjectWindow.committedCost + subjectWindow.reservedCost + cost > allowance) {
            return refuse("subject_budget_exceeded");
          }

          // Reservation bounds (ledger parity, renamed for actions).
          const long = req.longReservation === true;
          if (long && !req.hostAuthorizedLong) return refuse("long_reservation_not_authorized");
          const subjectReservations = Object.values(state.reservations).filter(
            r => r.subject === req.subject,
          );
          if (subjectReservations.length >= maxOutstanding) return refuse("too_many_outstanding");
          const subjectReservedTotal = subjectReservations.reduce((sum, r) => sum + r.cost, 0);
          if (subjectReservedTotal + cost > maxReservedPerSubject) {
            return refuse("subject_reservation_cap");
          }
          if (cohortOutstandingCap !== undefined) {
            const totalReserved = sumReserved(state, () => true);
            if (totalReserved + cost > cohortOutstandingCap) return refuse("cohort_reservation_cap");
          }

          // Global pacing bucket.
          const globalRefilled = refilledTokens(state.bucket, atMs);
          if (Math.floor(globalRefilled) < cost) {
            return refuse("rate_limited", {
              retryAfterMs: retryAfterFor(globalRefilled, cost, state.bucket.refillPerSecond),
            });
          }

          // All checks passed: debit buckets and record the reservation.
          state.bucket.tokens = globalRefilled - cost;
          state.bucket.lastRefillMs = atMs;
          for (const { entry, refilled } of pacingDebits) {
            entry.bucket.tokens = refilled - cost;
            entry.bucket.lastRefillMs = atMs;
          }
          const seq = state.nextReservationSeq++;
          const reservation: ActionReservation = {
            id: `act_${seq}`,
            subject: req.subject,
            action: req.action,
            cost,
            ...(req.cohortId !== undefined ? { cohortId: req.cohortId } : {}),
            createdAtMs: atMs,
            expiresAtMs: atMs + (long ? longTtlMs : ttlMs),
            long,
            ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
          };
          state.reservations[reservation.id] = reservation;
          if (req.idempotencyKey) state.idempotency[req.idempotencyKey] = reservation.id;
          subjectWindow.reservedCost += cost;
          if (cohort) cohort.reservedCost += cost;
          return {
            state,
            value: {
              allowed: true,
              enforced,
              mode,
              reservationId: reservation.id,
              cost,
              ...(unpriced ? { unpriced: true } : {}),
            },
          };
        });
        if (result.allowed && result.reservationId && !result.duplicate) {
          // This process created the reservation: stamp its monotonic
          // creation instant so the hybrid expiry rule can see it.
          ownReservationMono.set(result.reservationId, {
            createdMonoMs: atMonoMs,
            ttlMs: req.longReservation === true ? longTtlMs : ttlMs,
          });
        }
        return result;
      } catch (error) {
        if (error instanceof StoreConflictError || error instanceof StoreDataError) {
          return {
            allowed: false,
            enforced,
            mode,
            reason: "store_conflict",
            cost,
            ...(unpriced ? { unpriced: true } : {}),
          };
        }
        throw error;
      }
    },

    async commitAction(reservationId) {
      const atMonoMs = monoNowFn();
      try {
        const result = await mutate<{ committed: boolean; reason?: string }>(state => {
          const atMs = now();
          expireReservations(state, atMs, atMonoMs, true);
          pruneStaleSubjects(state, atMs, atMonoMs);
          const reservation = state.reservations[reservationId];
          if (!reservation) {
            return { state: null, value: { committed: false, reason: "unknown_or_expired_reservation" } };
          }
          const subjectWindow = ensureSubjectWindow(state, reservation.subject, atMs, atMonoMs, true);
          subjectWindow.committedCost += reservation.cost;
          subjectWindow.reservedCost = Math.max(0, subjectWindow.reservedCost - reservation.cost);
          if (reservation.cohortId) {
            const cohort = state.declaredCohorts[reservation.cohortId];
            if (cohort) {
              ensureCohortWindow(state, reservation.cohortId, cohort, atMs, atMonoMs, true);
              cohort.committedCost += reservation.cost;
              cohort.reservedCost = Math.max(0, cohort.reservedCost - reservation.cost);
            }
          }
          dropReservation(state, reservation);
          syncOverrides(state);
          return { state, value: { committed: true } };
        });
        if (result.committed) ownReservationMono.delete(reservationId);
        return result;
      } catch (error) {
        if (isStoreFailure(error)) return { committed: false, reason: "store_conflict" };
        throw error;
      }
    },

    async releaseAction(reservationId) {
      const atMonoMs = monoNowFn();
      try {
        const result = await mutate<{ released: boolean; reason?: string }>(state => {
          const atMs = now();
          pruneStaleSubjects(state, atMs, atMonoMs);
          const reservation = state.reservations[reservationId];
          if (!reservation) return { state: null, value: { released: false } };
          const subjectWindow = ensureSubjectWindow(state, reservation.subject, atMs, atMonoMs, true);
          subjectWindow.reservedCost = Math.max(0, subjectWindow.reservedCost - reservation.cost);
          if (reservation.cohortId) {
            const cohort = state.declaredCohorts[reservation.cohortId];
            if (cohort) {
              ensureCohortWindow(state, reservation.cohortId, cohort, atMs, atMonoMs, true);
              cohort.reservedCost = Math.max(0, cohort.reservedCost - reservation.cost);
            }
          }
          dropReservation(state, reservation);
          syncOverrides(state);
          return { state, value: { released: true } };
        });
        if (result.released) ownReservationMono.delete(reservationId);
        return result;
      } catch (error) {
        if (isStoreFailure(error)) return { released: false, reason: "store_conflict" };
        throw error;
      }
    },

    async sweepExpired() {
      try {
        return await mutate(state => {
          const atMs = now();
          const atMonoMs = monoNowFn();
          const expired = expireReservations(state, atMs, atMonoMs, true);
          // F-13: a sweep is also the host's cleanup trigger for stale
          // subject windows; a prune-only sweep still persists.
          const pruned = pruneStaleSubjects(state, atMs, atMonoMs);
          return { state: expired > 0 || pruned > 0 ? state : null, value: { expired } };
        });
      } catch (error) {
        if (isStoreFailure(error)) return { expired: 0, reason: "store_conflict" };
        throw error;
      }
    },

    async declareActionCohort(req) {
      const unique = [...new Set(req.subjects)];
      const declareWallMs = now();
      const declareMonoMs = monoNowFn();
      let createdNewCohort = false;
      try {
        const result = await mutate(state => {
          createdNewCohort = false;
          pruneStaleSubjects(state, declareWallMs, declareMonoMs);
          const existing = state.declaredCohorts[req.cohortId];
          if (existing) {
            // Re-declaration updates membership and ceiling but does NOT
            // reset the window accounting: re-declaring must not launder
            // cost already counted against the ceiling.
            existing.subjects = unique;
            existing.ceilingCostPerWindow = Math.max(0, req.ceilingCostPerWindow);
          } else {
            createdNewCohort = true;
            state.declaredCohorts[req.cohortId] = {
              subjects: unique,
              ceilingCostPerWindow: Math.max(0, req.ceilingCostPerWindow),
              windowStartMs: declareWallMs,
              committedCost: 0,
              reservedCost: 0,
            };
          }
          syncOverrides(state);
          return { state, value: { registered: unique.length } };
        });
        if (createdNewCohort) {
          // This process created the cohort window: anchor it (L-DEEP-2).
          windowAnchors.set(`cohort:${req.cohortId}`, {
            startWallMs: declareWallMs,
            startMonoMs: declareMonoMs,
          });
        }
        return result;
      } catch (error) {
        if (isStoreFailure(error)) return { registered: 0, reason: "store_conflict" };
        throw error;
      }
    },

    async setCohortPacing(req) {
      try {
        return await mutate(state => {
          pruneStaleSubjects(state, now(), monoNowFn());
          const pacingBurst = Math.max(0, req.burst);
          const refillPerSecond = Math.max(0, req.refillPerSecond);
          const existing = state.cohortPacing[req.cohortKey];
          state.cohortPacing[req.cohortKey] = {
            subjects: [...new Set(req.subjects)],
            // Re-applying pacing for the same scope UPDATES membership
            // and the bucket parameters but PRESERVES the bucket's
            // spent state (tokens + refill clock): a growing subject
            // list must never mint a fresh burst for a cohort that has
            // already drained one.
            bucket: existing
              ? {
                  tokens: existing.bucket.tokens,
                  lastRefillMs: existing.bucket.lastRefillMs,
                  burst: pacingBurst,
                  refillPerSecond,
                }
              : {
                  tokens: pacingBurst,
                  lastRefillMs: now(),
                  burst: pacingBurst,
                  refillPerSecond,
                },
          };
          syncOverrides(state);
          return { state, value: { applied: true } };
        });
      } catch (error) {
        if (isStoreFailure(error)) return { applied: false, reason: "store_conflict" };
        throw error;
      }
    },

    async clearCohortPacing(cohortKey) {
      try {
        return await mutate<{ cleared: boolean; reason?: string }>(state => {
          if (!state.cohortPacing[cohortKey]) return { state: null, value: { cleared: false } };
          pruneStaleSubjects(state, now(), monoNowFn());
          delete state.cohortPacing[cohortKey];
          syncOverrides(state);
          return { state, value: { cleared: true } };
        });
      } catch (error) {
        if (isStoreFailure(error)) return { cleared: false, reason: "store_conflict" };
        throw error;
      }
    },

    setAllowanceOverride(subject, allowance) {
      overrideTouched.add(subject);
      if (allowance === null) overrideMap.delete(subject);
      else overrideMap.set(subject, Math.max(0, allowance));
    },

    async flushOverrides() {
      const flushed = overrideTouched.size;
      const enforced = mode === "enforce";
      if (flushed === 0) return { flushed: 0, mode, enforced };
      try {
        await mutate<null>(state => {
          pruneStaleSubjects(state, now(), monoNowFn());
          syncOverrides(state);
          // Always persist (return the state, never null): the whole
          // point of the flush is that the mirror reaches shared state
          // even when nothing else about the state changed.
          return { state, value: null };
        });
      } catch (error) {
        // F-06 discipline, extended to this 2.7-only entry (the
        // released tree has no flush): a dead or corrupt store must
        // not throw out of a public method either.
        if (isStoreFailure(error)) return { flushed: 0, mode, enforced, reason: "store_conflict" };
        throw error;
      }
      return { flushed, mode, enforced };
    },

    clampActionStepDown(currentAllowance, targetAllowance, context) {
      return clampActionStepDown(currentAllowance, targetAllowance, {
        ...context,
        derivedSoftFloorCost: context.derivedSoftFloorCost ?? derivedSoftFloorCost,
      });
    },

    async snapshot() {
      const buildSnapshot = (view: ActionBudgetState): ActionBudgetSnapshot => {
        const atMs = now();
        const atMonoMs = monoNowFn();
        // View-only: anchors and the mono mirror map are read, never
        // written, and nothing here persists (the F-13 prune lives on
        // the persisting mutation paths, not on this read path - a
        // snapshot must not publish state, per the override contract).
        expireReservations(view, atMs, atMonoMs, false);
        for (const subject of Object.keys(view.subjects)) {
          ensureSubjectWindow(view, subject, atMs, atMonoMs, false);
        }
        for (const [cohortId, cohort] of Object.entries(view.declaredCohorts)) {
          ensureCohortWindow(view, cohortId, cohort, atMs, atMonoMs, false);
        }
        refillBucket(view.bucket, atMs);
        syncOverrides(view);
        let committedCost = 0;
        for (const window_ of Object.values(view.subjects)) committedCost += window_.committedCost;
        return {
          budgetId,
          mode,
          version: view.version,
          subjectAllowance,
          derivedSoftFloorCost,
          outstandingReservations: Object.keys(view.reservations).length,
          reservedCost: sumReserved(view, () => true),
          committedCost,
          bucketTokens: Math.floor(view.bucket.tokens),
          declaredCohorts: Object.keys(view.declaredCohorts).length,
          subjects: view.subjects,
          evidence: { ...view.evidence },
        };
      };
      try {
        return await mutate<ActionBudgetSnapshot>(state => ({
          state: null,
          value: buildSnapshot(cloneState(state)),
        }));
      } catch (error) {
        if (isStoreFailure(error)) {
          // F-06: never throw out of a read path; the snapshot is
          // marked so the host can tell it describes an empty budget.
          return { ...buildSnapshot(emptyState()), storeError: "store_conflict" };
        }
        throw error;
      }
    },
  };
}
