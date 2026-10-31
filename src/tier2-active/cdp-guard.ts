/** Low-confidence diagnostic signals only. This cannot block CDP / REA. */
export interface CdpGuardOptions {
  onDetected: (reason: string) => void;
  enabled?: boolean;
  intervalMs?: number;
  enableInDev?: boolean; // compatibility alias for enabled
}
export function initCdpGuard(options: CdpGuardOptions): () => void {
  if (typeof window === "undefined" || !(options.enabled ?? options.enableInDev ?? false)) return () => {};
  const seen = new Set<string>();
  const signal = (s: string) => { if (!seen.has(s)) { seen.add(s); options.onDetected(s); } };
  const check = () => {
    if (window.navigator.webdriver) signal("navigator.webdriver=true (weak heuristic)");
    // No debugger loop, Error.stack getter trap, global overrides, or WebMCP tampering.
  };
  check();
  const interval = Math.max(5000, options.intervalMs ?? 30000);
  const timer = window.setInterval(check, interval);
  return () => window.clearInterval(timer);
}
