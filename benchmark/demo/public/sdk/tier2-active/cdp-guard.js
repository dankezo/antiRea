export function detectAutomationSignals(options) {
    if (typeof window === "undefined" || !(options.enabled ?? options.enableInDev ?? false))
        return () => { };
    const seen = new Set();
    const signal = (s) => {
        if (!seen.has(s)) {
            seen.add(s);
            options.onDetected(s);
        }
    };
    const check = () => {
        if (window.navigator.webdriver)
            signal("navigator.webdriver=true (weak heuristic)");
    };
    check();
    const interval = Math.max(5000, options.intervalMs ?? 30000);
    const timer = window.setInterval(check, interval);
    return () => window.clearInterval(timer);
}
export const initCdpGuard = detectAutomationSignals;
