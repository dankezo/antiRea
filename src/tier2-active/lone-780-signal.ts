/**
 * AC-12 - Lone-780 viewport component signal (PASS-LAB, component only).
 *
 * Lab record (ac-batch2-lab, RESULTS-AC-BATCH2.md, ac12-results.json;
 * pooled re-analysis of the frozen C48/C51/C52/C59 logs under the
 * C59 R780 rule: at least 3 page-open windows containing a resize to
 * exactly 780): the pooled tool sessions fire 5/5; simulated humans
 * fire 0/80, and 0/80 ever produce a resize to exactly 780 anywhere
 * in their sessions.
 *
 * BINDING RESTRICTIONS, encoded structurally:
 * - Lone-780 is NEVER a standalone gate. The result type carries no
 *   verdict and no blocked flag; it is a component input only.
 * - The forms the earlier cycles killed stay killed: the frozen
 *   exact-sequence form (C48) and the R12-prime pair form (C51) are
 *   not revived here. The surviving signature is the lone 780's
 *   presence per page-open window.
 * - The named false-positive class is real and unmeasured in the
 *   lab: developers and designers drag-resizing through exactly 780
 *   while testing responsive layouts. Hosts handle that class by
 *   declaration / exemption, never by treating this component as
 *   proof.
 *
 * Opt-in: nothing calls this by default.
 */

export interface Lone780Component {
  component: "lone-780-viewport";
  /** Page-open windows containing a resize to exactly 780. */
  windowsWith780: number;
  /** Total page-open windows observed. */
  windowsTotal: number;
  /** Component presence under the frozen R780 rule (at least 3 windows with 780). */
  present: boolean;
  /** Always false: this component can never stand alone as a gate. */
  standalone: false;
  /** Always "none": the component itself enforces nothing. */
  enforcement: "none";
}

/** The frozen R780 firing floor: at least 3 page-open windows containing a resize to exactly 780. */
export const LONE_780_MIN_WINDOWS = 3;
/** The exact viewport width the signature reads. */
export const LONE_780_WIDTH = 780;

/**
 * Evaluate one session's page-open windows. Each window is the list
 * of viewport widths resized to inside that window. A window counts
 * once when any resize lands on exactly 780.
 */
export function evaluateLone780(windows: readonly (readonly number[])[]): Lone780Component {
  const list = Array.isArray(windows) ? windows : [];
  let with780 = 0;
  for (const win of list) {
    if (Array.isArray(win) && win.some(w => w === LONE_780_WIDTH)) with780++;
  }
  return {
    component: "lone-780-viewport",
    windowsWith780: with780,
    windowsTotal: list.length,
    present: with780 >= LONE_780_MIN_WINDOWS,
    standalone: false,
    enforcement: "none",
  };
}

/** The only sanctioned consumption shape: a named component contribution for a host composite. */
export function lone780ComponentContribution(windows: readonly (readonly number[])[]): {
  name: "lone-780-viewport";
  present: boolean;
  windowsWith780: number;
} {
  const result = evaluateLone780(windows);
  return { name: result.component, present: result.present, windowsWith780: result.windowsWith780 };
}
