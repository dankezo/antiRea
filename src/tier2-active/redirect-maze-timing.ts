/**
 * Redirect-maze timing, MEASUREMENT FORM (ABG-04, upgraded in the
 * 3.1.0 build; Step-0 PASS-LAB at Step 0, seed 20321204) - port of
 * tarrinho/AntiBotGW detection/redirect_maze.py: a 3-hop signed chain
 * (token `{step}.{ts_ms}.{hmac16}`, HMAC over
 * identity|step|ts_ms|dest-hash, depth 3, TTL 30 s), with the lab
 * harness's entry gate (maze entry iff risk >= 80; the source's own
 * `should_maze` has no production call site - dead wiring, profile
 * G1, recorded in R-ABG-3 and not re-tested).
 *
 * WHY THIS SHIPS AS MEASUREMENT ONLY, WITH NO FROZEN VERDICT. The
 * lab's flag line was a total chain time under 800 ms. The lab's own
 * descriptive operating-point arm shows why that line cannot be
 * frozen: 50 seeded replicas with plausible inter-hop gaps
 * U(200,500) ms flag at 0.78 (39/50) - the 800 ms line sits INSIDE
 * the plausible gap distribution, so it is a tuning choice, not a
 * natural split between humans and bots. The dissection requires a
 * real-browser hop-timing distribution before any threshold is
 * frozen, and no such distribution exists yet.
 *
 * Accordingly this module:
 * - measures and reports the total hop time of a completed chain
 *   (`totalMs`), the per-hop timestamps and whether the chain
 *   completed, and nothing more by default;
 * - has NO default threshold: `verdict` is "measurement_only" and
 *   `wouldFlag` is null unless the HOST explicitly configures
 *   `thresholdMs`, in which case `wouldFlag` reports the comparison
 *   against the HOST's number and the result is labelled
 *   "host_configured" - the module never presents a host number as
 *   a lab-frozen gate;
 * - exports the lab's 800 ms only as ABG04_LAB_REFERENCE_MS, a
 *   descriptive reference carrying the 0.78 operating point, never
 *   as a default.
 *
 * Token discipline from the lab: hop timestamps are INTEGER ms
 * (the source's int(time*1000)); a fractional timestamp would put a
 * "." inside the token and break its 3-part format - the lab's
 * first run failed exactly there, and this module rounds at issue
 * time. A wrong-step or bad-HMAC token is a restart (the source's
 * 404) and is never scored: `recordHop` reports scored: false.
 * A chain that stops early is never evaluated.
 *
 * ADVISORY / measurement only, opt-in. Every result carries
 * enforcement: "none". Nothing runs until the host issues tokens
 * and feeds hops back.
 */

/** Chain depth (source constant). */
export const REDIRECT_MAZE_DEPTH = 3;
/** Entry risk gate applied by the lab harness (source REDIRECT_MAZE_THRESHOLD). */
export const REDIRECT_MAZE_ENTRY_RISK = 80;
/** Token TTL in ms (source constant, 30 s). */
export const REDIRECT_MAZE_TOKEN_TTL_MS = 30_000;
/**
 * The lab's 800 ms line, exported as a DESCRIPTIVE REFERENCE ONLY.
 * It is not a default threshold and this module never verdicts on
 * it: at this line, 39 of 50 seeded replicas with plausible gaps
 * U(200,500) ms flag (0.78), so the line sits inside the plausible
 * distribution. See the module header.
 */
export const ABG04_LAB_REFERENCE_MS = 800;

interface NodeHashLike {
  update(data: string, encoding?: string): NodeHashLike;
  digest(encoding: string): string;
}
interface NodeHmacLike {
  update(data: string | Uint8Array): NodeHmacLike;
  digest(encoding: string): string;
}
interface NodeCryptoLike {
  createHash(algorithm: string): NodeHashLike;
  createHmac(algorithm: string, key: string | Uint8Array): NodeHmacLike;
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare const require: ((id: string) => NodeCryptoLike) | undefined;

function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.createHmac === "function" && typeof nodeCrypto.createHash === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; redirect-maze timing requires Node.js");
}

const MEASUREMENT_NOTICE =
  "Measurement only (enforcement: none): this module reports a completed 3-hop chain's total " +
  "time. It ships NO frozen threshold verdict: the lab's 800 ms line flags 0.78 of seeded " +
  "replicas with plausible gaps, so it is a tuning choice, not a natural split, and a " +
  "real-browser hop-timing distribution is required before any threshold is frozen. " +
  "wouldFlag is null unless the host configures its own thresholdMs.";

/** Lab-harness entry gate: a maze is offered iff risk >= 80 and the request carries no maze token yet. */
export function shouldEnterRedirectMaze(riskScore: number, hasMazeToken: boolean): boolean {
  return riskScore >= REDIRECT_MAZE_ENTRY_RISK && !hasMazeToken;
}

export interface RedirectMazeTimerOptions {
  /** Destination the chain ultimately serves; bound into every token's HMAC. Defaults to "/dashboard". */
  destination?: string;
  /**
   * HOST-CONFIGURED comparison line in ms. Deliberately has NO
   * default: when unset, measurements carry wouldFlag: null and
   * verdict: "measurement_only". When set, the number is the host's
   * own tuning choice, labelled as such on every result.
   */
  thresholdMs?: number;
  /** Token TTL in ms. Defaults to 30,000 (source constant). */
  tokenTtlMs?: number;
  /** Maximum identities with an in-flight chain. Defaults to 10,000. */
  maxIdentities?: number;
}

export interface RedirectMazeHopResult {
  kind: "redirect_maze_timing";
  identity: string;
  /** True when the presented token verified for this identity. */
  tokenValid: boolean;
  /** The hop step recorded (0..2), or null when the token did not verify. */
  step: number | null;
  /** True when this hop completed the 3-hop chain and a total was measured. */
  complete: boolean;
  /** False for bad tokens and incomplete chains: unscored input is never a measurement. */
  scored: boolean;
  /** Total chain time in ms (max hop ts - min hop ts) once complete; null before that. */
  totalMs: number | null;
  /** Hop timestamps recorded so far for this chain (integer ms). */
  hopTimestampsMs: number[];
  /**
   * "measurement_only" when the host configured no threshold;
   * "host_configured" when `wouldFlag` compares against the host's
   * own thresholdMs. Never a lab-frozen verdict.
   */
  verdict: "measurement_only" | "host_configured";
  /** totalMs < host thresholdMs when a host threshold exists; otherwise null. */
  wouldFlag: boolean | null;
  /** The host-configured threshold applied, or null. The lab's 800 ms is never substituted here. */
  thresholdMs: number | null;
  /** "restart" for an invalid token (the source's 404 restart); null otherwise. */
  response: "restart" | null;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface RedirectMazeTimer {
  /** Issue the signed token for `step` of `identity`'s chain at `nowMs` (rounded to integer ms). */
  issueToken(identity: string, step: number, nowMs?: number): string;
  /** Verify and record one presented hop token; measures the total when the chain completes. */
  recordHop(identity: string, token: string, nowMs?: number): RedirectMazeHopResult;
  /** Drop any in-flight chain state for `identity`. */
  resetChain(identity: string): void;
}

export function createRedirectMazeTimer(
  secret: string | Uint8Array,
  options: RedirectMazeTimerOptions = {},
): RedirectMazeTimer {
  if ((typeof secret !== "string" && !(secret instanceof Uint8Array)) || (typeof secret === "string" && secret.length === 0)) {
    throw new Error("createRedirectMazeTimer: a non-empty secret is required");
  }
  const destination = options.destination ?? "/dashboard";
  const thresholdMs = options.thresholdMs;
  if (thresholdMs !== undefined && (!Number.isFinite(thresholdMs) || thresholdMs <= 0)) {
    throw new Error("createRedirectMazeTimer: thresholdMs, when configured, must be a positive finite number");
  }
  const tokenTtlMs = options.tokenTtlMs ?? REDIRECT_MAZE_TOKEN_TTL_MS;
  const maxIdentities = options.maxIdentities ?? 10_000;

  const destHash = getNodeCrypto().createHash("sha256").update(destination, "utf8").digest("hex").slice(0, 16);

  function tokenFor(identity: string, step: number, tsMs: number): string {
    const h = getNodeCrypto()
      .createHmac("sha256", secret)
      .update(`${identity}|${step}|${tsMs}|${destHash}`)
      .digest("hex")
      .slice(0, 16);
    return `${step}.${tsMs}.${h}`;
  }

  function verify(identity: string, token: string): { ok: boolean; step: number; tsMs: number } {
    const parts = typeof token === "string" ? token.split(".") : [];
    if (parts.length !== 3) return { ok: false, step: -1, tsMs: 0 };
    const step = Number.parseInt(parts[0] as string, 10);
    const tsMs = Number.parseInt(parts[1] as string, 10);
    if (!Number.isInteger(step) || !Number.isInteger(tsMs) || String(step) !== parts[0] || String(tsMs) !== parts[1]) {
      return { ok: false, step: -1, tsMs: 0 };
    }
    const expected = tokenFor(identity, step, tsMs);
    if (expected.length !== token.length) return { ok: false, step, tsMs };
    const a = new TextEncoder().encode(expected);
    const b = new TextEncoder().encode(token);
    return { ok: getNodeCrypto().timingSafeEqual(a, b), step, tsMs };
  }

  const chains = new Map<string, Map<number, number>>();

  function chainFor(identity: string): Map<number, number> {
    const existing = chains.get(identity);
    if (existing) {
      chains.delete(identity);
      chains.set(identity, existing);
      return existing;
    }
    if (chains.size >= maxIdentities) {
      const oldest = chains.keys().next().value as string | undefined;
      if (oldest !== undefined) chains.delete(oldest);
    }
    const fresh = new Map<number, number>();
    chains.set(identity, fresh);
    return fresh;
  }

  return {
    issueToken(identity, step, nowMs = Date.now()) {
      if (typeof identity !== "string" || identity.length === 0) throw new Error("issueToken: identity must be a non-empty string");
      if (!Number.isInteger(step) || step < 0 || step >= REDIRECT_MAZE_DEPTH) {
        throw new Error(`issueToken: step must be an integer in [0, ${REDIRECT_MAZE_DEPTH})`);
      }
      // Integer ms at issue time: a fractional ts would put a "."
      // inside the token and break its 3-part format (lab record).
      return tokenFor(identity, step, Math.round(nowMs));
    },
    recordHop(identity, token, nowMs = Date.now()) {
      const base = {
        kind: "redirect_maze_timing" as const,
        identity,
        verdict: (thresholdMs === undefined ? "measurement_only" : "host_configured") as "measurement_only" | "host_configured",
        thresholdMs: thresholdMs ?? null,
        enforcement: "none" as const,
        notice: MEASUREMENT_NOTICE,
      };
      const v = verify(identity, token);
      if (!v.ok || v.step < 0 || v.step >= REDIRECT_MAZE_DEPTH || nowMs - v.tsMs > tokenTtlMs) {
        return {
          ...base,
          tokenValid: false,
          step: null,
          complete: false,
          scored: false,
          totalMs: null,
          hopTimestampsMs: [],
          wouldFlag: null,
          response: "restart" as const,
        };
      }
      const chain = chainFor(identity);
      chain.set(v.step, v.tsMs);
      const stamps = [...chain.values()].sort((a, b) => a - b);
      const complete = chain.size >= REDIRECT_MAZE_DEPTH;
      const totalMs = complete ? (stamps[stamps.length - 1] as number) - (stamps[0] as number) : null;
      if (complete) chains.delete(identity);
      return {
        ...base,
        tokenValid: true,
        step: v.step,
        complete,
        scored: complete,
        totalMs,
        hopTimestampsMs: stamps,
        wouldFlag: complete && thresholdMs !== undefined && totalMs !== null ? totalMs < thresholdMs : null,
        response: null,
      };
    },
    resetChain(identity) {
      chains.delete(identity);
    },
  };
}
