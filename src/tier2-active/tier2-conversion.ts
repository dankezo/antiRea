/**
 * Tier-2 conversion layer (antiRea 3.0, Item 1): C27 + C35
 * enforcement conversion - PERSISTENT, INDEPENDENTLY CORROBORATED
 * inferred evidence becomes a SOFT, FLOORED budget step-down;
 * direct decoy evidence becomes taint + step-up on first touch.
 *
 * BUILD REGISTRATION. farmgate-2026-11-16/
 * REGISTRATION-TIER2-CONVERSION.md (frozen 2026-11-16), parent
 * REGISTRATION-C27-C35-ENFORCEMENT.md (frozen 2026-11-04) with
 * Danny's locked decisions of 2026-11-04 12:11: 1A (identity-level
 * soft step-down), 2A (C35 first touch = taint + step_up,
 * self-disarm mandatory), 3B (NO API evidence pack in this
 * version), 4A (shadow first - done on the farm), 5A (alpha-wealth
 * fleet FP budget is a mandatory operational gate). This module is
 * the SDK port of the validated lab reference implementation
 * (c27c35-enf-lab/conversion.cjs, the per-identity recompute form,
 * plus the V-C split-clock taint variant
 * conversion-taint-vc.cjs); its tier law is that lab law, with the
 * build registration's closed-list additions (alpha-wealth gate,
 * host-declared strata, budget exposure) and nothing else.
 *
 * OPT-IN ENFORCEMENT, DEFAULT OBSERVE. Nothing in this module runs
 * until the host constructs an instance, and a constructed instance
 * still enforces NOTHING until the host passes `enabled: true`
 * (or calls `setEnabled(true)`): with enforcement off, flags and
 * touches are recorded as telemetry (evidence deltas accrue exactly
 * as the lab's disabled mode accrues them) and every tier stays 0.
 * There is no configuration in which this layer is on by default.
 *
 * EVIDENCE BASIS - read before trusting any tier this layer grants:
 * - C27 leg: FC-03R PREMISE-CONFIRMED on the farm's age-aligned
 *   statistic (ages 1-12): ordinary p95 R = 0.833, p99 R = 1.000,
 *   heavy 0 -> 0, PLUS the lab pin (harness-v2 scripted
 *   populations: VALID/SALE FP 0/1,200, plateaus flagged 100%).
 *   The shipped parameters derive from ages 1-12 + the lab pin.
 * - C35 leg: LAB-ONLY evidence. The farm has no decoy surface, so
 *   no C35 claim is upgraded by the farm gate: NAV FP 0/1,200 over
 *   ~1.11M requests and enumeration sensitivity 1.000 are lab
 *   (scripted-population) numbers, exactly as the decoy-tripwire
 *   header states them.
 * - NO THETA AGE 31-90 CLAIM. The parent registration's theta
 *   estimand speaks of observation days 31-90; the farm statistic
 *   that confirmed the saturation premise covers ages 1-12 and
 *   theta at ages 31-90 was never observed on the farm. This
 *   module makes no claim about that window.
 *
 * LIMITS - in the code, not just this header:
 * - SOFT ONLY, NEVER A HARD BLOCK. The highest consequence this
 *   layer can produce is tier 2, a budget step-down computed
 *   through `softBudgetStepDown` / `clampEnforcement` on an
 *   inferred-evidence context. Access continues at the stepped
 *   budget; there is no deny, no ceiling, no tier 3 from inferred
 *   or decoy evidence in any configuration (parent registration
 *   section 0).
 * - FLOORED AT 500. A stepped budget never goes below
 *   `SOFT_BUDGET_FLOOR_RECORDS` = 500 records / identity / 24h
 *   (decision 1A; the floor's derivation lives in
 *   enforcement-tiering.ts). A host base budget already below the
 *   floor is never raised and never cut further by this layer.
 * - SELF-DISARMING (decision 2A, V-C form, mandatory): tier 2
 *   expires after 30 days without a new flag; taint expires and
 *   the C35 ledger (distinct-decoy map + accrued delta + the
 *   identity's cohort-delta contribution) CLEARS 90 days after
 *   the identity's last touch, on the split touch clock (a C27
 *   flag does not extend a taint's life, and a touch does not
 *   extend a tier-2 flag clock). A population-level leak trigger
 *   (`disarmTriggered`) plus `disarm()` void the in-window C35
 *   consequences when the host's own decoy placement leaks.
 * - RETROACTIVE VOID (mandatory): `voidTouch` (and `disarm` /
 *   `rollbackEpoch`) remove EXACTLY the voided identity's delta
 *   contribution - per-identity cohort-delta accounting, never the
 *   whole cohort - recompute every tier from live evidence only,
 *   and append an attribution record for every tier change. Raw
 *   touch records are kept (marked voided) for host investigation.
 * - ALPHA-WEALTH GATE (decision 5A, mandatory): a fleet-level
 *   budget ledger across all enforcing detectors fed into this
 *   layer. Every tier-up spends one unit; on exhaustion the layer
 *   automatically falls back to observe-only (no NEW tier-ups;
 *   existing tiers and taints are untouched, evidence keeps
 *   accruing) until the window refills. Cap and window are host
 *   configuration; the ledger state is visible in the fleet
 *   snapshot.
 * - STRATA BY HOST DECLARATION ONLY. Strata enter through the
 *   config map (`identityStrata`) or the host classifier callback
 *   (`classifyStratum`), including a protected declaration (a
 *   stratum named in `protectedStrata`, the literal stratum
 *   `"protected"`, or `protectedIdentities`). Undeclared
 *   identities get the pooled conservative parameters. This module
 *   NEVER infers a stratum from traffic.
 * - PROTECTED IDENTITIES NEVER TIER FROM INFERRED EVIDENCE. A
 *   protected identity's C27 flag is telemetry only. The one
 *   shipped exception is kept: a protected identity's OWN decoy
 *   touch is direct evidence and still taints + step-ups (parent
 *   registration section 2.4; canary precedent) - but it can never
 *   reach tier 2 on inferred corroboration.
 * - GRACE. A passed step-up grants 24h of grace: step-up is
 *   suppressed while grace holds (flags/touches still record),
 *   the C27 persistence counter resets, and pre-pass C35 touches
 *   stop counting toward the repeat condition. Grace never shields
 *   a budget: it is read by the tier rules, never written back
 *   into budget state (parent registration section 2.3).
 * - ONE SIGNAL NEVER TIERS ALONE PAST STEP-UP. Tier 2 always
 *   requires persistence/repeat PLUS an INDEPENDENT corroborating
 *   channel: a different detector family's signal inside the
 *   corroboration window, the cohort union floor (150 distinct
 *   records), a live cross-signal (C35 taint corroborates C27;
 *   a C27 flag corroborates C35), a herd flag, or a CUSUM
 *   crossing. A same-family re-flag is persistence, never
 *   corroboration.
 *
 * CLOCK. Like the lab, this layer runs on a logical day counter
 * the host advances with `advanceDays` (the conversion law is
 * stated in days: grace 1, tier-2 expiry 30, taint/ledger 90,
 * corroboration window, alpha window). Event ORDER inside a day
 * is a monotonically increasing sequence number, never the day
 * counter, so same-day pass-vs-touch order is unambiguous.
 *
 * Pure computation: no I/O, no runtime dependencies. State is
 * in-memory maps bounded by `maxIdentities`.
 */

import {
  SOFT_BUDGET_FLOOR_RECORDS,
  clampEnforcement,
  softBudgetStepDown,
} from "./enforcement-tiering";

/* ------------------------------------------------------------------ */
/* Frozen constants (parent registration sections 3-4; policy         */
/* choices, not measured values - registration section 9).            */
/* ------------------------------------------------------------------ */

/** LLR contribution of one C27 flag in a new evidence epoch: ln(20). */
export const TIER2_DELTA_C27 = Math.log(20);
/** LLR contribution of the first distinct decoy touch: ln(50). */
export const TIER2_DELTA_C35_FIRST = Math.log(50);
/** LLR contribution of each further distinct decoy touch: ln(5). */
export const TIER2_DELTA_C35_REPEAT = Math.log(5);
/** Per-identity per-epoch cap on the C35 contribution: ln(500). */
export const TIER2_DELTA_C35_MAX = Math.log(500);
/** Full accumulator crossing boundary B = ln(1/alpha), alpha 1e-3: ln(1000). */
export const TIER2_BOUNDARY_B = Math.log(1000);
/** Cohort union floor: corroboration by cohort scale at >= 150 distinct records. */
export const TIER2_UNION_FLOOR = 150;
/** Identity scale floor: a C27 flag contributes only at >= 150 novel records (90d). */
export const TIER2_SCALE_FLOOR = 150;
/** LAUNCH age gate: identities younger than 60 days are never scored by C27. */
export const TIER2_LAUNCH_MIN_AGE_DAYS = 60;
/** Tier 2 expires after this many days without a new flag. */
export const TIER2_TIER2_EXPIRY_DAYS = 30;
/** Taint expires and the C35 ledger clears this many days after the last touch (V-C). */
export const TIER2_TAINT_EXPIRY_DAYS = 90;
/** Grace after a passed step-up, in days (24h in the lab's day-step model). */
export const TIER2_GRACE_DAYS = 1;

/** Tier 0 = observe, 1 = step_up, 2 = soft budget step-down. There is no tier 3. */
export type Tier2Tier = 0 | 1 | 2;

export interface Tier2ConversionOptions {
  /**
   * Enforcement switch (the kill switch, parent registration
   * section 5.2). Default false: OBSERVE ONLY - evidence accrues,
   * tiers stay 0. Pass true (or call `setEnabled(true)`) to opt in
   * to tier consequences. `setEnabled(false)` returns every tier
   * to 0 in one evaluation cycle; telemetry is kept.
   */
  enabled?: boolean;
  /**
   * The host's base record budget for an identity (records /
   * identity / 24h), used to report the lawful stepped budget in
   * snapshots. Default 2000. Per-call bases can be passed to
   * `effectiveBudget`. The step-down itself is always computed by
   * `softBudgetStepDown`, so the floor binds whatever base is used.
   */
  baseBudgetRecords?: number;
  /**
   * The budget a tier-2 identity is stepped down TOWARD, before
   * the soft floor clamps it. Default 500 (= the floor): a tier-2
   * identity lands exactly on the floor. A target below the floor
   * still lands on the floor for inferred evidence.
   */
  stepDownTargetRecords?: number;
  /**
   * Alpha-wealth fleet budget (decision 5A): the maximum number of
   * tier-ups this layer may grant inside one alpha window, across
   * ALL enforcing detectors feeding it. Default 100. On exhaustion
   * the layer falls back to observe-only for new tier-ups until
   * the window refills. This is an operational FP budget, not a
   * measured constant.
   */
  alphaCap?: number;
  /** Alpha-wealth window length in (logical) days. Default 30. */
  alphaWindowDays?: number;
  /**
   * Corroboration window in days: an independent family's signal
   * corroborates only while it is at most this old. Default 90
   * (the evidence-epoch length).
   */
  corroborationWindowDays?: number;
  /**
   * Host-declared strata: identity -> stratum name (plain object
   * or Map, copied at construction). A stratum listed in
   * `protectedStrata` - or the literal name `"protected"` -
   * declares the identity protected.
   */
  identityStrata?: Record<string, string> | Map<string, string>;
  /**
   * Host classifier callback: identity -> stratum name, or
   * null/undefined for undeclared. Consulted only when the config
   * map has no entry. A throwing callback is treated as
   * "undeclared" (herd-detector callback discipline). NEVER fed
   * traffic features by this module - the host decides what it
   * reads; this layer only asks it for a declaration.
   */
  classifyStratum?: (identity: string) => string | null | undefined;
  /** Stratum names the host declares protected. `"protected"` is always one. */
  protectedStrata?: Iterable<string>;
  /** Identities the host declares protected outright. */
  protectedIdentities?: Iterable<string>;
  /** Cap on identities tracked at once (least-recently-touched evicted). Default 10,000. */
  maxIdentities?: number;
}

export interface Tier2C27FlagOptions {
  /** Evidence epoch (the identity's sliding 90-day window id). One delta per epoch. */
  epoch: number | string;
  /** The identity's total novel records over days 1-90 (scale floor input). */
  novel90?: number;
  /** The identity's age in days (LAUNCH gate input). */
  ageDays?: number;
  /** Per-event protected declaration (merged with host-declared strata). */
  protected?: boolean;
  /** Verified-lane identities are filtered before accrual of a C27 delta. */
  verifiedLane?: boolean;
  /** Script/host-fed cohort union size (distinct records) at flag time. */
  cohortUnion?: number;
  /** Host assertion that an independent signal is live on this identity/cohort. */
  otherSignal?: boolean;
  /** Recorded-only CUSUM field (never enters the tier rule; see the lab's C9 note). */
  cusumFlag?: boolean;
  /**
   * The detector family that independently corroborates THIS flag,
   * when the host feeds corroboration inline. A family equal to
   * the C27 family (`"c27"` / `"shrink_slope"`) is ignored: a
   * same-family re-flag never corroborates.
   */
  corroboratingFamily?: string;
}

export interface Tier2C35TouchOptions {
  /** The declared decoy the identity touched. */
  decoy: number | string;
  protected?: boolean;
  verifiedLane?: boolean;
  cohortUnion?: number;
  otherSignal?: boolean;
  cusumFlag?: boolean;
  /** Inline independent corroboration family (same rule as on C27 flags). */
  corroboratingFamily?: string;
}

export interface Tier2CorroborationInput {
  /** Detector family of the corroborating signal, e.g. "cusum", "herd", "c35", "action_cohort". */
  family: string;
}

export interface Tier2FlagResult {
  identity: string;
  /** Lab-compatible alias of `identity`. */
  id: string;
  tier: Tier2Tier;
  /** C27 delta accrued by this call (0 when telemetry-only or a repeat epoch). */
  d27: number;
  telemetryOnly: boolean;
  /** Named reason (see the reason vocabulary in the factory docs). */
  reason: string;
  stratum: string | null;
  /** Lawful budget for this identity after the call, against the configured base. */
  effectiveBudgetRecords: number;
}

export interface Tier2TouchResult {
  identity: string;
  id: string;
  tier: Tier2Tier;
  taint: boolean;
  /** C35 delta accrued by this call (cap-adjusted; 0 for a repeat decoy). */
  d35: number;
  telemetryOnly: boolean;
  reason: string;
  stratum: string | null;
  effectiveBudgetRecords: number;
}

export interface Tier2IdentitySnapshot {
  identity: string;
  tier: Tier2Tier;
  /** The consequence vocabulary of the tier: observe / step_up / budget_step_down. Never harder. */
  enforcement: "observe" | "step_up" | "budget_step_down";
  taint: boolean;
  /** Live C27 persistence counter (flags since the last passed step-up). */
  c27Flags: number;
  /** Live (non-voided) distinct decoys touched. */
  c35Distinct: number;
  /** Live accrued C35 delta this epoch. */
  c35Delta: number;
  /** Live (non-voided) touch records. */
  c35Touches: number;
  c35TierInWindow: boolean;
  lastPassSeq: number;
  lastTouchSeq: number;
  graceUntilDay: number;
  graceActive: boolean;
  protected: boolean;
  /** Host-declared stratum, or null when undeclared (pooled parameters). */
  stratum: string | null;
  baseBudgetRecords: number;
  /** Lawful stepped budget against the configured base (never below 500 at tier 2 when the base is). */
  effectiveBudgetRecords: number;
  /** Independent families with a live in-window corroboration on this identity. */
  corroboratingFamilies: string[];
}

export interface Tier2AlphaState {
  cap: number;
  windowDays: number;
  /** Tier-ups spent in the current window. */
  spent: number;
  remaining: number;
  exhausted: boolean;
  windowStartDay: number;
  currentDay: number;
}

export interface Tier2FleetSnapshot {
  day: number;
  enabled: boolean;
  c35Advisory: boolean;
  identitiesTracked: number;
  telemetry: Tier2Telemetry;
  alpha: Tier2AlphaState;
  cohortDeltaTotal: number;
  unionLiveSize: number;
  attributionRecords: number;
}

export interface Tier2Telemetry {
  tierUp: number;
  tierDown: number;
  disarms: number;
  voids: number;
  d27: number;
  d35: number;
  advisoryTouches: number;
  alphaBlocks: number;
}

/** One attribution record (parent registration section 5.1): a tier change caused by a void. */
export interface Tier2AttributionRecord {
  id: string;
  tierBefore: Tier2Tier;
  tierAfter: Tier2Tier;
  reason: string;
  voidedDecoys: (number | string)[];
  voidedDecoyCount: number;
  voidedDelta35: number;
  liveCorroboration: string[];
  graceActive: boolean;
  graceUntilDay: number;
  protected: boolean;
  day: number;
  voidedEpoch?: number | string;
}

export interface Tier2VoidResult {
  identity: string;
  decoy: number | string;
  /** Touch records voided by this call. */
  voided: number;
  /** Exactly the delta those touches had accrued (the identity's own contribution). */
  voidedDelta: number;
  /** The identity's tier after recomputation from live evidence. */
  tier: Tier2Tier;
}

export interface Tier2Conversion {
  /** Ingest one C27 (shrink-slope) flag. Alias: `ingestC27Flag`. */
  c27Flag(identity: string, opts: Tier2C27FlagOptions): Tier2FlagResult;
  ingestC27Flag(identity: string, opts: Tier2C27FlagOptions): Tier2FlagResult;
  /** Record a clean late window for an identity (two consecutive cool it to tier 0). */
  c27CleanWindow(identity: string): { tier: Tier2Tier; cleanWindows: number };
  /** Ingest one C35 decoy touch. Aliases: `recordDecoyTouch`, `ingestDecoyTouch`. */
  c35Touch(identity: string, opts: Tier2C35TouchOptions): Tier2TouchResult;
  recordDecoyTouch(identity: string, opts: Tier2C35TouchOptions): Tier2TouchResult;
  ingestDecoyTouch(identity: string, opts: Tier2C35TouchOptions): Tier2TouchResult;
  /**
   * Register an INDEPENDENT detector family's signal on an identity
   * as corroboration (inside the corroboration window). Registering
   * the C27 family corroborates a later C35 evaluation and vice
   * versa; registering a family never corroborates its own family's
   * tier-2 rule.
   */
  recordCorroboration(identity: string, input: Tier2CorroborationInput): { identity: string; family: string; corroboratingFamilies: string[] };
  /** The identity passed a step-up challenge: 24h grace, C27 persistence reset. */
  passStepUp(identity: string): { tier: Tier2Tier; graceUntilDay: number };
  /** Retroactive void of one identity's touch(es) of one decoy (decision 2A). */
  voidTouch(identity: string, decoy: number | string): Tier2VoidResult;
  /** Population disarm: void in-window (24h) C35 consequences, recompute, go advisory. */
  disarm(): { voided: number; c35Advisory: boolean };
  /** Host-only re-arm after a disarm. Does NOT restore voided taint/tier. */
  rearmC35(): { c35Advisory: boolean };
  isC35Advisory(): boolean;
  /** The frozen population trigger for a disarm (registration section 4.4.2). */
  disarmTriggered(stats: { activeIdentities: number; touchedIdentities: number; maxDistinctPerDecoy: number }): boolean;
  /** Kill switch (section 5.2): disabling returns every tier to 0; telemetry is kept. */
  setEnabled(v: boolean): { enabled: boolean };
  /** Void every tier granted on flags of one epoch, with symmetric recompute (section 5.3). */
  rollbackEpoch(epoch: number | string): { voided: number };
  /** Advance the logical day counter; expiries and the alpha refill are evaluated here. */
  advanceDays(n: number): { day: number };
  /** Per-identity snapshot (lab-compatible shape, extended), or null for an unknown identity. */
  snapshot(identity: string): Tier2IdentitySnapshot | null;
  /** Fleet snapshot when called with no identity. */
  snapshot(): Tier2FleetSnapshot;
  /** The lawful budget for an identity against a base (defaults to the configured base). */
  effectiveBudget(identity: string, baseBudgetRecords?: number): number;
  /** Live cohort accounting: total live C35 delta and live distinct-decoy union size. */
  cohortState(): { cohortDeltaTotal: number; unionLiveSize: number };
  /** Feed the herd-flag producer's flagged set (corroboration channel; never voided by disarm). */
  setHerdFlagged(ids: Iterable<string>): { herdFlagged: number };
  /** Feed the CUSUM-crossing producer's flagged set (corroboration channel; never voided by disarm). */
  setCusumFlagged(ids: Iterable<string>): { cusumFlagged: number };
  setProducerState(input: "cohortUnion" | "otherSignal" | "cusum" | "herdFlag", state: "not_wired" | "wired"): { input: string; state: string };
  getProducerState(): Record<string, string>;
  readonly telemetry: Tier2Telemetry;
  readonly attributionLog: Tier2AttributionRecord[];
  readonly advisoryLog: { seq: number; day: number; decoy: number | string }[];
  readonly constants: {
    D27: number; D35_1: number; D35_R: number; D35_MAX: number;
    BOUNDARY_B: number; UNION_FLOOR: number; SCALE_FLOOR: number;
    SOFT_BUDGET_FLOOR_RECORDS: number;
  };
}

/** Named error thrown for every invalid tier-2 conversion input. */
export class Tier2ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Tier2ConversionError";
  }
}

const fail = (message: string): never => {
  throw new Tier2ConversionError(`createTier2Conversion: ${message}`);
};

function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value as string;
}

function requireIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

/** Detector-family normalization: families compare case-insensitively, whitespace-trimmed. */
function normFamily(family: string): string {
  return family.trim().toLowerCase();
}
const C27_FAMILIES = new Set(["c27", "shrink_slope", "shrink-slope", "shrinkslope"]);
const C35_FAMILIES = new Set(["c35", "decoy_tripwire", "decoy-tripwire", "decoytripwire", "canary", "canary_echo"]);

interface TouchRecord {
  seq: number;
  day: number;
  decoy: number | string;
  d35: number;
  evalSeq: number | null;
  tainted: boolean;
  voided: boolean;
}

interface IdentityState {
  tier: Tier2Tier;
  taint: boolean;
  c27Epochs: Set<string>;
  c27Flags: { epoch: number | string; seq: number }[];
  c27CleanWindows: number;
  lastPassSeq: number;
  lastTouchSeq: number;
  c35Decoys: Map<string, { decoy: number | string; seq: number }>;
  c35Delta: number;
  c35Touches: TouchRecord[];
  graceUntilDay: number;
  protectedFlag: boolean;
  verifiedLane: boolean;
  tier2Day: number;
  lastFlagDay: number;
  /** V-C split clock: day of the most recent touch ON THE EVALUATION PATH. */
  lastTouchDay: number;
  c35TierInWindow: boolean;
  cohortUnion: number;
  otherSignal: boolean;
  cusumFlag: boolean;
  stratum: string | null;
  corroborations: { family: string; day: number; seq: number }[];
}

export function createTier2Conversion(
  options: Tier2ConversionOptions = {},
): Tier2Conversion {
  if (typeof options !== "object" || options === null) fail("options must be an object");

  let enabled = options.enabled === true;
  const baseBudgetRecords = requireIntInRange(options.baseBudgetRecords ?? 2000, "baseBudgetRecords", 1, 10_000_000);
  const stepDownTargetRecords = requireIntInRange(options.stepDownTargetRecords ?? SOFT_BUDGET_FLOOR_RECORDS, "stepDownTargetRecords", 0, 10_000_000);
  const alphaCap = requireIntInRange(options.alphaCap ?? 100, "alphaCap", 1, 1_000_000);
  const alphaWindowDays = requireIntInRange(options.alphaWindowDays ?? 30, "alphaWindowDays", 1, 3650);
  const corroborationWindowDays = requireIntInRange(options.corroborationWindowDays ?? 90, "corroborationWindowDays", 1, 3650);
  const maxIdentities = requireIntInRange(options.maxIdentities ?? 10_000, "maxIdentities", 1, 1_000_000);

  const strataMap = new Map<string, string>();
  if (options.identityStrata !== undefined) {
    const entries = options.identityStrata instanceof Map
      ? [...options.identityStrata.entries()]
      : Object.entries(options.identityStrata);
    for (const [id, stratum] of entries) {
      requireIdentity(id, "identityStrata key");
      if (typeof stratum !== "string" || stratum.trim().length === 0) {
        fail("identityStrata values must be non-empty strings");
      }
      strataMap.set(id, stratum);
    }
  }
  const classifyStratum = options.classifyStratum;
  if (classifyStratum !== undefined && typeof classifyStratum !== "function") {
    fail("classifyStratum must be a function");
  }
  const protectedStrata = new Set<string>(["protected"]);
  if (options.protectedStrata !== undefined) {
    for (const s of options.protectedStrata) {
      if (typeof s !== "string" || s.trim().length === 0) fail("protectedStrata entries must be non-empty strings");
      protectedStrata.add(s);
    }
  }
  const protectedIdentities = new Set<string>();
  if (options.protectedIdentities !== undefined) {
    for (const id of options.protectedIdentities) protectedIdentities.add(requireIdentity(id, "protectedIdentities entry"));
  }

  const ids = new Map<string, IdentityState>();
  const telemetry: Tier2Telemetry = { tierUp: 0, tierDown: 0, disarms: 0, voids: 0, d27: 0, d35: 0, advisoryTouches: 0, alphaBlocks: 0 };
  const cohortDeltaById = new Map<string, number>();
  let cohortDeltaTotal = 0;
  const attributionLog: Tier2AttributionRecord[] = [];
  const advisoryLog: { seq: number; day: number; decoy: number | string }[] = [];
  const producerState: Record<string, string> = { cohortUnion: "not_wired", otherSignal: "not_wired", cusum: "not_wired", herdFlag: "not_wired" };
  let herdFlaggedIds = new Set<string>();
  let cusumFlaggedIds = new Set<string>();
  let c35Advisory = false;
  let day = 0;
  let seq = 0;
  let alphaSpent = 0;
  let alphaWindowStartDay = 0;

  function resolveDeclaration(identity: string): { stratum: string | null; declaredProtected: boolean } {
    if (protectedIdentities.has(identity)) return { stratum: "protected", declaredProtected: true };
    let stratum = strataMap.get(identity) ?? null;
    if (stratum === null && classifyStratum) {
      try {
        const classified = classifyStratum(identity);
        stratum = typeof classified === "string" && classified.trim().length > 0 ? classified : null;
      } catch {
        stratum = null; // A throwing host classifier declares nothing for this identity.
      }
    }
    return { stratum, declaredProtected: stratum !== null && protectedStrata.has(stratum) };
  }

  function st(identity: string): IdentityState {
    const existing = ids.get(identity);
    if (existing) {
      // Refresh the host declaration on every touch of the identity:
      // a host that declares a stratum mid-flight (e.g. enrols an
      // identity into the protected registry) takes effect at the
      // next event, per parent registration section 3.3 (host
      // declaration removes inferred tiers - applied at recompute
      // and at the next flag evaluation).
      const decl = resolveDeclaration(identity);
      existing.stratum = decl.stratum;
      if (decl.declaredProtected) existing.protectedFlag = true;
      ids.delete(identity);
      ids.set(identity, existing);
      return existing;
    }
    if (ids.size >= maxIdentities) {
      const oldest = ids.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        const evicted = ids.get(oldest);
        if (evicted && evicted.c35Delta !== 0) {
          cohortDeltaTotal -= evicted.c35Delta;
          cohortDeltaById.delete(oldest);
        }
        ids.delete(oldest);
      }
    }
    const decl = resolveDeclaration(identity);
    const fresh: IdentityState = {
      tier: 0, taint: false,
      c27Epochs: new Set<string>(),
      c27Flags: [],
      c27CleanWindows: 0,
      lastPassSeq: -1,
      lastTouchSeq: -1,
      c35Decoys: new Map(),
      c35Delta: 0,
      c35Touches: [],
      graceUntilDay: -1,
      protectedFlag: decl.declaredProtected,
      verifiedLane: false,
      tier2Day: -1, lastFlagDay: -1, lastTouchDay: -1,
      c35TierInWindow: false,
      cohortUnion: 0, otherSignal: false,
      cusumFlag: false,
      stratum: decl.stratum,
      corroborations: [],
    };
    ids.set(identity, fresh);
    return fresh;
  }

  function setTierRaw(s: IdentityState, next: Tier2Tier): void {
    if (s.tier !== next) {
      if (next > s.tier) telemetry.tierUp++;
      else telemetry.tierDown++;
      s.tier = next;
    }
  }

  function alphaRefillIfDue(): void {
    if (day - alphaWindowStartDay >= alphaWindowDays) {
      alphaSpent = 0;
      alphaWindowStartDay = day;
    }
  }

  function alphaState(): Tier2AlphaState {
    alphaRefillIfDue();
    return {
      cap: alphaCap, windowDays: alphaWindowDays,
      spent: alphaSpent, remaining: Math.max(0, alphaCap - alphaSpent),
      exhausted: alphaSpent >= alphaCap,
      windowStartDay: alphaWindowStartDay, currentDay: day,
    };
  }

  /**
   * The ONLY path to a higher tier. Enforces, in order: the kill
   * switch (observe-only when disabled) and the alpha-wealth gate
   * (observe-only for new tier-ups when the fleet budget is spent).
   * Returns false when the tier-up was refused; the caller keeps
   * its evidence and reports the named block reason.
   */
  function tryTierUp(s: IdentityState, next: Tier2Tier): "ok" | "disabled" | "alpha_exhausted" {
    if (next <= s.tier) return "ok";
    if (!enabled) return "disabled";
    alphaRefillIfDue();
    if (alphaSpent >= alphaCap) {
      telemetry.alphaBlocks++;
      return "alpha_exhausted";
    }
    alphaSpent++;
    setTierRaw(s, next);
    if (next === 2) s.tier2Day = day;
    return "ok";
  }

  function graceActive(s: IdentityState): boolean {
    return day < s.graceUntilDay;
  }

  function isProtected(s: IdentityState): boolean {
    return s.protectedFlag;
  }

  function liveCorroboratingFamilies(s: IdentityState, identity: string): string[] {
    const out = new Set<string>();
    for (const c of s.corroborations) {
      if (day - c.day <= corroborationWindowDays) out.add(c.family);
    }
    if (herdFlaggedIds.has(identity)) out.add("herd");
    if (cusumFlaggedIds.has(identity)) out.add("cusum");
    return [...out];
  }

  /**
   * Independent corroboration for `family`'s tier-2 rule. Sources:
   * the cohort union floor, the host's other-signal assertion, a
   * recorded different-family signal inside the window, and the
   * live cross-signal (taint for C27; a live C27 flag for C35).
   * Same-family records are filtered by construction.
   */
  function hasIndependentCorroboration(s: IdentityState, identity: string, family: "c27" | "c35"): boolean {
    if (s.cohortUnion >= TIER2_UNION_FLOOR) return true;
    if (s.otherSignal) return true;
    const own = family === "c27" ? C27_FAMILIES : C35_FAMILIES;
    for (const fam of liveCorroboratingFamilies(s, identity)) {
      if (!own.has(fam)) return true;
    }
    if (family === "c27" && s.taint) return true; // live C35 taint corroborates C27
    if (family === "c35" && s.c27Flags.length > 0) return true; // a live C27 flag corroborates C35
    return false;
  }

  function recordInlineCorroboration(s: IdentityState, familyRaw: string | undefined): void {
    if (familyRaw === undefined) return;
    if (typeof familyRaw !== "string" || familyRaw.trim().length === 0) {
      fail("corroboratingFamily must be a non-empty string");
    }
    s.corroborations.push({ family: normFamily(familyRaw), day, seq });
  }

  function budgetFor(s: IdentityState, base: number): number {
    if (s.tier < 2) return base;
    // Tier 2 is the ONLY budget this layer moves, and it moves it
    // exclusively through the tiering law's own clamp: inferred
    // context, tripwire-gated, floored at 500, never a hard block.
    const clamp = clampEnforcement("budget_step_down", {
      origin: "inferred", calibrationTier: "audit_only", tripwireGated: true,
    });
    if (clamp.action !== "budget_step_down") return base;
    return softBudgetStepDown(base, stepDownTargetRecords, {
      origin: "inferred", calibrationTier: "audit_only", tripwireGated: true,
    }).limit;
  }

  function effectiveBudget(identityRaw: string, baseOverride?: number): number {
    const identity = requireIdentity(identityRaw, "identity");
    const base = baseOverride === undefined
      ? baseBudgetRecords
      : requireIntInRange(baseOverride, "baseBudgetRecords", 1, 10_000_000);
    const s = ids.get(identity);
    if (!s) return base;
    return budgetFor(s, base);
  }

  /* ------------------------- C27 ------------------------- */

  function c27Flag(identityRaw: string, o: Tier2C27FlagOptions): Tier2FlagResult {
    const identity = requireIdentity(identityRaw, "identity");
    if (typeof o !== "object" || o === null) fail("c27Flag options must be an object");
    if (o.epoch === undefined || o.epoch === null || (typeof o.epoch !== "number" && typeof o.epoch !== "string")) {
      fail("c27Flag epoch must be a number or string");
    }
    const s = st(identity);
    seq++;
    if (o.protected !== undefined) s.protectedFlag = o.protected;
    if (o.verifiedLane !== undefined) s.verifiedLane = o.verifiedLane;
    if (o.cohortUnion !== undefined) s.cohortUnion = o.cohortUnion;
    if (o.otherSignal !== undefined) s.otherSignal = o.otherSignal;
    if (o.cusumFlag !== undefined) s.cusumFlag = o.cusumFlag;
    recordInlineCorroboration(s, o.corroboratingFamily);
    const out: Tier2FlagResult = {
      identity, id: identity, tier: s.tier, d27: 0, telemetryOnly: false,
      reason: "", stratum: s.stratum, effectiveBudgetRecords: budgetFor(s, baseBudgetRecords),
    };
    const done = (): Tier2FlagResult => {
      out.tier = s.tier;
      out.effectiveBudgetRecords = budgetFor(s, baseBudgetRecords);
      return out;
    };
    if (o.ageDays !== undefined && o.ageDays < TIER2_LAUNCH_MIN_AGE_DAYS) {
      out.telemetryOnly = true; out.reason = "LAUNCH-age<60: never scored";
      return done();
    }
    if (o.novel90 !== undefined && o.novel90 < TIER2_SCALE_FLOOR) {
      out.telemetryOnly = true; out.reason = "sub-scale: novel90<150";
      return done();
    }
    s.lastFlagDay = day;
    s.c27CleanWindows = 0;
    const epochKey = String(o.epoch);
    const firstInEpoch = !s.c27Epochs.has(epochKey);
    if (firstInEpoch) {
      s.c27Epochs.add(epochKey);
      s.c27Flags.push({ epoch: o.epoch, seq });
      if (!isProtected(s) && !s.verifiedLane) {
        out.d27 = TIER2_DELTA_C27;
        telemetry.d27 += TIER2_DELTA_C27;
      }
    }
    if (!enabled) { out.reason = "conversion disabled: observe only"; return done(); }
    if (isProtected(s)) { out.reason = "protected: inferred evidence never tiers"; return done(); }
    if (graceActive(s)) { out.reason = "grace suppresses step-up"; return done(); }
    const up1 = tryTierUp(s, 1);
    if (up1 === "alpha_exhausted") { out.reason = "alpha-wealth exhausted: observe-only fallback"; return done(); }
    const firstFlag = s.c27Flags[0];
    const passedSinceFirst = firstFlag !== undefined && s.lastPassSeq > firstFlag.seq;
    const persistent = s.c27Flags.length >= 2;
    const corroborated = hasIndependentCorroboration(s, identity, "c27");
    if (persistent && !passedSinceFirst && corroborated) {
      const up2 = tryTierUp(s, 2);
      out.reason = up2 === "alpha_exhausted"
        ? "alpha-wealth exhausted: observe-only fallback"
        : "tier2: persistent + corroborated";
    } else {
      out.reason = persistent
        ? (passedSinceFirst ? "tier1: self-resolved since first flag" : "tier1: no corroboration")
        : "tier1: single flag";
    }
    return done();
  }

  function c27CleanWindow(identityRaw: string): { tier: Tier2Tier; cleanWindows: number } {
    const identity = requireIdentity(identityRaw, "identity");
    const s = st(identity);
    seq++;
    s.c27CleanWindows++;
    if (s.c27CleanWindows >= 2 && s.tier > 0) setTierRaw(s, 0);
    return { tier: s.tier, cleanWindows: s.c27CleanWindows };
  }

  /* ------------------------- C35 ------------------------- */

  function c35Touch(identityRaw: string, o: Tier2C35TouchOptions): Tier2TouchResult {
    const identity = requireIdentity(identityRaw, "identity");
    if (typeof o !== "object" || o === null) fail("c35Touch options must be an object");
    if ((typeof o.decoy !== "number" || !Number.isFinite(o.decoy)) && (typeof o.decoy !== "string" || o.decoy.length === 0)) {
      fail("c35Touch decoy must be a finite number or a non-empty string");
    }
    const s = st(identity);
    seq++;
    if (o.protected !== undefined) s.protectedFlag = o.protected;
    if (o.verifiedLane !== undefined) s.verifiedLane = o.verifiedLane;
    if (o.cohortUnion !== undefined) s.cohortUnion = o.cohortUnion;
    if (o.otherSignal !== undefined) s.otherSignal = o.otherSignal;
    if (o.cusumFlag !== undefined) s.cusumFlag = o.cusumFlag;
    recordInlineCorroboration(s, o.corroboratingFamily);
    const out: Tier2TouchResult = {
      identity, id: identity, tier: s.tier, taint: s.taint, d35: 0, telemetryOnly: false,
      reason: "", stratum: s.stratum, effectiveBudgetRecords: budgetFor(s, baseBudgetRecords),
    };
    const done = (): Tier2TouchResult => {
      out.tier = s.tier;
      out.taint = s.taint;
      out.effectiveBudgetRecords = budgetFor(s, baseBudgetRecords);
      return out;
    };
    if (s.verifiedLane) {
      out.telemetryOnly = true; out.reason = "verified lane: filtered pre-layer";
      return done();
    }
    if (c35Advisory) {
      advisoryLog.push({ seq, day, decoy: o.decoy });
      telemetry.advisoryTouches++;
      out.telemetryOnly = true;
      out.reason = "c35 advisory: raw evidence only";
      return done();
    }
    const decoyKey = String(o.decoy);
    const isNew = !s.c35Decoys.has(decoyKey);
    const touchRec: TouchRecord = { seq, day, decoy: o.decoy, d35: 0, evalSeq: null, tainted: false, voided: false };
    s.c35Touches.push(touchRec);
    if (isNew) {
      s.c35Decoys.set(decoyKey, { decoy: o.decoy, seq });
      s.lastFlagDay = day;
      const prev = s.c35Decoys.size - 1;
      const add = prev === 0 ? TIER2_DELTA_C35_FIRST : TIER2_DELTA_C35_REPEAT;
      const capped = Math.min(TIER2_DELTA_C35_MAX, s.c35Delta + add);
      out.d35 = capped - s.c35Delta;
      s.c35Delta = capped;
      telemetry.d35 += out.d35;
      s.c35TierInWindow = true;
      touchRec.d35 = out.d35;
      if (out.d35 !== 0) {
        cohortDeltaById.set(identity, (cohortDeltaById.get(identity) ?? 0) + out.d35);
        cohortDeltaTotal += out.d35;
      }
    }
    if (!enabled) { out.reason = "conversion disabled: observe only"; return done(); }
    // First touch: taint + step-up eligibility (direct evidence).
    // A protected identity's OWN touch still taints (shipped exception).
    s.taint = true;
    touchRec.tainted = true;
    if (graceActive(s)) { out.reason = "grace suppresses step-up; taint kept"; return done(); }
    // Variant-A write point (lab-pinned): lastTouchSeq / the V-C
    // touch clock are written ONLY here, on the tier-evaluation
    // path - after the advisory / disabled / grace returns above.
    s.lastTouchSeq = seq;
    s.lastTouchDay = day;
    touchRec.evalSeq = seq;
    const up1 = tryTierUp(s, 1);
    if (up1 === "alpha_exhausted") { out.reason = "alpha-wealth exhausted: observe-only fallback"; return done(); }
    const distinct = s.c35Decoys.size;
    const touchedAfterPass = s.lastPassSeq >= 0 && s.lastTouchSeq > s.lastPassSeq;
    const repeatOk = distinct >= 3 || touchedAfterPass;
    const selfResolved = s.lastPassSeq >= 0 && s.lastTouchSeq <= s.lastPassSeq;
    // Tier 2 from C35 additionally requires the identity NOT be
    // protected: protected tier-2 would rest on inferred
    // corroboration, which protected identities never tier from.
    const corroborated = hasIndependentCorroboration(s, identity, "c35");
    if (repeatOk && !selfResolved && corroborated && !isProtected(s)) {
      const up2 = tryTierUp(s, 2);
      out.reason = up2 === "alpha_exhausted"
        ? "alpha-wealth exhausted: observe-only fallback"
        : "tier2: repeat + corroborated";
    } else {
      out.reason = "tier1: first touch / no repeat / no corroboration";
    }
    return done();
  }

  function passStepUp(identityRaw: string): { tier: Tier2Tier; graceUntilDay: number } {
    const identity = requireIdentity(identityRaw, "identity");
    const s = st(identity);
    seq++;
    s.lastPassSeq = seq;
    s.graceUntilDay = day + TIER2_GRACE_DAYS;
    s.c27Flags = [];
    if (s.tier === 1) setTierRaw(s, 0);
    return { tier: s.tier, graceUntilDay: s.graceUntilDay };
  }

  function recordCorroboration(
    identityRaw: string,
    input: Tier2CorroborationInput,
  ): { identity: string; family: string; corroboratingFamilies: string[] } {
    const identity = requireIdentity(identityRaw, "identity");
    if (typeof input !== "object" || input === null || typeof input.family !== "string" || input.family.trim().length === 0) {
      fail("recordCorroboration family must be a non-empty string");
    }
    const s = st(identity);
    seq++;
    const family = normFamily(input.family);
    s.corroborations.push({ family, day, seq });
    return { identity, family, corroboratingFamilies: liveCorroboratingFamilies(s, identity) };
  }

  /* ----------------- recompute / void machinery ----------------- */

  function liveUnionSize(): number {
    const u = new Set<string>();
    for (const s of ids.values()) for (const k of s.c35Decoys.keys()) u.add(k);
    return u.size;
  }

  function recomputeTier(
    s: IdentityState,
    identity: string,
    unionLive: number,
    c27Dead: boolean,
  ): { c27Tier: Tier2Tier; c35Tier: Tier2Tier; tier: Tier2Tier; liveTaint: boolean; distinctLive: number } {
    const liveTouches = s.c35Touches.filter((t) => !t.voided);
    const taintClock = s.lastTouchDay >= 0 ? s.lastTouchDay : s.lastFlagDay;
    const liveTaint = liveTouches.some((t) => t.tainted) && !(day - taintClock > TIER2_TAINT_EXPIRY_DAYS);
    const distinctLive = new Set(liveTouches.map((t) => String(t.decoy))).size;
    let latestLiveEvalSeq = -1;
    for (const t of liveTouches) if (t.evalSeq !== null && t.evalSeq > latestLiveEvalSeq) latestLiveEvalSeq = t.evalSeq;
    let c27Tier: Tier2Tier = 0;
    if (!c27Dead && s.c27Flags.length > 0 && s.c27CleanWindows < 2 && !isProtected(s) && !graceActive(s) && enabled) {
      const firstFlag = s.c27Flags[0];
      const passedSinceFirst = firstFlag !== undefined && s.lastPassSeq > firstFlag.seq;
      const persistent = s.c27Flags.length >= 2;
      const corrob = unionLive >= TIER2_UNION_FLOOR || liveTaint || herdFlaggedIds.has(identity) || cusumFlaggedIds.has(identity)
        || liveCorroboratingFamilies(s, identity).some((f) => !C27_FAMILIES.has(f));
      if (persistent && !passedSinceFirst && corrob) {
        c27Tier = day - s.lastFlagDay > TIER2_TIER2_EXPIRY_DAYS ? 1 : 2;
      } else {
        c27Tier = 1;
      }
    }
    let c35Tier: Tier2Tier = 0;
    if (liveTouches.length > 0 && !graceActive(s) && enabled) {
      const touchedAfterPass = s.lastPassSeq >= 0 && latestLiveEvalSeq > s.lastPassSeq;
      const selfResolved = s.lastPassSeq >= 0 && latestLiveEvalSeq >= 0 && latestLiveEvalSeq <= s.lastPassSeq;
      const repeatOk = distinctLive >= 3 || touchedAfterPass;
      const corrob = unionLive >= TIER2_UNION_FLOOR || c27Tier >= 1
        || liveCorroboratingFamilies(s, identity).some((f) => !C35_FAMILIES.has(f));
      if (repeatOk && !selfResolved && corrob && !isProtected(s)) c35Tier = 2;
      else c35Tier = 1;
    }
    return { c27Tier, c35Tier, tier: Math.max(c27Tier, c35Tier) as Tier2Tier, liveTaint, distinctLive };
  }

  function recomputeAll(reason: string, perIdVoid: Map<string, { voidedDecoys: (number | string)[]; voidedDelta: number }>, voidedEpoch?: number | string): void {
    const unionLive = liveUnionSize();
    for (const [identity, s] of ids) {
      const before = s.tier;
      const c27Dead = voidedEpoch !== undefined && perIdVoid.has(identity) && reason === "C27-epoch-void";
      const rec = recomputeTier(s, identity, unionLive, c27Dead);
      const next = reason === "C27-epoch-void" && c27Dead ? rec.c35Tier : rec.tier;
      if (next !== before) {
        setTierRaw(s, next);
        const v = perIdVoid.get(identity) ?? { voidedDecoys: [], voidedDelta: 0 };
        const channels: string[] = [];
        if (unionLive >= TIER2_UNION_FLOOR) channels.push("cohort-union");
        if (rec.liveTaint) channels.push("c35-taint-live");
        if (rec.c27Tier >= 1) channels.push("c27-tier");
        if (herdFlaggedIds.has(identity)) channels.push("herd-flag-live");
        if (cusumFlaggedIds.has(identity)) channels.push("cusum-crossing-live");
        attributionLog.push({
          id: identity, tierBefore: before, tierAfter: next,
          reason,
          voidedDecoys: v.voidedDecoys, voidedDecoyCount: v.voidedDecoys.length,
          voidedDelta35: v.voidedDelta,
          liveCorroboration: channels.length ? channels : ["none"],
          graceActive: graceActive(s), graceUntilDay: s.graceUntilDay,
          protected: isProtected(s), day,
          ...(voidedEpoch !== undefined ? { voidedEpoch } : {}),
        });
      }
    }
  }

  function voidTouch(identityRaw: string, decoy: number | string): Tier2VoidResult {
    const identity = requireIdentity(identityRaw, "identity");
    if ((typeof decoy !== "number" || !Number.isFinite(decoy)) && (typeof decoy !== "string" || decoy.length === 0)) {
      fail("voidTouch decoy must be a finite number or a non-empty string");
    }
    const s = ids.get(identity);
    if (!s) return { identity, decoy, voided: 0, voidedDelta: 0, tier: 0 };
    const decoyKey = String(decoy);
    const targets = s.c35Touches.filter((t) => !t.voided && String(t.decoy) === decoyKey);
    if (targets.length === 0) return { identity, decoy, voided: 0, voidedDelta: 0, tier: s.tier };
    let voidedDelta = 0;
    for (const t of targets) {
      t.voided = true;
      voidedDelta += t.d35;
      if (s.c35Decoys.get(decoyKey)?.seq === t.seq) s.c35Decoys.delete(decoyKey);
    }
    s.c35Delta -= voidedDelta;
    if (voidedDelta !== 0) {
      cohortDeltaById.set(identity, (cohortDeltaById.get(identity) ?? 0) - voidedDelta);
      cohortDeltaTotal -= voidedDelta;
    }
    telemetry.voids++;
    const liveTouches = s.c35Touches.filter((t) => !t.voided);
    const taintClock = s.lastTouchDay >= 0 ? s.lastTouchDay : s.lastFlagDay;
    s.taint = liveTouches.some((t) => t.tainted) && !(day - taintClock > TIER2_TAINT_EXPIRY_DAYS);
    s.c35TierInWindow = liveTouches.length > 0;
    let latestLiveEvalSeq = -1;
    for (const t of liveTouches) if (t.evalSeq !== null && t.evalSeq > latestLiveEvalSeq) latestLiveEvalSeq = t.evalSeq;
    s.lastTouchSeq = latestLiveEvalSeq;
    const perIdVoid = new Map<string, { voidedDecoys: (number | string)[]; voidedDelta: number }>();
    perIdVoid.set(identity, { voidedDecoys: [decoy], voidedDelta });
    recomputeAll("host-void-touch", perIdVoid);
    return { identity, decoy, voided: targets.length, voidedDelta, tier: s.tier };
  }

  function disarm(): { voided: number; c35Advisory: boolean } {
    c35Advisory = true;
    telemetry.disarms++;
    const disarmDay = day;
    const inWindow = (t: TouchRecord): boolean => t.day >= disarmDay - 1;
    let voided = 0;
    const perIdVoid = new Map<string, { voidedDecoys: (number | string)[]; voidedDelta: number }>();
    for (const [identity, s] of ids) {
      const inW = s.c35Touches.filter((t) => !t.voided && inWindow(t));
      if (inW.length === 0) continue;
      voided++;
      telemetry.voids++;
      let voidedDelta = 0;
      const voidedDecoys: (number | string)[] = [];
      for (const t of inW) {
        t.voided = true;
        voidedDelta += t.d35;
        voidedDecoys.push(t.decoy);
        const key = String(t.decoy);
        if (s.c35Decoys.get(key)?.seq === t.seq) s.c35Decoys.delete(key);
      }
      s.c35Delta -= voidedDelta;
      if (voidedDelta !== 0) {
        cohortDeltaById.set(identity, (cohortDeltaById.get(identity) ?? 0) - voidedDelta);
        cohortDeltaTotal -= voidedDelta;
      }
      const liveTouches = s.c35Touches.filter((t) => !t.voided);
      const taintClock = s.lastTouchDay >= 0 ? s.lastTouchDay : s.lastFlagDay;
      s.taint = liveTouches.some((t) => t.tainted) && !(day - taintClock > TIER2_TAINT_EXPIRY_DAYS);
      s.c35TierInWindow = liveTouches.length > 0;
      let latestLiveEvalSeq = -1;
      for (const t of liveTouches) if (t.evalSeq !== null && t.evalSeq > latestLiveEvalSeq) latestLiveEvalSeq = t.evalSeq;
      s.lastTouchSeq = latestLiveEvalSeq;
      perIdVoid.set(identity, { voidedDecoys, voidedDelta });
    }
    recomputeAll("C35-disarm-void", perIdVoid);
    return { voided, c35Advisory: true };
  }

  function rollbackEpoch(epoch: number | string): { voided: number } {
    let voided = 0;
    const perIdVoid = new Map<string, { voidedDecoys: (number | string)[]; voidedDelta: number }>();
    for (const [identity, s] of ids) {
      if (!s.c27Flags.some((f) => String(f.epoch) === String(epoch))) continue;
      s.c27Flags = s.c27Flags.filter((f) => String(f.epoch) !== String(epoch));
      s.c27Epochs.delete(String(epoch));
      perIdVoid.set(identity, { voidedDecoys: [], voidedDelta: 0 });
      if (s.tier > 0) voided++;
    }
    recomputeAll("C27-epoch-void", perIdVoid, epoch);
    return { voided };
  }

  /* ------------------------- clock / switches ------------------------- */

  function advanceDays(n: number): { day: number } {
    const steps = requireIntInRange(n, "advanceDays days", 0, 100_000);
    day += steps;
    alphaRefillIfDue();
    for (const [identity, s] of ids) {
      if (s.tier === 2 && s.lastFlagDay >= 0 && day - s.lastFlagDay > TIER2_TIER2_EXPIRY_DAYS) {
        setTierRaw(s, 0);
      }
      // V-C self-disarm: taint + ledger live on the TOUCH clock.
      const taintClock = s.lastTouchDay >= 0 ? s.lastTouchDay : s.lastFlagDay;
      if (s.c35Decoys.size > 0 && taintClock >= 0 && day - taintClock > TIER2_TAINT_EXPIRY_DAYS) {
        if (s.c35Delta !== 0) {
          cohortDeltaById.set(identity, (cohortDeltaById.get(identity) ?? 0) - s.c35Delta);
          cohortDeltaTotal -= s.c35Delta;
          s.c35Delta = 0;
        }
        for (const t of s.c35Touches) if (!t.voided) t.voided = true;
        s.c35Decoys.clear();
        s.c35TierInWindow = false;
        s.lastTouchSeq = -1;
        s.taint = false;
      } else if (s.taint && taintClock >= 0 && day - taintClock > TIER2_TAINT_EXPIRY_DAYS) {
        s.taint = false;
      }
    }
    return { day };
  }

  function setEnabled(v: boolean): { enabled: boolean } {
    if (typeof v !== "boolean") fail("setEnabled expects a boolean");
    enabled = v;
    if (!v) {
      for (const s of ids.values()) if (s.tier > 0) setTierRaw(s, 0);
    }
    return { enabled };
  }

  /* ------------------------- snapshots ------------------------- */

  function identitySnapshot(identity: string): Tier2IdentitySnapshot | null {
    const s = ids.get(identity);
    if (!s) return null;
    return {
      identity,
      tier: s.tier,
      enforcement: s.tier === 2 ? "budget_step_down" : s.tier === 1 ? "step_up" : "observe",
      taint: s.taint,
      c27Flags: s.c27Flags.length,
      c35Distinct: s.c35Decoys.size,
      c35Delta: s.c35Delta,
      c35Touches: s.c35Touches.filter((t) => !t.voided).length,
      c35TierInWindow: s.c35TierInWindow,
      lastPassSeq: s.lastPassSeq,
      lastTouchSeq: s.lastTouchSeq,
      graceUntilDay: s.graceUntilDay,
      graceActive: graceActive(s),
      protected: isProtected(s),
      stratum: s.stratum,
      baseBudgetRecords,
      effectiveBudgetRecords: budgetFor(s, baseBudgetRecords),
      corroboratingFamilies: liveCorroboratingFamilies(s, identity),
    };
  }

  function fleetSnapshot(): Tier2FleetSnapshot {
    return {
      day,
      enabled,
      c35Advisory,
      identitiesTracked: ids.size,
      telemetry: { ...telemetry },
      alpha: alphaState(),
      cohortDeltaTotal,
      unionLiveSize: liveUnionSize(),
      attributionRecords: attributionLog.length,
    };
  }

  function snapshot(identity?: string): Tier2IdentitySnapshot | Tier2FleetSnapshot | null {
    if (identity === undefined) return fleetSnapshot();
    return identitySnapshot(requireIdentity(identity, "identity"));
  }

  return {
    c27Flag,
    ingestC27Flag: c27Flag,
    c27CleanWindow,
    c35Touch,
    recordDecoyTouch: c35Touch,
    ingestDecoyTouch: c35Touch,
    recordCorroboration,
    passStepUp,
    voidTouch,
    disarm,
    rearmC35: () => {
      c35Advisory = false;
      return { c35Advisory: false };
    },
    isC35Advisory: () => c35Advisory,
    disarmTriggered: (stats) =>
      (stats.activeIdentities > 0 && stats.touchedIdentities / stats.activeIdentities > 0.005) ||
      stats.maxDistinctPerDecoy > 10,
    setEnabled,
    rollbackEpoch,
    advanceDays,
    snapshot: snapshot as Tier2Conversion["snapshot"],
    effectiveBudget,
    cohortState: () => ({ cohortDeltaTotal, unionLiveSize: liveUnionSize() }),
    setHerdFlagged: (idSet) => {
      herdFlaggedIds = new Set([...idSet].map((id) => requireIdentity(id, "herd-flagged identity")));
      producerState["herdFlag"] = "wired";
      return { herdFlagged: herdFlaggedIds.size };
    },
    setCusumFlagged: (idSet) => {
      cusumFlaggedIds = new Set([...idSet].map((id) => requireIdentity(id, "cusum-flagged identity")));
      producerState["cusum"] = "wired";
      return { cusumFlagged: cusumFlaggedIds.size };
    },
    setProducerState: (input, state) => {
      if (!["cohortUnion", "otherSignal", "cusum", "herdFlag"].includes(input)) fail(`unknown producer input: ${input}`);
      if (state !== "not_wired" && state !== "wired") fail(`bad producer state: ${state}`);
      producerState[input] = state;
      return { input, state };
    },
    getProducerState: () => ({ ...producerState }),
    telemetry,
    attributionLog,
    advisoryLog,
    constants: {
      D27: TIER2_DELTA_C27, D35_1: TIER2_DELTA_C35_FIRST, D35_R: TIER2_DELTA_C35_REPEAT,
      D35_MAX: TIER2_DELTA_C35_MAX, BOUNDARY_B: TIER2_BOUNDARY_B,
      UNION_FLOOR: TIER2_UNION_FLOOR, SCALE_FLOOR: TIER2_SCALE_FLOOR,
      SOFT_BUDGET_FLOOR_RECORDS,
    },
  };
}
