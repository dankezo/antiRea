/**
 * Export scope guard (P0 control).
 *
 * Rate-limiting an export endpoint does not protect the dataset when ONE
 * call returns all of it: in the reconstruction-study lab, a 3-per-minute
 * export cap still leaked 100% of a 10,000-record dataset on call #1,
 * because the budget being limited was requests, not rows. This guard
 * limits the ROWS: an export whose estimated row count exceeds
 * `maxRowsPerExport` is rejected with `422 export_scope_too_broad` before
 * the handler runs, so the single-call dump stops existing.
 *
 * The wirings that make it real are the host's responsibility (see
 * docs/LIMITATIONS.md):
 *
 * - `estimateRows(req)` tells the guard how many rows the requested export
 *   would produce (for example by running the host's own COUNT query). As a
 *   fallback the guard reads a numeric `antireaExportRows` property an
 *   earlier host middleware stamped on the request. With no estimate the
 *   guard cannot judge scope: it still enforces `requireFilterParams`, but
 *   the row cap and the flat budget charge are skipped - wire an estimate.
 * - Budget pricing, when a `recordBudget` is supplied, comes in two forms:
 *   - Per-record (preferred): if the host also supplies `extractRecordIds`,
 *     the middleware wraps the export response and prices the ids it
 *     actually contained through the budget's per-record state machine
 *     (`consumeExported`): a record already viewed costs 1 more, an unseen
 *     record costs 2, a re-export costs 0. A record's all-in price is its
 *     highest state - it is never charged the full view price AND the full
 *     export price. Pre-flight, this path only gates an identity already
 *     at its cap; the exact charge lands with the response. Because that
 *     left a parallel-burst hole (F-03), the middleware additionally
 *     RESERVES the worst-case price of the estimate (2 x estimated rows)
 *     before the handler runs and releases it when the response settles,
 *     so concurrent exports cannot jointly overshoot the cap; the
 *     reservation is worst-case, so an export whose worst case alone
 *     exceeds the identity's remaining budget is refused even though
 *     its exact per-record price might have fit. A response body the
 *     extractor cannot price - a non-JSON body such as CSV, or a
 *     streamed body (F-04) - is NOT free: it is charged the flat
 *     estimate price (`budgetMultiplier` x estimated rows), or
 *     `unpricedBodyFloorUnits` when no estimate was wired.
 *   - Flat (cruder): with only a row estimate, an allowed export burns the
 *     budget at `budgetMultiplier` x rows up front, and an export the
 *     budget cannot afford is rejected with `429 record_budget_exceeded`.
 *     This path cannot see that exported rows were already viewed, so it
 *     overcharges exactly the records the per-record path prices fairly.
 * - Identity: when a `recordBudget` is wired but NO identity can be
 *   resolved for the request (no account, no API key and no determinable
 *   IP), the export is NOT exempt (F-14 - a NEW fix in this tree, not a
 *   port: the hole was still open in 2.6.3). Every budget effect -
 *   the rejection floor, the flat charge, the per-record gate and the
 *   middleware's pricing/reservation - is applied to a single shared
 *   `unknown:unresolved` bucket, the quota guard's precedent for the
 *   same situation. Set `allowUnresolvedIdentity: true` only to restore
 *   the legacy behavior of leaving such exports unbudgeted.
 * - Zero-cost oracles are priced too: a 422 rejection (unfiltered or
 *   over-scope) charges the identity `rejectionFloorUnits` (default 1)
 *   when a budget is attached, so probing the guard's boundaries is not
 *   free. And every response carries `Cache-Control: private, no-store`
 *   (option `noStore`) so a cached export response can never bypass
 *   accounting.
 *
 * Normal users exporting a filtered report (the legitimate use) stay far
 * below the cap; the cap only bites on unfiltered, dataset-scale pulls.
 */

import type { QuotaExpressNext, QuotaExpressResponse, QuotaRequestLike } from "./quota-guard";
import {
  resolveRecordBudgetIdentityKey,
  type RecordBudget,
  type RecordBudgetIdentityOptions,
} from "./record-budget";

export interface ExportGuardOptions extends RecordBudgetIdentityOptions {
  /** Maximum rows a single export call may return. Required. */
  maxRowsPerExport: number;
  /**
   * Query parameters of which at least one must be present (non-empty) for
   * an export to be allowed at all - an unfiltered export is a dump.
   * Rejected with `422 export_filter_required` when none is present.
   */
  requireFilterParams?: readonly string[];
  /** Budget cost multiplier applied to exported rows on the flat (estimate-only) pricing path. Defaults to 2. */
  budgetMultiplier?: number;
  /** Shared record budget (from `createRecordBudget`) that allowed exports are charged against. */
  recordBudget?: RecordBudget;
  /**
   * When a `recordBudget` is wired but the request's identity cannot be
   * resolved at all (no account, no API key, no determinable IP), the
   * default (`false`) charges the export against a single shared
   * `unknown:unresolved` budget bucket, so an unresolvable export is
   * never silently exempt (F-14; the quota guard's precedent). Set to
   * `true` only to restore the legacy behavior of skipping budget
   * enforcement for such requests.
   */
  allowUnresolvedIdentity?: boolean;
  /**
   * Estimate how many rows this export request would produce. May be async
   * (a COUNT query). Return `undefined` when the host cannot estimate.
   */
  estimateRows?: (req: QuotaRequestLike) => number | undefined | Promise<number | undefined>;
  /**
   * Extract the record ids an export response body actually contained.
   * When supplied (with `recordBudget`), the middleware prices the export
   * per-record via the budget's state machine instead of the flat
   * multiplier. A body that yields no ids because it is not JSON-shaped
   * (CSV, plain text, streamed) falls back to the flat estimate price -
   * it is never free (F-04). Errors thrown here are swallowed by the
   * middleware.
   */
  extractRecordIds?: (body: unknown, req: QuotaRequestLike) => readonly string[] | undefined | null;
  /**
   * Budget units charged to the identity when the guard rejects with 422
   * (filter floor or scope cap) and a record budget is attached. Defaults
   * to 1; set 0 to disable.
   */
  rejectionFloorUnits?: number;
  /**
   * Budget units charged when an export response body cannot be priced
   * per-record (a non-JSON body such as CSV, or a streamed body - F-04)
   * AND no row estimate is available to price it by. When an estimate
   * IS available, such a body is charged the flat estimate price
   * (`budgetMultiplier` x estimated rows) instead. Defaults to 1; set
   * 0 to disable.
   */
  unpricedBodyFloorUnits?: number;
  /**
   * Add `Cache-Control: private, no-store` to every guard response
   * (rejections and allowed pass-throughs alike), so budget-metered export
   * responses are never served from cache. Defaults to true.
   */
  noStore?: boolean;
  /** Structured operator event sink for rejections. Errors thrown here are swallowed. */
  onRejected?: (event: ExportGuardRejection) => Promise<void> | void;
}

export type ExportGuardRejectionKind =
  | "export_scope_too_broad"
  | "export_filter_required"
  | "record_budget_exceeded";

export interface ExportGuardRejection {
  kind: ExportGuardRejectionKind;
  identityKey?: string;
  estimatedRows?: number;
  maxRowsPerExport: number;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

export interface ExportGuardResult {
  allowed: boolean;
  /** HTTP status to return: 200 when allowed, 422 for scope/filter rejections, 429 for budget rejections. */
  status: number;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  /** The row estimate the decision was based on, when one was available. */
  estimatedRows?: number;
  /** Budget identity key the export was charged to, when a budget is wired. */
  identityKey?: string;
}

export interface ExportGuard {
  checkRequest(req: QuotaRequestLike): Promise<ExportGuardResult>;
  readonly maxRowsPerExport: number;
}

type ExportRequestLike = QuotaRequestLike & { antireaExportRows?: unknown };

/**
 * Budget bucket for exports whose identity cannot be resolved at all
 * when a budget is wired (F-14) - the same key the quota guard counts
 * unresolvable requests against. It deliberately does NOT start with
 * `ip:`, so it lives in the record budget's main (account) pool.
 */
const UNRESOLVED_BUDGET_IDENTITY_KEY = "unknown:unresolved";

export function createExportGuard(options: ExportGuardOptions): ExportGuard {
  const maxRows = Math.max(1, Math.floor(options.maxRowsPerExport) || 1);
  const multiplier = Math.max(0, options.budgetMultiplier ?? 2);
  const rejectionFloor = Math.max(0, Math.floor(options.rejectionFloorUnits ?? 1) || 0);
  const requiredFilters = (options.requireFilterParams ?? []).filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  );

  const baseHeaders = (): Record<string, string> => ({
    "X-Export-Max-Rows": String(maxRows),
    ...(options.noStore !== false ? { "Cache-Control": "private, no-store" } : {}),
  });

  const emit = async (rejection: ExportGuardRejection): Promise<void> => {
    if (!options.onRejected) return;
    try {
      await options.onRejected(rejection);
    } catch {
      /* Operator logging must never break request handling. */
    }
  };

  const checkRequest = async (rawReq: QuotaRequestLike): Promise<ExportGuardResult> => {
    const req = rawReq as ExportRequestLike;

    // Budget identity, resolved once up front: 422 rejections charge the
    // rejection floor against it, and step 4 prices against it.
    let identityKey: string | undefined;
    if (options.recordBudget) {
      identityKey = await resolveRecordBudgetIdentityKey(req, options);
      if (!identityKey && options.allowUnresolvedIdentity !== true) {
        // F-14: a wired budget with no resolvable identity must not be
        // a silent fail-open (pre-fix, every budget effect below was
        // skipped and the export ran unaccounted). Count it against
        // the shared unknown bucket instead, mirroring the quota
        // guard; the legacy skip remains only as an explicit opt-in.
        identityKey = UNRESOLVED_BUDGET_IDENTITY_KEY;
      }
    }

    const reject = async (
      kind: ExportGuardRejectionKind,
      status: number,
      body: Record<string, unknown>,
      context: { estimatedRows?: number },
    ): Promise<ExportGuardResult> => {
      await emit({
        kind,
        ...(identityKey ? { identityKey } : {}),
        ...(context.estimatedRows !== undefined ? { estimatedRows: context.estimatedRows } : {}),
        maxRowsPerExport: maxRows,
        timestamp: new Date().toISOString(),
      });
      if (status === 422 && options.recordBudget && identityKey && rejectionFloor > 0) {
        // Probing the guard is not a free oracle: price the rejection.
        try {
          options.recordBudget.charge(identityKey, rejectionFloor);
        } catch {
          /* Accounting must never break request handling. */
        }
      }
      return {
        allowed: false,
        status,
        headers: baseHeaders(),
        body,
        ...(context.estimatedRows !== undefined ? { estimatedRows: context.estimatedRows } : {}),
        ...(identityKey ? { identityKey } : {}),
      };
    };

    // 1. Filter floor: an export naming no narrowing filter is a dump.
    if (requiredFilters.length > 0) {
      let params = new URLSearchParams();
      try {
        params = new URL(req.url, "http://export.invalid").searchParams;
      } catch {
        params = new URLSearchParams();
      }
      const hasFilter = requiredFilters.some(name => {
        const value = params.get(name);
        return value !== null && value.trim() !== "";
      });
      if (!hasFilter) {
        return reject(
          "export_filter_required",
          422,
          {
            error: "export_filter_required",
            message: `Exports must narrow scope with at least one of: ${requiredFilters.join(", ")}.`,
            requireFilterParams: [...requiredFilters],
          },
          {},
        );
      }
    }

    // 2. Row estimate: host callback first, then a host-stamped property.
    let estimatedRows: number | undefined;
    if (options.estimateRows) {
      const value = await options.estimateRows(req);
      if (typeof value === "number" && Number.isFinite(value)) estimatedRows = Math.max(0, Math.floor(value));
    }
    if (estimatedRows === undefined && typeof req.antireaExportRows === "number" && Number.isFinite(req.antireaExportRows)) {
      estimatedRows = Math.max(0, Math.floor(req.antireaExportRows));
    }

    // 3. Scope cap: the single-call dump stops existing.
    if (estimatedRows !== undefined && estimatedRows > maxRows) {
      return reject(
        "export_scope_too_broad",
        422,
        {
          error: "export_scope_too_broad",
          message: `Export would return about ${estimatedRows} rows; the per-export maximum is ${maxRows}. Narrow the filter and export in slices.`,
          maxRowsPerExport: maxRows,
          estimatedRows,
        },
        { estimatedRows },
      );
    }

    // 4. Budget pricing.
    if (options.recordBudget && identityKey) {
      if (options.extractRecordIds) {
        // Per-record path: exact pricing happens in the middleware's
        // response wrap via consumeExported; pre-flight only refuses an
        // identity that is already at its cap. (The middleware adds a
        // worst-case reservation on top of this gate - see F-03 in the
        // header - so parallel exports cannot burst past the cap
        // between this check and the response.)
        const verdict = options.recordBudget.check(identityKey, 1);
        if (!verdict.allowed) {
          return reject(
            "record_budget_exceeded",
            429,
            {
              error: "record_budget_exceeded",
              message:
                "This identity has received its distinct-record budget for the current window; " +
                "narrow the export or retry after the window resets.",
              used: verdict.used,
              limit: verdict.limit,
            },
            { estimatedRows },
          );
        }
        return {
          allowed: true,
          status: 200,
          headers: {
            ...baseHeaders(),
            "X-RecordBudget-Limit": String(verdict.limit),
            "X-RecordBudget-Used": String(verdict.used),
            "X-RecordBudget-Remaining": String(verdict.remaining),
          },
          ...(estimatedRows !== undefined ? { estimatedRows } : {}),
          identityKey,
        };
      }
      if (estimatedRows !== undefined) {
        // Flat path: allowed exports pay multiplier x rows, up front.
        const cost = Math.ceil(estimatedRows * multiplier);
        const verdict = options.recordBudget.check(identityKey, cost);
        if (!verdict.allowed) {
          return reject(
            "record_budget_exceeded",
            429,
            {
              error: "record_budget_exceeded",
              message:
                "This identity has received its distinct-record budget for the current window; " +
                "narrow the export or retry after the window resets.",
              used: verdict.used,
              limit: verdict.limit,
            },
            { estimatedRows },
          );
        }
        options.recordBudget.charge(identityKey, cost);
        return {
          allowed: true,
          status: 200,
          headers: {
            ...baseHeaders(),
            "X-RecordBudget-Limit": String(verdict.limit),
            "X-RecordBudget-Used": String(verdict.used + cost),
            "X-RecordBudget-Remaining": String(Math.max(0, verdict.limit - verdict.used - cost)),
          },
          estimatedRows,
          identityKey,
        };
      }
    }

    return {
      allowed: true,
      status: 200,
      headers: baseHeaders(),
      ...(estimatedRows !== undefined ? { estimatedRows } : {}),
    };
  };

  return { checkRequest, maxRowsPerExport: maxRows };
}

/** Minimal structural Express-style request for the export middleware. */
export type ExportGuardExpressRequest = QuotaRequestLike & { exportEstimate?: number };

const WRAPPED = Symbol("antirea.exportGuardWrapped");

/**
 * Express/Connect middleware: responds with the guard's rejection
 * (422/429 + JSON body) or calls `next()` for an allowed export. When the
 * guard is wired for per-record pricing (`recordBudget` +
 * `extractRecordIds`), the response is wrapped before `next()` so the ids
 * the export actually contained are priced via `consumeExported` as it
 * completes; the wrap covers `json`, `end` and streamed `write` chunks,
 * and non-JSON bodies fall back to the flat estimate price (F-04). On
 * the same path the middleware first reserves the estimate's worst-case
 * price (F-03) and releases it at settle; a handler that never settles
 * the response (no `json`/`end`) holds its reservation until the
 * budget window rolls, exactly like `reserveUnits` in the record
 * budget's own middleware.
 */
export function createExpressExportGuardMiddleware(options: ExportGuardOptions) {
  const guard = createExportGuard(options);
  return async function exportGuardMiddleware(
    req: ExportGuardExpressRequest,
    res: QuotaExpressResponse,
    next: QuotaExpressNext,
  ): Promise<void> {
    let result: ExportGuardResult;
    try {
      result = await guard.checkRequest(req);
    } catch (err) {
      next(err);
      return;
    }
    // F-03 pre-flight reservation (per-record path only): hold the
    // worst-case price of the estimate (2 units per estimated row -
    // the price of a row this identity has never seen) while the
    // export is in flight, so N parallel exports cannot each pass the
    // at-cap gate at used=0 and jointly blow the ceiling. The
    // reservation is released when the response settles (see the wrap
    // below). A failed reservation refuses exactly like the guard's
    // own budget gate.
    let reservedUnits = 0;
    if (
      result.allowed &&
      options.recordBudget &&
      options.extractRecordIds &&
      result.identityKey &&
      result.estimatedRows !== undefined &&
      result.estimatedRows > 0
    ) {
      const worstCase = result.estimatedRows * 2;
      if (options.recordBudget.reserve(result.identityKey, worstCase)) {
        reservedUnits = worstCase;
      } else {
        const verdict = options.recordBudget.check(result.identityKey, 1);
        try {
          await options.onRejected?.({
            kind: "record_budget_exceeded",
            identityKey: result.identityKey,
            estimatedRows: result.estimatedRows,
            maxRowsPerExport: guard.maxRowsPerExport,
            timestamp: new Date().toISOString(),
          });
        } catch {
          /* Operator logging must never break request handling. */
        }
        result = {
          allowed: false,
          status: 429,
          headers: result.headers,
          body: {
            error: "record_budget_exceeded",
            message:
              "This identity has received its distinct-record budget for the current window; " +
              "narrow the export or retry after the window resets.",
            used: verdict.used,
            limit: verdict.limit,
          },
          estimatedRows: result.estimatedRows,
          identityKey: result.identityKey,
        };
      }
    }
    for (const [name, value] of Object.entries(result.headers)) {
      res.setHeader(name, value);
    }
    if (result.allowed) {
      if (result.estimatedRows !== undefined) req.exportEstimate = result.estimatedRows;
      if (options.recordBudget && options.extractRecordIds && result.identityKey) {
        const budget = options.recordBudget;
        const identityKey = result.identityKey;
        const multiplier = Math.max(0, options.budgetMultiplier ?? 2);
        const unpricedFloor = Math.max(0, Math.floor(options.unpricedBodyFloorUnits ?? 1) || 0);
        let accounted = false;
        // F-04: streamed bodies are priced too. `res.write` chunks are
        // accumulated (bounded at ~1M chars; beyond that the body is
        // simply remembered as unpriceable) and settled together with
        // the final `end()` body. Before this fix only `json()` and
        // `end(string)` were seen at all, so a CSV delivered by
        // `end(string)`, `send(string)` or `write`+`end()` cost 0.
        const streamedChunks: string[] = [];
        let streamedChars = 0;
        let streamTruncated = false;
        const noteChunk = (chunk: unknown): void => {
          try {
            const text =
              typeof chunk === "string"
                ? chunk
                : chunk instanceof Uint8Array
                  ? new TextDecoder().decode(chunk)
                  : undefined;
            if (text === undefined) return;
            if (streamedChars + text.length > 1_000_000) {
              streamTruncated = true;
              return;
            }
            streamedChunks.push(text);
            streamedChars += text.length;
          } catch {
            /* Chunk capture must never break the host response. */
          }
        };
        const settle = (rawBody: unknown): void => {
          if (accounted) return;
          accounted = true;
          try {
            let ids: readonly string[] | undefined | null;
            let unpriceable = streamTruncated;
            if (
              rawBody !== undefined &&
              rawBody !== null &&
              typeof rawBody === "object" &&
              !(rawBody instanceof Uint8Array)
            ) {
              ids = options.extractRecordIds?.(rawBody, req);
            } else {
              const tail =
                typeof rawBody === "string"
                  ? rawBody
                  : rawBody instanceof Uint8Array
                    ? new TextDecoder().decode(rawBody)
                    : "";
              const text = streamedChunks.join("") + tail;
              if (text.length > 0) {
                try {
                  ids = options.extractRecordIds?.(JSON.parse(text), req);
                } catch {
                  unpriceable = true;
                }
              }
            }
            if (ids && ids.length > 0) {
              budget.consumeExported(identityKey, ids);
            } else if (unpriceable) {
              // F-04: a body the per-record extractor cannot price
              // (CSV, plain text, streamed chunks) is charged the
              // flat estimate price - the same price the estimate-only
              // path would have charged for these rows - or the
              // configured floor when no estimate was wired.
              const est = result.estimatedRows;
              if (est !== undefined && est > 0) budget.charge(identityKey, Math.ceil(est * multiplier));
              else if (unpricedFloor > 0) budget.charge(identityKey, unpricedFloor);
            }
          } catch {
            /* Accounting must never break the host response. */
          } finally {
            // F-03: the in-flight reservation always comes back.
            if (reservedUnits > 0) {
              try {
                budget.release(identityKey, reservedUnits);
              } catch {
                /* Accounting must never break the host response. */
              }
              reservedUnits = 0;
            }
          }
        };
        const wrapTarget = (target: QuotaExpressResponse): void => {
          const marked = target as QuotaExpressResponse & { [WRAPPED]?: boolean };
          if (marked[WRAPPED]) return;
          marked[WRAPPED] = true;
          if (typeof target.json === "function") {
            const originalJson = target.json.bind(target);
            target.json = (body: unknown) => {
              settle(body);
              return originalJson(body);
            };
          }
          const writable = target as QuotaExpressResponse & {
            write?: (chunk: unknown, ...rest: unknown[]) => unknown;
          };
          if (typeof writable.write === "function") {
            const originalWrite = writable.write.bind(target);
            writable.write = (chunk: unknown, ...rest: unknown[]) => {
              noteChunk(chunk);
              return originalWrite(chunk, ...rest);
            };
          }
          if (typeof target.end === "function") {
            const originalEnd = target.end.bind(target);
            target.end = (body?: string) => {
              settle(body);
              return originalEnd(body);
            };
          }
        };
        wrapTarget(res);
        if (typeof res.status === "function") {
          const originalStatus = res.status.bind(res);
          res.status = (code: number) => {
            const chained = originalStatus(code);
            if (chained && chained !== res && typeof chained === "object") {
              wrapTarget(chained as QuotaExpressResponse);
              return chained;
            }
            return chained ?? res;
          };
        }
      }
      next();
      return;
    }
    const body = result.body ?? { error: "export_scope_too_broad" };
    if (typeof res.status === "function") {
      const chained = res.status(result.status);
      if (chained && typeof chained.json === "function") {
        chained.json(body);
        return;
      }
    }
    if (typeof res.json === "function") {
      res.json(body);
      return;
    }
    res.statusCode = result.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
}
