/**
 * Decoy-first ordering (antiRea 3.3.3, X33-02 NARROWED) - an
 * agent-loop budget shield ONLY. OPT-IN, default OFF.
 *
 * LICENSED CLAIM, verbatim (SCOPE-NOTE-X33-02-AGENT-BUDGET-
 * SHIELD.md section 2, carried into the 3.3.3 freeze section
 * 1.2): "Decoy-first ordering is a budget shield against
 * agent-loop-class consumers whose retained evidence is bounded
 * well below the site's full surface: at a ~20:1
 * content-to-budget ratio it drove a budget-bound reader's
 * real-API-map accuracy from 100% to 0% (n = 3 personas, one
 * free model)." (The freeze writes the ratio with the
 * almost-equal sign; an ASCII tilde stands in for it here. Measured
 * detail: AGENT-MAP-ACC 100% OFF to 0% ON, 3/3 personas, on a
 * 4,000-char truncated capture of a 79,094-char full capture;
 * the untruncated HTTP-only control read 100% in both arms -
 * the effect is the budget binding, not content removal. In v1,
 * where the capture was smaller than the budget, the budget
 * never bound and there was no effect.)
 *
 * THE DISPROOF, which must always travel with the claim:
 * against REA-default this mechanism is structurally inert.
 * REA retains raw evidence wholesale - it does not read through
 * a summary budget on this channel - and in the v2 trial
 * RETAINED-REAL was 100% in the ON arm (3/3; 35 events
 * retained, 0 dropped). Ordering cannot truncate a raw
 * evidence store. X33-02's candidate verdict is KILL (v2) and
 * stays KILL; this module is the residual mechanism the same
 * measurements proved real, scoped to the budget-bound reader.
 * It must never be described as an anti-REA-default mechanism,
 * and it contributes nothing to any anti-REA benchmark tally.
 *
 * WHAT IT DOES. Presentation-order control only: for a flagged
 * consumer, decoy blocks (or decoy spec sections) are moved to
 * the head of the surface, so a reader whose retained evidence
 * is bounded keeps the decoy material and loses the real
 * material beyond its budget. No byte of content changes; only
 * order changes, and only for flagged identities.
 *
 * CONTRACT.
 * - Not flagged, or not enabled: the helpers return the SAME
 *   array / object reference they were given, so downstream
 *   output is byte-identical to 3.3.2 by construction.
 * - Flagged and enabled: a NEW array / object is returned with
 *   decoy entries first (stable within each role; spec keys in
 *   the given decoyKeys order, then the remaining keys in
 *   their original order). The input is never mutated.
 */

export interface OrderableBlock {
  name: string;
  role: "real" | "decoy";
  content: string;
}

export interface DecoyFirstOrderOptions {
  /** Ordering applies only when this is exactly `true`. Default false (OFF). */
  enabled?: boolean;
  /** Whether the requesting identity is flagged. */
  flagged: boolean;
}

/**
 * Order content blocks decoy-first for a flagged consumer.
 * Returns the same array reference unless flagged and enabled.
 */
export function orderBlocks<T extends OrderableBlock>(blocks: T[], opts: DecoyFirstOrderOptions): T[] {
  if (opts.enabled !== true || !opts.flagged) return blocks;
  const decoys: T[] = [];
  const reals: T[] = [];
  for (const block of blocks) {
    if (block.role === "decoy") decoys.push(block);
    else reals.push(block);
  }
  return [...decoys, ...reals];
}

/**
 * Order a spec object's keys decoy-first for a flagged
 * consumer: the declared decoy keys first (in decoyKeys
 * order), then the remaining keys in their original order.
 * Returns the same object reference unless flagged and enabled.
 */
export function orderSpecSections(
  spec: Record<string, unknown>,
  decoyKeys: string[],
  opts: DecoyFirstOrderOptions,
): Record<string, unknown> {
  if (opts.enabled !== true || !opts.flagged) return spec;
  const out: Record<string, unknown> = {};
  // defineProperty, not assignment: a "__proto__" key in the spec
  // must land as an own property, not replace out's prototype and
  // silently drop the entry.
  const setOwn = (key: string, value: unknown): void => {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  };
  const decoySet = new Set(decoyKeys);
  for (const key of decoyKeys) {
    if (Object.prototype.hasOwnProperty.call(spec, key)) setOwn(key, spec[key]);
  }
  for (const key of Object.keys(spec)) {
    if (!decoySet.has(key)) setOwn(key, spec[key]);
  }
  return out;
}
