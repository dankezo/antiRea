/**
 * AC-09 - Headless-request component signal (PASS-LAB, component only).
 *
 * Lab record (ac-batch1-lab, RESULTS-AC-BATCH1-STEP0.md,
 * ac09-results.json): the round-1 proxy logs re-measured exactly:
 * baseline log 72/72 browser-class requests carry HeadlessChrome in
 * the user agent, protected log 102/102. Ordinary-browser false
 * positives 0/200. Declared automation flags 50/50 (descriptive).
 *
 * BINDING RESTRICTION, encoded structurally: this is a COMPONENT
 * signal only, never a standalone verdict. The result type has no
 * verdict, no blocked flag and no score that a host could gate on;
 * the only consumer shape exported is a composite input (a named
 * component contribution). The user agent is attacker-controlled
 * and evasion costs one header change (unmeasured in the lab, by
 * design of the candidate).
 *
 * Opt-in: nothing calls this by default.
 */

export interface HeadlessRequestComponent {
  /** Always the literal component name, for composite bookkeeping. */
  component: "headless-request";
  /** True when the user agent declares HeadlessChrome. */
  present: boolean;
  /** Always false: this component can never stand alone as a gate. */
  standalone: false;
  /** Always "none": the component itself enforces nothing. */
  enforcement: "none";
}

/**
 * Evaluate one request's user agent as a composite component.
 * Accepts a raw UA string or a request-like object with a
 * user-agent header (plain record or Headers-like get()).
 */
export function evaluateHeadlessRequest(input: string | { headers?: unknown; userAgent?: string }): HeadlessRequestComponent {
  let ua = "";
  if (typeof input === "string") {
    ua = input;
  } else if (input && typeof input === "object") {
    if (typeof input.userAgent === "string") ua = input.userAgent;
    else {
      const headers = (input as { headers?: unknown }).headers;
      if (headers && typeof (headers as { get?: unknown }).get === "function") {
        ua = (headers as { get(n: string): string | null }).get("user-agent") ?? "";
      } else if (headers && typeof headers === "object") {
        for (const key of Object.keys(headers as Record<string, unknown>)) {
          if (key.toLowerCase() === "user-agent") {
            const v = (headers as Record<string, unknown>)[key];
            ua = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
          }
        }
      }
    }
  }
  return {
    component: "headless-request",
    present: ua.includes("HeadlessChrome"),
    standalone: false,
    enforcement: "none",
  };
}

/**
 * The only sanctioned consumption shape: fold the component into a
 * host composite as a named boolean contribution. There is no
 * exported path from this module to a block / allow decision.
 */
export function headlessComponentContribution(input: string | { headers?: unknown; userAgent?: string }): {
  name: "headless-request";
  present: boolean;
} {
  const result = evaluateHeadlessRequest(input);
  return { name: result.component, present: result.present };
}
