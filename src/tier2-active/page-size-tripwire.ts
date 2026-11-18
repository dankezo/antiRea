/**
 * AC-03 - Page-size sweep of the union tripwire (PASS-LAB-WITH-COST).
 *
 * Lab record (ac-batch2-lab, RESULTS-AC-BATCH2.md, ac03-results.json;
 * frozen C61 construction over the shipped e-value tripwire defaults):
 * on the registered 120-record union, NO page size fires:
 *   page size 20: peak capital 1.587 (hand-derived 1.5865), crossed false
 *   page size 50: peak capital 2.194 (hand-derived 2.1935), crossed false
 * against the threshold 20. The extension drains cross at:
 *   U*(50) = 320 novel records, U*(20) = 460 novel records,
 *   U*(10) never crosses at or below 2,120 novel records.
 *
 * COST ON RECORD, encoded here rather than hidden: the tripwire is
 * BLIND at the 120-record scale at every page size. Small-scale
 * protection is the meter layer (the shipped record budget,
 * createRecordBudget, and the export guard), not this visibility
 * layer. A legitimate reader draining the same union at the same
 * page size produces the identical stream: this remains an advisory
 * volume signal, as designed.
 *
 * This module is the page-size-aware extension surface: it reports,
 * for a host-declared page size and observed novel-record count,
 * whether the lab-measured crossing point for that page size has
 * been reached, and it exposes the measured 120-record peaks so a
 * host never has to guess what the tripwire can and cannot see.
 * Opt-in: nothing in the shipped tripwires calls this by default.
 */

export interface PageSizeSweepCell {
  pageSize: number;
  /** Peak e-process capital on the 120-record union, lab-measured where available. */
  peakCapitalAt120?: number;
  /** Novel-record union size at which the extension crosses, or null when it never crosses at or below the lab cap. */
  crossingUnion: number | null;
  /** Lab cap for the never-crossing statement. */
  crossingCap?: number;
}

/** Lab-measured sweep table (AC-03). Page sizes outside the table were not measured. */
export const AC03_PAGE_SIZE_SWEEP: readonly PageSizeSweepCell[] = [
  { pageSize: 10, crossingUnion: null, crossingCap: 2120 },
  { pageSize: 20, peakCapitalAt120: 1.587, crossingUnion: 460 },
  { pageSize: 50, peakCapitalAt120: 2.194, crossingUnion: 320 },
];

/** The tripwire threshold the lab peaks are read against. */
export const AC03_TRIPWIRE_THRESHOLD = 20;

/** The union size at which the lab found the tripwire blind at every page size. */
export const AC03_BLIND_UNION_RECORDS = 120;

export interface PageSizeCrossingResult {
  pageSize: number;
  novelRecords: number;
  /** True only when the lab-measured crossing union for this page size is known and reached. */
  crossed: boolean;
  /** The lab crossing union for this page size, or null when never / unmeasured. */
  crossingUnion: number | null;
  /** True when this page size has a lab measurement at all. */
  measured: boolean;
  /** Standing cost note: below the crossing union, protection is the meter layer. */
  protectionLayerBelowCrossing: "meter";
}

/**
 * Page-size-aware crossing check, using only lab-measured crossing
 * points. Unmeasured page sizes report measured: false and never
 * claim a crossing.
 */
export function evaluatePageSizeCrossing(pageSize: number, novelRecords: number): PageSizeCrossingResult {
  const size = Math.floor(pageSize);
  const novel = Math.max(0, Math.floor(novelRecords) || 0);
  const cell = AC03_PAGE_SIZE_SWEEP.find(c => c.pageSize === size);
  if (!cell) {
    return {
      pageSize: size,
      novelRecords: novel,
      crossed: false,
      crossingUnion: null,
      measured: false,
      protectionLayerBelowCrossing: "meter",
    };
  }
  return {
    pageSize: size,
    novelRecords: novel,
    crossed: cell.crossingUnion !== null && novel >= cell.crossingUnion,
    crossingUnion: cell.crossingUnion,
    measured: true,
    protectionLayerBelowCrossing: "meter",
  };
}

/**
 * The measured peak capital on the 120-record union for a page size,
 * or undefined when that page size was not in the lab sweep. Every
 * measured peak is far below AC03_TRIPWIRE_THRESHOLD: at the
 * 120-record scale the tripwire does not fire at any page size.
 */
export function peakCapitalAt120(pageSize: number): number | undefined {
  return AC03_PAGE_SIZE_SWEEP.find(c => c.pageSize === Math.floor(pageSize))?.peakCapitalAt120;
}
