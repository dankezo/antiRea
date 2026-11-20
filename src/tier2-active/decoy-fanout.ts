/**
 * Provenance fan-out (antiRea 3.3.1, B2 / A-N5) - OPT-IN,
 * default OFF (the surface that serves these chains is
 * `createDecoySurface`, itself disabled by default).
 *
 * WHAT IT DOES. A decoy dataset arranged as a chain instead of
 * a flat list: level-1 records (products) carry the id of a
 * level-2 record (a supplier), each supplier is an individual
 * record route carrying the id of a level-3 record (a
 * contract), each contract carries a level-4 id (a rebate
 * plan), and the plans are leaves. Following the references -
 * the only way to "verify" the data - means fetching every
 * chain record individually, and each fetch is a record serve
 * the host meters like any other (in the trial twin, chain
 * fetches billed 1 record each to the same 150-record budget;
 * hosts wire their own metering over the surface's chain
 * serves, or use the surface's `billChainRecord` callback).
 * The chain also makes the decoys corroborate each other:
 * every level confirms the level above it exists.
 *
 * MEASURED BASIS - WITH ITS ACCOUNTING CAVEAT, which is part
 * of this module's contract and must travel with the number.
 * decoy-map trial v4, FAN arm: at an equal planted decoy
 * record count (78 = 78 against the flat spec-only baseline),
 * real yield per identity fell from 150 to 100 records
 * (-33.3% against a registered -15% threshold) and decoy
 * retention in the capture was 78/78, equal to the baseline.
 * BUT the -33.3% was measured under the harness budget's
 * all-or-nothing page accounting: the 19 billed chain records
 * stranded a full 50-record page. Under partial-page
 * accounting the same arm yields 131 real records (-12.7%,
 * below the registered threshold). So the honest claim is:
 * fan-out cut real yield by up to a third under page-granular
 * budgeting, and part of the effect is accounting-dependent.
 * Never quote -33.3% without that framing.
 *
 * FORM. Pure helpers: route construction and the route map.
 * Serving and optional billing live in `decoy-surface.ts`.
 * Records are host-written, exactly like join sets; ids are
 * plain (identity gating is the join sets' mechanism, A7 -
 * hosts can combine the two).
 */

export interface DecoyChainLevelDecl {
  /** Individual-record route template with an "{id}" placeholder, e.g. "/api/suppliers/{id}". */
  route: string;
  /** Field on this level's records holding the record's own id. */
  idField: string;
  /**
   * Field on this level's records holding the NEXT level's id.
   * Required on every level except the last (the leaf level).
   */
  nextField?: string;
  /** Response wrapper key: the record is served as `{ [wrapKey]: record }`. Default "record". */
  wrapKey?: string;
  /** This level's records. Ids are the values the previous level's `nextField` points at. */
  records: Array<Record<string, unknown>>;
}

export interface DecoyChainDecl {
  /** The chain's levels, in traversal order (level 1 first, leaf last). At least 2. */
  levels: DecoyChainLevelDecl[];
}

export class DecoyFanoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoyFanoutError";
  }
}

/** The concrete route one record is served at: the level's route template with "{id}" replaced by the record's id. */
export function chainRouteFor(level: DecoyChainLevelDecl, record: Record<string, unknown>): string {
  const id = record[level.idField];
  if (typeof id !== "string" && typeof id !== "number") {
    throw new DecoyFanoutError(`chain record on ${level.route} has no usable ${level.idField} id`);
  }
  return level.route.split("{id}").join(String(id));
}

/** Structural validation of a chain declaration. Returns the list of problems (empty = valid); never throws. */
export function validateDecoyChainDecl(chain: unknown): string[] {
  const errors: string[] = [];
  if (!chain || typeof chain !== "object") return ["chain must be an object"];
  const c = chain as DecoyChainDecl;
  if (!Array.isArray(c.levels) || c.levels.length < 2) {
    errors.push("chain.levels must declare at least 2 levels (a 1-level chain fans out nowhere)");
    return errors;
  }
  const routes = new Set<string>();
  c.levels.forEach((level, li) => {
    const last = li === c.levels.length - 1;
    if (!level || typeof level !== "object") { errors.push(`chain.levels[${li}] must be an object`); return; }
    if (typeof level.route !== "string" || !level.route.startsWith("/") || !level.route.includes("{id}")) {
      errors.push(`chain.levels[${li}].route must be an absolute route template containing "{id}": ${String(level.route)}`);
    }
    if (typeof level.idField !== "string" || level.idField.length === 0) errors.push(`chain.levels[${li}].idField must be a non-empty string`);
    if (!last && (typeof level.nextField !== "string" || level.nextField.length === 0)) {
      errors.push(`chain.levels[${li}].nextField is required on every level except the leaf`);
    }
    if (!Array.isArray(level.records) || level.records.length === 0) {
      errors.push(`chain.levels[${li}].records must be a non-empty array`);
      return;
    }
    const ids = new Set<string>();
    level.records.forEach((record, ri) => {
      const id = record?.[level.idField];
      if (typeof id !== "string" && typeof id !== "number") {
        errors.push(`chain.levels[${li}].records[${ri}] has no usable ${level.idField} id`);
        return;
      }
      const route = level.route.split("{id}").join(String(id));
      if (routes.has(route)) errors.push(`chain route collision: ${route}`);
      routes.add(route);
      if (ids.has(String(id))) errors.push(`chain.levels[${li}] declares id ${String(id)} twice`);
      ids.add(String(id));
      if (!last && level.nextField && typeof record[level.nextField] !== "string" && typeof record[level.nextField] !== "number") {
        errors.push(`chain.levels[${li}].records[${ri}] has no usable ${level.nextField} reference to the next level`);
      }
    });
  });
  return errors;
}

export interface ChainRouteEntry {
  /** Index of the level the record belongs to (0-based). */
  levelIndex: number;
  /** The level declaration the record came from. */
  level: DecoyChainLevelDecl;
  /** The record served at this route. */
  record: Record<string, unknown>;
}

/**
 * Build the concrete route map for a chain: every record of
 * every level at its individual route. Throws
 * DecoyFanoutError on an invalid declaration.
 */
export function buildChainRouteMap(chain: DecoyChainDecl): Map<string, ChainRouteEntry> {
  const errors = validateDecoyChainDecl(chain);
  if (errors.length > 0) throw new DecoyFanoutError(`invalid decoy chain: ${errors.join("; ")}`);
  const map = new Map<string, ChainRouteEntry>();
  chain.levels.forEach((level, levelIndex) => {
    for (const record of level.records) map.set(chainRouteFor(level, record), { levelIndex, level, record });
  });
  return map;
}

/** Every concrete route a chain owns, in level then record order. */
export function chainRoutes(chain: DecoyChainDecl): string[] {
  return [...buildChainRouteMap(chain).keys()];
}

/**
 * Resolve the next hop from a served record: the concrete
 * route its `nextField` points at, or null on the leaf level
 * (or when the reference dangles - a dangling reference is a
 * registry defect the host can audit for with this helper).
 */
export function chainNextRoute(chain: DecoyChainDecl, entry: ChainRouteEntry): string | null {
  const nextLevel = chain.levels[entry.levelIndex + 1];
  if (!nextLevel || !entry.level.nextField) return null;
  const nextId = entry.record[entry.level.nextField];
  if (typeof nextId !== "string" && typeof nextId !== "number") return null;
  return nextLevel.route.split("{id}").join(String(nextId));
}
