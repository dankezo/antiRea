/**
 * Decoy hygiene audit (ABP-02 TRAP-PATHS-MUST-NOT-BE-PUBLIC-IN-PAGE-SOURCE).
 *
 * The neighbour failure, measured in the ABP Step-0 lab: all 3 of its
 * default trap paths appeared VERBATIM in the script it served to
 * every visitor, so the trap list could be read off the page and
 * avoided; and the trap container's hiding markers were CONSTANT
 * (1px size, clip-path inset(50%), z-index -9999, aria-hidden,
 * nofollow, tabindex), so the container itself was fingerprintable
 * with a single selector. A trap a client can enumerate or
 * fingerprint from the page source is a trap that only fires on
 * clients that never look.
 *
 * antiRea form: hygiene RULES over host page source, as a pure audit
 * the host (or a test) runs over the HTML it is about to serve.
 *
 * - R1 `trap_path_in_script`: no registered trap path may appear
 *   verbatim inside a <script> block. A script is code shipped to
 *   every visitor; a trap list there is public by construction.
 * - R2 `trap_paths_enumerated`: at most ONE distinct trap path may
 *   appear in the page source at all. The one sanctioned appearance
 *   is a single bait anchor (see `canaryTrapLink`): one href, one
 *   path. Two or more distinct trap paths in one page means the page
 *   enumerates the trap surface.
 * - R3 `constant_hiding_markers`: the hiding markers of one trap
 *   container must not combine 2 or more of the constant marker
 *   spellings the lab fingerprinted (1px sizing, clip-path inset,
 *   z-index -9999, display:none). Any single technique is ordinary
 *   CSS; the constant COMBINATION is the fingerprint. (antiRea's own
 *   `canaryTrapLink` uses display:none alone, plus aria-hidden and
 *   tabindex as accessibility semantics, and passes this audit.)
 *
 * The audit is advisory: it reports violations, it rewrites nothing,
 * and a page with no trap at all passes trivially.
 */

export type TrapHygieneRule = "trap_path_in_script" | "trap_paths_enumerated" | "constant_hiding_markers";

export interface TrapHygieneViolation {
  rule: TrapHygieneRule;
  detail: string;
}

export interface TrapHygieneResult {
  ok: boolean;
  violations: TrapHygieneViolation[];
}

/**
 * The constant hiding-marker spellings measured in the lab fixture,
 * normalized (lowercase, whitespace removed) for matching.
 */
export const CONSTANT_HIDING_MARKERS = [
  "width:1px",
  "height:1px",
  "clip-path:inset(50%)",
  "z-index:-9999",
  "display:none",
] as const;

const normalizeStyleText = (text: string): string => text.toLowerCase().replace(/\s+/g, "");

const scriptBlocks = (html: string): string[] => {
  const blocks: string[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) blocks.push(m[1] ?? "");
  return blocks;
};

/** Audit one HTML page (or fragment) against the ABP-02 hygiene rules. */
export function auditTrapHygiene(html: string, trapPaths: readonly string[]): TrapHygieneResult {
  const violations: TrapHygieneViolation[] = [];
  const source = typeof html === "string" ? html : "";
  const paths = [...new Set((trapPaths ?? []).filter(p => typeof p === "string" && p.length > 0))];

  // R1: no trap path verbatim inside a script block.
  const scripts = scriptBlocks(source);
  for (const path of paths) {
    if (scripts.some(block => block.includes(path))) {
      violations.push({
        rule: "trap_path_in_script",
        detail: `trap path ${path} appears verbatim inside a <script> block`,
      });
    }
  }

  // R2: at most one distinct trap path in the page source overall.
  const present = paths.filter(path => source.includes(path));
  if (present.length > 1) {
    violations.push({
      rule: "trap_paths_enumerated",
      detail: `${present.length} distinct trap paths appear in the page source (${present.join(", ")}); at most one bait anchor is sanctioned`,
    });
  }

  // R3: no combination of 2+ constant hiding markers.
  const normalized = normalizeStyleText(source);
  const markersFound = CONSTANT_HIDING_MARKERS.filter(marker => normalized.includes(marker));
  if (markersFound.length >= 2) {
    violations.push({
      rule: "constant_hiding_markers",
      detail: `constant hiding-marker combination is fingerprintable: ${markersFound.join(" + ")}`,
    });
  }

  return { ok: violations.length === 0, violations };
}
