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
 * neither replaces the other.
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
 * transactional state on every mutation (the `allowanceOverrides`
 * field) so snapshots stay auditable; on a shared store, a second
 * budget instance reads the mirrored overrides but its own
 * `setAllowanceOverride` calls remain local to that instance.
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

import type { DisclosureLedgerState, LedgerStoreAdapter, LedgerUpdater } from "./disclosure-ledger";
import {
  clampEnforcement,
  type EnforcementContext,
  type SoftBudgetStepDownResult,
} from "./enforcement-tiering";

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
}

export interface ReserveActionRequest {
  subject: string;
  action: string;
  /** Explicit host-computed cost; defaults to the price table entry. */
  cost?: number;
  cohortId?: string;
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
  | "long_reservation_not_authorized"
  | "store_conflict";

export interface ReserveActionResult {
  allowed: boolean;
  /** False in audit-only mode: the decision was computed, not guaranteed. */
  enforced: boolean;
  mode: ActionBudgetMode;
  reservationId?: string;
  /** The cost charged (price-table default or the explicit cost). */
  cost?: number;
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

export interface ActionBudget {
  readonly mode: ActionBudgetMode;
  /** Plain-language statement of what this budget does and does not guarantee. */
  readonly enforcementNote: string;
  /** Maximum single-action price in the host's table (see the header). */
  readonly derivedSoftFloorCost: number;
  reserveAction(req: ReserveActionRequest): Promise<ReserveActionResult>;
  commitAction(reservationId: string): Promise<{ committed: boolean; reason?: string }>;
  releaseAction(reservationId: string): Promise<{ released: boolean }>;
  /** Eagerly expire reservations whose TTL has passed. */
  sweepExpired(): Promise<{ expired: number }>;
  declareActionCohort(req: {
    cohortId: string;
    subjects: string[];
    ceilingCostPerWindow: number;
  }): Promise<{ registered: number }>;
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
  }): Promise<{ applied: boolean }>;
  clearCohortPacing(cohortKey: string): Promise<{ cleared: boolean }>;
  /** Per-subject allowance override (the step-down landing point). Synchronous, process-local - see the header. */
  setAllowanceOverride(subject: string, allowance: number | null): void;
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

export function createActionBudget(options: ActionBudgetOptions): ActionBudget {
  const store = options.store;
  const budgetId = options.budgetId ?? "default";
  const prices: Record<string, number> = { ...(options.prices ?? {}) };
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

  async function readAuditState(): Promise<ActionBudgetState> {
    const raw = await store.get(directKey);
    if (!raw) return emptyState();
    return JSON.parse(raw) as ActionBudgetState;
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
        // The adapter's updater is typed for DisclosureLedgerState; the
        // runtime contract is shape-agnostic JSON + a version field, so
        // the action-budget state is cast through that signature here
        // (and only here).
        const updater = ((raw: DisclosureLedgerState | null) => {
          const base = (raw as unknown as ActionBudgetState | null) ?? emptyState();
          const outcome = fn(cloneState(base));
          captured = outcome.value;
          if (outcome.state === null) return null;
          return outcome.state as unknown as DisclosureLedgerState;
        }) as unknown as LedgerUpdater;
        const result = await transact(txLedgerId, lastKnownVersion, updater);
        lastKnownVersion = result.version;
        if (result.conflict) continue;
        return captured as T;
      }
      throw new StoreConflictError();
    }
    const state = await readAuditState();
    const outcome = fn(cloneState(state));
    if (outcome.state !== null) await store.put(directKey, JSON.stringify(outcome.state));
    return outcome.value;
  }

  /* ------------------------- state helpers ------------------------- */

  /** Tokens a bucket holds at `atMs`, without mutating it. */
  function refilledTokens(bucket: ActionBucketState, atMs: number): number {
    const elapsedMs = Math.max(0, atMs - bucket.lastRefillMs);
    if (elapsedMs <= 0 || bucket.refillPerSecond <= 0) return bucket.tokens;
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
  ): ActionSubjectWindow {
    let window_ = state.subjects[subject];
    if (!window_) {
      window_ = { windowStartMs: atMs, committedCost: 0, reservedCost: 0 };
      state.subjects[subject] = window_;
      return window_;
    }
    if (atMs - window_.windowStartMs >= windowMs) {
      window_.windowStartMs = atMs;
      window_.committedCost = 0;
      window_.reservedCost = sumReserved(state, r => r.subject === subject);
    }
    return window_;
  }

  /** Roll a declared cohort's window if it has expired (same recompute discipline). */
  function ensureCohortWindow(state: ActionBudgetState, cohort: DeclaredActionCohortState, atMs: number): void {
    if (atMs - cohort.windowStartMs >= windowMs) {
      cohort.windowStartMs = atMs;
      cohort.committedCost = 0;
      cohort.reservedCost = sumReserved(state, r => r.cohortId !== undefined && state.declaredCohorts[r.cohortId] === cohort);
    }
  }

  function expireReservations(state: ActionBudgetState, atMs: number): number {
    let expired = 0;
    for (const [id, reservation] of Object.entries(state.reservations)) {
      if (reservation.expiresAtMs <= atMs) {
        const window_ = state.subjects[reservation.subject];
        if (window_) window_.reservedCost = Math.max(0, window_.reservedCost - reservation.cost);
        if (reservation.cohortId) {
          const cohort = state.declaredCohorts[reservation.cohortId];
          if (cohort) cohort.reservedCost = Math.max(0, cohort.reservedCost - reservation.cost);
        }
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
      const enforced = mode === "enforce";
      const tablePrice = prices[req.action];
      const rawCost = req.cost ?? tablePrice ?? 0;
      const cost = Number.isFinite(rawCost) ? Math.max(0, rawCost) : 0;
      try {
        return await mutate<ReserveActionResult>(state => {
          const refuse = (
            reason: ReserveActionRefusalReason,
            extra?: Partial<ReserveActionResult>,
          ): { state: ActionBudgetState | null; value: ReserveActionResult } => ({
            state: null,
            value: { allowed: false, enforced, mode, reason, cost, ...extra },
          });

          syncOverrides(state);

          // Lazy sweep: stale reservations free their subject/cohort
          // reserved cost before any check runs (ledger discipline).
          expireReservations(state, atMs);

          if (req.idempotencyKey) {
            const existingId = state.idempotency[req.idempotencyKey];
            const existing = existingId ? state.reservations[existingId] : undefined;
            if (existing) {
              return {
                state: null,
                value: {
                  allowed: true,
                  enforced,
                  mode,
                  reservationId: existing.id,
                  cost: existing.cost,
                  duplicate: true,
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
            ensureCohortWindow(state, cohort, atMs);
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
          const subjectWindow = ensureSubjectWindow(state, req.subject, atMs);
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
            value: { allowed: true, enforced, mode, reservationId: reservation.id, cost },
          };
        });
      } catch (error) {
        if (error instanceof StoreConflictError) {
          return { allowed: false, enforced, mode, reason: "store_conflict", cost };
        }
        throw error;
      }
    },

    async commitAction(reservationId) {
      return mutate<{ committed: boolean; reason?: string }>(state => {
        const atMs = now();
        expireReservations(state, atMs);
        const reservation = state.reservations[reservationId];
        if (!reservation) {
          return { state: null, value: { committed: false, reason: "unknown_or_expired_reservation" } };
        }
        const subjectWindow = ensureSubjectWindow(state, reservation.subject, atMs);
        subjectWindow.committedCost += reservation.cost;
        subjectWindow.reservedCost = Math.max(0, subjectWindow.reservedCost - reservation.cost);
        if (reservation.cohortId) {
          const cohort = state.declaredCohorts[reservation.cohortId];
          if (cohort) {
            ensureCohortWindow(state, cohort, atMs);
            cohort.committedCost += reservation.cost;
            cohort.reservedCost = Math.max(0, cohort.reservedCost - reservation.cost);
          }
        }
        dropReservation(state, reservation);
        syncOverrides(state);
        return { state, value: { committed: true } };
      });
    },

    async releaseAction(reservationId) {
      return mutate<{ released: boolean }>(state => {
        const atMs = now();
        const reservation = state.reservations[reservationId];
        if (!reservation) return { state: null, value: { released: false } };
        const subjectWindow = ensureSubjectWindow(state, reservation.subject, atMs);
        subjectWindow.reservedCost = Math.max(0, subjectWindow.reservedCost - reservation.cost);
        if (reservation.cohortId) {
          const cohort = state.declaredCohorts[reservation.cohortId];
          if (cohort) {
            ensureCohortWindow(state, cohort, atMs);
            cohort.reservedCost = Math.max(0, cohort.reservedCost - reservation.cost);
          }
        }
        dropReservation(state, reservation);
        syncOverrides(state);
        return { state, value: { released: true } };
      });
    },

    async sweepExpired() {
      return mutate(state => {
        const expired = expireReservations(state, now());
        return { state: expired > 0 ? state : null, value: { expired } };
      });
    },

    async declareActionCohort(req) {
      const unique = [...new Set(req.subjects)];
      return mutate(state => {
        const existing = state.declaredCohorts[req.cohortId];
        if (existing) {
          // Re-declaration updates membership and ceiling but does NOT
          // reset the window accounting: re-declaring must not launder
          // cost already counted against the ceiling.
          existing.subjects = unique;
          existing.ceilingCostPerWindow = Math.max(0, req.ceilingCostPerWindow);
        } else {
          state.declaredCohorts[req.cohortId] = {
            subjects: unique,
            ceilingCostPerWindow: Math.max(0, req.ceilingCostPerWindow),
            windowStartMs: now(),
            committedCost: 0,
            reservedCost: 0,
          };
        }
        syncOverrides(state);
        return { state, value: { registered: unique.length } };
      });
    },

    async setCohortPacing(req) {
      return mutate(state => {
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
    },

    async clearCohortPacing(cohortKey) {
      return mutate<{ cleared: boolean }>(state => {
        if (!state.cohortPacing[cohortKey]) return { state: null, value: { cleared: false } };
        delete state.cohortPacing[cohortKey];
        syncOverrides(state);
        return { state, value: { cleared: true } };
      });
    },

    setAllowanceOverride(subject, allowance) {
      overrideTouched.add(subject);
      if (allowance === null) overrideMap.delete(subject);
      else overrideMap.set(subject, Math.max(0, allowance));
    },

    clampActionStepDown(currentAllowance, targetAllowance, context) {
      return clampActionStepDown(currentAllowance, targetAllowance, {
        ...context,
        derivedSoftFloorCost: context.derivedSoftFloorCost ?? derivedSoftFloorCost,
      });
    },

    async snapshot() {
      return mutate<ActionBudgetSnapshot>(state => {
        const atMs = now();
        const view = cloneState(state);
        expireReservations(view, atMs);
        for (const subject of Object.keys(view.subjects)) ensureSubjectWindow(view, subject, atMs);
        for (const cohort of Object.values(view.declaredCohorts)) ensureCohortWindow(view, cohort, atMs);
        refillBucket(view.bucket, atMs);
        syncOverrides(view);
        let committedCost = 0;
        for (const window_ of Object.values(view.subjects)) committedCost += window_.committedCost;
        return {
          state: null,
          value: {
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
          },
        };
      });
    },
  };
}
