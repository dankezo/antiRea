/** Low-confidence diagnostic signals only. This cannot block CDP / REA. */
export interface AutomationSignalOptions {
  onDetected: (reason: string) => void;
  enabled?: boolean;
  intervalMs?: number;
  enableInDev?: boolean; // compatibility alias for enabled
}

export type CdpGuardOptions = AutomationSignalOptions;

/**
 * Inspects basic surface automation flags such as `navigator.webdriver`.
 * Low-confidence diagnostic telemetry only; this does NOT block CDP or REA.
 */
export function detectAutomationSignals(options: AutomationSignalOptions): () => void {
  if (typeof window === "undefined" || !(options.enabled ?? options.enableInDev ?? false)) return () => {};
  const seen = new Set<string>();
  const signal = (s: string) => {
    if (!seen.has(s)) {
      seen.add(s);
      options.onDetected(s);
    }
  };
  const check = () => {
    if (window.navigator.webdriver) signal("navigator.webdriver=true (weak heuristic)");
    // No debugger loop, Error.stack getter trap, global overrides, or WebMCP tampering.
  };
  check();
  const interval = Math.max(5000, options.intervalMs ?? 30000);
  const timer = window.setInterval(check, interval);
  return () => window.clearInterval(timer);
}

/**
 * @deprecated Use detectAutomationSignals() instead. This helper only inspects basic automation flags like navigator.webdriver and does not block CDP.
 */
export const initCdpGuard = detectAutomationSignals;
