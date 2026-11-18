/**
 * Prefix crowding signal (CS-03 PrefixCrowding, Step 0 PASS-lab -
 * see the study lab's REGISTRATION-CS-03-PrefixCrowding-STEP0.md
 * and CS-03-STEP0-RESULTS.md under the antiRea research tree,
 * seed 20299811).
 *
 * WHAT IT MEASURES. Per window, how the active identities
 * distribute across host-supplied network bucket labels (for
 * example source /24 strings or ASN labels the host already logs).
 * Two statistics per bucket, exactly as frozen in the Step 0
 * registration (statistic C-PREFIX):
 * - share: the bucket's distinct active identities divided by all
 *   distinct active identities in the window.
 * - saturation: the bucket's share divided by its trailing
 *   baseline share, the mean of its shares over all previous
 *   windows of the probe (a bucket absent from a previous window
 *   has share 0 in that window). A bucket with zero baseline whose
 *   share reaches the share bar has saturation +Infinity by the
 *   frozen rule; a zero-baseline bucket below the share bar has
 *   saturation 0.
 * A window FLAGS iff at least one bucket has share >= shareBar
 * (default 0.30) AND saturation >= saturationBar (default 2.0) in
 * the same window. The first non-empty window is BASELINE-ONLY:
 * it is never scored, it only starts the baseline.
 *
 * The host supplies bucket labels. This module performs no
 * external lookup, stores no raw IP addresses, and makes no
 * IP-to-bucket assumption of its own: the only helpers are
 * `slash24BucketLabel` (an IPv4 address to its /24 label) and
 * `asnBucketLabel` (a passthrough of a host-supplied ASN label).
 * Any other labelling (IPv6 prefixes, cloud regions, feed-derived
 * ranges such as an NHS-07 style feed) is the host's choice of
 * label strings, passed through unchanged.
 *
 * WHAT THE LAB MEASURED (Step 0, seed 20299811; a statistic-shape
 * probe on SYNTHETIC labels, because the farm generator emits no
 * network bucket labels - this is NOT evidence about real network
 * distributions, and that limitation travels with the verdict):
 * - P1 (false positives): zero flagged windows among the 5 scored
 *   legit windows. The office-NAT confound bucket (B48, drawn by
 *   the seeded lab model) held the largest legit share in 4 of 5
 *   scored windows (0.25 / 0.218 / 0.267 / 0.190 / 0.319); on the
 *   last window its share crossed the 0.30 line, but its
 *   saturation stayed at 1.46 (below 2.0) because the bucket was
 *   present from the first window, so the AND condition protected
 *   it. The tests in tests/prefix-crowding-signal.test.cjs
 *   reproduce those five windows exactly.
 * - P2 (detection sanity, gated placement A): 40 fleet identities
 *   in ONE fresh bucket on a 112-identity window flagged: share
 *   0.357, saturation +Infinity under the zero-baseline rule.
 * - P3 (cost): median 0.022 ms per window against a 10 ms budget.
 * The frozen registration defines gates P1-P3 only.
 *
 * STRUCTURAL BLIND SPOT - declared up front, measured in the lab,
 * and pinned by this module's tests:
 * - SPLIT-FLEET PLACEMENT B DEFEATS IT. The same 40-bot fleet
 *   split 20 + 20 across two fresh buckets reads per-bucket share
 *   0.179 on the same 112-identity window and does NOT flag. A
 *   fleet that spreads across buckets dilutes its own per-bucket
 *   share below the 0.30 line; that is a true property of the
 *   share-plus-saturation shape, recorded in the registration
 *   before the run. This statistic sees concentrated fleets, not
 *   distributed ones, and no claim beyond that is made here.
 *
 * HARD CONDITIONS:
 * - ADVISORY ONLY: every output carries `enforcement: "none"`.
 *   A flag is a property of a WINDOW and a bucket, never a verdict
 *   on an identity or an IP; it must never be the sole basis for
 *   any consequence. Concentration evidence is cohort-level
 *   (the C27 lesson reused by the registration).
 * - OPT-IN: nothing runs until the host constructs an instance
 *   and feeds it labelled windows.
 * - BASELINE HONESTY: a host whose legit population changes shape
 *   (a new office, a new carrier NAT) will see saturation rise for
 *   that bucket; the statistic cannot tell a new legitimate
 *   concentration from a new fleet concentration beyond the
 *   baseline it was fed. Hosts must feed representative baseline
 *   windows before reading flags.
 *
 * Pure computation: no I/O, no runtime dependencies. State is a
 * bounded map of per-bucket trailing share sums (the baseline is
 * a running mean, so no window history is retained) plus counters.
 */

const DEFAULT_SHARE_BAR = 0.3;
const DEFAULT_SATURATION_BAR = 2.0;
const DEFAULT_MAX_BUCKETS = 10_000;
const DEFAULT_MAX_ENTRIES_PER_WINDOW = 100_000;

const ADVISORY_NOTICE =
  "Advisory telemetry only (enforcement: none): per-window concentration of distinct identities " +
  "in host-supplied network bucket labels, read as share against the host trailing baseline " +
  "saturation (CS-03 Step 0, seed 20299811, synthetic lab labels - not a measurement on real " +
  "network distributions). A flag names a bucket in a window, never an identity. Known blind " +
  "spot: a fleet split across two or more buckets dilutes its per-bucket share and is not " +
  "flagged (lab placement B, share 0.179, no flag). Never use this signal as the sole basis " +
  "for any consequence.";

export interface PrefixCrowdingEntry {
  /** The authenticated identity active in the window. Counted once per window. */
  identity: string;
  /** Host-supplied network bucket label for this identity in this window (for example a /24 or ASN string). */
  bucket: string;
}

export interface PrefixCrowdingWindow {
  /** Optional host label for the window (for example a day string). Echoed on the result. */
  windowId?: string;
  /** The identities active in this window, each with its host-supplied bucket label. */
  entries: readonly PrefixCrowdingEntry[];
}

export interface CreatePrefixCrowdingSignalOptions {
  /** Share at or above which a bucket can flag. Default 0.30 (frozen Step 0 bar). */
  shareBar?: number;
  /** Saturation at or above which a bucket can flag. Default 2.0 (frozen Step 0 bar: a doubling over baseline). */
  saturationBar?: number;
  /** Maximum distinct bucket labels whose baseline is tracked (least recently seen evicted). Default 10,000. */
  maxBuckets?: number;
  /** Maximum entries accepted in one window. Default 100,000. */
  maxEntriesPerWindow?: number;
}

export interface PrefixCrowdingBucketResult {
  bucket: string;
  /** Distinct active identities in this bucket in this window. */
  identities: number;
  /** identities divided by all distinct active identities in the window. */
  share: number;
  /** Mean share over all previous windows, or null on the baseline-only first window. */
  baselineShare: number | null;
  /**
   * share divided by baselineShare, or null on the baseline-only
   * first window. +Infinity under the frozen zero-baseline rule
   * (zero baseline and share at or above the share bar); 0 for a
   * zero-baseline bucket below the share bar.
   */
  saturation: number | null;
  /** True iff share >= shareBar and saturation >= saturationBar in this window. */
  flagged: boolean;
}

export interface PrefixCrowdingResult {
  kind: "prefix-crowding";
  /**
   * `"baseline_only"` - the first non-empty window: never scored;
   * `"scored"` - read against the trailing baseline;
   * `"empty_window"` - no usable entries: not scored and does not
   * advance the baseline.
   */
  status: "baseline_only" | "scored" | "empty_window";
  /** True iff at least one bucket flagged in this window. Always false unless scored. */
  flagged: boolean;
  /** The host's window label, or null when none was supplied. */
  windowId: string | null;
  /** 0-based index among non-empty windows fed so far (this window included when non-empty). */
  windowIndex: number | null;
  /** Previous non-empty windows used as the baseline for this window. */
  baselineWindows: number;
  /** Distinct active identities in this window. */
  activeIdentities: number;
  /** Distinct bucket labels in this window. */
  bucketCount: number;
  /** Per-bucket results, sorted by share descending, then bucket label ascending. */
  buckets: PrefixCrowdingBucketResult[];
  /** The largest-share bucket (ties broken by label ascending), or null on an empty window. */
  worstBucket: PrefixCrowdingBucketResult | null;
  /** Buckets that flagged in this window (empty unless scored and flagged). */
  flaggedBuckets: PrefixCrowdingBucketResult[];
  shareBar: number;
  saturationBar: number;
  /** Always `"none"`: this module enforces nothing, about anyone. */
  enforcement: "none";
  notice: string;
}

export interface PrefixCrowdingSnapshot {
  enforcement: "none";
  shareBar: number;
  saturationBar: number;
  /** Non-empty windows fed (baseline windows included). */
  windows: number;
  /** Windows read against a baseline. */
  windowsScored: number;
  /** Scored windows that flagged. */
  windowsFlagged: number;
  /** Distinct bucket labels currently tracked in the baseline. */
  bucketsTracked: number;
  counters: {
    entriesSeen: number;
    /** Entries ignored because their identity was already counted in the same window. */
    duplicateEntries: number;
    /** Duplicate entries whose bucket differed from the identity's first bucket in the window (first label wins). */
    conflictingEntries: number;
    emptyWindows: number;
    /** Bucket baselines evicted past maxBuckets. */
    evictedBuckets: number;
  };
  notice: string;
}

export interface PrefixCrowdingSignalInstance {
  /** Feed one window of host-labelled active identities and read its crowding result. */
  observeWindow(window: PrefixCrowdingWindow): PrefixCrowdingResult;
  /** State summary: window counts, tracked buckets, feed counters, configuration. */
  snapshot(): PrefixCrowdingSnapshot;
}

/** Named error thrown for every invalid prefix-crowding input. */
export class PrefixCrowdingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrefixCrowdingError";
  }
}

const fail = (message: string): never => {
  throw new PrefixCrowdingError(`createPrefixCrowdingSignal: ${message}`);
};

function requireIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requireLabel(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    fail(`${field} must be a string of 1 to 1024 characters`);
  }
  return value as string;
}

/**
 * The only IP-to-bucket assumption in the module: an IPv4 address
 * maps to its /24 label (the first three octets plus ".0/24").
 * Returns null for anything that is not a dotted-quad IPv4 address
 * with octets in 0-255, including every IPv6 form: this module
 * makes no IPv6 bucketing assumption, so IPv6 labels are entirely
 * the host's to supply.
 */
export function slash24BucketLabel(ip: string): string | null {
  if (typeof ip !== "string") return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    if (Number(part) > 255) return null;
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/**
 * ASN label passthrough: the host's ASN label (for example
 * "AS13335") is returned unchanged. The module parses nothing and
 * looks nothing up; a non-string or empty label returns null.
 */
export function asnBucketLabel(label: string): string | null {
  if (typeof label !== "string" || label.length === 0) return null;
  return label;
}

export function createPrefixCrowdingSignal(
  options: CreatePrefixCrowdingSignalOptions = {},
): PrefixCrowdingSignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");

  const shareBar = options.shareBar ?? DEFAULT_SHARE_BAR;
  if (typeof shareBar !== "number" || !Number.isFinite(shareBar) || shareBar <= 0 || shareBar > 1) {
    fail("shareBar must be a finite number in (0, 1]");
  }
  const saturationBar = options.saturationBar ?? DEFAULT_SATURATION_BAR;
  if (typeof saturationBar !== "number" || !Number.isFinite(saturationBar) || saturationBar <= 0) {
    fail("saturationBar must be a positive finite number");
  }
  const maxBuckets = requireIntInRange(options.maxBuckets ?? DEFAULT_MAX_BUCKETS, "maxBuckets", 1, 1_000_000);
  const maxEntriesPerWindow = requireIntInRange(
    options.maxEntriesPerWindow ?? DEFAULT_MAX_ENTRIES_PER_WINDOW,
    "maxEntriesPerWindow",
    1,
    10_000_000,
  );

  /** Trailing share sum per bucket; the baseline mean is sum divided by baselineWindowCount. */
  const shareSums = new Map<string, number>();
  let baselineWindowCount = 0;
  const counters = {
    entriesSeen: 0,
    duplicateEntries: 0,
    conflictingEntries: 0,
    emptyWindows: 0,
    evictedBuckets: 0,
  };
  let windowsScored = 0;
  let windowsFlagged = 0;

  function observeWindow(window: PrefixCrowdingWindow): PrefixCrowdingResult {
    if (typeof window !== "object" || window === null) fail("window must be an object");
    if (window.windowId !== undefined) requireLabel(window.windowId, "window.windowId");
    if (!Array.isArray(window.entries)) fail("window.entries must be an array");
    if (window.entries.length > maxEntriesPerWindow) {
      fail(`window.entries must contain at most ${maxEntriesPerWindow} entries`);
    }
    const base = {
      kind: "prefix-crowding" as const,
      windowId: window.windowId ?? null,
      shareBar,
      saturationBar,
      enforcement: "none" as const,
      notice: ADVISORY_NOTICE,
    };

    // Distinct identities per bucket; the first label an identity
    // carries in a window wins, later entries for it are counted
    // as duplicates (and as conflicts when the label differs).
    const bucketOf = new Map<string, string>();
    for (const entry of window.entries) {
      if (typeof entry !== "object" || entry === null) fail("window entry must be an object");
      const identity = requireLabel(entry.identity, "entry.identity");
      const bucket = requireLabel(entry.bucket, "entry.bucket");
      counters.entriesSeen++;
      const existing = bucketOf.get(identity);
      if (existing !== undefined) {
        counters.duplicateEntries++;
        if (existing !== bucket) counters.conflictingEntries++;
        continue;
      }
      bucketOf.set(identity, bucket);
    }

    const activeIdentities = bucketOf.size;
    if (activeIdentities === 0) {
      counters.emptyWindows++;
      return {
        ...base,
        status: "empty_window",
        flagged: false,
        windowIndex: null,
        baselineWindows: baselineWindowCount,
        activeIdentities: 0,
        bucketCount: 0,
        buckets: [],
        worstBucket: null,
        flaggedBuckets: [],
      };
    }

    const counts = new Map<string, number>();
    for (const bucket of bucketOf.values()) counts.set(bucket, (counts.get(bucket) ?? 0) + 1);

    const isBaselineOnly = baselineWindowCount === 0;
    const buckets: PrefixCrowdingBucketResult[] = [];
    for (const [bucket, identities] of counts) {
      const share = identities / activeIdentities;
      if (isBaselineOnly) {
        buckets.push({ bucket, identities, share, baselineShare: null, saturation: null, flagged: false });
      } else {
        const baselineShare = (shareSums.get(bucket) ?? 0) / baselineWindowCount;
        const saturation =
          baselineShare > 0 ? share / baselineShare : share >= shareBar ? Infinity : 0;
        buckets.push({
          bucket,
          identities,
          share,
          baselineShare,
          saturation,
          flagged: share >= shareBar && saturation >= saturationBar,
        });
      }
    }
    buckets.sort((a, b) => b.share - a.share || (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
    const flaggedBuckets = buckets.filter((entry) => entry.flagged);
    const flagged = flaggedBuckets.length > 0;
    const windowIndex = baselineWindowCount;
    const result: PrefixCrowdingResult = {
      ...base,
      status: isBaselineOnly ? "baseline_only" : "scored",
      flagged,
      windowIndex,
      baselineWindows: baselineWindowCount,
      activeIdentities,
      bucketCount: buckets.length,
      buckets,
      worstBucket: buckets[0] ?? null,
      flaggedBuckets,
    };

    // The baseline updates only after scoring: this window's shares
    // join the trailing mean that later windows are read against.
    // Buckets absent from this window contribute share 0 through
    // the window count alone, exactly as the registration defines.
    for (const entry of buckets) {
      const existing = shareSums.get(entry.bucket);
      if (existing !== undefined) {
        shareSums.delete(entry.bucket);
        shareSums.set(entry.bucket, existing + entry.share);
      } else {
        shareSums.set(entry.bucket, entry.share);
      }
    }
    while (shareSums.size > maxBuckets) {
      const oldest = shareSums.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      shareSums.delete(oldest);
      counters.evictedBuckets++;
    }
    baselineWindowCount++;
    if (!isBaselineOnly) {
      windowsScored++;
      if (flagged) windowsFlagged++;
    }
    return result;
  }

  function snapshot(): PrefixCrowdingSnapshot {
    return {
      enforcement: "none",
      shareBar,
      saturationBar,
      windows: baselineWindowCount,
      windowsScored,
      windowsFlagged,
      bucketsTracked: shareSums.size,
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  return { observeWindow, snapshot };
}
