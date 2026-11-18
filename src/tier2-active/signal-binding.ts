/**
 * Signal binding audit (ABS-05): gating signals must be
 * server-measured or cryptographically bound.
 *
 * The neighbour failure, measured in abs-lab (RESULTS-ABS-STEP0):
 * a verify carrying FABRICATED clean signals passed with risk 0
 * and a cookie set. The only consistency check (fp_hash equals
 * sha256(fp_raw)) was vacuous - both values are computed by the
 * attacker, so the check compares the attacker's arithmetic with
 * itself.
 *
 * The rule this module encodes: an input may GATE (block, ban,
 * step up, deny) only when the server can stand behind its value:
 *
 * - `server-measured`: the server observed it in its own serving
 *   path (route class, response status, records served, timing on
 *   a server clock). The flow scorer's inputs are of this kind
 *   when the host feeds them from its own path, which is that
 *   module's documented contract.
 * - `cryptographically-bound`: a client-supplied value carried
 *   inside a container the server verified (a step-up proof
 *   payload, a Web Bot Auth signature, a signed cursor). The
 *   binding, not the value, is what counts.
 * - `client-supplied` and unbound: telemetry only. It may inform
 *   an investigation; it must never be the sole or deciding input
 *   to a gate.
 *
 * GAP, stated plainly: the cdp-guard browser signals
 * (navigator.webdriver and friends) are client-supplied and cannot
 * be bound from inside a browser - any page script can lie about
 * them, and no in-page mechanism can prove otherwise. That gap is
 * structural, not a TODO: `CDP_GUARD_BINDING_GAP` names it, and the
 * shipped module already confines those signals to low-confidence
 * telemetry. This audit keeps them out of gating configurations
 * instead of pretending a binding exists.
 *
 * Pure computation; zero runtime dependencies.
 */

/** Where a signal input's value comes from. */
export type SignalInputProvenance = "server-measured" | "cryptographically-bound" | "client-supplied";

export interface SignalInputDescriptor {
  /** Host-chosen input name, reported back in audit results. */
  name: string;
  provenance: SignalInputProvenance;
  /**
   * For `client-supplied` inputs only: true when the value arrives
   * inside a cryptographically verified container (see the header).
   * Ignored for the other provenances.
   */
  bound?: boolean;
}

export interface SignalBindingAudit {
  /** True when every input may gate: no unbound client-supplied input is present. */
  gatingReady: boolean;
  /** Names of client-supplied inputs that are not cryptographically bound. */
  unbound: string[];
}

/** Named error thrown for malformed descriptors or a failed gating assertion. */
export class SignalBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalBindingError";
  }
}

/**
 * The cdp-guard binding gap (ABS-05): browser-side automation
 * signals are client-supplied telemetry and can never be bound
 * from inside the browser, so they must never gate on their own.
 */
export const CDP_GUARD_BINDING_GAP =
  "cdp-guard inputs (navigator.webdriver and similar in-page signals) are client-supplied and " +
  "cannot be cryptographically bound from inside a browser; they are low-confidence telemetry " +
  "only and must never be the deciding input to a gate (ABS-05).";

const PROVENANCES = new Set<string>(["server-measured", "cryptographically-bound", "client-supplied"]);

function validateDescriptor(raw: unknown, index: number): SignalInputDescriptor {
  if (typeof raw !== "object" || raw === null) {
    throw new SignalBindingError(`auditSignalInputs: descriptor ${index} must be an object`);
  }
  const d = raw as SignalInputDescriptor;
  if (typeof d.name !== "string" || d.name.length === 0) {
    throw new SignalBindingError(`auditSignalInputs: descriptor ${index} needs a non-empty name`);
  }
  if (!PROVENANCES.has(d.provenance as string)) {
    throw new SignalBindingError(
      `auditSignalInputs: descriptor "${d.name}" has unknown provenance ${JSON.stringify(d.provenance)}`,
    );
  }
  return d;
}

/**
 * Classify a set of signal inputs for gating use (ABS-05). An
 * input is gating-ready when it is server-measured,
 * cryptographically-bound by provenance, or client-supplied with
 * `bound: true`. Everything else lands in `unbound`.
 */
export function auditSignalInputs(inputs: readonly SignalInputDescriptor[]): SignalBindingAudit {
  if (!Array.isArray(inputs)) {
    throw new SignalBindingError("auditSignalInputs: inputs must be an array of descriptors");
  }
  const unbound: string[] = [];
  inputs.forEach((raw, index) => {
    const d = validateDescriptor(raw, index);
    if (d.provenance === "client-supplied" && d.bound !== true) unbound.push(d.name);
  });
  return { gatingReady: unbound.length === 0, unbound };
}

/**
 * Assert a gating configuration rests only on bound inputs
 * (ABS-05): throws `SignalBindingError` naming every unbound
 * client-supplied input. Hosts call this at wiring time, so a
 * fabricated-clean-signals gate fails at startup, not in traffic.
 */
export function assertGatingInputsBound(inputs: readonly SignalInputDescriptor[]): void {
  const audit = auditSignalInputs(inputs);
  if (!audit.gatingReady) {
    throw new SignalBindingError(
      `gating inputs must be server-measured or cryptographically bound (ABS-05); unbound client-supplied: ${audit.unbound.join(", ")}`,
    );
  }
}
