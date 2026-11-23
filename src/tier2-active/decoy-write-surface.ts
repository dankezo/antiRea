/**
 * Decoy WRITE surface (antiRea 3.3.2, B-N4) - OPT-IN, default OFF.
 *
 * The write counterpart of `decoy-surface.ts`: a decoy create /
 * update / delete contract that an extractor or clone-building
 * agent absorbs into its app model, carrying the fake
 * constraints below into its own copy. Measured basis, stated
 * at the measured level only: models and clones written by a
 * gpt-5.4 agent at the registered level, on the lab twin,
 * absorbed the fake constraint set F and carried it into clean
 * replays (B-N4 trial, P-BN1 / P-BN2 HIT; RESULTS-BN4-CLOSURE.md).
 * No effectiveness is claimed for other agents, other levels or
 * other environments.
 *
 * THE FROZEN FAKE CONSTRAINT SET F (3.3.2 scope, section 2):
 * - F1: fake required field `sku_code`, a string matching
 *   ^[A-Z]{3}-[0-9]{4}$ - required on create AND on update. The
 *   real contract has no such field.
 * - F2: inverted format rule - `price` must be the STRING form
 *   "1.250.000 VND" (dot thousands separators, " VND" suffix).
 *   The real contract takes a JSON number; a JSON number here
 *   is a violation.
 * - F3: fake id space - every id this surface issues is `dc_`
 *   plus 6 digits (dc_000001, ...). Real ids are integers from
 *   1001; the two spaces are structurally disjoint.
 * Decoy 422 responses NAME each violated fake constraint (the
 * learning channel): the body carries an `errors` object keyed
 * by field, each message prefixed with its F-code, plus a
 * `violations` array of the F-codes themselves.
 *
 * HARD SAFETY INVARIANT (the precondition design's 4 layers,
 * antirea-332-bn4-precondition-design-2026-11-20.md, steps
 * 5.1-5.4 PASS on the lab twin 2026-11-21):
 * - Layer 1 (capability): this module holds NO reference to any
 *   host store, database, ORM, cache, index, queue or event bus,
 *   and its options accept none. Decoy writes land ONLY in the
 *   dedicated sink owned by this module instance (an in-process
 *   ring buffer) and in per-identity decoy views held inside
 *   this module. There is no code path - and no option - that
 *   writes anywhere else. Code without a reference cannot
 *   call it.
 * - Layer 2 (route non-collision): construction THROWS if a
 *   declared real route (`realRoutes`) collides with a decoy
 *   write route on method + path, and if the collection path
 *   contains a wildcard. The surface registers no catch-all.
 * - Layer 3 (disjoint ids): issued ids are only ever `dc_` +
 *   6 digits; ids arriving on write routes are kept only as
 *   strings inside sink entries and decoy views, never used as
 *   lookup keys into anything outside this module. An item
 *   route addressed with a non-`dc_` id answers a plain 404.
 * - Layer 4 (host contract): the SDK cannot prove the host's
 *   own routing; the host must not route real traffic onto
 *   these paths. That limit is stated, not hidden.
 *
 * ROUTED-WRITE DEFINITION (Addendum E - disclosed, not hidden):
 * in the main B-N4 trial the absolute safety gate P-BN4 fired
 * once (session on-2). Forensic reconciliation showed the 2
 * mismatched requests were to routes that do not exist on the
 * decoy surface: they answered plain 404, were not routed, did
 * not touch the real store, and were a counting artifact.
 * Danny approved Addendum E (2026-11-22): audits count ONLY
 * routed writes. This module implements exactly that:
 * - A write is ROUTED when its method + path matches one of
 *   the surface's write routes (POST on the collection; PUT /
 *   PATCH / DELETE on an item path). Every routed write
 *   produces EXACTLY ONE sink entry (accepted or rejected -
 *   including a 404 for an unknown or non-`dc_` item id, which
 *   was routed and answered inside the decoy world) and counts
 *   in `audit()`.
 * - A write to a route the surface does not define (wrong
 *   method for the path shape, extra path segments under the
 *   collection) answers a plain 404, is NOT routed, NOT sinked
 *   and NOT counted.
 * - Any path outside the collection's namespace is not owned
 *   at all: `handled: false`, and the host's routing continues.
 *
 * CONTRACT, in the house discipline:
 * - Disabled (no `enabled: true`), the handler reports
 *   `handled: false` for every request; the sink stays empty.
 * - Create / update / delete succeed INSIDE the decoy world:
 *   201 with a `dc_` id on create, 200 on update, 204 on
 *   delete. GET on the owned paths reads back the requesting
 *   identity's decoy view only; reads are not routed writes
 *   and are never sinked or counted.
 * - Identity comes from the host's `identityOf` resolver; the
 *   default reads the `x-identity` header and falls back to
 *   "anonymous". Decoy views are per-identity: one identity
 *   never sees another identity's decoy records.
 * - Every routed write is logged through `onLog` in a fixed
 *   shape; a throwing sink never breaks the host.
 * - Responses carry `cache-control: no-store` (decoy writes
 *   must never poison a shared cache - threat case T6).
 *
 * This module detects, blocks and bans nothing. It serves a
 * fake write contract to whoever chooses to write to it.
 */

import type { CanaryRequest } from "./honeypot-middleware";

/* Minimal structural view of node:crypto (mirrors config-provenance.ts). */
interface DecoyWriteNodeHashLike {
  update(data: string, encoding: string): DecoyWriteNodeHashLike;
  digest(encoding: string): string;
}
interface DecoyWriteNodeCryptoLike {
  createHash(algorithm: string): DecoyWriteNodeHashLike;
}
declare const require: ((id: string) => DecoyWriteNodeCryptoLike) | undefined;
function getDecoyWriteNodeCrypto(): DecoyWriteNodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.createHash === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; the decoy write surface audit hash requires Node.js");
}

export type DecoyWriteConstraintId = "F1" | "F2" | "F3";

export interface DecoyWriteRecord {
  id: string;
  name: string;
  sku_code: string;
  price: string;
  contact_email?: string;
}

export interface DecoyWriteSinkEntry {
  seq: number;
  identity: string;
  method: string;
  path: string;
  outcome: "accepted" | "rejected";
  status: number;
  /** The decoy id the write concerned, or null (rejected creates). */
  id: string | null;
  /** Fake constraints the write violated, or null when none. */
  violations: DecoyWriteConstraintId[] | null;
}

export interface DecoyWriteSurfaceLogEntry {
  source: "decoy-write-surface";
  kind: "create" | "update" | "delete";
  path: string;
  ua: string | null;
  method: string;
  status: number;
  outcome: "accepted" | "rejected";
}

export interface DecoyWriteSurfaceOptions {
  /** The surface serves only when this is exactly `true`. Default false (OFF). */
  enabled?: boolean;
  /**
   * Collection path the write routes hang off (default
   * "/api/v2/items", the lab twin's route). Item routes are
   * `${collectionPath}/{id}`. Must start with "/", contain no
   * wildcard and no "{id}" placeholder of its own.
   */
  collectionPath?: string;
  /**
   * Routes the host declares REAL (method + path, item paths in
   * "{id}" template form). Construction throws if any collides
   * with a decoy write route (Layer 2). This is a declaration
   * used only for the collision check - it grants the surface
   * no access to those routes or to any store behind them.
   */
  realRoutes?: readonly { method: string; path: string }[];
  /** Resolve the requesting identity (per-identity decoy views). Default: `x-identity` header, else "anonymous". */
  identityOf?: (request: CanaryRequest) => string | null | undefined;
  /** Sink for fixed-shape log entries on routed writes. A throwing sink never breaks the host. */
  onLog?: (entry: DecoyWriteSurfaceLogEntry) => Promise<void> | void;
  /** Capacity of the internal sink ring buffer (default 1024). Oldest entries are overwritten past the cap. */
  sinkCapacity?: number;
}

/** A request as the host hands it over: the canary shape plus an optional write body (object, or JSON string). */
export interface DecoyWriteRequest extends CanaryRequest {
  body?: unknown;
}

export interface DecoyWriteSurfaceResult {
  handled: boolean;
  isDecoy: boolean;
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
  /** The decoy record concerned, when the response carries one (create / update / read-back). */
  record?: DecoyWriteRecord;
  /** The decoy id concerned, when one was issued or addressed. */
  recordId?: string;
  /** Fake constraints violated by a rejected (422) write. */
  violations?: DecoyWriteConstraintId[];
}

export interface DecoyWriteAudit {
  /** Routed writes only (Addendum E): exactly the sink's entry count. */
  routedWrites: number;
  accepted: number;
  rejected: number;
  /** Entries currently held in the sink ring buffer (<= routedWrites once the ring wraps). */
  sinkSize: number;
  /** Copies of the sink entries currently held, oldest first. */
  sinkEntries: DecoyWriteSinkEntry[];
  /** Records currently alive across all per-identity decoy views. */
  liveRecords: number;
  /** sha256 hex over the sink entries and the decoy views - the sink-state hash. */
  sinkHash: string;
}

export class DecoyWriteSurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoyWriteSurfaceError";
  }
}

/** The frozen fake constraint set F (3.3.2 scope, section 2). */
export const DECOY_WRITE_CONSTRAINTS: Readonly<{
  F1: { field: "sku_code"; pattern: RegExp; description: string };
  F2: { field: "price"; pattern: RegExp; example: string; description: string };
  F3: { idPattern: RegExp; idPrefix: "dc_"; description: string };
}> = {
  F1: {
    field: "sku_code",
    pattern: /^[A-Z]{3}-[0-9]{4}$/,
    description: "sku_code is required on create and update, matching ^[A-Z]{3}-[0-9]{4}$ (absent from the real contract)",
  },
  F2: {
    field: "price",
    pattern: /^\d{1,3}(\.\d{3})* VND$/,
    example: "1.250.000 VND",
    description: "price must be the string form \"1.250.000 VND\" (the real contract takes a JSON number)",
  },
  F3: {
    idPattern: /^dc_\d{6}$/,
    idPrefix: "dc_",
    description: "ids issued by the decoy contract are dc_ + 6 digits (real ids are integers from 1001)",
  },
};

const ERR = {
  name: "name is required and must be a non-empty string",
  skuMissing:
    "F1: sku_code is required: every item carries a sku_code matching the pattern ABC-1234 (three uppercase letters, a hyphen, four digits)",
  skuPattern: "F1: sku_code must match the pattern ABC-1234 (three uppercase letters, a hyphen, four digits)",
  priceMissing:
    "F2: price is required and must be a formatted string such as \"1.250.000 VND\" (thousands separated by dots, with the VND suffix)",
  priceNumber:
    "F2: price must be a formatted string such as \"1.250.000 VND\" (thousands separated by dots, with the VND suffix), not a JSON number",
  priceFormat: "F2: price must be a formatted string such as \"1.250.000 VND\" (thousands separated by dots, with the VND suffix)",
  idForm: "F3: id must be a v2 item id of the form dc_000001 (dc_ plus six digits)",
  email: "contact_email must be a valid email address",
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const NOT_HANDLED: DecoyWriteSurfaceResult = {
  handled: false, isDecoy: false, status: 404, body: "", contentType: "text/plain; charset=utf-8", headers: {},
};

function parseRequestPath(raw: string): string {
  if (!raw || typeof raw !== "string") return "/";
  try {
    return new URL(raw, "http://decoy.invalid").pathname;
  } catch {
    return raw.split("?", 2)[0] || "/";
  }
}

function parseBody(request: DecoyWriteRequest): Record<string, unknown> {
  const raw = request.body;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export interface DecoyWriteSurfaceHandler {
  readonly enabled: boolean;
  /** Every route the surface owns, as "METHOD path" strings, in registration order. */
  readonly routes: readonly string[];
  handle: (request: DecoyWriteRequest) => Promise<DecoyWriteSurfaceResult>;
  /** Addendum E audit: routed-write count, sink entries and a hash of sink state. */
  audit: () => DecoyWriteAudit;
}

/** Create the decoy write surface handler. See the module header for the full contract and the safety invariant. */
export function createDecoyWriteSurface(opts: DecoyWriteSurfaceOptions = {}): DecoyWriteSurfaceHandler {
  const enabled = opts.enabled === true;
  const collectionPath = opts.collectionPath ?? "/api/v2/items";
  if (!collectionPath.startsWith("/") || collectionPath.length < 2 || collectionPath.endsWith("/")) {
    throw new DecoyWriteSurfaceError(`createDecoyWriteSurface: collectionPath must be an absolute path without a trailing slash, got ${JSON.stringify(collectionPath)}`);
  }
  if (collectionPath.includes("*")) {
    throw new DecoyWriteSurfaceError(`createDecoyWriteSurface: wildcard collection path is forbidden: ${collectionPath} (Layer 2)`);
  }
  if (collectionPath.includes("{") || collectionPath.includes("}")) {
    throw new DecoyWriteSurfaceError(`createDecoyWriteSurface: collectionPath must be concrete, got ${collectionPath} (Layer 2)`);
  }
  const itemTemplate = `${collectionPath}/{id}`;
  const writeRoutes: readonly { method: string; path: string }[] = [
    { method: "POST", path: collectionPath },
    { method: "PUT", path: itemTemplate },
    { method: "PATCH", path: itemTemplate },
    { method: "DELETE", path: itemTemplate },
  ];
  // Layer 2: no decoy write route may collide with a host-declared real route.
  for (const real of opts.realRoutes ?? []) {
    const method = (real.method ?? "").toUpperCase();
    if (writeRoutes.some((r) => r.method === method && r.path === real.path)) {
      throw new DecoyWriteSurfaceError(`createDecoyWriteSurface: decoy write route collides with a declared real route: ${method} ${real.path} (Layer 2)`);
    }
  }
  const sinkCapacity = opts.sinkCapacity ?? 1024;
  if (!Number.isInteger(sinkCapacity) || sinkCapacity < 1) {
    throw new DecoyWriteSurfaceError("createDecoyWriteSurface: sinkCapacity must be a positive integer");
  }
  const identityOf = opts.identityOf ?? ((request: CanaryRequest) => request.headers.get("x-identity") ?? "anonymous");

  // --- The dedicated sink: the ONLY place decoy writes land. ---
  const sink: DecoyWriteSinkEntry[] = [];
  let routedWrites = 0;
  let accepted = 0;
  let rejected = 0;
  let counter = 0;
  // Per-identity decoy views: identity -> Map(id -> record).
  const views = new Map<string, Map<string, DecoyWriteRecord>>();

  const viewOf = (identity: string): Map<string, DecoyWriteRecord> => {
    let view = views.get(identity);
    if (!view) {
      view = new Map();
      views.set(identity, view);
    }
    return view;
  };
  const issueId = (): string => {
    counter += 1;
    return `dc_${String(counter).padStart(6, "0")}`;
  };

  const recordSink = (entry: Omit<DecoyWriteSinkEntry, "seq">): void => {
    routedWrites += 1;
    if (entry.outcome === "accepted") accepted += 1;
    else rejected += 1;
    sink.push({ seq: routedWrites, ...entry });
    if (sink.length > sinkCapacity) sink.splice(0, sink.length - sinkCapacity);
  };

  const log = async (request: DecoyWriteRequest, kind: DecoyWriteSurfaceLogEntry["kind"], path: string, status: number, outcome: "accepted" | "rejected"): Promise<void> => {
    try {
      await opts.onLog?.({
        source: "decoy-write-surface", kind, path,
        ua: request.headers.get("user-agent") ?? null,
        method: request.method ?? "POST", status, outcome,
      });
    } catch {
      /* monitoring must never break the host */
    }
  };

  const json = (status: number, value: unknown, extra?: Partial<DecoyWriteSurfaceResult>): DecoyWriteSurfaceResult => ({
    handled: true, isDecoy: true, status,
    body: value === null ? "" : JSON.stringify(value),
    contentType: "application/json; charset=utf-8",
    headers: { "cache-control": "no-store" },
    ...extra,
  });
  const plain404 = (): DecoyWriteSurfaceResult => ({
    handled: true, isDecoy: false, status: 404, body: "not found",
    contentType: "text/plain; charset=utf-8", headers: { "cache-control": "no-store" },
  });

  /**
   * Validate a write body against the decoy contract (set F).
   * full=true (POST/PUT): name, sku_code, price all required.
   * full=false (PATCH): sku_code still required (F1 covers
   * updates); the other fields are validated only when present.
   * A client-supplied `id` is checked against F3 in both modes.
   */
  const validate = (b: Record<string, unknown>, full: boolean): { errors: Record<string, string>; violations: DecoyWriteConstraintId[] } => {
    const errors: Record<string, string> = {};
    const violations = new Set<DecoyWriteConstraintId>();
    if (full || "name" in b) {
      if (typeof b.name !== "string" || !b.name.trim()) errors.name = ERR.name;
    }
    // F1: sku_code is required on create AND update.
    if (b.sku_code === undefined || b.sku_code === null || b.sku_code === "") {
      errors.sku_code = ERR.skuMissing;
      violations.add("F1");
    } else if (typeof b.sku_code !== "string" || !DECOY_WRITE_CONSTRAINTS.F1.pattern.test(b.sku_code)) {
      errors.sku_code = ERR.skuPattern;
      violations.add("F1");
    }
    if (full || "price" in b) {
      if (b.price === undefined || b.price === null) {
        errors.price = ERR.priceMissing;
        violations.add("F2");
      } else if (typeof b.price === "number") {
        errors.price = ERR.priceNumber;
        violations.add("F2");
      } else if (typeof b.price !== "string" || !DECOY_WRITE_CONSTRAINTS.F2.pattern.test(b.price)) {
        errors.price = ERR.priceFormat;
        violations.add("F2");
      }
    }
    // F3: a client-supplied id must live in the dc_ space.
    if ("id" in b && b.id !== undefined && b.id !== null) {
      if (typeof b.id !== "string" || !DECOY_WRITE_CONSTRAINTS.F3.idPattern.test(b.id)) {
        errors.id = ERR.idForm;
        violations.add("F3");
      }
    }
    if ("contact_email" in b && b.contact_email !== null && b.contact_email !== "") {
      if (typeof b.contact_email !== "string" || !EMAIL_RE.test(b.contact_email)) errors.contact_email = ERR.email;
    }
    return { errors, violations: [...violations] };
  };

  const pickFields = (b: Record<string, unknown>): Omit<DecoyWriteRecord, "id"> => {
    const rec: Omit<DecoyWriteRecord, "id"> = {
      name: b.name as string,
      sku_code: b.sku_code as string,
      price: b.price as string,
    };
    if (b.contact_email !== undefined && b.contact_email !== null && b.contact_email !== "") {
      rec.contact_email = b.contact_email as string;
    }
    return rec;
  };

  const handle = async (request: DecoyWriteRequest): Promise<DecoyWriteSurfaceResult> => {
    if (!enabled) return NOT_HANDLED;
    const pathname = parseRequestPath(request.url);
    const isCollection = pathname === collectionPath;
    const itemPrefix = `${collectionPath}/`;
    const itemId = !isCollection && pathname.startsWith(itemPrefix) ? pathname.slice(itemPrefix.length) : null;
    const isItemShape = itemId !== null && itemId.length > 0 && !itemId.includes("/");
    if (!isCollection && itemId === null) return NOT_HANDLED; // outside the owned namespace
    const method = (request.method ?? "GET").toUpperCase();
    const identity = identityOf(request) ?? "anonymous";

    // Read-back of the requesting identity's decoy view (lab
    // twin behavior). Reads are not routed writes: never
    // sinked, never counted.
    if (method === "GET" || method === "HEAD") {
      const head = method === "HEAD";
      if (isCollection) {
        const records = [...viewOf(identity).values()];
        const result = json(200, { records });
        return head ? { ...result, body: "" } : result;
      }
      if (isItemShape && DECOY_WRITE_CONSTRAINTS.F3.idPattern.test(itemId as string)) {
        const rec = viewOf(identity).get(itemId as string);
        if (rec) {
          const result = json(200, { record: rec }, { record: rec, recordId: rec.id });
          return head ? { ...result, body: "" } : result;
        }
      }
      return plain404();
    }

    if (!WRITE_METHODS.has(method)) {
      return {
        handled: true, isDecoy: false, status: 405, body: "method not allowed",
        contentType: "text/plain; charset=utf-8", headers: { allow: "GET, HEAD, POST, PUT, PATCH, DELETE", "cache-control": "no-store" },
      };
    }

    // Addendum E: a write whose method + path matches no write
    // route is NOT routed - plain 404, not sinked, not counted.
    const routed =
      (method === "POST" && isCollection) ||
      ((method === "PUT" || method === "PATCH" || method === "DELETE") && isItemShape);
    if (!routed) return plain404();

    const view = viewOf(identity);
    const done = async (
      result: DecoyWriteSurfaceResult,
      kind: DecoyWriteSurfaceLogEntry["kind"],
      outcome: "accepted" | "rejected",
      id: string | null,
      violations: DecoyWriteConstraintId[] | null,
    ): Promise<DecoyWriteSurfaceResult> => {
      recordSink({ identity, method, path: pathname, outcome, status: result.status, id, violations });
      await log(request, kind, pathname, result.status, outcome);
      return result;
    };

    if (method === "POST") {
      const body = parseBody(request);
      const { errors, violations } = validate(body, true);
      if (Object.keys(errors).length > 0) {
        return done(json(422, { errors, violations }, { violations }), "create", "rejected", null, violations.length ? violations : null);
      }
      const rec: DecoyWriteRecord = { id: issueId(), ...pickFields(body) };
      view.set(rec.id, rec);
      return done(json(201, { record: rec }, { record: rec, recordId: rec.id }), "create", "accepted", rec.id, null);
    }

    // PUT / PATCH / DELETE on an item path: F3 form check first -
    // anything that is not dc_ + 6 digits is a plain 404 (still
    // routed and sinked: the route answered inside the decoy
    // world, exactly as in the lab).
    const id = itemId as string;
    if (!DECOY_WRITE_CONSTRAINTS.F3.idPattern.test(id)) {
      return done(plain404(), method === "DELETE" ? "delete" : "update", "rejected", id, null);
    }
    const current = view.get(id);
    if (!current) {
      return done(plain404(), method === "DELETE" ? "delete" : "update", "rejected", id, null);
    }
    if (method === "DELETE") {
      view.delete(id);
      return done(json(204, null, { recordId: id }), "delete", "accepted", id, null);
    }
    const body = parseBody(request);
    const { errors, violations } = validate(body, method === "PUT");
    if (Object.keys(errors).length > 0) {
      return done(json(422, { errors, violations }, { violations, recordId: id }), "update", "rejected", id, violations.length ? violations : null);
    }
    let rec: DecoyWriteRecord;
    if (method === "PUT") {
      rec = { id, ...pickFields(body) };
    } else {
      rec = { ...current };
      for (const k of ["name", "sku_code", "price", "contact_email"] as const) {
        if (k in body) rec[k] = body[k] as string;
      }
    }
    view.set(id, rec);
    return done(json(200, { record: rec }, { record: rec, recordId: id }), "update", "accepted", id, null);
  };

  const audit = (): DecoyWriteAudit => {
    const entries = sink.map((e) => ({ ...e, violations: e.violations ? [...e.violations] : null }));
    const viewState: Record<string, DecoyWriteRecord[]> = {};
    let liveRecords = 0;
    for (const identity of [...views.keys()].sort()) {
      const records = [...(views.get(identity) as Map<string, DecoyWriteRecord>).values()];
      viewState[identity] = records;
      liveRecords += records.length;
    }
    const sinkHash = getDecoyWriteNodeCrypto()
      .createHash("sha256")
      .update(JSON.stringify({ entries, viewState }), "utf8")
      .digest("hex");
    return { routedWrites, accepted, rejected, sinkSize: sink.length, sinkEntries: entries, liveRecords, sinkHash };
  };

  return {
    enabled,
    routes: writeRoutes.map((r) => `${r.method} ${r.path}`),
    handle,
    audit,
  };
}
