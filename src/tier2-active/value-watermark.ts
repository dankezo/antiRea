/**
 * Value watermark (HARVEST2 candidate C39, lab PASS at the
 * "SUPREME" standard - see the study lab's C39-DESIGN-SUPREME.md,
 * C39-RESULTS-SUPREME.md, C39-DESIGN-POOL.md and
 * C39-RESULTS-POOL.md under the antiRea research tree).
 *
 * WHAT IT MEASURES. A derived per-edition total (a feed/export
 * number computed from q x p per record) is published with a small
 * keyed residue added record by record, so a later republication
 * of the same edition can be checked for provenance: whoever
 * republishes the numbers carries the residue digits with them
 * unless they change the totals enough to destroy the lower
 * decimal digits the residue lives in. The statistic is per
 * decimal scale (units / tens / hundreds): on each scale, the
 * fraction of records whose republished residue digit still equals
 * the keyed digit g for that record.
 *
 * THE FROZEN LAB RULE, translated without re-invention
 * (SUPREME = UPG-C placement x UPG-B R-ADAPT confirmation):
 * - Residues g in {0..6} are keyed per record and scale, with the
 *   lab's salts verbatim: units salt 0, tens salt 7919, hundreds
 *   salt 104729.
 * - Placement is by the record's own magnitude T = q * p:
 *   T >= 20,000 -> a = gU + 10*gT + 100*gH (three scales);
 *   2,000 <= T < 20,000 -> a = gU + 10*gT (two scales);
 *   T < 2,000 -> a = gU (units only). So 0 <= a <= 666 always,
 *   and small totals never carry a hundreds residue (lab
 *   distortion: median a/T 0.229%, p99 2.18% over 500 records).
 * - Verification decodes aHat = round(publishedTotal - q * p) by
 *   divmod over the three scales: units digit = mod10(aHat),
 *   tens digit = mod10(floor(aHat / 10)), hundreds digit =
 *   floor(aHat / 100). Eligibility is read from the record's
 *   ORIGINAL T = q * p (deviation D-S1 of the lab, applied
 *   verbatim): units are eligible on every record, tens only on
 *   T >= 2,000, hundreds only on T >= 20,000, and the hundreds
 *   scale can only confirm when its eligible set is >= 50.
 * - Per-scale confirmation is R-ADAPT verbatim: matches >= 3 AND
 *   match fraction >= 0.30 over that scale's eligible set AND
 *   matches >= the binomial expectation at p = 1/7 plus 8 SD.
 *   The edition verdict is the OR of the three scales.
 * - Group totals (verbatim from supreme.cjs checkGroupsSupreme):
 *   a group matches iff (sum of published totals - sum of q * p)
 *   equals the sum of the members' placement residues exactly,
 *   and the batch confirms iff >= 5 groups match (the lab harness
 *   formed 50 groups of 10; the rule is the absolute >= 5).
 * - Pooled LOW evidence (C39-POOL, the registered patch for the
 *   one thin spot of SUPREME): records with T < 2,000 carry only
 *   the units scale, and a single edition's LOW set is far too
 *   small for the 8 SD floor (lab: n ~ 5/500, confirmation
 *   arithmetically impossible). verifyEdition therefore also
 *   accumulates the LOW tier's (matches, eligible) into the
 *   instance, and pooledLowStatus() applies R-ADAPT verbatim to
 *   the pooled counts (lab: 80 pooled editions, n ~ 421, target
 *   cell 94% under +-1 noise, all FP cells 0%).
 *
 * PORT DEVIATION - DECLARED, the g stream. The lab's g was a
 * two-key toy hash over numeric ids and edition labels 'A'/'B'.
 * This module's g is FNV-1a 32-bit over (key, editionId,
 * recordId, scale salt) followed by a murmur-style avalanche,
 * reduced mod 7. That is a DIFFERENT stream from the lab's: the
 * individual digits differ for the same record. What is identical
 * is what the frozen rule actually depends on: g is deterministic
 * per (key, edition, record, scale), independent across scales
 * via the lab salts, and uniform on {0..6}, so the placement,
 * the binomial p = 1/7 in R-ADAPT, and every confirmation
 * statistic are unchanged. The SDK recheck re-measures the
 * decisive lab cells against this stream on fresh seeds.
 *
 * HARD CONDITIONS - in the code, not just the docs:
 *
 * 1. HOST KEY IS MANDATORY. `key` is the host's secret string;
 *    construction without a non-empty key throws
 *    ValueWatermarkError. The key never leaves the host: marking
 *    and verification both happen host-side.
 * 2. ADVISORY ONLY. Every result carries `enforcement: "none"`.
 *    A confirmation is provenance telemetry about an edition,
 *    never a blocking decision and never proof of intent.
 * 3. OPERATIONAL CONSTRAINTS (verbatim from the lab):
 *    "chỉ số dẫn xuất feed/export theo ấn bản; KHÔNG giá giao
 *    dịch/tổng hoá đơn; cần bộ ba (q, p, T) nguyên vẹn; chết cấu
 *    trúc: tái tính từ thành phần = không xác nhận theo xây dựng;
 *    evader biết cả cấu hình phá được (ranh giới đã khai)".
 *    In English: the watermark applies only
 *    to derived per-edition feed/export numbers, NEVER to
 *    transaction prices or invoice totals, and verification is
 *    only possible while the (q, p, publishedTotal) triple of
 *    each record survives intact.
 *
 * KNOWN BLINDNESS - measured in the lab, pinned by tests.
 * Structural death 1: a republisher who RECOMPUTES the totals
 * from the components (publishedTotal := q * p) carries no
 * residue at all, so verification confirms 0% BY CONSTRUCTION
 * (lab K3: 0% on every column) - C39 claims provenance only
 * through republication chains that carry the published totals.
 * Structural death 2, the declared evader boundary: an evader
 * who knows the WHOLE configuration (placement tiers and every
 * scale for their records) can strip and re-forge residues and
 * breaks the watermark completely (lab EV-ALL: 0%); evaders who
 * know only one or two scales are still caught by the remaining
 * scale (lab EV-U / EV-T / EV-H / EV-UT: 100% combined). Do not
 * read this module as claiming anything against the
 * knows-everything evader.
 *
 * Lab headline numbers (synthetic substrate, supreme.cjs seed
 * 20261601, 200 reps/cell; pool.cjs seed 20262101): FP 0%
 * absolute on all 15 false-positive values (exact / rounding /
 * cross-key x scales, plus the unit-only control arm), 18/18
 * gated transform cells at 100% combined (including +-1 noise
 * and rounding to hundreds), controls K1-K3 at 0%. All numbers
 * are lab substrate; calibration on real export traffic is the
 * farm gate (~16/11) and has not happened.
 *
 * Pure computation: no I/O, no runtime dependencies. Pooled LOW
 * state is three counters plus an edition count on the instance.
 */

/** One source record of an edition: quantity q at unit price p; T = q * p is the record's original total. */
export interface ValueWatermarkRecord {
  /** Record identifier inside the edition; a non-empty string or a finite number. */
  id: string | number;
  q: number;
  p: number;
}

/** A source record after marking: the published total carries the placement residue. */
export interface ValueWatermarkMarkedRecord extends ValueWatermarkRecord {
  publishedTotal: number;
}

/** A record as republished: the (q, p, publishedTotal) triple verification needs intact. */
export interface ValueWatermarkPublishedRecord extends ValueWatermarkRecord {
  publishedTotal: number;
}

/** One group for the group-totals check: member records plus the group's published (summed) total. */
export interface ValueWatermarkGroup {
  records: ValueWatermarkRecord[];
  publishedTotal: number;
}

export interface CreateValueWatermarkOptions {
  /**
   * The host's secret key string. MANDATORY: construction throws
   * ValueWatermarkError when it is missing or empty (hard
   * condition 1). Keep it server-side; rotating it invalidates
   * every previously marked edition.
   */
  key: string;
}

/** Per-scale verification outcome: matches over the scale's eligible set, and its R-ADAPT verdict. */
export interface ValueWatermarkScaleResult {
  matches: number;
  eligible: number;
  confirmed: boolean;
}

export interface ValueWatermarkVerification {
  /** OR of the three scales' R-ADAPT confirmations. */
  confirmed: boolean;
  scales: {
    unit: ValueWatermarkScaleResult;
    tens: ValueWatermarkScaleResult;
    hundreds: ValueWatermarkScaleResult;
  };
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
}

export interface ValueWatermarkPooledLowStatus {
  /** verifyEdition calls that contributed at least one LOW-tier (T < 2,000) record. */
  editions: number;
  /** Pooled LOW-tier records checked (units scale). */
  eligible: number;
  /** Pooled LOW-tier units matches. */
  matches: number;
  /** R-ADAPT applied verbatim to the pooled counts. */
  confirmed: boolean;
}

export interface ValueWatermarkGroupResult {
  matchedGroups: number;
  totalGroups: number;
  /** Verbatim lab rule: at least 5 matched groups (supreme.cjs checkGroupsSupreme). */
  confirmed: boolean;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
}

export interface ValueWatermarkInstance {
  /** Always `"none"`: this module enforces nothing. */
  readonly enforcement: "none";
  /**
   * Mark one edition: returns NEW record objects carrying
   * `publishedTotal = q * p + a` with the SUPREME placement
   * residue a for the record's magnitude tier. Inputs are never
   * mutated. Throws ValueWatermarkError on corrupt records.
   */
  markEdition(editionId: string, records: ValueWatermarkRecord[]): ValueWatermarkMarkedRecord[];
  /**
   * Verify one republished edition against this instance's key.
   * Never throws for a mismatch - a non-matching edition is the
   * result `confirmed: false`. Throws ValueWatermarkError only
   * on corrupt input (non-finite q / p / publishedTotal, empty
   * id, empty editionId). As a side effect, the LOW tier's
   * (matches, eligible) are accumulated into the pooled state
   * read by pooledLowStatus().
   */
  verifyEdition(editionId: string, records: ValueWatermarkPublishedRecord[]): ValueWatermarkVerification;
  /** Pooled LOW-tier evidence across every verifyEdition call so far on this instance. */
  pooledLowStatus(): ValueWatermarkPooledLowStatus;
  /** Forget all pooled LOW-tier evidence. */
  resetPooledLow(): void;
  /**
   * Verify group totals: a group matches iff
   * (group publishedTotal - sum of q * p over its records)
   * equals the sum of the members' placement residues exactly;
   * the batch confirms iff >= 5 groups match (lab rule verbatim).
   */
  verifyGroupTotals(editionId: string, groups: ValueWatermarkGroup[]): ValueWatermarkGroupResult;
}

/** Named error thrown for every invalid value-watermark input. */
export class ValueWatermarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueWatermarkError";
  }
}

const fail = (message: string): never => {
  throw new ValueWatermarkError(`createValueWatermark: ${message}`);
};

/* The lab's scale salts, verbatim (supreme.cjs: gU salt 0, gT salt 7919, gH salt 104729). */
const SALT_UNIT = 0;
const SALT_TENS = 7919;
const SALT_HUNDREDS = 104729;

/* Magnitude tiers, verbatim placement thresholds. */
const TENS_FLOOR = 2_000;
const HUNDREDS_FLOOR = 20_000;
/* The hundreds scale confirms only on an eligible set of at least 50 (UPG-C verbatim). */
const HUNDREDS_MIN_ELIGIBLE = 50;
/* Group-totals confirmation: >= 5 matched groups (supreme.cjs checkGroupsSupreme). */
const GROUP_MIN_MATCHES = 5;

const mod10 = (n: number): number => ((n % 10) + 10) % 10;

/**
 * R-ADAPT verbatim (supreme.cjs confirmAdapt): matches >= 3 AND
 * match fraction >= 0.30 AND matches >= binomial expectation at
 * p = 1/7 plus 8 SD, all over the scale's eligible set.
 */
function confirmAdapt(matches: number, checked: number): boolean {
  if (checked === 0 || matches < 3) return false;
  const p = 1 / 7;
  const exp = checked * p;
  const sd = Math.sqrt(checked * p * (1 - p));
  return matches >= 0.3 * checked && matches >= exp + 8 * sd;
}

function requireEditionId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value as string;
}

function requireRecordId(value: unknown, field: string): string | number {
  if (typeof value === "string") {
    if (value.trim().length === 0) fail(`${field} must be a non-empty string or a finite number`);
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fail(`${field} must be a non-empty string or a finite number`);
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${field} must be a finite number`);
  }
  return value as number;
}

interface ValidatedRecord {
  id: string | number;
  q: number;
  p: number;
  /** Original total T = q * p; placement and eligibility read from it. */
  T: number;
}

function validateSourceRecord(record: unknown, field: string): ValidatedRecord {
  if (typeof record !== "object" || record === null) fail(`${field} must be an object`);
  const r = record as Record<string, unknown>;
  const id = requireRecordId(r["id"], `${field}.id`);
  const q = requireFiniteNumber(r["q"], `${field}.q`);
  const p = requireFiniteNumber(r["p"], `${field}.p`);
  return { id, q, p, T: q * p };
}

export function createValueWatermark(options: CreateValueWatermarkOptions): ValueWatermarkInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");
  const key = options.key;
  if (typeof key !== "string" || key.trim().length === 0) {
    fail("options.key must be a non-empty string (the host secret is mandatory)");
  }

  /**
   * The keyed residue digit g in {0..6}: FNV-1a 32-bit over
   * (key, editionId, recordId, salt) with a murmur-style
   * avalanche, reduced mod 7. PORT DEVIATION from the lab stream
   * - declared in the header: a different stream, the same
   * uniform {0..6} distribution and the same frozen statistics.
   */
  function g(editionId: string, recordId: string | number, salt: number): number {
    const material = `${key}\u0000${editionId}\u0000${String(recordId)}\u0000${salt}`;
    let hsh = 0x811c9dc5;
    for (let i = 0; i < material.length; i++) {
      hsh ^= material.charCodeAt(i);
      hsh = Math.imul(hsh, 0x01000193);
    }
    hsh ^= hsh >>> 16;
    hsh = Math.imul(hsh, 2246822507);
    hsh ^= hsh >>> 13;
    hsh = Math.imul(hsh, 3266489909);
    hsh ^= hsh >>> 16;
    return (hsh >>> 0) % 7;
  }

  /** SUPREME placement residue for one record, by its original T. Always 0 <= a <= 666. */
  function placementResidue(editionId: string, rec: ValidatedRecord): number {
    let a = g(editionId, rec.id, SALT_UNIT);
    if (rec.T >= TENS_FLOOR) a += 10 * g(editionId, rec.id, SALT_TENS);
    if (rec.T >= HUNDREDS_FLOOR) a += 100 * g(editionId, rec.id, SALT_HUNDREDS);
    return a;
  }

  /* Pooled LOW-tier state (C39-POOL): accumulated by verifyEdition. */
  let pooledEditions = 0;
  let pooledEligible = 0;
  let pooledMatches = 0;

  function markEdition(editionId: string, records: ValueWatermarkRecord[]): ValueWatermarkMarkedRecord[] {
    const ed = requireEditionId(editionId, "editionId");
    if (!Array.isArray(records)) fail("records must be an array");
    return records.map((record, i) => {
      const rec = validateSourceRecord(record, `records[${i}]`);
      return { ...record, publishedTotal: rec.T + placementResidue(ed, rec) };
    });
  }

  function verifyEdition(editionId: string, records: ValueWatermarkPublishedRecord[]): ValueWatermarkVerification {
    const ed = requireEditionId(editionId, "editionId");
    if (!Array.isArray(records)) fail("records must be an array");
    let um = 0,
      uc = 0,
      tm = 0,
      tc = 0,
      hm = 0,
      hc = 0;
    let lowMatches = 0,
      lowEligible = 0;
    records.forEach((record, i) => {
      const rec = validateSourceRecord(record, `records[${i}]`);
      const publishedTotal = requireFiniteNumber(
        (record as unknown as Record<string, unknown>)["publishedTotal"],
        `records[${i}].publishedTotal`,
      );
      const aHat = Math.round(publishedTotal - rec.q * rec.p);
      uc++;
      const unitMatch = mod10(aHat) === g(ed, rec.id, SALT_UNIT);
      if (unitMatch) um++;
      if (rec.T < TENS_FLOOR) {
        lowEligible++;
        if (unitMatch) lowMatches++;
      }
      if (rec.T >= TENS_FLOOR) {
        tc++;
        if (mod10(Math.floor(aHat / 10)) === g(ed, rec.id, SALT_TENS)) tm++;
      }
      if (rec.T >= HUNDREDS_FLOOR) {
        hc++;
        if (Math.floor(aHat / 100) === g(ed, rec.id, SALT_HUNDREDS)) hm++;
      }
    });
    if (lowEligible > 0) {
      pooledEditions++;
      pooledEligible += lowEligible;
      pooledMatches += lowMatches;
    }
    const unit = { matches: um, eligible: uc, confirmed: confirmAdapt(um, uc) };
    const tens = { matches: tm, eligible: tc, confirmed: confirmAdapt(tm, tc) };
    const hundreds = {
      matches: hm,
      eligible: hc,
      confirmed: hc >= HUNDREDS_MIN_ELIGIBLE && confirmAdapt(hm, hc),
    };
    return {
      confirmed: unit.confirmed || tens.confirmed || hundreds.confirmed,
      scales: { unit, tens, hundreds },
      enforcement: "none",
    };
  }

  function pooledLowStatus(): ValueWatermarkPooledLowStatus {
    return {
      editions: pooledEditions,
      eligible: pooledEligible,
      matches: pooledMatches,
      confirmed: confirmAdapt(pooledMatches, pooledEligible),
    };
  }

  function resetPooledLow(): void {
    pooledEditions = 0;
    pooledEligible = 0;
    pooledMatches = 0;
  }

  function verifyGroupTotals(editionId: string, groups: ValueWatermarkGroup[]): ValueWatermarkGroupResult {
    const ed = requireEditionId(editionId, "editionId");
    if (!Array.isArray(groups)) fail("groups must be an array");
    let matchedGroups = 0;
    groups.forEach((group, gi) => {
      if (typeof group !== "object" || group === null) fail(`groups[${gi}] must be an object`);
      const publishedTotal = requireFiniteNumber(
        (group as unknown as Record<string, unknown>)["publishedTotal"],
        `groups[${gi}].publishedTotal`,
      );
      if (!Array.isArray(group.records) || group.records.length === 0) {
        fail(`groups[${gi}].records must be a non-empty array`);
      }
      let sumQp = 0;
      let sumA = 0;
      group.records.forEach((record, ri) => {
        const rec = validateSourceRecord(record, `groups[${gi}].records[${ri}]`);
        sumQp += rec.T;
        sumA += placementResidue(ed, rec);
      });
      if (publishedTotal - sumQp === sumA) matchedGroups++;
    });
    return {
      matchedGroups,
      totalGroups: groups.length,
      confirmed: matchedGroups >= GROUP_MIN_MATCHES,
      enforcement: "none",
    };
  }

  return {
    enforcement: "none",
    markEdition,
    verifyEdition,
    pooledLowStatus,
    resetPooledLow,
    verifyGroupTotals,
  };
}
