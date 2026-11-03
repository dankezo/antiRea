/**
 * Missing-mass signal (HARVEST2 candidate C22, lab PASS - see the
 * study lab's C22-STEP0.md, C22-DESIGN.md and C22-RESULTS.md under
 * the antiRea research tree).
 *
 * WHAT IT MEASURES. A herd of one-hit identities (each identity
 * touches the surface once and is discarded - the 1-hit/IP shape)
 * leaves no per-identity trace by definition. On the SURFACE x
 * WINDOW side it does leave one: the frequency spectrum. The
 * statistic is the Good-Turing estimate of the unseen mass,
 * m = f1 / n, computed per (surface, window) cell: f1 = number of
 * identities appearing EXACTLY ONCE in the cell, n = total events
 * in the cell. A 1-hit herd inflates f1 far above the surface's own
 * natural newcomer rate; legitimate traffic - including sale-week
 * traffic, whose extra sessions come from returning identities -
 * does not (lab: VALID FP 1/280 = 0.36% at the day scale, SALE
 * 0/140, herds of 100-400 one-hit identities/day flagged 100%,
 * herds of 50/day flagged 84.5% day / 100% week - all simulation,
 * scripted populations; see the honest limits below).
 *
 * THE FROZEN LAB RULE, translated without re-invention:
 * - Cells are (surface, window) at two scales: day (D1, primary)
 *   and week (D7, secondary; the week cell's counts are aggregated
 *   over its 7 component days and f1/n recomputed from the sums,
 *   never averaged from daily ratios).
 * - A cell is scored only when n >= `minCellEvents` (lab floor:
 *   200). Below-floor cells are counted, never scored - low-traffic
 *   surfaces are a DECLARED blind region, exactly as the lab
 *   registered.
 * - Scoring is one-sided ties-inclusive conformal against a
 *   reference pool of legitimate cells the host fits per surface
 *   and scale: p = (1 + #{reference cells with m >= cell m}) /
 *   (N + 1). Flag iff p <= alpha: 0.02 at the day scale, 0.05 at
 *   the week scale (0.05 is the finest resolution the lab's
 *   24-cell week reference supports).
 * - Surfaces are HOST-DEFINED: the host supplies `surfaceOf`,
 *   mapping each resource id to a surface name (or null for
 *   "not counted"). The lab's id ranges (its binding surface was
 *   resource ids 200..1999 of a synthetic site) are harness
 *   specifics and are NOT hard-coded here.
 *
 * HARD CONDITIONS - in the code, not just the docs:
 *
 * 1. HOST SURFACE MAP IS MANDATORY. With no `surfaceOf` the module
 *    is DISABLED: it records nothing, fits nothing, and every call
 *    returns an explicit disabled status.
 * 2. ADVISORY ONLY. The module emits signal objects
 *    (`enforcement: "none"`, the policy-signals precedent). It has
 *    no blocking decision, attaches no consequence, and never
 *    attributes any identity: the statistic is a property of a
 *    surface cell, not of any caller in it.
 * 3. OPT-IN. Nothing runs until the host constructs an instance
 *    and fits a reference pool from its own legitimate traffic.
 * 4. NO RETROACTIVE CELLS. Windows close in arrival order per
 *    surface; an event whose window has already closed is refused
 *    as a structured no-op (`late_window`) and never rewrites a
 *    reported cell.
 *
 * KNOWN BLINDNESS - measured in the lab, pinned by tests. An
 * evader that REUSES identities (>= 2 touches per identity) is
 * structurally invisible to this statistic: reuse contributes
 * nothing to f1 (lab EV-REUSE-2: 0/42 cells flagged). The lab PASS
 * stands on the linked-tax clause registered in the queue BEFORE
 * C22 ran: a reusing herd stops being a 1-hit herd and hands
 * itself to the channels that meter identity persistence (the
 * served-record union, C6 input-space coverage, C10-style motif
 * evidence). That combination has never been measured end-to-end;
 * do not read this module as covering it. A mixed herd (half
 * 1-hit, half 3-touch) is still largely caught (lab: 39/42 =
 * 92.9%) because its 1-hit half still inflates f1.
 *
 * UNMEASURED CELL. The lab's viral construction was full-persona
 * newcomers arriving through the hub, and it did not move the
 * statistic (0 flags). A real drive-by viral event - thousands of
 * strangers each viewing exactly one deep page and leaving - pumps
 * f1 into deep surfaces by construction and was NEVER measured, in
 * either lab step. A host whose deep surfaces receive drive-by
 * traffic must measure that cell on its own logs before treating a
 * flag as herd evidence.
 *
 * Pure computation: no I/O, no runtime dependencies. State is
 * bounded in-memory maps (per surface: the open day and week
 * cells' identity counters plus the last closed cell per scale).
 */

/** Window scales, in the lab's naming: D1 = day (primary), D7 = week (secondary). */
export type MissingMassScale = "day" | "week";

const DISABLED_REASON = "surface_map_not_declared";

const DAY_MS = 86_400_000;

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): an abnormal share of one-hit identities on this " +
  "surface cell (Good-Turing missing mass). A flag is investigation telemetry about a surface, " +
  "never attribution of any identity, and must never be the sole evidence for any consequence. " +
  "Known blindness: herds reusing identities (>= 2 touches each) are invisible to this statistic " +
  "by construction; drive-by viral traffic on deep surfaces is unmeasured.";

export interface MissingMassEvent {
  /** The authenticated identity the resource was served to. */
  identity: string;
  /** The resource served; mapped to a surface by the host's `surfaceOf`. */
  resourceId: number | string;
  /** Millisecond timestamp of the serve. */
  ts: number;
}

/** One calibration cell: either a touch list (one identity per touch) or an identity -> touch-count map. */
export type MissingMassCellSample = string[] | Record<string, number>;

export interface CreateMissingMassSignalOptions {
  /**
   * Host surface map: resource id -> surface name, or null when the
   * resource belongs to no metered surface. When omitted, the
   * instance is created DISABLED (hard condition 1). A map that
   * throws is treated as returning null for that event.
   */
  surfaceOf?: (resourceId: number | string) => string | null;
  /** Minimum events for a cell to be scored (the lab floor). Defaults to 200. */
  minCellEvents?: number;
  /** Conformal level at the day scale. Defaults to 0.02 (the lab's alpha D1). */
  alphaDay?: number;
  /** Conformal level at the week scale. Defaults to 0.05 (the lab's alpha D7). */
  alphaWeek?: number;
  /** Anchor (ms since epoch) that day windows are aligned to; week windows are 7 aligned days. Defaults to 0. */
  windowStartMs?: number;
  /** Minimum reference cells a fit call must yield per surface and scale. Defaults to 20. */
  minTrainCells?: number;
  /** Maximum surfaces tracked at once (least-recently-seen evicted). Defaults to 1,000. */
  maxSurfaces?: number;
}

export interface MissingMassObservation {
  /**
   * `"recorded"` - the event entered its surface cells;
   * `"no_surface"` - the host map placed it on no metered surface;
   * `"late_window"` - its window had already closed (never
   * retroactive); `"invalid_ts"` - non-finite or out-of-range
   * timestamp, refused before any state was touched;
   * `"disabled"` - the module is disabled.
   */
  status: "recorded" | "no_surface" | "late_window" | "invalid_ts" | "disabled";
  /** Present when `status` is `"disabled"`: the named reason the module is off. */
  reason?: string;
  /** The surface the event mapped to, when one was resolved. */
  surface?: string;
  /** Whether the event was counted into a cell. */
  counted: boolean;
  /** Signals of any cells this event closed (day and/or week), in scale order. */
  signals: MissingMassSignal[];
}

export interface MissingMassSignal {
  kind: "missing_mass";
  surface: string;
  scale: MissingMassScale;
  /** Aligned window index at this scale (days, resp. weeks, since `windowStartMs`). */
  windowIndex: number;
  /**
   * `"scored"` - the cell met the floor and a reference pool
   * exists; `"below_floor"` - n < `minCellEvents`, never scored;
   * `"uncalibrated"` - no reference pool fitted for this surface
   * and scale; `"insufficient_data"` - no cell has closed yet
   * (only from `evaluateSurface`).
   */
  status: "scored" | "below_floor" | "uncalibrated" | "insufficient_data";
  /** True exactly when scored and the conformal p crossed this scale's alpha. */
  flagged: boolean;
  /** One-sided ties-inclusive conformal p against the fitted reference pool, or null when not scored. */
  pValue: number | null;
  /** The cell's missing-mass statistic m = f1 / n. */
  missingMass: number;
  /** f1: identities appearing exactly once in the cell. */
  singletonIdentities: number;
  /** n: total events in the cell. */
  events: number;
  /** The conformal level applied at this scale. */
  alpha: number;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface MissingMassFitResult {
  fitted: boolean;
  status: "fitted" | "disabled";
  surface: string;
  scale: MissingMassScale;
  /** Reference cells that met the floor and entered the pool. */
  cells: number;
  /** Cells skipped for falling below the event floor. */
  skipped: number;
}

export interface MissingMassSnapshot {
  enabled: boolean;
  /** `"surface_map_not_declared"` when disabled, otherwise null. */
  disabledReason: string | null;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  minCellEvents: number;
  alphaDay: number;
  alphaWeek: number;
  surfacesTracked: number;
  /** Fitted reference pools, keyed `"<surface>:<scale>"` -> reference cell count. */
  calibrations: Record<string, number>;
  counters: {
    /** Events counted into a cell. */
    recorded: number;
    /** Events the host map placed on no metered surface. */
    noSurface: number;
    /** Events refused because their window had already closed. */
    lateWindow: number;
    /** Events refused for a non-finite or out-of-range timestamp. */
    invalidTs: number;
    /** Day cells closed (any surface). */
    dayCellsClosed: number;
    /** Week cells closed (any surface). */
    weekCellsClosed: number;
  };
  notice: string;
}

export interface MissingMassSignalInstance {
  /** Whether the module is on (a surface map was supplied at construction). */
  readonly enabled: boolean;
  /** Feed one serve event. See {@link MissingMassObservation} for the outcome vocabulary. */
  observe(event: MissingMassEvent): MissingMassObservation;
  /**
   * Fit the reference pool for one surface and scale from the
   * host's own legitimate cells. Each cell is a touch list (one
   * identity per touch) or an identity -> touch-count map. Cells
   * below the event floor are skipped and counted. Throws when
   * fewer than `minTrainCells` cells are usable.
   */
  fitSurfaceCalibration(
    surface: string,
    scale: MissingMassScale,
    cells: MissingMassCellSample[],
  ): MissingMassFitResult;
  /** The most recently closed cell's signal for a surface and scale. */
  evaluateSurface(surface: string, scale: MissingMassScale): MissingMassSignal;
  /** State and calibration summary. */
  snapshot(): MissingMassSnapshot;
}

/** Named error thrown for every invalid missing-mass input. */
export class MissingMassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingMassError";
  }
}

const fail = (message: string): never => {
  throw new MissingMassError(`createMissingMassSignal: ${message}`);
};

function requireIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requireAlpha(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 0.5) {
    fail(`${field} must be a finite number in (0, 0.5]`);
  }
  return value as number;
}

function requireSurfaceName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value as string;
}

/** The F-21 timestamp discipline shared with the herd detector: finite and inside the representable Date range. */
function isValidTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8.64e15;
}

interface OpenCell {
  windowIndex: number;
  counts: Map<string, number>;
  n: number;
}

interface ScaleState {
  open: OpenCell | null;
  lastClosed: MissingMassSignal | null;
}

interface SurfaceState {
  day: ScaleState;
  week: ScaleState;
  lastSeen: number;
}

export function createMissingMassSignal(
  options: CreateMissingMassSignalOptions = {},
): MissingMassSignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");

  const minCellEvents = requireIntInRange(options.minCellEvents ?? 200, "minCellEvents", 1, 1_000_000_000);
  const alphaDay = requireAlpha(options.alphaDay ?? 0.02, "alphaDay");
  const alphaWeek = requireAlpha(options.alphaWeek ?? 0.05, "alphaWeek");
  const windowStartMs = options.windowStartMs ?? 0;
  if (!isValidTs(windowStartMs)) fail("windowStartMs must be a finite timestamp within the representable range");
  const minTrainCells = requireIntInRange(options.minTrainCells ?? 20, "minTrainCells", 1, 1_000_000);
  const maxSurfaces = requireIntInRange(options.maxSurfaces ?? 1_000, "maxSurfaces", 1, 1_000_000);

  const surfaceOf = options.surfaceOf;
  if (surfaceOf !== undefined && typeof surfaceOf !== "function") fail("surfaceOf must be a function");
  const enabled = surfaceOf !== undefined;

  const surfaces = new Map<string, SurfaceState>();
  /** Reference pools: key `${surface}\u0000${scale}` -> sorted reference m values. */
  const pools = new Map<string, number[]>();
  const counters = { recorded: 0, noSurface: 0, lateWindow: 0, invalidTs: 0, dayCellsClosed: 0, weekCellsClosed: 0 };
  let seq = 0;

  const poolKey = (surface: string, scale: MissingMassScale): string => `${surface}\u0000${scale}`;
  const alphaFor = (scale: MissingMassScale): number => (scale === "day" ? alphaDay : alphaWeek);

  function cellStats(counts: Map<string, number>): { f1: number; n: number; m: number } {
    let f1 = 0;
    let n = 0;
    for (const c of counts.values()) {
      n += c;
      if (c === 1) f1++;
    }
    return { f1, n, m: n > 0 ? f1 / n : 0 };
  }

  function closeCell(surface: string, scale: MissingMassScale, cell: OpenCell): MissingMassSignal {
    const { f1, n, m } = cellStats(cell.counts);
    const alpha = alphaFor(scale);
    const base = {
      kind: "missing_mass" as const,
      surface,
      scale,
      windowIndex: cell.windowIndex,
      missingMass: m,
      singletonIdentities: f1,
      events: n,
      alpha,
      enforcement: "none" as const,
      notice: ADVISORY_NOTICE,
    };
    if (n < minCellEvents) {
      return { ...base, status: "below_floor", flagged: false, pValue: null };
    }
    const pool = pools.get(poolKey(surface, scale));
    if (!pool) {
      return { ...base, status: "uncalibrated", flagged: false, pValue: null };
    }
    // One-sided ties-inclusive conformal p: (1 + #{ref >= m}) / (N + 1).
    let ge = 0;
    for (const ref of pool) if (ref >= m) ge++;
    const pValue = (1 + ge) / (pool.length + 1);
    return { ...base, status: "scored", flagged: pValue <= alpha, pValue };
  }

  function touchSurface(surface: string): SurfaceState {
    const existing = surfaces.get(surface);
    if (existing) {
      existing.lastSeen = seq++;
      surfaces.delete(surface);
      surfaces.set(surface, existing);
      return existing;
    }
    if (surfaces.size >= maxSurfaces) {
      const oldest = surfaces.keys().next().value as string | undefined;
      if (oldest !== undefined) surfaces.delete(oldest);
    }
    const fresh: SurfaceState = {
      day: { open: null, lastClosed: null },
      week: { open: null, lastClosed: null },
      lastSeen: seq++,
    };
    surfaces.set(surface, fresh);
    return fresh;
  }

  /**
   * Feed one touch into one scale's cell state. Returns the closed
   * cell's signal when the event rolled the window, `"late"` when
   * the event's window already closed, or null.
   */
  function feedScale(
    state: SurfaceState,
    surface: string,
    scale: MissingMassScale,
    windowIndex: number,
    identity: string,
  ): MissingMassSignal | "late" | null {
    const scaleState = state[scale];
    if (scaleState.open === null) {
      scaleState.open = { windowIndex, counts: new Map(), n: 0 };
    } else if (windowIndex < scaleState.open.windowIndex) {
      return "late";
    } else if (windowIndex > scaleState.open.windowIndex) {
      const closed = closeCell(surface, scale, scaleState.open);
      scaleState.lastClosed = closed;
      if (scale === "day") counters.dayCellsClosed++;
      else counters.weekCellsClosed++;
      scaleState.open = { windowIndex, counts: new Map(), n: 0 };
      const cell = scaleState.open;
      cell.counts.set(identity, 1);
      cell.n = 1;
      return closed;
    }
    const cell = scaleState.open;
    cell.counts.set(identity, (cell.counts.get(identity) ?? 0) + 1);
    cell.n++;
    return null;
  }

  function observe(event: MissingMassEvent): MissingMassObservation {
    if (!enabled) {
      return { status: "disabled", reason: DISABLED_REASON, counted: false, signals: [] };
    }
    if (typeof event !== "object" || event === null) fail("event must be an object");
    if (typeof event.identity !== "string" || event.identity.trim().length === 0) {
      fail("event.identity must be a non-empty string");
    }
    if (
      (typeof event.resourceId !== "number" || !Number.isFinite(event.resourceId)) &&
      (typeof event.resourceId !== "string" || event.resourceId.length === 0)
    ) {
      fail("event.resourceId must be a finite number or a non-empty string");
    }
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      return { status: "invalid_ts", counted: false, signals: [] };
    }

    let surface: string | null;
    try {
      surface = surfaceOf!(event.resourceId);
    } catch {
      surface = null; // A throwing host map is treated as "no surface" (herd-detector callback discipline).
    }
    if (surface === null || surface === undefined || typeof surface !== "string" || surface.trim().length === 0) {
      counters.noSurface++;
      return { status: "no_surface", counted: false, signals: [] };
    }

    const dayIndex = Math.floor((event.ts - windowStartMs) / DAY_MS);
    const weekIndex = Math.floor(dayIndex / 7);
    const state = touchSurface(surface);
    const signals: MissingMassSignal[] = [];
    const dayResult = feedScale(state, surface, "day", dayIndex, event.identity);
    if (dayResult === "late") {
      counters.lateWindow++;
      return { status: "late_window", surface, counted: false, signals };
    }
    if (dayResult !== null) signals.push(dayResult);
    const weekResult = feedScale(state, surface, "week", weekIndex, event.identity);
    if (weekResult === "late") {
      // The day cell accepted the touch but the week cell is older:
      // cannot happen with aligned windows (week index is monotone
      // in day index), but refuse rather than half-count if a host
      // anchor ever makes it possible.
      counters.lateWindow++;
      return { status: "late_window", surface, counted: false, signals };
    }
    if (weekResult !== null) signals.push(weekResult);
    counters.recorded++;
    return { status: "recorded", surface, counted: true, signals };
  }

  function fitSurfaceCalibration(
    surface: string,
    scale: MissingMassScale,
    cells: MissingMassCellSample[],
  ): MissingMassFitResult {
    requireSurfaceName(surface, "surface");
    if (scale !== "day" && scale !== "week") fail('scale must be "day" or "week"');
    if (!enabled) {
      return { fitted: false, status: "disabled", surface, scale, cells: 0, skipped: 0 };
    }
    if (!Array.isArray(cells)) fail("cells must be an array of cell samples");
    const values: number[] = [];
    let skipped = 0;
    cells.forEach((cell, i) => {
      const counts = new Map<string, number>();
      if (Array.isArray(cell)) {
        cell.forEach((identity, j) => {
          if (typeof identity !== "string" || identity.length === 0) {
            fail(`cells[${i}][${j}] must be a non-empty identity string`);
          }
          counts.set(identity, (counts.get(identity) ?? 0) + 1);
        });
      } else if (typeof cell === "object" && cell !== null) {
        for (const [identity, count] of Object.entries(cell)) {
          if (identity.length === 0) fail(`cells[${i}] has an empty identity key`);
          if (typeof count !== "number" || !Number.isFinite(count) || count < 0 || !Number.isInteger(count)) {
            fail(`cells[${i}][${JSON.stringify(identity)}] must be a non-negative integer touch count`);
          }
          if (count > 0) counts.set(identity, count);
        }
      } else {
        fail(`cells[${i}] must be a touch list (string[]) or an identity -> count map`);
      }
      const { f1, n, m } = cellStats(counts);
      void f1;
      if (n < minCellEvents) skipped++;
      else values.push(m);
    });
    if (values.length < minTrainCells) {
      fail(
        `fitSurfaceCalibration needs at least ${minTrainCells} legitimate cells at or above the ` +
          `${minCellEvents}-event floor for surface ${JSON.stringify(surface)} (${scale}); ` +
          `got ${values.length} (${skipped} below floor)`,
      );
    }
    values.sort((a, b) => a - b);
    pools.set(poolKey(surface, scale), values);
    return { fitted: true, status: "fitted", surface, scale, cells: values.length, skipped };
  }

  function evaluateSurface(surface: string, scale: MissingMassScale): MissingMassSignal {
    requireSurfaceName(surface, "surface");
    if (scale !== "day" && scale !== "week") fail('scale must be "day" or "week"');
    const alpha = alphaFor(scale);
    const state = surfaces.get(surface);
    const lastClosed = state ? state[scale].lastClosed : null;
    if (lastClosed) return lastClosed;
    const open = state ? state[scale].open : null;
    return {
      kind: "missing_mass",
      surface,
      scale,
      windowIndex: open ? open.windowIndex : -1,
      status: "insufficient_data",
      flagged: false,
      pValue: null,
      missingMass: 0,
      singletonIdentities: 0,
      events: open ? open.n : 0,
      alpha,
      enforcement: "none",
      notice: enabled
        ? "No cell has closed yet at this scale; the open cell's event count is reported, nothing is scored."
        : `Module disabled (${DISABLED_REASON}): no surface map was declared, so nothing is scored.`,
    };
  }

  function snapshot(): MissingMassSnapshot {
    const calibrations: Record<string, number> = {};
    for (const [key, pool] of pools) {
      const [surface, scale] = key.split("\u0000");
      calibrations[`${surface}:${scale}`] = pool.length;
    }
    return {
      enabled,
      disabledReason: enabled ? null : DISABLED_REASON,
      enforcement: "none",
      minCellEvents,
      alphaDay,
      alphaWeek,
      surfacesTracked: surfaces.size,
      calibrations,
      counters: { ...counters },
      notice: enabled ? ADVISORY_NOTICE : `Module disabled (${DISABLED_REASON}): no surface map was declared, so nothing is scored.`,
    };
  }

  return { enabled, observe, fitSurfaceCalibration, evaluateSurface, snapshot };
}
