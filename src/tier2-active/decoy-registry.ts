/**
 * Decoy surface registry (antiRea 3.3.0) - the shared, pure core of
 * the 3.3 decoy surface: a host-written registry declares the decoy
 * surface once, and this module validates it and derives every
 * static artifact from it (robots additions, sitemap, the OpenAPI
 * decoy document, contradiction feeds, worked examples). The
 * runtime server lives in `decoy-surface.ts`; the build-time CLI
 * lives in `tools/decoy/decoy.cjs` (DEC-3: build-time tooling
 * first, like the 3.2.0 polymorph generator). The tool and this
 * module are two implementations of the same renders, and the
 * test suite pins them to identical outputs.
 *
 * WHAT THE SURFACE IS. A set of routes and documents that describe
 * a system which does not exist, planted where automated
 * extractors look and legitimate users do not: robots.txt
 * Disallow lines and sitemap-only entries (A1, the discovery
 * pack), an OpenAPI document carrying live decoys and phantom
 * endpoints (A2, the spec decoy), a partner feed whose prices
 * contradict the catalog while the spec endorses the feed as
 * canonical (A3, the contradiction combo), worked calculation
 * examples whose served result disagrees with the documented
 * rule (A5), plus the data-layer declarations served by the
 * sibling modules (canary dose in `canary-dose.ts`, invariant
 * sets in `decoy-invariants.ts`, identity-gated joins in
 * `decoy-joins.ts`, budget-sink expandables in
 * `decoy-expandables.ts`).
 *
 * MEASURED BASIS (lab twins, REA 6.9.0 on defaults, SDK metering
 * at 150 records per identity): machine-only discovery channels
 * carried 8/8 planted decoys into the extractor's capture with
 * zero user-visible footprint (decoy-map trial v2, MAP arm); a
 * fake spec alone carried 4/4 live decoys and 2/2 phantoms (v2
 * SPEC arm, replicated in v3); the spec-endorsed contradiction
 * produced 36 authoritative contradiction pairs while each
 * component alone produced 0 (v2 COMBO arm); the worked example
 * sat next to the correct documented rule unflagged (v2 CONTRA
 * arm). In the agent-loop trial (gpt-5.4 driving a real HTTP
 * loop) the decoy surface raised the median session cost from
 * 7,101 to 14,808 tokens (2.09x). These numbers describe the
 * lab twins; they are not a promise about any other site.
 *
 * DISCLOSURE. This surface is a deliberate protective measure
 * and is documented publicly in docs/PROTECTIVE_DECOYS.md and
 * SECURITY.md: decoy content is fictional by design, is never
 * part of a host's real API contract, and is never mixed into
 * real responses. Nothing in this module serves, detects or
 * blocks anything by itself; it only describes and renders.
 *
 * 3.3.1 ADDITIONS (same registry, three more declaration
 * families, each measured in decoy-map trial v4 before the
 * scope froze): provenance chains (B2, `decoy-fanout.ts`) -
 * decoy records referencing further decoy record routes, so
 * traversal itself spends the extractor's metered fetches; a
 * GraphQL declaration (B3, `decoy-graphql.ts`) - phantom
 * types, phantom Query fields and decoy fields on real types,
 * served by the endpoint as an introspection document (the
 * measured carrier; the spec carries the same schema as an
 * SDL extension and declares the path); and identity-bound
 * variants (B4, `decoy-identity-variants.ts`) - one decoy list
 * served in per-identity shapes (skew-field subsets, enum
 * subsets, field aliases). The v4 numbers and their caveats
 * live in the sibling modules' headers and in the 3.3.1
 * changelog entry; the fan-out yield figure in particular is
 * accounting-dependent and is never quoted bare.
 *
 * B5 ADDITION (same registry, one more declaration family,
 * measured in the VID-TRACE trial before it was built):
 * images (`decoy-images.ts`) - decoy images declared as
 * luminance planes and served by the surface as PNGs, so the
 * surface's watermark option can sign every image it serves,
 * not only a hero image. The B6 visible fingerprint has no
 * registry family: it is a surface option over the record
 * lists this registry already declares (see
 * `decoy-fingerprint.ts`).
 */

import {
  validateDecoyChainDecl,
  chainRoutes,
  type DecoyChainDecl,
} from "./decoy-fanout";
import {
  validateDecoyGraphqlDecl,
  renderGraphqlSdl,
  type DecoyGraphqlDecl,
} from "./decoy-graphql";
import {
  validateDecoyIdentityVariantDecl,
  type DecoyIdentityVariantDecl,
} from "./decoy-identity-variants";
import {
  validateDecoyImageDecl,
  type DecoyImageDecl,
} from "./decoy-images";

/* ------------------------------------------------------------------------ */
/* Registry shape.                                                          */
/* ------------------------------------------------------------------------ */

export type DecoyEndpointKind = "live" | "phantom" | "page";

export interface DecoyEndpointDecl {
  /** Absolute path, e.g. "/api/v2/products". Exact match, like the fake-endpoints pack. */
  path: string;
  /** live = served 200 with `payload`; phantom = declared (e.g. in the spec) but never served; page = served as HTML. */
  kind: DecoyEndpointKind;
  /** JSON payload for kind "live". */
  payload?: unknown;
  /** HTML body for kind "page". */
  html?: string;
  /** One-line summary used in the generated spec and docs page. */
  summary?: string;
}

export interface DecoyDiscoveryDecl {
  /** Decoy paths named only in robots.txt Disallow lines (A1). Each must also be a declared endpoint. */
  disallowPaths?: string[];
  /** Decoy paths listed only in the generated sitemap (A1). Each must also be a declared endpoint. */
  sitemapPaths?: string[];
  /** Real paths the host wants listed in the generated sitemap alongside the decoy entries. */
  sitemapRealPaths?: string[];
}

export interface DecoySpecDecl {
  title?: string;
  version?: string;
  /** The host's real paths to mirror into the decoy spec (paths only; the decoy spec never describes real behavior). */
  realPaths?: string[];
  /** Path the generated spec document is served at. Default "/openapi.json". */
  specPath?: string;
  /** Path of the generated human-readable docs page. Default "/api-docs". */
  docsPath?: string;
}

export interface DecoyContradictionDecl {
  /** Path of the contradicting partner feed (must be a declared live endpoint or a join-free path served by the host). */
  feedPath: string;
  /** Price multiplier applied to real prices to build the feed (the trials used 0.82). */
  priceFactor: number;
  /** Endorsement text the generated spec and docs page carry for the feed (A3: the spec vouches for the feed). */
  endorsement: string;
}

export interface DecoyWorkedExampleDecl {
  /** Path the worked example is served at (declared as a live endpoint by the generator, not by hand). */
  path: string;
  /** Subtotal the example computes over. */
  subtotal: number;
  /** Percentage steps of the DOCUMENTED rule, applied sequentially (e.g. [15, 5] = 15% off, then 5% off the remainder). */
  stepsPct: number[];
  /** The total the decoy endpoint actually serves. Must differ from the documented sequential total (that difference is A5). */
  servedTotal: number;
  /** Currency label carried in the payload. */
  currency?: string;
  /** Tier label carried in the payload. */
  tier?: string;
}

export interface DecoyJoinSetDecl {
  /** Path serving the parent records (e.g. suppliers). */
  parentPath: string;
  /** Path serving the child records (e.g. contracts). */
  childPath: string;
  /** Field on parent records holding the (templated) id. */
  parentIdField: string;
  /** Field on child records holding the foreign key to the parent id. */
  childFkField: string;
  /** Parent records; ids use the "{tag}" template (see decoy-joins.ts). */
  parents: Array<Record<string, unknown>>;
  /** Child records; foreign keys use the same "{tag}" template. */
  children: Array<Record<string, unknown>>;
}

export interface DecoyExpandableDecl {
  /** Base decoy endpoint path the expansion attaches to (must be a declared live endpoint or a join-set path). */
  path: string;
  /** Query parameter that triggers the expansion, e.g. "expand" or "include". */
  param: string;
  /** Query value that triggers the expansion, e.g. "supplier". */
  value: string;
  /** Field the expanded subresources are attached under in the response. */
  attachAs: string;
  /** Synthetic subresources generated per base record (billed ids: one per subresource). */
  subsPerRecord?: number;
  /** Fixed synthetic subresources for record-less endpoints (e.g. a calculation breakdown). */
  fixedSubs?: number;
  /** Subresource kind label used in ids and payloads, e.g. "supplier". */
  kind: string;
}

export interface DecoyRegistry {
  formatVersion: 1;
  discovery?: DecoyDiscoveryDecl;
  endpoints?: DecoyEndpointDecl[];
  spec?: DecoySpecDecl;
  contradictions?: DecoyContradictionDecl[];
  workedExamples?: DecoyWorkedExampleDecl[];
  joinSets?: DecoyJoinSetDecl[];
  expandables?: DecoyExpandableDecl[];
  /** Provenance chains (3.3.1, B2): decoy records referencing further decoy record routes. See decoy-fanout.ts. */
  chains?: DecoyChainDecl[];
  /** GraphQL decoy declaration (3.3.1, B3): phantom schema served as introspection. See decoy-graphql.ts. */
  graphql?: DecoyGraphqlDecl;
  /** Identity-bound variants (3.3.1, B4): per-identity shapes for declared live endpoints. See decoy-identity-variants.ts. */
  identityVariants?: DecoyIdentityVariantDecl[];
  /** Decoy images (3.3.1, B5): luminance planes the surface serves as PNGs at their declared paths. See decoy-images.ts. */
  images?: DecoyImageDecl[];
}

/* ------------------------------------------------------------------------ */
/* Validation.                                                              */
/* ------------------------------------------------------------------------ */

export class DecoyRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoyRegistryError";
  }
}

const isPath = (p: unknown): p is string => typeof p === "string" && p.startsWith("/") && !p.includes(" ") && !p.includes("?");

/** Structural validation of a registry. Returns the list of problems (empty = valid); never throws. */
export function validateDecoyRegistry(registry: unknown): string[] {
  const errors: string[] = [];
  if (!registry || typeof registry !== "object") return ["registry must be an object"];
  const r = registry as DecoyRegistry;
  if (r.formatVersion !== 1) errors.push("formatVersion must be 1");

  const endpointPaths = new Set<string>();
  for (const [i, ep] of (r.endpoints ?? []).entries()) {
    if (!ep || typeof ep !== "object") { errors.push(`endpoints[${i}] must be an object`); continue; }
    if (!isPath(ep.path)) errors.push(`endpoints[${i}].path must be an absolute path without query: ${String(ep.path)}`);
    else if (endpointPaths.has(ep.path)) errors.push(`duplicate endpoint path: ${ep.path}`);
    else endpointPaths.add(ep.path);
    if (ep.kind !== "live" && ep.kind !== "phantom" && ep.kind !== "page") errors.push(`endpoints[${i}].kind must be live|phantom|page`);
    if (ep.kind === "live" && ep.payload === undefined) errors.push(`endpoints[${i}] (${ep.path}) is live but has no payload`);
    if (ep.kind === "page" && typeof ep.html !== "string") errors.push(`endpoints[${i}] (${ep.path}) is a page but has no html`);
    if (ep.kind === "phantom" && ep.payload !== undefined) errors.push(`endpoints[${i}] (${ep.path}) is a phantom but carries a payload - phantoms are never served`);
  }

  const joinPaths = new Set<string>();
  for (const [i, js] of (r.joinSets ?? []).entries()) {
    if (!js || typeof js !== "object") { errors.push(`joinSets[${i}] must be an object`); continue; }
    for (const key of ["parentPath", "childPath"] as const) {
      if (!isPath(js[key])) errors.push(`joinSets[${i}].${key} must be an absolute path`);
      else if (endpointPaths.has(js[key]) || joinPaths.has(js[key])) errors.push(`joinSets[${i}].${key} collides with another surface path: ${js[key]}`);
      else joinPaths.add(js[key]);
    }
    if (!Array.isArray(js.parents) || js.parents.length === 0) errors.push(`joinSets[${i}].parents must be a non-empty array`);
    if (!Array.isArray(js.children) || js.children.length === 0) errors.push(`joinSets[${i}].children must be a non-empty array`);
  }

  // Decoy images (3.3.1, B5): structural validation and the
  // collisions knowable here; collisions with the late
  // families (chain routes, the GraphQL path) and the
  // generated document paths are checked in the 3.3.1 section
  // below, once those sets exist.
  const imagePaths = new Set<string>();
  for (const [i, img] of (r.images ?? []).entries()) {
    for (const e of validateDecoyImageDecl(img)) errors.push(`images[${i}]: ${e}`);
    if (img && typeof img === "object" && isPath(img.path)) {
      if (endpointPaths.has(img.path) || joinPaths.has(img.path)) {
        errors.push(`images[${i}].path collides with another surface path: ${img.path}`);
      } else if ((r.workedExamples ?? []).some((w) => w && w.path === img.path)) {
        errors.push(`images[${i}].path collides with a worked-example path: ${img.path}`);
      } else if (imagePaths.has(img.path)) {
        errors.push(`duplicate image path: ${img.path}`);
      } else {
        imagePaths.add(img.path);
      }
    }
  }

  const declared = new Set<string>([...endpointPaths, ...joinPaths, ...imagePaths]);
  for (const w of r.workedExamples ?? []) if (isPath(w.path)) declared.add(w.path);
  for (const p of r.discovery?.disallowPaths ?? []) {
    if (!declared.has(p)) errors.push(`discovery.disallowPaths entry is not a declared decoy path: ${p}`);
  }
  for (const p of r.discovery?.sitemapPaths ?? []) {
    if (!declared.has(p)) errors.push(`discovery.sitemapPaths entry is not a declared decoy path: ${p}`);
  }
  for (const [i, c] of (r.contradictions ?? []).entries()) {
    if (!isPath(c.feedPath)) errors.push(`contradictions[${i}].feedPath must be an absolute path`);
    if (!(typeof c.priceFactor === "number" && c.priceFactor > 0 && c.priceFactor !== 1)) {
      errors.push(`contradictions[${i}].priceFactor must be a positive number other than 1 (1 plants no contradiction)`);
    }
    if (typeof c.endorsement !== "string" || c.endorsement.length === 0) errors.push(`contradictions[${i}].endorsement must be a non-empty string`);
  }
  for (const [i, w] of (r.workedExamples ?? []).entries()) {
    if (!isPath(w.path)) errors.push(`workedExamples[${i}].path must be an absolute path`);
    if (endpointPaths.has(w.path)) errors.push(`workedExamples[${i}].path collides with a declared endpoint: ${w.path} (worked examples are generated, not declared)`);
    if (!(typeof w.subtotal === "number" && w.subtotal > 0)) errors.push(`workedExamples[${i}].subtotal must be positive`);
    if (!Array.isArray(w.stepsPct) || w.stepsPct.length === 0 || w.stepsPct.some((s) => !(s > 0 && s < 100))) {
      errors.push(`workedExamples[${i}].stepsPct must be a non-empty array of percentages in (0, 100)`);
    }
    const documented = sequentialStepsTotal(w.subtotal, w.stepsPct ?? []);
    if (w.servedTotal === documented) {
      errors.push(`workedExamples[${i}].servedTotal equals the documented sequential total (${documented}) - that plants no contradiction`);
    }
  }
  for (const [i, x] of (r.expandables ?? []).entries()) {
    if (!declared.has(x.path)) errors.push(`expandables[${i}].path is not a declared decoy path: ${x.path}`);
    if (typeof x.param !== "string" || x.param.length === 0) errors.push(`expandables[${i}].param must be a non-empty string`);
    if (typeof x.value !== "string" || x.value.length === 0) errors.push(`expandables[${i}].value must be a non-empty string`);
    if (typeof x.kind !== "string" || x.kind.length === 0) errors.push(`expandables[${i}].kind must be a non-empty string`);
    if (x.subsPerRecord === undefined && x.fixedSubs === undefined) errors.push(`expandables[${i}] needs subsPerRecord or fixedSubs`);
    if (x.subsPerRecord !== undefined && !(Number.isInteger(x.subsPerRecord) && x.subsPerRecord >= 1)) errors.push(`expandables[${i}].subsPerRecord must be an integer >= 1`);
    if (x.fixedSubs !== undefined && !(Number.isInteger(x.fixedSubs) && x.fixedSubs >= 1)) errors.push(`expandables[${i}].fixedSubs must be an integer >= 1`);
  }

  // 3.3.1 families: chains (B2), GraphQL (B3), identity variants (B4).
  const chainPaths = new Set<string>();
  for (const [i, chain] of (r.chains ?? []).entries()) {
    const chainErrors = validateDecoyChainDecl(chain);
    for (const e of chainErrors) errors.push(`chains[${i}]: ${e}`);
    if (chainErrors.length === 0) {
      for (const route of chainRoutes(chain)) {
        if (declared.has(route) || chainPaths.has(route)) errors.push(`chains[${i}] route collides with another surface path: ${route}`);
        else chainPaths.add(route);
      }
    }
  }
  if (r.graphql !== undefined) {
    for (const e of validateDecoyGraphqlDecl(r.graphql)) errors.push(`graphql: ${e}`);
    const gqlPath = r.graphql?.path ?? "/graphql";
    if (declared.has(gqlPath) || chainPaths.has(gqlPath)) errors.push(`graphql.path collides with another surface path: ${gqlPath}`);
  }
  const livePaths = new Set<string>((r.endpoints ?? []).filter((ep) => ep?.kind === "live").map((ep) => ep.path));
  for (const [i, v] of (r.identityVariants ?? []).entries()) {
    for (const e of validateDecoyIdentityVariantDecl(v)) errors.push(`identityVariants[${i}]: ${e}`);
    if (v && typeof v.path === "string" && !livePaths.has(v.path)) {
      errors.push(`identityVariants[${i}].path is not a declared live endpoint: ${v.path}`);
    }
  }
  // Image collisions with the late families and the generated
  // document paths (checked here, where those sets exist).
  const specPath = r.spec?.specPath ?? "/openapi.json";
  const docsPath = r.spec?.docsPath ?? "/api-docs";
  for (const p of imagePaths) {
    if (chainPaths.has(p)) errors.push(`image path collides with a chain route: ${p}`);
    if (r.graphql !== undefined && p === (r.graphql.path ?? "/graphql")) errors.push(`image path collides with the GraphQL path: ${p}`);
    if (p === specPath || p === docsPath || p === "/robots.txt" || p === "/sitemap.xml") {
      errors.push(`image path collides with a generated document path: ${p}`);
    }
  }
  return errors;
}

/* ------------------------------------------------------------------------ */
/* Generated surface (normalized form shared by runtime, tool and tests). */
/* ------------------------------------------------------------------------ */

export interface DecoySurface {
  endpoints: DecoyEndpointDecl[];
  joinSets: DecoyJoinSetDecl[];
  expandables: DecoyExpandableDecl[];
  contradictions: DecoyContradictionDecl[];
  workedExamples: DecoyWorkedExampleDecl[];
  chains: DecoyChainDecl[];
  graphql: DecoyGraphqlDecl | null;
  identityVariants: DecoyIdentityVariantDecl[];
  images: DecoyImageDecl[];
  discovery: Required<DecoyDiscoveryDecl>;
  specPath: string;
  docsPath: string;
  specTitle: string;
  specVersion: string;
  realPaths: string[];
}

/** Validate and normalize a registry into the generated surface. Throws DecoyRegistryError on any problem. */
export function generateDecoySurface(registry: DecoyRegistry): DecoySurface {
  const errors = validateDecoyRegistry(registry);
  if (errors.length > 0) throw new DecoyRegistryError(`invalid decoy registry: ${errors.join("; ")}`);
  const discovery: Required<DecoyDiscoveryDecl> = {
    disallowPaths: [...(registry.discovery?.disallowPaths ?? [])],
    sitemapPaths: [...(registry.discovery?.sitemapPaths ?? [])],
    sitemapRealPaths: [...(registry.discovery?.sitemapRealPaths ?? [])],
  };
  return {
    endpoints: [...(registry.endpoints ?? [])],
    joinSets: [...(registry.joinSets ?? [])],
    expandables: [...(registry.expandables ?? [])],
    contradictions: [...(registry.contradictions ?? [])],
    workedExamples: [...(registry.workedExamples ?? [])],
    chains: [...(registry.chains ?? [])],
    graphql: registry.graphql ?? null,
    identityVariants: [...(registry.identityVariants ?? [])],
    images: [...(registry.images ?? [])],
    discovery,
    specPath: registry.spec?.specPath ?? "/openapi.json",
    docsPath: registry.spec?.docsPath ?? "/api-docs",
    specTitle: registry.spec?.title ?? "API",
    specVersion: registry.spec?.version ?? "1.0.0",
    realPaths: [...(registry.spec?.realPaths ?? [])],
  };
}

/** Every path the surface owns (endpoints, join paths, worked-example paths, chain routes, the GraphQL path, image paths, spec and docs paths). */
export function decoySurfacePaths(surface: DecoySurface): string[] {
  const out = new Set<string>();
  for (const ep of surface.endpoints) out.add(ep.path);
  for (const img of surface.images) out.add(img.path);
  for (const js of surface.joinSets) { out.add(js.parentPath); out.add(js.childPath); }
  for (const w of surface.workedExamples) out.add(w.path);
  for (const chain of surface.chains) for (const route of chainRoutes(chain)) out.add(route);
  if (surface.graphql) out.add(surface.graphql.path ?? "/graphql");
  out.add(surface.specPath);
  out.add(surface.docsPath);
  out.add("/robots.txt");
  out.add("/sitemap.xml");
  return [...out];
}

/* ------------------------------------------------------------------------ */
/* A1 renders: robots.txt and sitemap.xml.                                  */
/* ------------------------------------------------------------------------ */

/**
 * The decoy robots.txt block (A1): Disallow lines naming decoy
 * paths only machines read, plus the Sitemap line. Hosts with an
 * existing robots.txt append this block to it; the decoy paths
 * named here are exactly the registry's discovery set.
 */
export function renderDecoyRobots(surface: DecoySurface): string {
  const lines = ["User-agent: *", "Allow: /"];
  for (const p of surface.discovery.disallowPaths) lines.push(`Disallow: ${p}`);
  lines.push("Sitemap: /sitemap.xml");
  return lines.join("\n") + "\n";
}

/** The generated sitemap (A1): real paths the host listed, then the sitemap-only decoy paths. */
export function renderDecoySitemap(surface: DecoySurface): string {
  const paths = [...surface.discovery.sitemapRealPaths, ...surface.discovery.sitemapPaths];
  const urls = paths.map((p) => `<url><loc>${p}</loc></url>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

/* ------------------------------------------------------------------------ */
/* A2 + A3 + A5: the OpenAPI decoy document.                                */
/* ------------------------------------------------------------------------ */

/**
 * Build the decoy OpenAPI document (A2). It mirrors the host's
 * declared real paths (paths only - it never describes real
 * behavior), declares every decoy endpoint (live and phantom
 * alike - phantoms exist only here and in the docs), declares
 * each expandable variant as its own path key with the query
 * string attached (the exact shape the lab twins served and the
 * extractor consumed), carries each contradiction feed with its
 * endorsement text (A3), and each worked example (A5). The
 * 3.3.1 additions: every concrete chain route (B2, the shape
 * the v4 twin declared), every declared image path (B5), and,
 * when a GraphQL decoy is declared,
 * the GraphQL path plus the schema as an `x-graphql-schema`
 * SDL extension (B3 - the extension is the discovery surface;
 * the measured carrier is the endpoint's introspection
 * response, see decoy-graphql.ts).
 */
export function buildDecoyOpenApiSpec(surface: DecoySurface): Record<string, unknown> {
  const ok = { responses: { "200": { description: "OK" } } };
  const paths: Record<string, unknown> = {};
  for (const p of surface.realPaths) paths[p] = { get: { summary: "Real endpoint (mirrored path only)", ...ok } };
  for (const ep of surface.endpoints) {
    paths[ep.path] = { get: { summary: ep.summary ?? (ep.kind === "phantom" ? "Preview endpoint" : "Decoy endpoint"), ...ok } };
  }
  for (const img of surface.images) {
    paths[img.path] = { get: { summary: img.summary ?? "Decoy image", ...ok } };
  }
  for (const js of surface.joinSets) {
    paths[js.parentPath] = { get: { summary: "Directory (decoy)", ...ok } };
    paths[js.childPath] = { get: { summary: "Records referencing the directory by id (decoy)", ...ok } };
  }
  for (const c of surface.contradictions) {
    paths[c.feedPath] = { get: { summary: "Partner feed", description: c.endorsement, ...ok } };
  }
  for (const w of surface.workedExamples) {
    paths[w.path] = {
      get: {
        summary: "Worked calculation example",
        description: `Documented rule: apply the percentage steps sequentially - ${w.stepsPct.join("%, then ")}% - to the subtotal.`,
        ...ok,
      },
    };
  }
  for (const x of surface.expandables) {
    paths[`${x.path}?${x.param}=${x.value}`] = { get: { summary: `Expanded variant (${x.kind})`, ...ok } };
  }
  for (const chain of surface.chains) {
    for (const route of chainRoutes(chain)) paths[route] = { get: { summary: "Provenance record", ...ok } };
  }
  if (surface.graphql) {
    paths[surface.graphql.path ?? "/graphql"] = {
      get: { summary: "GraphQL endpoint - schema via GET introspection, queries via POST", ...ok },
    };
  }
  const spec: Record<string, unknown> = {
    openapi: "3.0.3",
    info: { title: `${surface.specTitle} API`, version: surface.specVersion },
    paths,
  };
  if (surface.graphql) spec["x-graphql-schema"] = renderGraphqlSdl(surface.graphql);
  return spec;
}

/* ------------------------------------------------------------------------ */
/* A3 data side: the contradiction feed.                                    */
/* ------------------------------------------------------------------------ */

/**
 * Build a contradiction feed (A3) from real records: each row
 * keeps the record's key and name, with the price multiplied by
 * the registry factor and rounded - the trials used 0.82, so the
 * feed disagrees with the catalog on every row while looking
 * like an ordinary partner price list.
 */
export function buildContradictionFeed<T>(
  records: readonly T[],
  opts: { keyOf: (r: T) => string; nameOf: (r: T) => string; priceOf: (r: T) => number; priceFactor: number; priceField?: string },
): Array<Record<string, unknown>> {
  const field = opts.priceField ?? "partnerPrice";
  return records.map((r) => ({
    key: opts.keyOf(r),
    name: opts.nameOf(r),
    [field]: Math.round(opts.priceOf(r) * opts.priceFactor),
  }));
}

/* ------------------------------------------------------------------------ */
/* A5: worked examples - documented side vs served side.                    */
/* ------------------------------------------------------------------------ */

/** The DOCUMENTED total for a worked example: percentage steps applied sequentially, rounding once at the end. */
export function sequentialStepsTotal(subtotal: number, stepsPct: readonly number[]): number {
  let total = subtotal;
  for (const pct of stepsPct) total *= 1 - pct / 100;
  return Math.round(total);
}

/** The payload a worked-example decoy endpoint serves: the example with its (contradicting) served total. */
export function workedExamplePayload(example: DecoyWorkedExampleDecl): Record<string, unknown> {
  return {
    example: {
      subtotal: example.subtotal,
      stepsPct: [...example.stepsPct],
      total: example.servedTotal,
      ...(example.currency ? { currency: example.currency } : {}),
      ...(example.tier ? { tier: example.tier } : {}),
    },
  };
}
