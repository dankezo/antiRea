/**
 * Identity-bound decoy variants - the S1 family (antiRea
 * 3.3.1, B4) - OPT-IN, default OFF (the surface that serves
 * these variants is `createDecoySurface`, itself disabled by
 * default, and it refuses to serve a surface that declares
 * variants without a variant secret).
 *
 * WHAT IT DOES. One decoy record list is served in a different
 * SHAPE to different identities. Each identity belongs to a
 * variant class, assigned by a keyed hash of the identity
 * under a host secret (so one host's classes teach an attacker
 * nothing about another host's). Three mechanisms, all
 * measured in the trial below:
 * - Skew fields: only a per-class subset of the declared skew
 *   fields is present on the records a class is served. A
 *   capture merged from two classes shows most skew fields
 *   under exactly one identity.
 * - Enum subsets: a field's values are remapped into a
 *   per-class subset of the declared enum universe, so a model
 *   copied from one identity has only ever seen part of the
 *   universe - and cannot tell the rest exists.
 * - Field aliases: the same semantic attribute is served under
 *   a different field NAME per class, so two captures of the
 *   same list do not even share a schema for those attributes.
 *
 * MEASURED BASIS. decoy-map trial v4, S1 arm (two variant
 * classes; 6-of-10 subsets for both the enum universe and the
 * skew fields; 3 aliased attributes): in the two-identity
 * union capture, 8/10 planted skew fields appeared under
 * exactly one identity (registered >= 30%); a single
 * identity's enum coverage was 60% of the universe from either
 * side (registered <= 70%); cross-identity decoy field-name
 * overlap was Jaccard 6/20 = 30% (registered <= 50%).
 *
 * WHAT IS NOT MEASURED, AND THEREFORE NOT CLAIMED: the
 * follow-on leg - extraction code written against identity A's
 * shape failing or silently mis-mapping when run against
 * identity B (the panel's "mis-map" leg) - has NOT been
 * measured. It needs an agent-loop follow-up that has not run.
 * This module claims only the three measured legs above: skew
 * exposure, enum coverage and name overlap. Do not describe
 * the variants as breaking copied extraction code.
 *
 * FORM. Pure transforms over host-declared records; inputs are
 * never mutated. The class assignment and subsets are
 * deterministic per (secret, identity), so one identity always
 * sees one consistent shape.
 */

import { rspHmac } from "../internal/rsp-crypto";

export interface DecoyAliasDecl {
  /** The field name in the host's declared records (the class-0 name by convention). */
  field: string;
  /** The name each variant class serves this attribute under; index = class. Length must be >= the variant class count. */
  names: string[];
}

export interface DecoyIdentityVariantDecl {
  /** Path of the decoy endpoint whose record list is varied (must be a declared live endpoint). */
  path: string;
  /** Number of variant classes. Default 2 (the trial's shape). */
  classes?: number;
  /** Enum field whose values are remapped into per-class subsets of `enumUniverse`. */
  enumField?: string;
  /** The full enum universe for `enumField`. */
  enumUniverse?: string[];
  /** Values per class subset. Default: ceil(universe x 0.6) (the trial served 6 of 10). */
  enumSubsetSize?: number;
  /** Skew fields: only the per-class subset of these is present on served records. */
  skewFields?: string[];
  /** Skew fields present per class. Default: ceil(fields x 0.6) (the trial served 6 of 10). */
  skewSubsetSize?: number;
  /** Attributes served under a different field name per class. */
  aliases?: DecoyAliasDecl[];
}

export class DecoyIdentityVariantsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoyIdentityVariantsError";
  }
}

/** Structural validation of an identity-variant declaration. Returns the list of problems (empty = valid); never throws. */
export function validateDecoyIdentityVariantDecl(decl: unknown): string[] {
  const errors: string[] = [];
  if (!decl || typeof decl !== "object") return ["identity variant declaration must be an object"];
  const d = decl as DecoyIdentityVariantDecl;
  if (typeof d.path !== "string" || !d.path.startsWith("/")) errors.push(`identityVariants.path must be an absolute path: ${String(d.path)}`);
  const classes = d.classes ?? 2;
  if (!Number.isInteger(classes) || classes < 2) errors.push("identityVariants.classes must be an integer >= 2");
  if (d.enumField !== undefined) {
    if (typeof d.enumField !== "string" || d.enumField.length === 0) errors.push("identityVariants.enumField must be a non-empty string");
    if (!Array.isArray(d.enumUniverse) || d.enumUniverse.length < 2) errors.push("identityVariants.enumUniverse must declare at least 2 values when enumField is set");
    const k = d.enumSubsetSize ?? Math.ceil((d.enumUniverse?.length ?? 0) * 0.6);
    if (Array.isArray(d.enumUniverse) && (!Number.isInteger(k) || k < 1 || k >= d.enumUniverse.length)) {
      errors.push("identityVariants.enumSubsetSize must be an integer in [1, enumUniverse.length) - a full-size subset varies nothing");
    }
  } else if (d.enumUniverse !== undefined || d.enumSubsetSize !== undefined) {
    errors.push("identityVariants.enumUniverse/enumSubsetSize require enumField");
  }
  if (d.skewFields !== undefined) {
    if (!Array.isArray(d.skewFields) || d.skewFields.length < 2) errors.push("identityVariants.skewFields must declare at least 2 fields");
    const k = d.skewSubsetSize ?? Math.ceil((d.skewFields?.length ?? 0) * 0.6);
    if (Array.isArray(d.skewFields) && (!Number.isInteger(k) || k < 1 || k >= d.skewFields.length)) {
      errors.push("identityVariants.skewSubsetSize must be an integer in [1, skewFields.length) - a full-size subset varies nothing");
    }
  } else if (d.skewSubsetSize !== undefined) {
    errors.push("identityVariants.skewSubsetSize requires skewFields");
  }
  for (const [i, a] of (d.aliases ?? []).entries()) {
    if (!a || typeof a.field !== "string" || a.field.length === 0) errors.push(`identityVariants.aliases[${i}].field must be a non-empty string`);
    if (!a || !Array.isArray(a.names) || a.names.length < classes) errors.push(`identityVariants.aliases[${i}].names must name every variant class (>= ${classes})`);
    else if (new Set(a.names).size !== a.names.length) errors.push(`identityVariants.aliases[${i}].names must be distinct per class`);
  }
  if (d.enumField === undefined && d.skewFields === undefined && (d.aliases ?? []).length === 0) {
    errors.push("identity variant declaration varies nothing: declare an enum field, skew fields or aliases");
  }
  return errors;
}

/**
 * The variant class of an identity: the first byte of
 * HMAC-SHA256(secret, "s1-variant:" + identity) modulo the
 * class count. Deterministic per (secret, identity); keyed,
 * so classes cannot be precomputed without the host secret.
 */
export function variantClassFor(secret: string | Uint8Array, identity: string, classes = 2): number {
  if (typeof identity !== "string" || identity.length === 0) throw new DecoyIdentityVariantsError("identity must be a non-empty string");
  if (!Number.isInteger(classes) || classes < 2) throw new DecoyIdentityVariantsError("classes must be an integer >= 2");
  const byte = rspHmac(secret, `s1-variant:${identity}`)[0] as number;
  return byte % classes;
}

/**
 * The subset indices a class sees: a contiguous window of
 * `subsetSize` over `universeSize`, offset per class. At the
 * trial's parameters (2 classes, universe 10, subset 6) this
 * reproduces the trial's subsets exactly: class 0 sees
 * indices 0-5, class 1 sees indices 4-9 (an overlap of 2).
 */
export function subsetIndicesFor(classIndex: number, classes: number, universeSize: number, subsetSize: number): number[] {
  if (!Number.isInteger(classIndex) || classIndex < 0 || classIndex >= classes) throw new DecoyIdentityVariantsError("classIndex out of range");
  if (!(subsetSize >= 1 && subsetSize <= universeSize)) throw new DecoyIdentityVariantsError("subsetSize must lie in [1, universeSize]");
  const offset = classes <= 1 ? 0 : Math.round((classIndex * (universeSize - subsetSize)) / (classes - 1));
  return Array.from({ length: subsetSize }, (_, i) => offset + i);
}

function classesOf(decl: DecoyIdentityVariantDecl): number {
  return decl.classes ?? 2;
}

function enumSubsetSizeOf(decl: DecoyIdentityVariantDecl): number {
  return decl.enumSubsetSize ?? Math.ceil((decl.enumUniverse?.length ?? 0) * 0.6);
}

function skewSubsetSizeOf(decl: DecoyIdentityVariantDecl): number {
  return decl.skewSubsetSize ?? Math.ceil((decl.skewFields?.length ?? 0) * 0.6);
}

/** The enum values a class is served (its subset of the universe), in universe order. */
export function enumSubsetFor(decl: DecoyIdentityVariantDecl, classIndex: number): string[] {
  if (!decl.enumUniverse) return [];
  return subsetIndicesFor(classIndex, classesOf(decl), decl.enumUniverse.length, enumSubsetSizeOf(decl)).map(
    (i) => decl.enumUniverse?.[i] as string,
  );
}

/** The skew fields a class is served (its subset of the declared skew fields), in declaration order. */
export function skewSubsetFor(decl: DecoyIdentityVariantDecl, classIndex: number): string[] {
  if (!decl.skewFields) return [];
  return subsetIndicesFor(classIndex, classesOf(decl), decl.skewFields.length, skewSubsetSizeOf(decl)).map(
    (i) => decl.skewFields?.[i] as string,
  );
}

/**
 * Serve `records` to `identity` under the declaration: enum
 * values remapped into the identity's class subset (a value's
 * universe index selects within the subset, so the mapping is
 * stable per value), skew fields outside the class subset
 * removed, aliased attributes renamed to the class's name.
 * Records carrying values outside the declared universe are
 * left as they are. Returns new records; inputs are never
 * mutated.
 */
export function applyIdentityVariants<T extends Record<string, unknown>>(
  records: readonly T[],
  decl: DecoyIdentityVariantDecl,
  secret: string | Uint8Array,
  identity: string,
): T[] {
  const errors = validateDecoyIdentityVariantDecl(decl);
  if (errors.length > 0) throw new DecoyIdentityVariantsError(`invalid identity variant declaration: ${errors.join("; ")}`);
  const cls = variantClassFor(secret, identity, classesOf(decl));
  const enumSubset = decl.enumField ? enumSubsetFor(decl, cls) : [];
  const skewKeep = decl.skewFields ? new Set(skewSubsetFor(decl, cls)) : null;
  return records.map((record) => {
    const out: Record<string, unknown> = { ...record };
    if (decl.enumField && decl.enumUniverse) {
      const value = out[decl.enumField];
      if (typeof value === "string") {
        const idx = decl.enumUniverse.indexOf(value);
        if (idx >= 0) out[decl.enumField] = enumSubset[idx % enumSubset.length];
      }
    }
    if (skewKeep && decl.skewFields) {
      for (const f of decl.skewFields) if (!skewKeep.has(f)) delete out[f];
    }
    for (const alias of decl.aliases ?? []) {
      const target = alias.names[cls] as string;
      if (target !== alias.field && alias.field in out) {
        out[target] = out[alias.field];
        delete out[alias.field];
      }
    }
    return out as T;
  });
}
