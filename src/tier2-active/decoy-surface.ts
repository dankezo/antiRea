/**
 * Decoy surface runtime (antiRea 3.3.0) - OPT-IN, default OFF.
 * Serves the surface generated from a host registry
 * (`decoy-registry.ts`): the discovery documents (A1), the
 * OpenAPI decoy document (A2), contradiction feeds and worked
 * examples (A3/A5, as declared live endpoints and generated
 * payloads), identity-gated join sets (A7, via `decoy-joins.ts`)
 * and budget-sink expandables (A8, via `decoy-expandables.ts`).
 *
 * CONTRACT, in the fake-endpoints discipline:
 * - Disabled (no `enabled: true`), the handler reports
 *   `handled: false` for every request, so a host that enables
 *   nothing routes exactly as it did on 3.2.0 - byte-identical
 *   real behavior is the default, not a configuration.
 * - Enabled, it owns exactly the generated surface's paths
 *   (see `decoySurfacePaths`); any other path is `handled:
 *   false` and the host's routing continues. It must never be
 *   mounted on a real route.
 * - GET and HEAD only; other methods on owned paths are 405
 *   before any decoy logic and produce no log entries.
 * - Phantom endpoints are `handled: true` with a plain 404:
 *   they exist in the spec and the docs, never on the wire.
 * - Expandable requests bill their synthetic subresource ids
 *   through the host's `billExpansion` callback BEFORE serving;
 *   a denial answers 429 with the record-budget error shape.
 *   With no callback the expansion still serves and the result
 *   reports `billed: false` - the degradation is visible, never
 *   silent (see the A8 module header for why billing is the
 *   load-bearing part).
 * - Identity for join gating and billing comes from the host's
 *   `identityOf` resolver; the default reads the `x-identity`
 *   header (the range convention) and falls back to
 *   "anonymous".
 * - Every served decoy response is logged through `onLog` in a
 *   fixed shape; a throwing sink never breaks the host.
 *
 * This module serves decoy content only. It detects, blocks
 * and bans nothing; budget denials surface only because the
 * host's own billing callback said no.
 */

import type { CanaryRequest } from "./honeypot-middleware";
import {
  buildDecoyOpenApiSpec,
  decoySurfacePaths,
  renderDecoyRobots,
  renderDecoySitemap,
  workedExamplePayload,
  type DecoySurface,
  type DecoyWorkedExampleDecl as DecoyWorkedExample,
} from "./decoy-registry";
import { gateRecordIds } from "./decoy-joins";
import { generateFixedSubresources, generateSubresources, type SyntheticSubresource } from "./decoy-expandables";

export interface DecoySurfaceLogEntry {
  source: "decoy-surface";
  kind: "robots" | "sitemap" | "spec" | "docs" | "endpoint" | "page" | "join" | "example" | "expand";
  path: string;
  ua: string | null;
  method: string;
}

export interface DecoySurfaceOptions {
  /** The pack serves only when this is exactly `true`. Default false (OFF). */
  enabled?: boolean;
  /** The generated surface (from `generateDecoySurface`). Required when enabled. */
  surface?: DecoySurface;
  /** Secret for identity-gated join ids (A7). Required when the surface declares join sets and the pack is enabled. */
  joinSecret?: string | Uint8Array;
  /** Seed for deterministic expansion content (A8). Defaults to a fixed string - hosts should set their own. */
  surfaceSeed?: string;
  /** Resolve the requesting identity (join gating, billing). Default: `x-identity` header, else "anonymous". */
  identityOf?: (request: CanaryRequest) => string | null | undefined;
  /**
   * Bill synthetic subresource ids to the identity's budget
   * (A8). Return false (or resolve false) to deny: the surface
   * answers 429. Wire this to the same budget that meters real
   * records - in the lab twin it was antiRea's record budget.
   */
  billExpansion?: (identity: string, subresourceIds: string[]) => boolean | Promise<boolean>;
  /** Sink for decoy log entries. A throwing sink never breaks the host. */
  onLog?: (entry: DecoySurfaceLogEntry) => Promise<void> | void;
}

export interface DecoySurfaceResult {
  handled: boolean;
  isDecoy: boolean;
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
  /** Expansion results only: whether the subresources were billed through the host callback. */
  billed?: boolean;
  /** Expansion results only: the synthetic subresource ids generated (and billed, when billed). */
  expansionIds?: string[];
}

export class DecoySurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoySurfaceError";
  }
}

const NOT_HANDLED: DecoySurfaceResult = {
  handled: false, isDecoy: false, status: 404, body: "", contentType: "text/plain; charset=utf-8", headers: {},
};

function parseRequestUrl(raw: string): { pathname: string; searchParams: URLSearchParams } {
  const fallback = { pathname: "/", searchParams: new URLSearchParams() };
  if (!raw || typeof raw !== "string") return fallback;
  try {
    const url = new URL(raw, "http://decoy.invalid");
    return { pathname: url.pathname, searchParams: url.searchParams };
  } catch {
    const [pathPart, queryPart] = raw.split("?", 2);
    return { pathname: pathPart || "/", searchParams: new URLSearchParams(queryPart ?? "") };
  }
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** The generated human-readable docs page: endpoint index, contradiction endorsements, documented worked-example rules. */
export function renderDecoyDocsPage(surface: DecoySurface): string {
  const items: string[] = [];
  for (const p of surface.realPaths) items.push(`<li><a href="${esc(p)}">${esc(p)}</a></li>`);
  for (const ep of surface.endpoints) items.push(`<li><a href="${esc(ep.path)}">${esc(ep.path)}</a> - ${esc(ep.summary ?? ep.kind)}</li>`);
  for (const js of surface.joinSets) {
    items.push(`<li><a href="${esc(js.parentPath)}">${esc(js.parentPath)}</a></li>`);
    items.push(`<li><a href="${esc(js.childPath)}">${esc(js.childPath)}</a> - records reference the directory by id; join on that field to resolve details.</li>`);
  }
  const endorsements = surface.contradictions
    .map((c) => `<h3>Partner feed</h3><p>${esc(c.endorsement)}</p><p><a href="${esc(c.feedPath)}">Partner feed (JSON)</a></p>`)
    .join("");
  const examples = surface.workedExamples
    .map((w) => {
      const steps = w.stepsPct.map((pct) => `x ${(1 - pct / 100).toFixed(2)}`).join(" ");
      const documented = Math.round(w.stepsPct.reduce((acc, pct) => acc * (1 - pct / 100), w.subtotal));
      return `<h3>Worked example</h3><p>Documented rule: apply the percentage steps sequentially. Example: ${w.subtotal} ${steps} = ${documented}${w.currency ? ` ${esc(w.currency)}` : ""}. <a href="${esc(w.path)}">Calculation example (JSON)</a></p>`;
    })
    .join("");
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>API Documentation</title></head><body>` +
    `<h2>API Documentation</h2><p>The machine-readable specification is the canonical description of this API: <a href="${esc(surface.specPath)}">OpenAPI specification (JSON)</a></p>` +
    `<ul>${items.join("")}</ul>${endorsements}${examples}</body></html>\n`
  );
}

export interface DecoySurfaceHandler {
  readonly enabled: boolean;
  /** Every path the surface owns, in registration order. */
  readonly paths: readonly string[];
  handle: (request: CanaryRequest) => Promise<DecoySurfaceResult>;
}

/** Create the decoy surface handler. See the module header for the full contract. */
export function createDecoySurface(opts: DecoySurfaceOptions = {}): DecoySurfaceHandler {
  const enabled = opts.enabled === true;
  const surface = opts.surface;
  if (enabled && !surface) throw new DecoySurfaceError("createDecoySurface: surface is required when enabled");
  if (enabled && surface && surface.joinSets.length > 0 && opts.joinSecret === undefined) {
    throw new DecoySurfaceError("createDecoySurface: joinSecret is required when the surface declares join sets (A7 ids are keyed)");
  }
  const seed = opts.surfaceSeed ?? "antirea-decoy-surface";
  const owned = new Set<string>(surface ? decoySurfacePaths(surface) : []);
  const identityOf = opts.identityOf ?? ((request: CanaryRequest) => request.headers.get("x-identity") ?? "anonymous");

  const log = async (request: CanaryRequest, kind: DecoySurfaceLogEntry["kind"], path: string): Promise<void> => {
    try {
      await opts.onLog?.({ source: "decoy-surface", kind, path, ua: request.headers.get("user-agent") ?? null, method: request.method ?? "GET" });
    } catch {
      /* monitoring must never break the host */
    }
  };

  const json = (status: number, value: unknown): DecoySurfaceResult => ({
    handled: true, isDecoy: true, status, body: JSON.stringify(value), contentType: "application/json; charset=utf-8", headers: {},
  });

  const handle = async (request: CanaryRequest): Promise<DecoySurfaceResult> => {
    if (!enabled || !surface) return NOT_HANDLED;
    const { pathname, searchParams } = parseRequestUrl(request.url);
    if (!owned.has(pathname)) return NOT_HANDLED;
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      return {
        handled: true, isDecoy: false, status: 405, body: "method not allowed",
        contentType: "text/plain; charset=utf-8", headers: { allow: "GET, HEAD" },
      };
    }
    const head = method === "HEAD";
    const finish = async (result: DecoySurfaceResult, kind: DecoySurfaceLogEntry["kind"]): Promise<DecoySurfaceResult> => {
      await log(request, kind, pathname);
      return head ? { ...result, body: "" } : result;
    };

    if (pathname === "/robots.txt") {
      return finish({ handled: true, isDecoy: true, status: 200, body: renderDecoyRobots(surface), contentType: "text/plain; charset=utf-8", headers: {} }, "robots");
    }
    if (pathname === "/sitemap.xml") {
      return finish({ handled: true, isDecoy: true, status: 200, body: renderDecoySitemap(surface), contentType: "application/xml; charset=utf-8", headers: {} }, "sitemap");
    }
    if (pathname === surface.specPath) return finish(json(200, buildDecoyOpenApiSpec(surface)), "spec");
    if (pathname === surface.docsPath) {
      return finish({ handled: true, isDecoy: true, status: 200, body: renderDecoyDocsPage(surface), contentType: "text/html; charset=utf-8", headers: {} }, "docs");
    }

    // Worked examples (A5) are generated live endpoints. An
    // expandable declared on the example's path (the trial's
    // discount breakdown) intercepts below, before this return.
    const example = surface.workedExamples.find((w) => w.path === pathname);
    const exampleExpansion = example
      ? surface.expandables.find((x) => x.path === pathname && searchParams.get(x.param) === x.value)
      : undefined;
    if (example && !exampleExpansion) return finish(json(200, workedExamplePayload(example)), "example");

    // Identity-gated join sets (A7): ids rewritten for the requesting identity.
    const joinSet = surface.joinSets.find((js) => js.parentPath === pathname || js.childPath === pathname);
    if (joinSet) {
      const identity = identityOf(request) ?? "anonymous";
      const secret = opts.joinSecret as string | Uint8Array;
      if (pathname === joinSet.parentPath) {
        return finish(json(200, { records: gateRecordIds(joinSet.parents, secret, identity, [joinSet.parentIdField]) }), "join");
      }
      return finish(json(200, { records: gateRecordIds(joinSet.children, secret, identity, [joinSet.childFkField]) }), "join");
    }

    const endpoint = surface.endpoints.find((ep) => ep.path === pathname);
    if (!endpoint && !example) return NOT_HANDLED;

    // Expandables (A8) intercept before the plain payload when the declared query matches.
    const expansion = surface.expandables.find(
      (x) => x.path === pathname && searchParams.get(x.param) === x.value,
    );
    if (expansion && (endpoint?.kind === "live" || example)) {
      const identity = identityOf(request) ?? "anonymous";
      const base = endpoint?.kind === "live" ? endpoint.payload : workedExamplePayload(example as DecoyWorkedExample);
      const payload = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      const subs: SyntheticSubresource[] = [];
      const arrayKey = Object.keys(payload).find((k) => Array.isArray(payload[k]));
      if (expansion.subsPerRecord !== undefined && arrayKey) {
        const records = payload[arrayKey] as Array<Record<string, unknown>>;
        payload[arrayKey] = records.map((record, i) => {
          const baseId = String(record["id"] ?? record["sku"] ?? record["orderRef"] ?? record["storeId"] ?? i);
          const generated = generateSubresources({ seed, path: pathname, kind: expansion.kind, baseId, count: expansion.subsPerRecord as number });
          subs.push(...generated);
          return { ...record, [expansion.attachAs]: generated };
        });
      } else if (expansion.fixedSubs !== undefined) {
        const generated = generateFixedSubresources({ seed, path: pathname, kind: expansion.kind, count: expansion.fixedSubs });
        subs.push(...generated);
        payload[expansion.attachAs] = generated;
      }
      const ids = subs.map((s) => s.id);
      let billed = false;
      if (opts.billExpansion) {
        billed = (await opts.billExpansion(identity, ids)) === true;
        if (!billed) {
          return {
            handled: true, isDecoy: true, status: 429,
            body: JSON.stringify({ error: "record_budget_exceeded" }),
            contentType: "application/json; charset=utf-8", headers: {}, billed: false, expansionIds: ids,
          };
        }
      }
      const result = json(200, payload);
      result.billed = billed;
      result.expansionIds = ids;
      return finish(result, "expand");
    }

    if (!endpoint) return NOT_HANDLED; // worked-example paths returned above
    if (endpoint.kind === "phantom") {
      // Declared in spec and docs, never served.
      return { handled: true, isDecoy: false, status: 404, body: "not found", contentType: "text/plain; charset=utf-8", headers: {} };
    }
    if (endpoint.kind === "page") {
      return finish({ handled: true, isDecoy: true, status: 200, body: endpoint.html ?? "", contentType: "text/html; charset=utf-8", headers: {} }, "page");
    }
    return finish(json(200, endpoint.payload), "endpoint");
  };

  return { enabled, paths: surface ? decoySurfacePaths(surface) : [], handle };
}
