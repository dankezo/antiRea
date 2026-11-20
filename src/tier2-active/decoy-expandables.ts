/**
 * Budget-sink expandables (antiRea 3.3.0, A8) - OPT-IN data
 * helpers; the serving and billing live in `decoy-surface.ts`.
 *
 * WHAT IT DOES. A decoy endpoint declares an expand/include
 * variant in the spec (`/api/v2/products?expand=supplier`). When
 * an extractor follows the declaration, every base record grows
 * live synthetic subresources, and each subresource is billed
 * to the SAME record budget as real records (the host wires the
 * billing callback to its record budget - in the lab twin, to
 * antiRea's own `createRecordBudget`). The extractor spends its
 * budget on synthetic depth before it ever walks the catalog.
 * Subresources are generated deterministically from a host
 * seed: stable ids (`sub-<kind>-<baseId>-<k>`), stable content,
 * no stored state.
 *
 * MEASURED BASIS. decoy-map trial v3, SINK arm: at the same
 * live decoy endpoint count as the spec-only baseline, real
 * yield per identity fell from 150 to 50 records (-66.7%,
 * registered threshold -20%) because all 4 spec-declared
 * expansions were requested and billed before the catalog walk
 * (40 + 12 + 25 + 3 = 80 subresources charged to the same
 * meter; the first budget rejection arrived at walk step 1
 * instead of step 3). The mechanism the log proved is request
 * allocation to expansions, which is why the billing callback -
 * not the payload shape - is the load-bearing part of this
 * module.
 *
 * HONEST LIMIT. Without a billing callback wired to a real
 * budget, an expansion is just more decoy data: it costs the
 * extractor requests but not budget. `createDecoySurface`
 * reports `billed: false` on unbilled expansions so the
 * degradation is visible, never silent.
 */

import { decoyRng } from "./decoy-invariants";

export class DecoyExpandablesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoyExpandablesError";
  }
}

export interface SyntheticSubresource {
  /** Stable billed id: `sub-<kind>-<baseId>-<k>`, or `sub-<kind>-<k>` for fixed subs. */
  id: string;
  /** The base record id this subresource expands (null for fixed subs). */
  parentId: string | null;
  /** The expansion kind label from the registry. */
  kind: string;
  /** Deterministic display label. */
  label: string;
  /** Deterministic integer value (domain-neutral; hosts needing richer shapes map over the result). */
  value: number;
}

const LABEL_LEFT = ["Northgate", "Saigon Agro", "Mekong", "Highland", "Red River", "Central", "Pacific", "Lotus", "Delta", "Annam"];
const LABEL_RIGHT = ["Trading", "Export", "Foods", "Coffee Co", "Textiles", "Ceramics", "Packaging", "Seafood", "Parts", "Supply"];

/**
 * Generate the synthetic subresources for one expansion of one
 * base record. Deterministic per (seed, path, baseId): the same
 * request always produces the same subresources and the same
 * billed ids.
 */
export function generateSubresources(opts: {
  seed: string;
  path: string;
  kind: string;
  baseId: string;
  count: number;
}): SyntheticSubresource[] {
  if (!Number.isInteger(opts.count) || opts.count < 0) throw new DecoyExpandablesError("count must be a non-negative integer");
  const rnd = decoyRng(opts.seed, `expand:${opts.path}:${opts.baseId}`);
  const out: SyntheticSubresource[] = [];
  for (let k = 0; k < opts.count; k++) {
    const left = LABEL_LEFT[Math.floor(rnd() * LABEL_LEFT.length)] as string;
    const right = LABEL_RIGHT[Math.floor(rnd() * LABEL_RIGHT.length)] as string;
    out.push({
      id: `sub-${opts.kind}-${opts.baseId}-${k + 1}`,
      parentId: opts.baseId,
      kind: opts.kind,
      label: `${left} ${right}`,
      value: 1 + Math.floor(rnd() * 100_000),
    });
  }
  return out;
}

/** Fixed subresources for record-less endpoints (e.g. a calculation breakdown). Deterministic per (seed, path). */
export function generateFixedSubresources(opts: { seed: string; path: string; kind: string; count: number }): SyntheticSubresource[] {
  if (!Number.isInteger(opts.count) || opts.count < 0) throw new DecoyExpandablesError("count must be a non-negative integer");
  const rnd = decoyRng(opts.seed, `expand-fixed:${opts.path}`);
  const out: SyntheticSubresource[] = [];
  for (let k = 0; k < opts.count; k++) {
    const left = LABEL_LEFT[Math.floor(rnd() * LABEL_LEFT.length)] as string;
    const right = LABEL_RIGHT[Math.floor(rnd() * LABEL_RIGHT.length)] as string;
    out.push({
      id: `sub-${opts.kind}-${k + 1}`,
      parentId: null,
      kind: opts.kind,
      label: `${left} ${right}`,
      value: 1 + Math.floor(rnd() * 100_000),
    });
  }
  return out;
}
