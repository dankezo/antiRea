/**
 * Monotonic interval clock (L-DEEP-2).
 *
 * Wall clocks step: NTP corrections, VM suspend/resume and manual
 * changes all move `Date.now()` in jumps, and every interval computed
 * from wall timestamps inherits the jump - a +5 minute step resets a
 * 60 s window early (the budget refills for free), a -5 minute step
 * stretches a window by the full step (a legitimate user stays
 * blocked 5 minutes past the design). Intervals must therefore be
 * measured on a clock that never steps.
 *
 * `monoNowMs()` returns `performance.now()` shifted by an anchor
 * captured once at module load, so its values sit on roughly the same
 * scale as `Date.now()` (handy when the two are compared in logs)
 * while every DIFFERENCE between two of its reads is step-free. The
 * anchor is a scale convenience only; no semantics depend on it.
 *
 * Resolution rule used by every L-DEEP-2 patched module
 * (`resolveIntervalClock`): a host that injects `now` but not
 * `monoNow` keeps the pre-patch single-clock behavior exactly - the
 * injected clock drives both domains, so existing host/test clocks
 * behave as they always have. Only a host that injects neither gets
 * the split default: wall for display timestamps, calendar semantics
 * and absolute deadlines, monotonic for every interval. A host may
 * inject `monoNow` explicitly to drive the interval domain itself.
 */
const MONO_ANCHOR_MS = Date.now() - performance.now();

/** Monotonic milliseconds on an epoch-like scale. Never steps; differences are true elapsed time. */
export function monoNowMs(): number {
  return MONO_ANCHOR_MS + performance.now();
}

export interface IntervalClock {
  /** Wall clock: display timestamps, calendar semantics, absolute deadlines shared across processes. */
  wall: () => number;
  /** Monotonic clock: the only source interval arithmetic may read. */
  mono: () => number;
}

/** The split default pair: `Date.now` for wall, `monoNowMs` for intervals. */
export function createIntervalClock(): IntervalClock {
  return { wall: () => Date.now(), mono: monoNowMs };
}

/** Resolve a module's `{ now, monoNow }` options into the clock pair, per the rule in the header. */
export function resolveIntervalClock(options: {
  now?: () => number;
  monoNow?: () => number;
}): IntervalClock {
  const wall = options.now ?? (() => Date.now());
  const mono = options.monoNow ?? (options.now ? wall : monoNowMs);
  return { wall, mono };
}
