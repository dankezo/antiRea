/**
 * AC-20 - Existence pair: pixel-diff vs blueprint match (PASS-LAB,
 * existence pair only).
 *
 * Lab record (ac-batch1-lab, RESULTS-AC-BATCH1-STEP0.md,
 * ac20-results.json, seed 20322306): a visually-identical /
 * structurally-different variant CAN exist at these tolerances:
 *   pixel-diff 28 / 12,960 cells = 0.00216 (gate at most 0.005)
 *   blueprint match 5 / 71 nodes = 0.070 (gate at most 0.60)
 * Selector divergence (descriptive): 0.85.
 *
 * TRIGGER FRAGILITY, on record and repeated here: this measures
 * that the pair can exist; it says nothing about the trigger that
 * would deploy the variant. AC-16's own Step-0 margin was 1 point
 * (C52), so any triggered deployment of AC-20 inherits a fragile
 * trigger. This utility is the paired check only: given two
 * captures (pixel cells and blueprint nodes), it reports both
 * fractions and whether the existence pair holds at the lab gates.
 * It makes no deployment decision.
 *
 * Opt-in: nothing calls this by default.
 */

export const AC20_PIXEL_DIFF_GATE = 0.005;
export const AC20_BLUEPRINT_MATCH_GATE = 0.6;

export interface ExistencePairResult {
  /** Fraction of pixel cells that differ (0 when both captures are empty). */
  pixelDiffFraction: number;
  differingCells: number;
  totalCells: number;
  /** Fraction of blueprint nodes in A that match a node in B by key. */
  blueprintMatchFraction: number;
  matchedNodes: number;
  totalNodes: number;
  /** True when both lab gates hold at once (the existence pair). */
  pairHolds: boolean;
  /** Standing note from the record: the trigger, not the pair, is the fragile part. */
  triggerFragility: "noted-on-record";
  enforcement: "none";
}

/**
 * Paired check. Pixel cells are compared position by position over
 * the longer capture (a missing cell counts as differing). Blueprint
 * nodes are compared by their string keys: a node in A matches when
 * the same key exists in B.
 */
export function evaluateExistencePair(input: {
  pixelCellsA: readonly unknown[];
  pixelCellsB: readonly unknown[];
  blueprintKeysA: readonly string[];
  blueprintKeysB: readonly string[];
}): ExistencePairResult {
  const cellsA = input.pixelCellsA ?? [];
  const cellsB = input.pixelCellsB ?? [];
  const totalCells = Math.max(cellsA.length, cellsB.length);
  let differing = 0;
  for (let i = 0; i < totalCells; i++) {
    if (cellsA[i] !== cellsB[i]) differing++;
  }
  const keysA = input.blueprintKeysA ?? [];
  const keysB = new Set(input.blueprintKeysB ?? []);
  let matched = 0;
  for (const key of keysA) if (keysB.has(key)) matched++;
  const pixelDiffFraction = totalCells === 0 ? 0 : differing / totalCells;
  const blueprintMatchFraction = keysA.length === 0 ? 0 : matched / keysA.length;
  return {
    pixelDiffFraction,
    differingCells: differing,
    totalCells,
    blueprintMatchFraction,
    matchedNodes: matched,
    totalNodes: keysA.length,
    pairHolds: pixelDiffFraction <= AC20_PIXEL_DIFF_GATE && blueprintMatchFraction <= AC20_BLUEPRINT_MATCH_GATE,
    triggerFragility: "noted-on-record",
    enforcement: "none",
  };
}
