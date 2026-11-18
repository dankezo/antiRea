/**
 * Prometheus metrics surface (NHS-13, antiRea 3.1.0).
 *
 * WHAT IT IS. An opt-in observability exporter: the host feeds it the
 * computed verdict, the fired signal names and the shadow flag of each
 * request it has already decided, and reads back exact counters plus a
 * live tarpit gauge in Prometheus text exposition form. The module
 * makes no decision, holds no per-identity state and cannot influence
 * a response: it is a counting surface only, so it has no false
 * positive surface of its own.
 *
 * COUNTING LAW (frozen in the NHS Step-0 lab, nhs-lab/nhs13.cjs,
 * RESULTS-NHS-STEP0.md, reading R-NHS-5 - the source semantics, which
 * replaced the research bag's contradictory wording):
 * - recording runs in BOTH modes: `requests_total` and
 *   `verdict_total` always take the COMPUTED verdict, shadow or not;
 * - `signal_total` bumps once per request per fired signal input;
 * - `shadow_total` bumps ADDITIONALLY iff the request ran in shadow
 *   mode AND its computed verdict is tarpit or block (a shadow
 *   challenge does NOT bump it);
 * - `tarpit_active` is a gauge of live held connections, supplied by
 *   the host or tracked through tarpitOpened / tarpitClosed.
 *
 * LAB EVIDENCE (Step-0, synthetic and frozen; not field rates). On
 * the 10-request fixture the counters are exact: requests 10, verdict
 * allow 4 / challenge 2 / tarpit 2 / block 2, all 14 signal counters
 * exact (bot 2, coherence 1, errrate 2, scanner 1, velocity 1,
 * crowdsec 1, blocked 1, the rest 0), shadow_total 3 with the shadow
 * challenge row correctly excluded; the gauge tracks 2, 1, 0; a
 * zero-state emit succeeds with all 21 series at 0. The PASS
 * certifies counter correctness, not detection value.
 *
 * Unknown verdict or signal names are rejected with a TypeError
 * instead of being silently counted under a new series: a typo in
 * host wiring must be loud, not a phantom metric.
 */

export type PrometheusVerdict = "allow" | "challenge" | "tarpit" | "block";

export const PROMETHEUS_VERDICTS: readonly PrometheusVerdict[] = Object.freeze([
  "allow",
  "challenge",
  "tarpit",
  "block",
]);

export type PrometheusSignal =
  | "errrate"
  | "blocked"
  | "scanner"
  | "bot"
  | "header"
  | "honeypot"
  | "velocity"
  | "asn"
  | "coherence"
  | "crowdsec"
  | "ja3"
  | "ja4"
  | "ja4t"
  | "c2ip";

/** The 14 registered signal series, in the lab's frozen emit order. */
export const PROMETHEUS_SIGNALS: readonly PrometheusSignal[] = Object.freeze([
  "errrate",
  "blocked",
  "scanner",
  "bot",
  "header",
  "honeypot",
  "velocity",
  "asn",
  "coherence",
  "crowdsec",
  "ja3",
  "ja4",
  "ja4t",
  "c2ip",
]);

const VERDICT_SET = new Set<string>(PROMETHEUS_VERDICTS);
const SIGNAL_SET = new Set<string>(PROMETHEUS_SIGNALS);

export interface PrometheusRecordInput {
  /** The verdict the host computed for this request (counted in both modes). */
  verdict: PrometheusVerdict;
  /** Signal names that fired for this request; each bumps once. */
  signals?: readonly PrometheusSignal[];
  /** True when the request ran in shadow (observe-only) mode. */
  shadow?: boolean;
}

export interface PrometheusSnapshot {
  requests: number;
  verdict: Record<PrometheusVerdict, number>;
  signal: Record<PrometheusSignal, number>;
  shadow: number;
  tarpitActive: number;
}

export interface PrometheusMetrics {
  record(input: PrometheusRecordInput): void;
  /** Mark one tarpit connection held (gauge +1). */
  tarpitOpened(): void;
  /** Mark one tarpit connection released (gauge -1, floored at 0). */
  tarpitClosed(): void;
  /** Set the gauge directly from the host's own live count. */
  setTarpitActive(n: number): void;
  snapshot(): PrometheusSnapshot;
  /**
   * Render the Prometheus text exposition: exactly 21 series lines
   * (1 requests + 4 verdict + 14 signal + shadow + gauge), each
   * newline-terminated. `tarpitActive` overrides the tracked gauge
   * for this emit only.
   */
  emit(tarpitActive?: number): string;
}

/** Create an independent metrics counter set. Opt-in: nothing records unless the host calls record(). */
export function createPrometheusMetrics(): PrometheusMetrics {
  let requests = 0;
  let shadow = 0;
  let tarpitActive = 0;
  const verdict: Record<PrometheusVerdict, number> = { allow: 0, challenge: 0, tarpit: 0, block: 0 };
  const signal = {} as Record<PrometheusSignal, number>;
  for (const s of PROMETHEUS_SIGNALS) signal[s] = 0;

  function record(input: PrometheusRecordInput): void {
    if (typeof input !== "object" || input === null || !VERDICT_SET.has(input.verdict as string)) {
      throw new TypeError(`prometheus metrics: unknown verdict ${JSON.stringify(input?.verdict)}`);
    }
    const signals = input.signals ?? [];
    for (const s of signals) {
      if (!SIGNAL_SET.has(s as string)) {
        throw new TypeError(`prometheus metrics: unknown signal ${JSON.stringify(s)}`);
      }
    }
    requests++;
    verdict[input.verdict]++;
    for (const s of signals) signal[s]++;
    if (input.shadow === true && (input.verdict === "tarpit" || input.verdict === "block")) shadow++;
  }

  function snapshot(): PrometheusSnapshot {
    return {
      requests,
      verdict: { ...verdict },
      signal: { ...signal },
      shadow,
      tarpitActive,
    };
  }

  function emit(override?: number): string {
    const gauge = override !== undefined ? override : tarpitActive;
    if (!Number.isFinite(gauge) || gauge < 0) {
      throw new TypeError("prometheus metrics: tarpitActive must be a finite number >= 0");
    }
    const lines: string[] = [`sentinel_requests_total ${requests}`];
    for (const v of PROMETHEUS_VERDICTS) lines.push(`sentinel_verdict_total{v="${v}"} ${verdict[v]}`);
    for (const s of PROMETHEUS_SIGNALS) lines.push(`sentinel_signal_total{s="${s}"} ${signal[s]}`);
    lines.push(`sentinel_shadow_total ${shadow}`);
    lines.push(`sentinel_tarpit_active ${gauge}`);
    return lines.join("\n") + "\n";
  }

  return {
    record,
    tarpitOpened() {
      tarpitActive++;
    },
    tarpitClosed() {
      if (tarpitActive > 0) tarpitActive--;
    },
    setTarpitActive(n: number) {
      if (!Number.isFinite(n) || n < 0) throw new TypeError("prometheus metrics: tarpitActive must be a finite number >= 0");
      tarpitActive = Math.floor(n);
    },
    snapshot,
    emit,
  };
}
