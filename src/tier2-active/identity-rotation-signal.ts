/**
 * Identity-rotation signal (ABE-03, PASS-LAB Step 0, abe-lab
 * REGISTRATION-ABE-STEP0.md and RESULTS-ABE-STEP0.md, cycle C572).
 *
 * WHAT IT MEASURES. Some clients declare their own identity per
 * request (an X-Real-IP value, an X-API-Key value) and a host that
 * keys limits on that declared value alone can be diluted simply
 * by rotating it. This signal does NOT trust the declared value:
 * it groups requests by a SECONDARY fingerprint the host supplies
 * (for example a JA4 string, a user-agent string, a behaviour
 * fingerprint, or any stable host-side grouping key - the lab
 * grouped by ja4|ua|subnet/24) and counts, inside a short trailing
 * window, how many DISTINCT declared identities appear under one
 * fingerprint. Rotation is the shape: one fingerprint, many
 * declared identities, in a short window.
 *
 * FROZEN LAB LAW (from the registration, unchanged):
 * - window 60 s, flag iff distinct declared IPs >= 3 OR distinct
 *   declared API keys >= 3 for one fingerprint group inside the
 *   window. The two axes are counted separately and never merged.
 * - a single change (2 distinct values) never flags.
 *
 * WHAT THE LAB MEASURED (seeded simulation, abe03.cjs, seed
 * 20321103, 200 sessions per stratum, 20 requests per session at
 * 3 s spacing; internal validity only - NOT real-traffic rates):
 * - ROT-IP (7 IPs rotating every 3rd request, one fingerprint):
 *   flagged 200/200.
 * - ROT-KEY (7 keys rotating every 3rd request, one fingerprint):
 *   flagged 200/200.
 * - LEGIT-MOBILE (one IP change mid-session, a real network move):
 *   flagged 0/200.
 * - LEGIT-CGNAT (one IP, 20 distinct fingerprints - many devices
 *   behind one NAT): flagged 0/200. Grouping is by fingerprint,
 *   never by IP, so a shared IP alone creates no group.
 * - LEGIT-KEYROT (one scheduled key change): flagged 0/200.
 * - SINGLE-CHANGE (one IP change, same subnet): flagged 0/200.
 *
 * HARD LIMITS.
 * - ADVISORY ONLY: enforcement: "none" on every output. A flag
 *   says one fingerprint presented many declared identities
 *   quickly; it is an investigation and step-up input, never a
 *   sole basis for a ban or a hard ceiling.
 * - The fingerprint is a GIVEN (registration R-ABE-5): this module
 *   does not compute JA4, parse user agents, or derive subnets.
 *   Whether a real deployment can compute a stable fingerprint
 *   is the host's problem and stays unclaimed here. If the host
 *   fingerprint itself rotates with the declared identity, the
 *   group never accumulates and the signal sees nothing.
 * - Declared values are counted, never trusted: no code path here
 *   treats a declared IP or key as authenticated identity.
 * - State is bounded: per-fingerprint event lists are truncated
 *   and fingerprint groups are evicted least-recently-seen first
 *   past the configured caps.
 *
 * Pure computation: no I/O, no runtime dependencies.
 */

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_ROTATE_THRESHOLD = 3;

const ADVISORY_NOTICE =
  "Advisory telemetry only (enforcement: none): one host-supplied secondary fingerprint " +
  "presenting at least 3 distinct declared IPs or at least 3 distinct declared API keys " +
  "inside a 60 s window - the identity-rotation shape measured in the ABE-03 lab (rotation " +
  "200/200 on both axes; legit mobile, CGNAT, scheduled key rotation and single-change " +
  "controls all 0/200, seeded simulation, abe-lab seed 20321103). The fingerprint is " +
  "host-supplied and is not computed here; declared values are counted, never trusted. " +
  "Never use this signal as the sole basis for any consequence.";

export interface IdentityRotationEvent {
  /** Host-supplied secondary fingerprint: the grouping key (for example JA4, UA, or a behaviour key). */
  fingerprint: string;
  /** Self-declared IP value for this request (for example an X-Real-IP value), when present. */
  declaredIp?: string;
  /** Self-declared API key value for this request (for example an X-API-Key value), when present. */
  declaredApiKey?: string;
  /** Millisecond timestamp of the request. */
  ts: number;
}

export interface CreateIdentityRotationSignalOptions {
  /** Trailing window length in ms. Default 60000 (60 s, lab law). */
  windowMs?: number;
  /** Distinct declared values on one axis inside the window that flag a fingerprint. Default 3 (lab law). */
  rotateThreshold?: number;
  /** Maximum fingerprint groups retained (least recently seen evicted). Default 10000. */
  maxFingerprints?: number;
  /** Maximum events retained per fingerprint (oldest truncated). Default 10000. */
  maxEventsPerFingerprint?: number;
}

export interface IdentityRotationObservation {
  status: "recorded" | "invalid_ts";
  counted: boolean;
  /** Assessment for the event fingerprint after this event, when recorded. */
  assessment?: IdentityRotationAssessment;
}

export interface IdentityRotationAssessment {
  fingerprint: string;
  /** Distinct declared IPs inside the trailing window. */
  distinctIps: number;
  /** Distinct declared API keys inside the trailing window. */
  distinctApiKeys: number;
  /** Events inside the trailing window. */
  eventsInWindow: number;
  /** True iff either axis reached the rotate threshold inside the window. */
  flagged: boolean;
  /** Which axis flagged, when flagged. */
  axis: "ip" | "api_key" | "both" | null;
  threshold: number;
  windowMs: number;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
}

export interface IdentityRotationResult {
  kind: "identity-rotation";
  /** Flagged fingerprints, sorted. */
  flagged: IdentityRotationAssessment[];
  /** Fingerprint groups tracked. */
  trackedFingerprints: number;
  threshold: number;
  windowMs: number;
  enforcement: "none";
  notice: string;
}

export interface IdentityRotationSnapshot {
  enforcement: "none";
  windowMs: number;
  rotateThreshold: number;
  fingerprints: number;
  counters: {
    observed: number;
    invalidTs: number;
    evictedFingerprints: number;
    truncatedEvents: number;
  };
  notice: string;
}

export interface IdentityRotationSignalInstance {
  observe(event: IdentityRotationEvent): IdentityRotationObservation;
  /** Assessment for one fingerprint at asOfTs (defaults to its latest event). */
  check(fingerprint: string, asOfTs?: number): IdentityRotationAssessment;
  /** Assessments for every tracked fingerprint; only flagged ones are returned in flagged. */
  evaluate(options?: { asOfTs?: number }): IdentityRotationResult;
  snapshot(): IdentityRotationSnapshot;
  reset(fingerprint?: string): void;
}

export class IdentityRotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityRotationError";
  }
}

const fail = (message: string): never => {
  throw new IdentityRotationError(`createIdentityRotationSignal: ${message}`);
};

function requireIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requirePositiveMs(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${field} must be a positive finite number of milliseconds`);
  }
  return value as number;
}

function requireKey(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    fail(`${field} must be a string of 1 to 1024 characters`);
  }
  return value as string;
}

function isValidTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8.64e15;
}

export function createIdentityRotationSignal(
  options: CreateIdentityRotationSignalOptions = {},
): IdentityRotationSignalInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");
  const windowMs = requirePositiveMs(options.windowMs ?? DEFAULT_WINDOW_MS, "windowMs");
  const rotateThreshold = requireIntInRange(
    options.rotateThreshold ?? DEFAULT_ROTATE_THRESHOLD, "rotateThreshold", 2, 1_000_000,
  );
  const maxFingerprints = requireIntInRange(options.maxFingerprints ?? 10_000, "maxFingerprints", 1, 1_000_000);
  const maxEventsPerFingerprint = requireIntInRange(
    options.maxEventsPerFingerprint ?? 10_000, "maxEventsPerFingerprint", 1, 1_000_000,
  );

  interface Stored { ts: number; ip?: string; key?: string }
  const groups = new Map<string, Stored[]>();
  const lastSeen = new Map<string, number>();
  const counters = { observed: 0, invalidTs: 0, evictedFingerprints: 0, truncatedEvents: 0 };
  let latestTs = -Infinity;

  function assess(fingerprint: string, asOfTs: number): IdentityRotationAssessment {
    const list = groups.get(fingerprint) ?? [];
    const floor = asOfTs - windowMs;
    const ips = new Set<string>();
    const keys = new Set<string>();
    let eventsInWindow = 0;
    for (const e of list) {
      if (e.ts < floor || e.ts > asOfTs) continue;
      eventsInWindow++;
      if (e.ip !== undefined) ips.add(e.ip);
      if (e.key !== undefined) keys.add(e.key);
    }
    const ipFlag = ips.size >= rotateThreshold;
    const keyFlag = keys.size >= rotateThreshold;
    return {
      fingerprint,
      distinctIps: ips.size,
      distinctApiKeys: keys.size,
      eventsInWindow,
      flagged: ipFlag || keyFlag,
      axis: ipFlag && keyFlag ? "both" : ipFlag ? "ip" : keyFlag ? "api_key" : null,
      threshold: rotateThreshold,
      windowMs,
      enforcement: "none",
    };
  }

  function observe(event: IdentityRotationEvent): IdentityRotationObservation {
    if (typeof event !== "object" || event === null) fail("event must be an object");
    const fingerprint = requireKey(event.fingerprint, "event.fingerprint");
    if (event.declaredIp !== undefined) requireKey(event.declaredIp, "event.declaredIp");
    if (event.declaredApiKey !== undefined) requireKey(event.declaredApiKey, "event.declaredApiKey");
    if (!isValidTs(event.ts)) {
      counters.invalidTs++;
      return { status: "invalid_ts", counted: false };
    }
    counters.observed++;
    if (event.ts > latestTs) latestTs = event.ts;
    if (!groups.has(fingerprint)) {
      while (groups.size >= maxFingerprints) {
        let oldestId: string | null = null;
        let oldestTs = Infinity;
        for (const [id, ts] of lastSeen) if (ts < oldestTs) { oldestTs = ts; oldestId = id; }
        if (oldestId === null) break;
        groups.delete(oldestId);
        lastSeen.delete(oldestId);
        counters.evictedFingerprints++;
      }
      groups.set(fingerprint, []);
    }
    const list = groups.get(fingerprint) as Stored[];
    list.push({ ts: event.ts, ip: event.declaredIp, key: event.declaredApiKey });
    if (list.length > maxEventsPerFingerprint) {
      const excess = list.length - maxEventsPerFingerprint;
      list.splice(0, excess);
      counters.truncatedEvents += excess;
    }
    lastSeen.set(fingerprint, Math.max(lastSeen.get(fingerprint) ?? -Infinity, event.ts));
    return { status: "recorded", counted: true, assessment: assess(fingerprint, event.ts) };
  }

  function check(fingerprint: string, asOfTs?: number): IdentityRotationAssessment {
    requireKey(fingerprint, "fingerprint");
    const at = asOfTs !== undefined ? asOfTs : (lastSeen.get(fingerprint) ?? 0);
    if (asOfTs !== undefined && !isValidTs(asOfTs)) fail("asOfTs must be a finite timestamp within the representable range");
    return assess(fingerprint, at);
  }

  function evaluate(evalOptions: { asOfTs?: number } = {}): IdentityRotationResult {
    const asOfTs = evalOptions.asOfTs !== undefined ? evalOptions.asOfTs : latestTs;
    if (asOfTs !== -Infinity && !isValidTs(asOfTs)) fail("asOfTs must be a finite timestamp within the representable range");
    const flagged: IdentityRotationAssessment[] = [];
    if (asOfTs !== -Infinity) {
      for (const fp of groups.keys()) {
        const a = assess(fp, asOfTs);
        if (a.flagged) flagged.push(a);
      }
      flagged.sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
    }
    return {
      kind: "identity-rotation",
      flagged,
      trackedFingerprints: groups.size,
      threshold: rotateThreshold,
      windowMs,
      enforcement: "none",
      notice: ADVISORY_NOTICE,
    };
  }

  function snapshot(): IdentityRotationSnapshot {
    return {
      enforcement: "none",
      windowMs,
      rotateThreshold,
      fingerprints: groups.size,
      counters: { ...counters },
      notice: ADVISORY_NOTICE,
    };
  }

  return {
    observe,
    check,
    evaluate,
    snapshot,
    reset(fingerprint?: string): void {
      if (fingerprint === undefined) {
        groups.clear();
        lastSeen.clear();
        latestTs = -Infinity;
      } else {
        groups.delete(fingerprint);
        lastSeen.delete(fingerprint);
      }
    },
  };
}
