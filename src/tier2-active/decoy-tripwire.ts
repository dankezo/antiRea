/**
 * Decoy tripwire (HARVEST2 candidate C35, CANDECOY, lab PASS with a
 * NARROWED claim - see the study lab's C35-DESIGN.md, C35-RESULTS.md
 * and C35-RESULTS-RANDOM.md under the antiRea research tree).
 *
 * WHAT IT MEASURES. The host declares a set of decoy resources:
 * resources that exist only to be touched by a caller that
 * ENUMERATES the id/URL space instead of navigating to resources it
 * was actually shown. This module records, per identity, whether
 * that identity ever touched a declared decoy, how many decoy
 * touches it made, and when the first one happened. That is all it
 * measures: a touch is evidence of ID-SPACE ENUMERATION, not
 * evidence of hostile intent (see the narrowed claim below).
 *
 * THE LAB NUMBERS (simulation, scripted populations - the lab's
 * harness-v2 legit traces and plateau walkers, resource space of
 * 2,000 real resources + 60 decoys in a 2,060-value enumeration
 * sequence):
 * - NAV channel false positives: 0 / 1,200 identities touched a
 *   decoy over 1,115,408 navigation requests (original run), and
 *   0 / 1,200 over 1,112,209 requests in the RANDOM-placement
 *   re-run. Zero by construction - decoy URLs do not exist in the
 *   legit resource universe - confirmed empirically by counting;
 *   both denominators are reported, exactly as the lab reports
 *   them. This is a per-channel number, NOT a general FP rate.
 * - Enumeration sensitivity: 1.000 at every K in {7, 20, 50}
 *   novel resources/day and every traversal order (perm / seq /
 *   desc), both for scattered-with-pattern placement and for
 *   per-rep RANDOM placement (RANDOM-CONFIRMED: 60/60 walkers in
 *   all 9 K x order cells).
 * - Learning evader: under the lab's generous learning rule (after
 *   3 touches the evader perfectly infers ANY learnable channel),
 *   100% of walkers still touched >= 1 decoy at every K - the
 *   first touch is unavoidable, and the >= 1-touch signal survives
 *   learning whole.
 *
 * THE NARROWED CLAIM - the only claim this module makes, verbatim
 * in substance from C35-RESULTS.md. C35 separates ENUMERATION from
 * NAVIGATION almost absolutely on its substrate (sensitivity
 * 1.000; navigation-channel FP 0 with its denominator). It does NOT
 * separate hostile enumeration from LEGITIMATE enumeration (a
 * sitemap crawler in a leak configuration, an id-listing
 * aggregator, a power user following a URL pattern). The evidence
 * value of a single touch is decided by each host's own legitimate
 * enumeration base rate, which the lab did not and cannot measure.
 * Accordingly `flagged` in this module means exactly "this identity
 * touched >= 1 declared decoy resource" - an enumeration tripwire
 * flag, never a maliciousness verdict. The posterior of a touch is
 * the host's to compute from its own base rate (the lab's worked
 * scenarios: prior 1% -> posterior 0.802 at the rule-of-three NAV
 * upper bound, 0.447 in a population with 1% unidentified
 * legitimate enumerators, and ~prior - worthless - in a leak
 * world).
 *
 * OPERATIONAL CONSTRAINT - part of the verdict, not a footnote.
 * Decoys must sit outside EVERY discovery surface: navigation,
 * sitemap, listing, search index, external links. If a decoy leaks
 * onto ANY surface, the signal dies: in the lab's leak
 * configurations a sitemap crawler touched all 60 decoys in its
 * first crawl round and a listing aggregator touched all 60 on day
 * one. The standard configuration is RANDOM placement plus
 * PLAUSIBLE content (nothing learnable); patterned placement is
 * itself a fingerprint a learning evader can exploit. This module
 * cannot check any of that for the host - it only sees the touches
 * the host feeds it - so a host that cannot keep its decoys off
 * every discovery surface must not treat a flag as evidence of
 * anything.
 *
 * HARD CONDITIONS - in the code, not just the docs:
 *
 * 1. HOST DECOY DECLARATION IS MANDATORY. With neither
 *    `decoyResourceIds` nor `isDecoyResource` the module is
 *    DISABLED: it records nothing, `observe` is a no-op returning
 *    status `"disabled"`, every `evaluateIdentity` returns status
 *    `"disabled"`, and the snapshot reports `disabled: true` (the
 *    C22/C9 hard-condition precedent in this tree).
 * 2. ADVISORY ONLY. The module emits signal objects
 *    (`enforcement: "none"`). It has no blocking decision and
 *    attaches no consequence; a flag is investigation telemetry.
 * 3. OPT-IN. Nothing runs until the host constructs an instance
 *    and feeds it serve events.
 *
 * Pure computation: no I/O, no runtime dependencies. State is
 * in-memory: one entry per identity seen, plus touch records for
 * identities that touched a decoy.
 */

const DISABLED_REASON = "decoy_resources_not_declared";

const ADVISORY_NOTICE =
  "Advisory signal only (enforcement: none): flagged means this identity touched >= 1 host-declared " +
  "decoy resource - evidence of id-space enumeration, NOT a maliciousness verdict. This module cannot " +
  "separate hostile enumeration from legitimate enumeration (sitemap crawlers, id-listing aggregators, " +
  "power users following a URL pattern); the evidence value of a touch is decided by the host's own " +
  "legitimate-enumeration base rate. The signal is valid only while every decoy stays off every " +
  "discovery surface (navigation, sitemap, listing, search index): a decoy leaking onto any surface " +
  "kills the signal.";

export interface DecoyTripwireEvent {
  /** The authenticated identity the resource was served to. */
  identity: string;
  /** The resource served; matched against the host's decoy declaration. */
  resourceId: number | string;
  /** Millisecond timestamp of the serve (any finite timestamp inside the representable Date range). */
  ts: number;
}

export interface CreateDecoyTripwireOptions {
  /**
   * Host-declared decoy resource ids (array or Set). Copied at
   * construction. Either this or `isDecoyResource` must be supplied;
   * with neither, the instance is created DISABLED (hard condition 1).
   * When both are supplied, a resource is a decoy when either
   * declaration says so.
   */
  decoyResourceIds?: Iterable<number | string>;
  /**
   * Host decoy predicate: resource id -> true when the resource is a
   * declared decoy. A predicate that throws is treated as returning
   * false for that event (herd-detector callback discipline).
   */
  isDecoyResource?: (resourceId: number | string) => boolean;
}

export interface DecoyTripwireObservation {
  /**
   * `"recorded"` - the event was counted (and, when the resource is
   * a declared decoy, a touch was recorded);
   * `"invalid_ts"` - non-finite or out-of-range timestamp, refused
   * as a no-op before any state was touched;
   * `"disabled"` - the module is disabled.
   */
  status: "recorded" | "invalid_ts" | "disabled";
  /** Present when `status` is `"disabled"`: the named reason the module is off. */
  reason?: string;
  /** Whether the event was counted into the request denominator. */
  counted: boolean;
  /** Whether the served resource is a host-declared decoy. */
  decoy: boolean;
  /** This identity's decoy touch count after the event (0 for non-decoy resources). */
  touchCount: number;
}

export interface DecoyTripwireSignal {
  kind: "decoy_tripwire";
  identity: string;
  /**
   * `"scored"` - the identity has been seen and the verdict below
   * applies; `"unknown_identity"` - the identity was never fed to
   * `observe`; `"disabled"` - the module is disabled.
   */
  status: "scored" | "unknown_identity" | "disabled";
  /** True exactly when the identity touched >= 1 declared decoy resource. */
  touched: boolean;
  /** Number of decoy touches recorded for this identity. */
  touchCount: number;
  /** Timestamp of the identity's first decoy touch, or null when it never touched one. */
  firstTouchAt: number | null;
  /**
   * Exactly `touched`: the enumeration tripwire fired (>= 1 decoy
   * touch). This is NOT a maliciousness verdict - see the header's
   * narrowed claim.
   */
  flagged: boolean;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface DecoyTripwireSnapshot {
  /** Identities with >= 1 recorded decoy touch. */
  identitiesTouched: number;
  /** Total decoy touch events recorded. */
  totalDecoyTouches: number;
  /** Total valid events fed to `observe` (the request denominator). */
  totalRequestsSeen: number;
  /** True when the module is disabled (no decoy declaration was supplied). */
  disabled: boolean;
  /** Whether the module is on (a decoy declaration was supplied at construction). */
  enabled: boolean;
  /** `"decoy_resources_not_declared"` when disabled, otherwise null. */
  disabledReason: string | null;
  /** Identities seen on any event, decoy or not. */
  identitiesSeen: number;
  /** Always `"none"`: this module enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface DecoyTripwireInstance {
  /** Whether the module is on (a decoy declaration was supplied at construction). */
  readonly enabled: boolean;
  /** Feed one serve event. See {@link DecoyTripwireObservation} for the outcome vocabulary. */
  observe(event: DecoyTripwireEvent): DecoyTripwireObservation;
  /** The tripwire verdict for one identity. See {@link DecoyTripwireSignal}. */
  evaluateIdentity(identity: string): DecoyTripwireSignal;
  /** State summary. */
  snapshot(): DecoyTripwireSnapshot;
}

/** Named error thrown for every invalid decoy-tripwire input. */
export class DecoyTripwireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoyTripwireError";
  }
}

const fail = (message: string): never => {
  throw new DecoyTripwireError(`createDecoyTripwire: ${message}`);
};

/** The F-21 timestamp discipline shared with the herd detector: finite and inside the representable Date range. */
function isValidTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8.64e15;
}

function isValidResourceId(value: unknown): value is number | string {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length > 0)
  );
}

function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value as string;
}

interface TouchRecord {
  touchCount: number;
  firstTouchAt: number;
}

export function createDecoyTripwire(
  options: CreateDecoyTripwireOptions = {},
): DecoyTripwireInstance {
  if (typeof options !== "object" || options === null) fail("options must be an object");

  const decoyIds = new Set<number | string>();
  if (options.decoyResourceIds !== undefined) {
    const ids = options.decoyResourceIds;
    if (
      typeof ids === "string" ||
      ids === null ||
      typeof (ids as Iterable<number | string>)[Symbol.iterator] !== "function"
    ) {
      fail("decoyResourceIds must be an array or Set of resource ids");
    }
    for (const id of ids as Iterable<number | string>) {
      if (!isValidResourceId(id)) {
        fail("decoyResourceIds entries must be finite numbers or non-empty strings");
      }
      decoyIds.add(id);
    }
  }
  const isDecoyResource = options.isDecoyResource;
  if (isDecoyResource !== undefined && typeof isDecoyResource !== "function") {
    fail("isDecoyResource must be a function");
  }
  const enabled = options.decoyResourceIds !== undefined || isDecoyResource !== undefined;

  const seenIdentities = new Set<string>();
  const touches = new Map<string, TouchRecord>();
  let totalDecoyTouches = 0;
  let totalRequestsSeen = 0;

  function isDecoy(resourceId: number | string): boolean {
    if (decoyIds.has(resourceId)) return true;
    if (isDecoyResource) {
      try {
        return isDecoyResource(resourceId) === true;
      } catch {
        return false; // A throwing host predicate is treated as "not a decoy" for that event.
      }
    }
    return false;
  }

  function observe(event: DecoyTripwireEvent): DecoyTripwireObservation {
    if (!enabled) {
      return { status: "disabled", reason: DISABLED_REASON, counted: false, decoy: false, touchCount: 0 };
    }
    if (typeof event !== "object" || event === null) fail("event must be an object");
    const identity = requireIdentity(event.identity, "event.identity");
    if (!isValidResourceId(event.resourceId)) {
      fail("event.resourceId must be a finite number or a non-empty string");
    }
    if (!isValidTs(event.ts)) {
      return { status: "invalid_ts", counted: false, decoy: false, touchCount: 0 };
    }
    totalRequestsSeen++;
    seenIdentities.add(identity);
    const decoy = isDecoy(event.resourceId);
    if (!decoy) {
      return { status: "recorded", counted: true, decoy: false, touchCount: 0 };
    }
    totalDecoyTouches++;
    const existing = touches.get(identity);
    if (existing) {
      existing.touchCount++;
      return { status: "recorded", counted: true, decoy: true, touchCount: existing.touchCount };
    }
    touches.set(identity, { touchCount: 1, firstTouchAt: event.ts });
    return { status: "recorded", counted: true, decoy: true, touchCount: 1 };
  }

  function evaluateIdentity(identity: string): DecoyTripwireSignal {
    const base = {
      kind: "decoy_tripwire" as const,
      enforcement: "none" as const,
      notice: enabled
        ? ADVISORY_NOTICE
        : `Module disabled (${DISABLED_REASON}): no decoy resources were declared, so nothing is scored.`,
    };
    if (!enabled) {
      return {
        ...base,
        identity: typeof identity === "string" ? identity : "",
        status: "disabled",
        touched: false,
        touchCount: 0,
        firstTouchAt: null,
        flagged: false,
      };
    }
    const id = requireIdentity(identity, "identity");
    const record = touches.get(id);
    if (record) {
      return {
        ...base,
        identity: id,
        status: "scored",
        touched: true,
        touchCount: record.touchCount,
        firstTouchAt: record.firstTouchAt,
        flagged: true,
      };
    }
    if (seenIdentities.has(id)) {
      return {
        ...base,
        identity: id,
        status: "scored",
        touched: false,
        touchCount: 0,
        firstTouchAt: null,
        flagged: false,
      };
    }
    return {
      ...base,
      identity: id,
      status: "unknown_identity",
      touched: false,
      touchCount: 0,
      firstTouchAt: null,
      flagged: false,
    };
  }

  function snapshot(): DecoyTripwireSnapshot {
    return {
      identitiesTouched: touches.size,
      totalDecoyTouches,
      totalRequestsSeen,
      disabled: !enabled,
      enabled,
      disabledReason: enabled ? null : DISABLED_REASON,
      identitiesSeen: seenIdentities.size,
      enforcement: "none",
      notice: enabled
        ? ADVISORY_NOTICE
        : `Module disabled (${DISABLED_REASON}): no decoy resources were declared, so nothing is scored.`,
    };
  }

  return { enabled, observe, evaluateIdentity, snapshot };
}
