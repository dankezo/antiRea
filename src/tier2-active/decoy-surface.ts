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
 *
 * 3.3.1 ADDITIONS, under the same contract:
 * - Provenance chains (B2): every chain record is served at
 *   its individual route, wrapped as declared. When the host
 *   passes `billChainRecord`, each chain serve is billed
 *   through it BEFORE serving and a denial answers the same
 *   429 record-budget shape as expansions; without a callback
 *   the serve reports `billed: false` in the result - the
 *   degradation is visible, never silent, exactly as for A8.
 * - GraphQL decoy (B3): the declared GraphQL path answers GET
 *   with the schema as an introspection document (the
 *   measured carrier - see decoy-graphql.ts). It answers
 *   nothing else: this surface ships no GraphQL execution.
 * - Identity variants (B4): a live endpoint with a variant
 *   declaration serves its record list transformed for the
 *   requesting identity (skew subsets, enum remapping, field
 *   aliases - see decoy-identity-variants.ts). Serving a
 *   surface that declares variants requires `variantSecret`,
 *   checked at construction like `joinSecret`.
 * - Surface-wide image watermarking (B5): the surface serves
 *   every image declared in the registry at its path, as a
 *   grayscale PNG. When the host enables `watermarkImages`
 *   (with `watermarkSecret`), EVERY image served - not only a
 *   hero image - carries the requesting identity's AC-23
 *   Y-DCT payload, embedded at serve time; with the option
 *   off, the declared plane is served exactly as declared.
 *   Enabling watermarking on a surface that declares an image
 *   too small to carry the payload fails at construction.
 *   The watermark is attribution, not recording prevention -
 *   see decoy-images.ts for the measured basis and its scope
 *   notes.
 * - Visible fingerprint (B6): when the host enables
 *   `fingerprintVisible` (with `fingerprintSecret`), the
 *   record lists of live decoy endpoints are served with the
 *   requesting identity's visible fingerprint woven in - a
 *   token and a stock phrase in the records' text, and a
 *   per-identity rotation of the list order (see
 *   decoy-fingerprint.ts). The fingerprint exists only inside
 *   this serving path: it is applied to decoy lists only,
 *   never to any other response the surface serves, and a
 *   host that does not enable it gets byte-identical serves.
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
import { buildChainRouteMap, type ChainRouteEntry } from "./decoy-fanout";
import { buildGraphqlIntrospection } from "./decoy-graphql";
import { applyIdentityVariants } from "./decoy-identity-variants";
import { decoyImageCarriesAc23, encodeGrayscalePng, type DecoyImageDecl } from "./decoy-images";
import { applyVisibleFingerprint } from "./decoy-fingerprint";
import { embedYDctWatermarkForIdentity } from "../tier4-forensic/screenshot-watermark-attribution";

export interface DecoySurfaceLogEntry {
  source: "decoy-surface";
  kind: "robots" | "sitemap" | "spec" | "docs" | "endpoint" | "page" | "join" | "example" | "expand" | "chain" | "graphql" | "image";
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
  /** Secret for identity-bound variant classes (B4). Required when the surface declares identity variants and the pack is enabled. */
  variantSecret?: string | Uint8Array;
  /**
   * Watermark EVERY image the surface serves (B5) with the
   * requesting identity's AC-23 Y-DCT payload. Only exactly
   * `true` enables it. Default false (OFF): declared images
   * are served exactly as declared.
   */
  watermarkImages?: boolean;
  /** Secret for the per-identity image payloads (B5). Required when `watermarkImages` is on and the surface declares images. */
  watermarkSecret?: string | Uint8Array;
  /**
   * Weave the requesting identity's visible fingerprint (B6)
   * into the record lists of live decoy endpoints: token and
   * stock phrase in the records' text, per-identity list
   * rotation. Only exactly `true` enables it. Default false
   * (OFF): lists are served byte-identically to the plain
   * surface.
   */
  fingerprintVisible?: boolean;
  /** Secret for the visible fingerprint derivation (B6). Required when `fingerprintVisible` is on and the pack is enabled. */
  fingerprintSecret?: string | Uint8Array;
  /** Record field the B6 weave lands on when it holds a string (default resolution: "title", then "name", then the first string field). */
  fingerprintTextField?: string;
  /**
   * Bill one chain record serve (B2) to the identity's budget,
   * before serving. Return false (or resolve false) to deny:
   * the surface answers 429 with the record-budget error shape.
   * With no callback, chain serves report `billed: false`.
   */
  billChainRecord?: (identity: string, recordId: string, path: string) => boolean | Promise<boolean>;
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
  /** Binary serves only (declared images, B5): the response bytes. When present, `body` is empty and the host writes these bytes instead. */
  bodyBytes?: Uint8Array;
  contentType: string;
  headers: Record<string, string>;
  /** Expansion and chain results only: whether the serve was billed through the host callback. */
  billed?: boolean;
  /** Expansion results only: the synthetic subresource ids generated (and billed, when billed). */
  expansionIds?: string[];
  /** Chain results only: the id of the chain record served (the value hosts bill against). */
  chainRecordId?: string;
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
  for (const img of surface.images) items.push(`<li><a href="${esc(img.path)}">${esc(img.path)}</a> - ${esc(img.summary ?? "image")}</li>`);
  for (const js of surface.joinSets) {
    items.push(`<li><a href="${esc(js.parentPath)}">${esc(js.parentPath)}</a></li>`);
    items.push(`<li><a href="${esc(js.childPath)}">${esc(js.childPath)}</a> - records reference the directory by id; join on that field to resolve details.</li>`);
  }
  for (const chain of surface.chains) {
    for (const level of chain.levels) {
      for (const record of level.records) {
        const route = level.route.split("{id}").join(String(record[level.idField]));
        items.push(`<li><a href="${esc(route)}">${esc(route)}</a> - provenance record; follow its references for the full chain.</li>`);
      }
    }
  }
  if (surface.graphql) {
    const gqlPath = surface.graphql.path ?? "/graphql";
    items.push(`<li><a href="${esc(gqlPath)}">${esc(gqlPath)}</a> - GraphQL endpoint; the schema is available via introspection.</li>`);
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
  if (enabled && surface && surface.identityVariants.length > 0 && opts.variantSecret === undefined) {
    throw new DecoySurfaceError("createDecoySurface: variantSecret is required when the surface declares identity variants (B4 classes are keyed)");
  }
  const watermarkOn = opts.watermarkImages === true;
  if (enabled && watermarkOn && surface && surface.images.length > 0) {
    if (opts.watermarkSecret === undefined) {
      throw new DecoySurfaceError("createDecoySurface: watermarkSecret is required when watermarkImages is on (B5 payloads are keyed)");
    }
    for (const img of surface.images) {
      if (!decoyImageCarriesAc23(img.width, img.height)) {
        throw new DecoySurfaceError(
          `createDecoySurface: declared image ${img.path} (${img.width}x${img.height}) cannot carry the AC-23 payload ` +
          "(dimensions must be multiples of 8 with at least 32 x 48 blocks); disable watermarkImages or replace the image",
        );
      }
    }
  }
  const fingerprintOn = opts.fingerprintVisible === true;
  if (enabled && fingerprintOn && opts.fingerprintSecret === undefined) {
    throw new DecoySurfaceError("createDecoySurface: fingerprintSecret is required when fingerprintVisible is on (B6 fingerprints are keyed)");
  }
  const imageMap = new Map<string, DecoyImageDecl>();
  if (surface) for (const img of surface.images) imageMap.set(img.path, img);
  const chainMap = new Map<string, ChainRouteEntry>();
  if (surface) {
    for (const chain of surface.chains) {
      for (const [route, entry] of buildChainRouteMap(chain)) chainMap.set(route, entry);
    }
  }
  const graphqlPath = surface?.graphql ? (surface.graphql.path ?? "/graphql") : null;
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
      return head ? { ...result, body: "", ...(result.bodyBytes ? { bodyBytes: new Uint8Array(0) } : {}) } : result;
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

    // Declared images (B5): served as grayscale PNGs. With
    // watermarking on, EVERY image carries the requesting
    // identity's AC-23 payload - embedded here, at serve time,
    // into a copy of the declared plane; the registry's plane
    // is never mutated.
    const image = imageMap.get(pathname);
    if (image) {
      let y: ArrayLike<number> = image.y;
      if (watermarkOn) {
        const identity = identityOf(request) ?? "anonymous";
        y = embedYDctWatermarkForIdentity(
          { width: image.width, height: image.height, y: image.y },
          opts.watermarkSecret as string | Uint8Array,
          identity,
        );
      }
      const png = encodeGrayscalePng({ width: image.width, height: image.height, y });
      return finish(
        { handled: true, isDecoy: true, status: 200, body: "", bodyBytes: png, contentType: "image/png", headers: {} },
        "image",
      );
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

    // GraphQL decoy (B3): GET answers with the schema as an
    // introspection document - the measured carrier. Nothing
    // else is executed; there is no GraphQL runtime here.
    if (graphqlPath && pathname === graphqlPath && surface.graphql) {
      return finish(json(200, buildGraphqlIntrospection(surface.graphql)), "graphql");
    }

    // Provenance chains (B2): each record at its individual
    // route, billed through the host callback when one is wired.
    const chainEntry = chainMap.get(pathname);
    if (chainEntry) {
      const identity = identityOf(request) ?? "anonymous";
      const recordId = String(chainEntry.record[chainEntry.level.idField]);
      let billed = false;
      if (opts.billChainRecord) {
        billed = (await opts.billChainRecord(identity, recordId, pathname)) === true;
        if (!billed) {
          return {
            handled: true, isDecoy: true, status: 429,
            body: JSON.stringify({ error: "record_budget_exceeded" }),
            contentType: "application/json; charset=utf-8", headers: {}, billed: false, chainRecordId: recordId,
          };
        }
      }
      const result = json(200, { [chainEntry.level.wrapKey ?? "record"]: chainEntry.record });
      result.billed = billed;
      result.chainRecordId = recordId;
      return finish(result, "chain");
    }

    const endpoint = surface.endpoints.find((ep) => ep.path === pathname);
    if (!endpoint && !example) return NOT_HANDLED;

    // Identity variants (B4): a live endpoint with a variant
    // declaration serves its record list reshaped for the
    // requesting identity's variant class.
    const variantDecl = endpoint?.kind === "live"
      ? surface.identityVariants.find((v) => v.path === pathname)
      : undefined;
    const servedPayload = ((): unknown => {
      if (!endpoint || endpoint.kind !== "live") return endpoint?.payload;
      let payload: unknown = endpoint.payload;
      if (variantDecl) {
        const identity = identityOf(request) ?? "anonymous";
        const secret = opts.variantSecret as string | Uint8Array;
        if (Array.isArray(payload)) {
          payload = applyIdentityVariants(payload as Array<Record<string, unknown>>, variantDecl, secret, identity);
        } else if (payload && typeof payload === "object") {
          const copy = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
          const arrayKey = Object.keys(copy).find((k) => Array.isArray(copy[k]));
          if (arrayKey) {
            copy[arrayKey] = applyIdentityVariants(copy[arrayKey] as Array<Record<string, unknown>>, variantDecl, secret, identity);
          }
          payload = copy;
        }
      }
      // Visible fingerprint (B6): woven into the decoy record
      // list only, after any variant reshaping, and only when
      // the host enabled it. With the option off this block
      // never runs and the serve is byte-identical to the
      // plain surface.
      if (fingerprintOn) {
        const identity = identityOf(request) ?? "anonymous";
        const secret = opts.fingerprintSecret as string | Uint8Array;
        const fpOpts = { textField: opts.fingerprintTextField };
        if (Array.isArray(payload)) {
          return applyVisibleFingerprint(payload as Array<Record<string, unknown>>, secret, identity, fpOpts);
        }
        if (payload && typeof payload === "object") {
          const copy = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
          const arrayKey = Object.keys(copy).find((k) => Array.isArray(copy[k]));
          if (arrayKey) {
            copy[arrayKey] = applyVisibleFingerprint(copy[arrayKey] as Array<Record<string, unknown>>, secret, identity, fpOpts);
          }
          return copy;
        }
      }
      return payload;
    })();

    // Expandables (A8) intercept before the plain payload when the declared query matches.
    const expansion = surface.expandables.find(
      (x) => x.path === pathname && searchParams.get(x.param) === x.value,
    );
    if (expansion && (endpoint?.kind === "live" || example)) {
      const identity = identityOf(request) ?? "anonymous";
      const base = endpoint?.kind === "live" ? servedPayload : workedExamplePayload(example as DecoyWorkedExample);
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
    return finish(json(200, servedPayload), "endpoint");
  };

  return { enabled, paths: surface ? decoySurfacePaths(surface) : [], handle };
}
