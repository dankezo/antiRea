/**
 * Identity-gated decoy joins (antiRea 3.3.0, A7) - OPT-IN,
 * default OFF (the surface that serves these sets is
 * `createDecoySurface`, itself disabled by default).
 *
 * WHAT IT DOES. A decoy dataset with a join in it (suppliers and
 * the contracts that reference them) is served with its ids
 * rewritten per requesting identity: the id tag is
 * HMAC-SHA256(secret, identity), so the SAME identity always
 * sees a self-consistent set whose joins resolve, while a
 * capture assembled from two identities (probe with one key,
 * extract with another - a common extractor workflow) silently
 * orphans: every foreign key points at a parent id that was
 * never captured. Nothing is blocked or flagged; the copied
 * model is simply broken in a way the copier only discovers
 * when their clone tries to join.
 *
 * ID SHAPE. Registry records carry templated ids with a `{tag}`
 * placeholder, e.g. parent id `SUP-{tag}-01` and child foreign
 * key `SUP-{tag}-01`. `gatedIdFor` substitutes the requesting
 * identity's tag. Ids without a placeholder get `-{tag}`
 * appended. Because the tag is keyed, one host's gated ids
 * teach an attacker nothing about another host's.
 *
 * MEASURED BASIS. decoy-map trial v3, IDJ arms: same-identity
 * probe+extract orphaned 0/30 decoy joins (0%); mixed-identity
 * (probe identity A, extract identity B) orphaned 30/30 (100%)
 * - both legs of the registered prediction at their extremes
 * (>= 50% mixed, <= 10% same). The join sets were captured in
 * full in both arms; the orphaning is a property of the merged
 * capture, not of any single response.
 */

import { rspHmacHex } from "../internal/rsp-crypto";

/** Placeholder in registry ids that the per-identity tag replaces. */
export const GATED_ID_TAG_PLACEHOLDER = "{tag}";

export class DecoyJoinsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoyJoinsError";
  }
}

/** The per-identity join tag: 6 hex chars of HMAC-SHA256(secret, "idj:" + identity). */
export function gatedTagForIdentity(secret: string | Uint8Array, identity: string): string {
  if (typeof identity !== "string" || identity.length === 0) throw new DecoyJoinsError("identity must be a non-empty string");
  return rspHmacHex(secret, `idj:${identity}`).slice(0, 6);
}

/**
 * Rewrite one templated id for an identity: replaces every
 * `{tag}` placeholder with the identity's tag, or appends
 * `-{tag}` when the id carries no placeholder.
 */
export function gatedIdFor(secret: string | Uint8Array, identity: string, templatedId: string): string {
  const tag = gatedTagForIdentity(secret, identity);
  if (templatedId.includes(GATED_ID_TAG_PLACEHOLDER)) return templatedId.split(GATED_ID_TAG_PLACEHOLDER).join(tag);
  return `${templatedId}-${tag}`;
}

/**
 * Return copies of `records` with the named fields rewritten
 * through {@link gatedIdFor} for `identity`. Apply the SAME
 * call (same secret, same identity) to parent ids and child
 * foreign keys and the set stays self-consistent for that
 * identity. Non-string field values are left untouched; inputs
 * are not mutated.
 */
export function gateRecordIds<T extends Record<string, unknown>>(
  records: readonly T[],
  secret: string | Uint8Array,
  identity: string,
  fields: readonly string[],
): T[] {
  return records.map((record) => {
    const out: Record<string, unknown> = { ...record };
    for (const field of fields) {
      const value = out[field];
      if (typeof value === "string") out[field] = gatedIdFor(secret, identity, value);
    }
    return out as T;
  });
}

export interface JoinResolution<T extends Record<string, unknown>> {
  /** Children whose foreign key resolved to a captured parent. */
  resolved: T[];
  /** Children whose foreign key points at a parent that is not in the set (the silently broken joins). */
  orphans: T[];
  /** orphans / total children (0 when there are no children). */
  orphanRate: number;
}

/**
 * Resolve a captured join: children referencing parents by
 * foreign key. This is the audit an analyst (or a test) runs on
 * a merged capture to count orphaned joins - the quantity the
 * v3 trial scored (0% same-identity, 100% mixed-identity).
 */
export function resolveJoins<P extends Record<string, unknown>, C extends Record<string, unknown>>(
  parents: readonly P[],
  parentIdField: string,
  children: readonly C[],
  childFkField: string,
): JoinResolution<C> {
  const parentIds = new Set<unknown>(parents.map((p) => p[parentIdField]));
  const resolved: C[] = [];
  const orphans: C[] = [];
  for (const child of children) {
    if (parentIds.has(child[childFkField])) resolved.push(child);
    else orphans.push(child);
  }
  return { resolved, orphans, orphanRate: children.length === 0 ? 0 : orphans.length / children.length };
}
