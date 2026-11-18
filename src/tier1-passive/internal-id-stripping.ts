/**
 * AC-36 - Internal-ID stripping, ONE LEG ONLY (PASS-LAB-WITH-COST,
 * binding restriction).
 *
 * Lab record (ac-batch1-lab, RESULTS-AC-BATCH1-STEP0.md,
 * ac36-results.json, seed 20322310). Answerability (agent /
 * screen-reader):
 *   RICH         1.000 / 1.000
 *   STANDARD     0.833 / 1.000   (internal ids stripped)
 *   IMPOVERISHED 0.300 / 0.233   (labels merged + a third removed)
 * At STANDARD, the agent drop is 0.167 with screen-reader drop
 * exactly 0: internal-ID stripping separates because screen
 * readers never see internal ids. At IMPOVERISHED, selectivity is
 * NEGATIVE (-0.067): label impoverishment harms screen-reader
 * users MORE than agents (SR drop 0.767 vs agent drop 0.700).
 *
 * BINDING RESTRICTION, encoded structurally: the IMPOVERISHED
 * variant must NOT be built. This module's only form is
 * "internal-id-stripping": it removes internal identifiers from a
 * node description and touches nothing else - labels, text, roles
 * and accessible names are preserved byte for byte. There is no
 * option to merge, drop or rewrite labels, and requesting any
 * other form throws.
 *
 * Model honesty from the lab: the modelled agent drop is a
 * CEILING for the real tax (a real agent falls back to pixels)
 * and the modelled screen-reader drop is a FLOOR for the real
 * harm (a screen-reader user has no fallback).
 *
 * Opt-in, surface layer: the host applies this to the surface it
 * serves to untrusted automation-shaped consumers; the accessible
 * surface keeps its labels exactly as authored.
 */

export const AC36_SUPPORTED_FORM = "internal-id-stripping" as const;

/** Lab-measured answerability drops at the STANDARD (stripping) level. */
export const AC36_MEASURED_DROPS = {
  agentDrop: 0.167,
  screenReaderDrop: 0,
  impoverishedSelectivity: -0.067,
} as const;

/** Attribute names treated as internal identifiers. */
const INTERNAL_ATTRIBUTE_NAMES = new Set([
  "data-internal-id",
  "data-record-id",
  "data-testid-internal",
  "internal-id",
  "internalid",
]);

/** An id is internal when it carries the host's internal marker prefix. */
function isInternalIdValue(value: string): boolean {
  return value.startsWith("internal-") || value.startsWith("int_") || value.startsWith("__");
}

export interface SurfaceNode {
  tag: string;
  /** Attributes as authored. Internal identifiers are removed; everything else is preserved. */
  attributes: Record<string, string>;
  /** Visible / accessible text. Never modified by stripping. */
  text?: string;
}

export interface StripInternalIdsResult {
  nodes: SurfaceNode[];
  /** How many internal identifiers were removed. */
  removed: number;
  /** The only form this module implements. */
  form: typeof AC36_SUPPORTED_FORM;
}

/**
 * Strip internal identifiers from node descriptions. Removes the
 * `id` attribute when its value is an internal id, and any
 * attribute named as internal, and preserves every other
 * attribute, label and text exactly. Inputs are never mutated.
 * Any form other than "internal-id-stripping" throws: the
 * impoverished variant is not an option here, by design.
 */
export function stripInternalIds(
  nodes: readonly SurfaceNode[],
  form: string = AC36_SUPPORTED_FORM,
): StripInternalIdsResult {
  if (form !== AC36_SUPPORTED_FORM) {
    throw new TypeError(
      `stripInternalIds: unsupported form "${form}" - the only supported form is "internal-id-stripping"; ` +
        "label impoverishment is measured non-selective (selectivity -0.067) and must not be built",
    );
  }
  let removed = 0;
  const out = nodes.map(node => {
    const attributes: Record<string, string> = {};
    for (const [name, value] of Object.entries(node.attributes ?? {})) {
      const lower = name.toLowerCase();
      if (INTERNAL_ATTRIBUTE_NAMES.has(lower) || (lower === "id" && isInternalIdValue(value))) {
        removed++;
        continue;
      }
      attributes[name] = value;
    }
    return { ...node, attributes };
  });
  return { nodes: out, removed, form: AC36_SUPPORTED_FORM };
}
