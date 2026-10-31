/** Opt-in, client-side anomaly *hints*; do not auto-ban, slow down, or fabricate responses. */
export interface BehaviorShieldOptions {
  maxRoutesPerMinute?: number;
  maxRapidClicksPerMinute?: number;
  onAnomaly: (score: number, reason: string) => void;
  enabled?: boolean;
}
export class BehaviorShield {
  private routeEvents: number[] = [];
  private clickEvents: number[] = [];
  private currentPath = "";
  private timer?: number;
  private active = false;
  private announced = new Set<string>();
  constructor(private options: BehaviorShieldOptions) {}
  private click = () => this.clickEvents.push(Date.now());
  private tick = () => {
    const now = Date.now(), cutoff = now - 60000;
    const path = window.location.pathname; // ignore query strings (often sensitive)
    if (path !== this.currentPath) { this.currentPath = path; this.routeEvents.push(now); }
    this.routeEvents = this.routeEvents.filter(t => t >= cutoff);
    this.clickEvents = this.clickEvents.filter(t => t >= cutoff);
    if (this.routeEvents.length >= (this.options.maxRoutesPerMinute ?? 15)) {
      if (!this.announced.has("routes")) { this.announced.add("routes"); this.options.onAnomaly(40, "rapid_route_changes"); }
    } else this.announced.delete("routes");
    if (this.clickEvents.length >= (this.options.maxRapidClicksPerMinute ?? 60)) {
      if (!this.announced.has("clicks")) { this.announced.add("clicks"); this.options.onAnomaly(25, "rapid_clicks"); }
    } else this.announced.delete("clicks");
  };
  public start(): void {
    if (typeof window === "undefined" || this.active || this.options.enabled !== true) return;
    this.active = true;
    this.currentPath = window.location.pathname;
    window.addEventListener("click", this.click, { passive: true });
    this.timer = window.setInterval(this.tick, 1500);
  }
  public stop(): void {
    if (typeof window === "undefined" || !this.active) return;
    this.active = false;
    window.removeEventListener("click", this.click);
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    this.clickEvents = []; this.routeEvents = []; this.announced.clear();
  }
}
