/**
 * GraphQL decoy (antiRea 3.3.1, B3 / DEC-4) - OPT-IN, default
 * OFF (the surface that serves it is `createDecoySurface`,
 * itself disabled by default; nothing is served unless a host
 * declares a `graphql` section in its decoy registry).
 *
 * WHAT IT DOES. The host declares a GraphQL schema that does
 * not exist: phantom types (declared in the schema, backed by
 * no resolver), phantom fields on the Query type, and decoy
 * fields added onto real types. The decoy OpenAPI document
 * carries the schema as an SDL extension (`x-graphql-schema`)
 * and declares the GraphQL path; the endpoint itself answers a
 * GET with the schema as an introspection JSON document, in
 * the shape GraphQL tooling consumes. An extractor mapping the
 * API picks up types and fields that no REST route and no real
 * resolver has ever served.
 *
 * MEASURED BASIS - AND ITS EXACT CARRIER. decoy-map trial v4,
 * GQL arm: 10 of 10 planted identifiers (3 phantom types, 3
 * phantom Query fields, 4 decoy fields on real types) appeared
 * in the extractor's capture, 0 flags, and the record meter
 * held at exactly 150. The carrier was the /graphql endpoint's
 * INTROSPECTION RESPONSE: the identifiers arrived in the
 * introspection JSON the endpoint served, not in retained spec
 * text (the arm's capture did not retain the /openapi.json
 * body, although the spec declaration is what drove discovery
 * of the endpoint). Claims for this module are scoped to
 * exactly that: the schema is served as introspection, and
 * that is the measured channel. Nothing here claims a spec
 * document is captured.
 *
 * FORM. Pure builders only: schema composition, SDL rendering
 * and the introspection document. Serving lives in
 * `decoy-surface.ts`. The builders never invent real types -
 * the host declares the real types the schema mirrors (names
 * and fields only), exactly like the REST spec decoy mirrors
 * real paths.
 */

export interface DecoyGraphqlFieldDecl {
  /** Field name as it appears in the schema. */
  name: string;
  /** GraphQL type label. Default "String" (the trial served every field as String). */
  type?: string;
}

export interface DecoyGraphqlTypeDecl {
  /** Type name, e.g. "Product". */
  name: string;
  fields: DecoyGraphqlFieldDecl[];
}

export interface DecoyGraphqlQueryDecl {
  /** Field name on the Query type. */
  name: string;
  /** Return type label (normally a phantom type name). */
  type: string;
}

export interface DecoyGraphqlDecoyFieldDecl {
  /** A REAL type the decoy field is added onto (must be declared in `realTypes`). */
  onType: string;
  field: DecoyGraphqlFieldDecl;
}

export interface DecoyGraphqlDecl {
  /** Path the GraphQL decoy endpoint is served at. Default "/graphql". */
  path?: string;
  /** The host's real GraphQL types to mirror (names and fields only; never behavior). */
  realTypes?: DecoyGraphqlTypeDecl[];
  /** Phantom types: in the schema and the introspection document, backed by nothing. */
  phantomTypes?: DecoyGraphqlTypeDecl[];
  /** Phantom fields on the Query type. */
  phantomQueries?: DecoyGraphqlQueryDecl[];
  /** Decoy fields added onto real types. */
  decoyFields?: DecoyGraphqlDecoyFieldDecl[];
}

export class DecoyGraphqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoyGraphqlError";
  }
}

const NAME_OK = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Structural validation of a GraphQL decoy declaration. Returns the list of problems (empty = valid); never throws. */
export function validateDecoyGraphqlDecl(decl: unknown): string[] {
  const errors: string[] = [];
  if (!decl || typeof decl !== "object") return ["graphql declaration must be an object"];
  const d = decl as DecoyGraphqlDecl;
  if (d.path !== undefined && !(typeof d.path === "string" && d.path.startsWith("/") && !d.path.includes(" ") && !d.path.includes("?"))) {
    errors.push(`graphql.path must be an absolute path without query: ${String(d.path)}`);
  }
  const realNames = new Set<string>();
  for (const [i, t] of (d.realTypes ?? []).entries()) {
    if (!t || typeof t.name !== "string" || !NAME_OK.test(t.name)) { errors.push(`graphql.realTypes[${i}].name must be a GraphQL name`); continue; }
    if (realNames.has(t.name)) errors.push(`graphql.realTypes declares ${t.name} twice`);
    realNames.add(t.name);
    if (!Array.isArray(t.fields) || t.fields.length === 0) errors.push(`graphql.realTypes[${i}] (${t.name}) must declare at least one field`);
    for (const f of t.fields ?? []) if (!f || typeof f.name !== "string" || !NAME_OK.test(f.name)) errors.push(`graphql.realTypes[${i}] (${t.name}) has a field with an invalid name`);
  }
  const phantomNames = new Set<string>();
  for (const [i, t] of (d.phantomTypes ?? []).entries()) {
    if (!t || typeof t.name !== "string" || !NAME_OK.test(t.name)) { errors.push(`graphql.phantomTypes[${i}].name must be a GraphQL name`); continue; }
    if (realNames.has(t.name)) errors.push(`graphql.phantomTypes[${i}] (${t.name}) collides with a real type of the same name`);
    if (phantomNames.has(t.name)) errors.push(`graphql.phantomTypes declares ${t.name} twice`);
    phantomNames.add(t.name);
    if (!Array.isArray(t.fields) || t.fields.length === 0) errors.push(`graphql.phantomTypes[${i}] (${t.name}) must declare at least one field`);
    for (const f of t.fields ?? []) if (!f || typeof f.name !== "string" || !NAME_OK.test(f.name)) errors.push(`graphql.phantomTypes[${i}] (${t.name}) has a field with an invalid name`);
  }
  for (const [i, q] of (d.phantomQueries ?? []).entries()) {
    if (!q || typeof q.name !== "string" || !NAME_OK.test(q.name)) errors.push(`graphql.phantomQueries[${i}].name must be a GraphQL name`);
    if (!q || typeof q.type !== "string" || q.type.length === 0) errors.push(`graphql.phantomQueries[${i}].type must be a non-empty type label`);
  }
  for (const [i, df] of (d.decoyFields ?? []).entries()) {
    if (!df || !realNames.has(df.onType)) errors.push(`graphql.decoyFields[${i}].onType is not a declared real type: ${String(df?.onType)}`);
    if (!df || !df.field || typeof df.field.name !== "string" || !NAME_OK.test(df.field.name)) errors.push(`graphql.decoyFields[${i}].field.name must be a GraphQL name`);
  }
  const planted = (d.phantomTypes ?? []).length + (d.phantomQueries ?? []).length + (d.decoyFields ?? []).length;
  if (planted === 0) errors.push("graphql declaration plants nothing: declare phantom types, phantom queries or decoy fields");
  return errors;
}

export interface GraphqlSchemaType {
  name: string;
  fields: Array<{ name: string; type: string }>;
}

/**
 * Compose the served schema: the Query type first (the real
 * Query fields when the host declared a Query type, then the
 * phantom queries), then the remaining real types with their
 * decoy fields appended, then the phantom types. Field types
 * default to "String", as in the trial.
 */
export function graphqlSchemaTypes(decl: DecoyGraphqlDecl): GraphqlSchemaType[] {
  const errors = validateDecoyGraphqlDecl(decl);
  if (errors.length > 0) throw new DecoyGraphqlError(`invalid GraphQL decoy declaration: ${errors.join("; ")}`);
  const decoyByType = new Map<string, DecoyGraphqlFieldDecl[]>();
  for (const df of decl.decoyFields ?? []) {
    const list = decoyByType.get(df.onType) ?? [];
    list.push(df.field);
    decoyByType.set(df.onType, list);
  }
  const withDecoys = (t: DecoyGraphqlTypeDecl): GraphqlSchemaType => {
    const fields = t.fields.map((f) => ({ name: f.name, type: f.type ?? "String" }));
    const seen = new Set(fields.map((f) => f.name));
    for (const f of decoyByType.get(t.name) ?? []) {
      if (!seen.has(f.name)) fields.push({ name: f.name, type: f.type ?? "String" });
    }
    return { name: t.name, fields };
  };
  const real = decl.realTypes ?? [];
  const queryReal = real.find((t) => t.name === "Query");
  const query: GraphqlSchemaType = {
    name: "Query",
    fields: [
      ...(queryReal ? queryReal.fields.map((f) => ({ name: f.name, type: f.type ?? "String" })) : []),
      ...(decl.phantomQueries ?? []).map((q) => ({ name: q.name, type: q.type })),
    ],
  };
  const out: GraphqlSchemaType[] = [query];
  for (const t of real) if (t.name !== "Query") out.push(withDecoys(t));
  if (queryReal) {
    // Decoy fields declared on Query itself ride the composed Query type.
    const seen = new Set(query.fields.map((f) => f.name));
    for (const f of decoyByType.get("Query") ?? []) {
      if (!seen.has(f.name)) query.fields.push({ name: f.name, type: f.type ?? "String" });
    }
  }
  for (const t of decl.phantomTypes ?? []) out.push({ name: t.name, fields: t.fields.map((f) => ({ name: f.name, type: f.type ?? "String" })) });
  return out;
}

/** Render the schema as SDL - the exact text the decoy spec carries in its `x-graphql-schema` extension. */
export function renderGraphqlSdl(decl: DecoyGraphqlDecl): string {
  return graphqlSchemaTypes(decl)
    .map((t) => `type ${t.name} {\n${t.fields.map((f) => `  ${f.name}: ${f.type}`).join("\n")}\n}`)
    .join("\n");
}

/**
 * The introspection document the endpoint serves - the
 * measured carrier of this decoy (see the module header). The
 * shape is the trial's: `__schema` with the query type, a null
 * mutation type, every composed type as an OBJECT with its
 * field names, and no directives.
 */
export function buildGraphqlIntrospection(decl: DecoyGraphqlDecl): Record<string, unknown> {
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: null,
        types: graphqlSchemaTypes(decl).map((t) => ({
          name: t.name,
          kind: "OBJECT",
          fields: t.fields.map((f) => ({ name: f.name, args: [] })),
        })),
        directives: [],
      },
    },
  };
}

export interface DecoyGraphqlIdentifiers {
  /** Phantom type names planted. */
  phantomTypes: string[];
  /** Phantom Query field names planted. */
  phantomQueries: string[];
  /** Decoy fields planted on real types, as "Type.field". */
  decoyFields: string[];
  /** Every planted identifier, in declaration order (types, queries, fields). */
  all: string[];
}

/** The planted identifier inventory - the list a trial (or a host audit) scores a capture against. */
export function decoyGraphqlIdentifiers(decl: DecoyGraphqlDecl): DecoyGraphqlIdentifiers {
  const phantomTypes = (decl.phantomTypes ?? []).map((t) => t.name);
  const phantomQueries = (decl.phantomQueries ?? []).map((q) => q.name);
  const decoyFields = (decl.decoyFields ?? []).map((df) => `${df.onType}.${df.field.name}`);
  return { phantomTypes, phantomQueries, decoyFields, all: [...phantomTypes, ...phantomQueries, ...decoyFields] };
}
