/**
 * Volume-rank rule - the R2-rank rule over EB05 cell scores, stratified
 * by identity volume (RECOMB-04 VOLUME-RANK, PASS-lab cycle C444,
 * 2026-11-13; registration recomb04-lab/
 * REGISTRATION-RECOMB-04-VOLUME-RANK.md, results recomb04-lab/
 * RESULTS.md).
 *
 * The problem this answers: a single rare-cell rank rule (flag an
 * identity when ONE of its rare-class cells ranks in the top 5% of all
 * cells by empirical-Bayes score) flags up to 30% of high-volume
 * legitimate identities in the lab, because high-volume identities own
 * many cells and one of them lands in the tail by chance. Requiring
 * TWO rare cells in the top slice (the R2 rule) buys the false-positive
 * headroom back: in the lab the R2 rule held legit FP at 0 in the same
 * HIGH stratum where the single-cell rule failed, while keeping walker
 * detection at 0.85-0.90 at every gated heterogeneity level.
 *
 * FROZEN RULE (from the registration, unchanged):
 * - Rank ALL cells by their two-component EB05 score DESCENDING.
 *   rankPct = 1 - rank / nCells, rank 0-based. The cutoff for a top
 *   fraction f is floor(nCells * f): a cell is in the top slice iff
 *   rank < cutoff.
 * - R2-rank5: an identity is flagged iff >= 2 of its RARE cells rank
 *   in the top 5%. R2-rank10 is the same rule at 10% and is reported
 *   descriptively only (in the lab its HIGH-stratum legit FP rose to
 *   0.12-0.21 - too loose to operate).
 * - Strata come from the identity's TOTAL VOLUME (a server-countable
 *   quantity) with frozen log-space boundaries, the geometric
 *   midpoints of the lab's legit volume-law medians (20 / 200 / 2000):
 *   volume < 63.2 -> LOW; 63.2 <= volume <= 632.5 -> MID;
 *   volume > 632.5 -> HIGH.
 *
 * TIES. The lab probe sorted with JavaScript's stable sort and did
 * not special-case equal scores, so tied cells keep their relative
 * INPUT ORDER in the ranking. This module does the same (Array sort
 * is stable in ES2019+): when scores tie at the cutoff, whichever
 * cell the host listed first takes the top-slice slot. Hosts feeding
 * scores with many exact ties should treat boundary membership as
 * arbitrary within the tie block.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not compute EB05: the
 * two-component MGPS fit (DuMouchel 1999, EM with a grid M-step) that
 * produced the lab scores is a batch analytics job, not a request-path
 * primitive, and stays host-side. The host supplies one scored cell
 * per (identity, class) - or any cell partition it uses - plus each
 * identity's total volume, and this pure function applies the frozen
 * rule. It holds no state and makes no decision: the output is a
 * per-identity flag for the host's own response policy.
 *
 * HONESTY SCOPE (read before wiring anything):
 * - The verdict is a LAB verdict on synthetic strata (scripted legit /
 *   walker / padded populations, Dirichlet heterogeneity grid). No
 *   real-traffic detection or FP rate is claimed.
 * - Detection was measured in the MID stratum ONLY: the frozen walker
 *   volume law (lognormal with support inside [100, 600]) placed
 *   every walker in MID at every grid point, so LOW and HIGH walker
 *   detection is UNMEASURED - the lab cannot say whether the rule
 *   holds for low- or high-volume walkers. Legit FP was measured in
 *   all three strata.
 * - The lab's legitimate stratum was its generator mixture label;
 *   this function reports strata from observed total volume. Those
 *   labels need not agree, so the lab's per-stratum FP rates cannot
 *   be transferred to this output without regrouping the fixtures.
 * - The detection margin at the two highest heterogeneity levels was
 *   thin (0.85 = 17/20 walkers; two walkers flipping would fail the
 *   frozen 0.80 bar). Treat the rule as viable-in-lab, not robust.
 * - No production operating threshold is claimed, and no mapping from
 *   observed volume to heterogeneity regime on real traces exists yet
 *   (that mapping waits on the farm calibration gate). ADVISORY ONLY:
 *   a flag is an investigation signal, never proof of abuse.
 */

export type VolumeStratum = "LOW" | "MID" | "HIGH";

/** Frozen stratum boundaries (registration section 3): volume < 63.2 is LOW. */
export const VOLUME_STRATUM_LOW_MAX = 63.2;
/** Frozen stratum boundaries (registration section 3): volume <= 632.5 is MID, above is HIGH. */
export const VOLUME_STRATUM_MID_MAX = 632.5;

/** Minimum rare cells in the top slice for a flag (the "2" in R2). */
export const VOLUME_RANK_MIN_RARE_CELLS = 2;

export interface VolumeRankCell {
  /** Identity that owns this cell. */
  identityId: string;
  /** Two-component EB05 score for the cell (host-computed; higher = more anomalous). */
  score: number;
  /** Whether the cell's class is one of the host's rare classes. */
  rare: boolean;
}

export interface VolumeRankIdentityResult {
  /** R2 rule at the primary top fraction (>= 2 rare cells in the top slice). */
  flagged: boolean;
  /** R2 rule at the descriptive top fraction (looser; reported, not operated). */
  flaggedDescriptive: boolean;
  /** Rare cells of this identity ranked in the primary top slice. */
  rareCellsInTop: number;
  /** Rare cells of this identity ranked in the descriptive top slice. */
  rareCellsInTopDescriptive: number;
  /** Total rare cells of this identity in the input. */
  rareCellCount: number;
  /** Volume stratum, or null when the identity has no finite recorded volume. */
  stratum: VolumeStratum | null;
}

export interface VolumeRankStratumSummary {
  identities: number;
  flagged: number;
  flaggedDescriptive: number;
}

export interface VolumeRankResult {
  /** Per-identity rule outcome, keyed by identityId, for every identity present in `cells`. */
  identities: Record<string, VolumeRankIdentityResult>;
  /** Per-stratum counts. `NONE` collects identities with no finite recorded volume. */
  summary: Record<VolumeStratum | "NONE", VolumeRankStratumSummary>;
  /** Total cells ranked (nCells in the frozen construction). */
  cellCount: number;
}

export interface VolumeRankInput {
  cells: readonly VolumeRankCell[];
  /** Total volume per identity (same units the frozen boundaries were set in: the lab used total action counts). */
  identityVolumes: Record<string, number>;
  /** Primary top fraction. Default 0.05 (R2-rank5). */
  topFrac?: number;
  /** Descriptive top fraction. Default 0.10 (R2-rank10). */
  topFracDescriptive?: number;
}

/**
 * Assign the frozen volume stratum for one identity volume.
 * Returns null for non-finite or negative volumes (no stratum can be claimed).
 */
export function volumeStratumOf(volume: number): VolumeStratum | null {
  if (!Number.isFinite(volume) || volume < 0) return null;
  if (volume < VOLUME_STRATUM_LOW_MAX) return "LOW";
  if (volume <= VOLUME_STRATUM_MID_MAX) return "MID";
  return "HIGH";
}

function checkFrac(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new RangeError(name + " must be a finite fraction in (0, 1], got " + value);
  }
}

function emptySummary(): Record<VolumeStratum | "NONE", VolumeRankStratumSummary> {
  return {
    LOW: { identities: 0, flagged: 0, flaggedDescriptive: 0 },
    MID: { identities: 0, flagged: 0, flaggedDescriptive: 0 },
    HIGH: { identities: 0, flagged: 0, flaggedDescriptive: 0 },
    NONE: { identities: 0, flagged: 0, flaggedDescriptive: 0 },
  };
}

/**
 * Apply the frozen R2-rank rule to host-scored cells.
 *
 * Pure: no state, no clock, no I/O. Identities are reported for every
 * identityId that owns at least one input cell; identities present
 * only in `identityVolumes` own no cells and are not reported.
 */
export function applyVolumeRankRule(input: VolumeRankInput): VolumeRankResult {
  const topFrac = input.topFrac ?? 0.05;
  const topFracDescriptive = input.topFracDescriptive ?? 0.1;
  checkFrac("topFrac", topFrac);
  checkFrac("topFracDescriptive", topFracDescriptive);

  const cells = input.cells;
  const nCells = cells.length;
  // Batch input is bounded before allocating ranking/index state.
  if (nCells > 100_000) throw new RangeError("cells must contain at most 100000 entries");
  for (const cell of cells) {
    if (!cell || typeof cell.identityId !== "string" || cell.identityId.length === 0 || cell.identityId.length > 1024) {
      throw new RangeError("cell identityId must contain 1 to 1024 characters");
    }
    if (!Number.isFinite(cell.score)) throw new RangeError("cell score must be finite");
    if (typeof cell.rare !== "boolean") throw new RangeError("cell rare must be boolean");
  }
  const cutoff = Math.floor(nCells * topFrac);
  const cutoffDescriptive = Math.floor(nCells * topFracDescriptive);

  // Rank ALL cells by score descending. The sort is stable, so tied
  // scores keep input order - the lab probe's tie behaviour, kept
  // deliberately (see the header).
  const order = cells.map((_, i) => i);
  order.sort((a, b) => {
    const sa = cells[a]!.score;
    const sb = cells[b]!.score;
    return sb - sa;
  });
  const rankOf = new Array<number>(nCells);
  order.forEach((cellIndex, rank) => {
    rankOf[cellIndex] = rank;
  });

  const identities: Record<string, VolumeRankIdentityResult> = {};
  const acc = new Map<string, VolumeRankIdentityResult>();
  cells.forEach((cell, i) => {
    let entry = acc.get(cell.identityId);
    if (!entry) {
      entry = {
        flagged: false,
        flaggedDescriptive: false,
        rareCellsInTop: 0,
        rareCellsInTopDescriptive: 0,
        rareCellCount: 0,
        stratum: volumeStratumOf(Object.prototype.hasOwnProperty.call(input.identityVolumes, cell.identityId)
          ? input.identityVolumes[cell.identityId]! : NaN),
      };
      acc.set(cell.identityId, entry);
    }
    if (cell.rare) {
      entry.rareCellCount++;
      const rank = rankOf[i]!;
      if (rank < cutoff) entry.rareCellsInTop++;
      if (rank < cutoffDescriptive) entry.rareCellsInTopDescriptive++;
    }
  });

  const summary = emptySummary();
  for (const [identityId, entry] of acc) {
    entry.flagged = entry.rareCellsInTop >= VOLUME_RANK_MIN_RARE_CELLS;
    entry.flaggedDescriptive = entry.rareCellsInTopDescriptive >= VOLUME_RANK_MIN_RARE_CELLS;
    // An identity is data even when its name matches Object.prototype.
    Object.defineProperty(identities, identityId, { value: entry, enumerable: true, configurable: true, writable: true });
    const bucket = summary[entry.stratum ?? "NONE"];
    bucket.identities++;
    if (entry.flagged) bucket.flagged++;
    if (entry.flaggedDescriptive) bucket.flaggedDescriptive++;
  }

  return { identities, summary, cellCount: nCells };
}
