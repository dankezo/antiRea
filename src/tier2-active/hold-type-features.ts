/**
 * Hold-type features - mechanical timing/typing features of one
 * browser session, plus the frozen signed-z composite (RECOMB-02
 * HOLD-TYPE, PASS-LAB Step 0 only; registration recomb02-lab/
 * REGISTRATION-RECOMB-02-HOLD-TYPE.md, runner recomb02-lab/
 * recomb02-run.cjs `computeFeatures`).
 *
 * The idea, inherited from AC-47: scripted drivers betray themselves
 * in the VARIANCE of their timings, not the means. A human's key holds,
 * inter-key intervals and click holds jitter; a driver that holds one
 * constant per session (the measured humanlike fleet pattern: one hold,
 * one inter-key interval, one click-hold drawn per session and then
 * repeated exactly) produces standard deviations at or near zero, and
 * a fill-style driver produces text with no keystrokes at all. These
 * five features measure exactly that, mechanically:
 *
 * - mouseEventRate: pointermove events / session duration in seconds
 *   (session span = last minus first timestamp over ALL events). This
 *   is the AC-47 definition as implemented in the runner, verbatim.
 * - clickDurationStd: population SD of mousedown->mouseup durations
 *   over TASK-TARGETED pairs only (targets in the host's task-click
 *   id set; field-focus clicks are not task clicks), paired by event
 *   order (zip), immune to timestamp ties.
 * - keyHoldStd: population SD of keydown->keyup holds, paired by
 *   event order; fewer than 2 keystrokes -> 0.
 * - interKeyStd: population SD of intervals between consecutive
 *   keydowns whose target id is the SAME as the previous keydown's;
 *   fewer than 2 such intervals -> 0.
 * - sType: per field, characters count as programmatic iff the field
 *   recorded 0 keydown events and its final length is > 0;
 *   sType = programmatic chars / total chars (0 when no chars).
 *
 * SCORING (frozen): against a host-supplied human reference
 * (per-feature mean and population SD), each feature becomes a SIGNED
 * z, sign chosen so higher = more agent-like:
 *   mouseEventRate -, clickDurationStd -, keyHoldStd -,
 *   interKeyStd -, sType as-is (+).
 * z = sign * (x - mean) / sd, with z = 0 when sd is 0 (the runner's
 * guard). set2Score = mean of the mouseEventRate + clickDurationStd
 * z's; typeScore = mean of the sType + keyHoldStd + interKeyStd z's;
 * composite = mean of all five.
 *
 * ADAPTATIONS FROM THE LAB RUNNER (smallest faithful changes; the
 * runner's harness shape is not a library shape):
 * 1. Event field names: the runner recorded `id`; library events use
 *    `targetId`. The runner's teleport features needed x/y
 *    coordinates; none of the five RECOMB-02 features do, so library
 *    events carry only type / t / targetId.
 * 2. Click-pair validity: the runner's twin page had exactly 7 task
 *    targets, so it required exactly 7 downs and 7 ups and returned
 *    NaN otherwise. The library pairs however many task-targeted
 *    downs/ups the host's own task set produces, keeping the runner's
 *    validity semantics: unequal down/up counts, or any negative
 *    paired duration, make the session invalid. Invalid numeric
 *    features are reported as finite zeros with valid=false. One valid pair gives SD 0, as in the
 *    runner's durations.length >= 2 ? popSD : 0 branch.
 * 3. Key-pair validity: on a bad pairing (unequal keydown/keyup
 *    counts or a negative hold) the runner still averaged the partial
 *    holds collected before the bad pair into keyHoldMean - a harness
 *    artifact. The library reports keyHoldStd 0 with valid=false and
 *    keyHoldMean 0 (no trustworthy holds).
 * 4. sType inputs: the runner read final field values off the page
 *    and counted keydown events per field id itself. The library
 *    takes the host-reported per-field finalLength and keydownCount;
 *    the per-field rule itself is verbatim.
 * 5. Empty session: the runner assumed a non-empty recorded session.
 *    The library returns zeroed features with sessionSeconds 0 for an
 *    empty event list instead of throwing. Zero-span or malformed
 *    sessions are explicitly invalid, have finite numeric fields,
 *    and are neutralized by the scorer. Valid lab sessions retain
 *    the frozen arithmetic exactly.
 * 6. Names: camelCase here, snake_case in the runner; the five
 *    features, signs and composites are the same.
 *
 * HONESTY SCOPE (mandatory, from the registration's own limitation):
 * - The lab verdict is STEP-0 ONLY: it covers feature and composite
 *   COMPUTATION on scripted twin-page sessions. This module makes NO
 *   detection claim - no sensitivity, no false-positive rate, no
 *   threshold ships with it.
 * - Thresholds are HOST-SIDE. The lab compared scores against the
 *   outer-5% tail of a human reference distribution; choosing the
 *   tail, the reference population and any consequence is the host's
 *   decision and the host's risk.
 * - A humanlike sampler that RE-DRAWS its holds per event (instead of
 *   holding one constant per session) is OUT OF SCOPE: it would
 *   produce human-shaped variances and these features would not
 *   separate it. The lab named this limitation up front; this module
 *   inherits it verbatim.
 * - Client-collected timing is telemetry, not evidence of intent:
 *   assistive input devices, remote desktops, keyboard layouts and
 *   plain fast typists can all produce unusual variances. Never use
 *   a composite as the sole ground for a consequence.
 */

export type HoldTypeEventType =
  | "pointermove"
  | "mousedown"
  | "mouseup"
  | "keydown"
  | "keyup"
  | "wheel";

export interface HoldTypeEvent {
  type: HoldTypeEventType;
  /** Event timestamp in milliseconds (host clock; only differences are read). */
  t: number;
  /** Recorded target id of the event, when the host records one. */
  targetId?: string;
}

export interface HoldTypeFieldInput {
  /** Field id, as it appears in keydown events' targetId. */
  id: string;
  /** Final character length of the field's value. */
  finalLength: number;
  /** Keydown events recorded for this field during the session. */
  keydownCount: number;
}

export interface HoldTypeConfig {
  /** Target ids that count as task clicks (the runner's TASK_CLICK_IDS role, host-declared). */
  taskClickIds: readonly string[];
  /** Per-field typing outcome for sType. */
  fields: readonly HoldTypeFieldInput[];
}

export type HoldTypeFeatureName =
  | "mouseEventRate"
  | "clickDurationStd"
  | "keyHoldStd"
  | "interKeyStd"
  | "sType";

export interface HoldTypeFeatureValues {
  mouseEventRate: number;
  clickDurationStd: number;
  keyHoldStd: number;
  interKeyStd: number;
  sType: number;
}

export interface HoldTypeDescriptive {
  keyHoldMean: number;
  interKeyMean: number;
  /** Mean task-click hold duration; 0 when there is no valid pair. */
  clickHoldMean: number;
  nKeydown: number;
  nEvents: number;
  sessionSeconds: number;
}

export interface HoldTypeFeatures extends HoldTypeFeatureValues {
  /** False for malformed or insufficient timing data; never use invalid sessions as evidence. */
  valid: boolean;
  invalidReasons: string[];
  descriptive: HoldTypeDescriptive;
}

export interface HoldTypeReference {
  mean: Record<HoldTypeFeatureName, number>;
  sd: Record<HoldTypeFeatureName, number>;
}

export interface HoldTypeScore {
  /** Invalid features or arithmetic overflow produce a neutral score with valid=false. */
  valid: boolean;
  set2Score: number;
  typeScore: number;
  composite: number;
  /** Signed z per feature (higher = more agent-like). */
  z: Record<HoldTypeFeatureName, number>;
}

const FEATURE_NAMES: readonly HoldTypeFeatureName[] = [
  "mouseEventRate",
  "clickDurationStd",
  "keyHoldStd",
  "interKeyStd",
  "sType",
];

/** Frozen signs (registration): higher signed z = more agent-like. */
const SIGNS: Record<HoldTypeFeatureName, number> = {
  mouseEventRate: -1,
  clickDurationStd: -1,
  keyHoldStd: -1,
  interKeyStd: -1,
  sType: 1,
};

function meanOf(a: readonly number[]): number {
  return a.reduce((s, x) => s + x, 0) / a.length;
}

function popSD(a: readonly number[]): number {
  const m = meanOf(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length);
}

/**
 * Compute the five frozen features for one session.
 * Pure: the same events + config always give the same features.
 */
export function computeHoldTypeFeatures(
  events: readonly HoldTypeEvent[],
  config: HoldTypeConfig,
): HoldTypeFeatures {
  if (!Array.isArray(events) || events.length > 100_000) {
    throw new RangeError("computeHoldTypeFeatures: events must be an array of at most 100000 entries");
  }
  if (!config || !Array.isArray(config.taskClickIds) || !Array.isArray(config.fields) ||
      config.taskClickIds.length > 10_000 || config.fields.length > 10_000) {
    throw new RangeError("computeHoldTypeFeatures: taskClickIds and fields must be arrays of at most 10000 entries");
  }
  const invalidReasons: string[] = [];
  const invalid = (reason: string): void => { if (!invalidReasons.includes(reason)) invalidReasons.push(reason); };
  events = events.filter((e) => {
    const accepted = e !== null && typeof e === "object" && typeof e.type === "string" &&
      typeof e.t === "number" && Number.isFinite(e.t) && Math.abs(e.t) <= 8.64e15;
    if (!accepted) invalid("invalid_event");
    return accepted;
  });
  const fields = config.fields.filter((f) => {
    const accepted = f !== null && typeof f === "object" && Number.isSafeInteger(f.finalLength) &&
      f.finalLength >= 0 && Number.isSafeInteger(f.keydownCount) && f.keydownCount >= 0;
    if (!accepted) invalid("invalid_field");
    return accepted;
  });
  const taskIds = new Set(config.taskClickIds);

  if (events.length === 0) {
    return {
      valid: false,
      invalidReasons: [...invalidReasons, "empty_session"],
      mouseEventRate: 0,
      clickDurationStd: 0,
      keyHoldStd: 0,
      interKeyStd: 0,
      sType: sTypeOf(fields),
      descriptive: {
        keyHoldMean: 0,
        interKeyMean: 0,
        clickHoldMean: 0,
        nKeydown: 0,
        nEvents: 0,
        sessionSeconds: 0,
      },
    };
  }

  // mouse_event_rate (AC-47 as implemented in the runner): pointermove
  // count over the whole-session span, first to last event of any type.
  let minT = Infinity;
  let maxT = -Infinity;
  let nPointermove = 0;
  for (const e of events) {
    if (e.t < minT) minT = e.t;
    if (e.t > maxT) maxT = e.t;
    if (e.type === "pointermove") nPointermove++;
  }
  const sessionSeconds = (maxT - minT) / 1000;
  const rawMouseEventRate = nPointermove / sessionSeconds;
  if (!(sessionSeconds > 0)) invalid("zero_span");
  if (!Number.isFinite(rawMouseEventRate)) invalid("non_finite_rate");
  const mouseEventRate = Number.isFinite(rawMouseEventRate) ? rawMouseEventRate : 0;

  // click_duration_std: task-targeted downs/ups only, zipped in event
  // order. Unequal counts or a negative duration invalidate the session.
  const downs = events.filter((e) => e.type === "mousedown" && e.targetId !== undefined && taskIds.has(e.targetId));
  const ups = events.filter((e) => e.type === "mouseup" && e.targetId !== undefined && taskIds.has(e.targetId));
  let clickBad = downs.length !== ups.length;
  const durations: number[] = [];
  if (!clickBad) {
    for (let i = 0; i < downs.length; i++) {
      const d = ups[i]!.t - downs[i]!.t;
      if (d < 0) {
        clickBad = true;
        break;
      }
      durations.push(d);
    }
  }
  if (clickBad) invalid("click_pair");
  const clickDurationStd = clickBad ? 0 : durations.length >= 2 ? popSD(durations) : 0;
  const clickHoldMean = clickBad || durations.length === 0 ? 0 : meanOf(durations);

  // key_hold_std: keydown/keyup zipped in event order. Bad pairing ->
  // invalid session with finite std and mean 0. Fewer than 2 keystrokes -> 0.
  const kdowns = events.filter((e) => e.type === "keydown");
  const kups = events.filter((e) => e.type === "keyup");
  let keyBad = kdowns.length !== kups.length;
  const keyHolds: number[] = [];
  if (!keyBad) {
    for (let i = 0; i < kdowns.length; i++) {
      const h = kups[i]!.t - kdowns[i]!.t;
      if (h < 0) {
        keyBad = true;
        break;
      }
      keyHolds.push(h);
    }
  }
  if (keyBad) invalid("key_pair");
  const keyHoldStd = keyBad ? 0 : keyHolds.length >= 2 ? popSD(keyHolds) : 0;
  const keyHoldMean = keyBad || keyHolds.length === 0 ? 0 : meanOf(keyHolds);

  // inter_key_std: intervals between CONSECUTIVE keydowns (in the
  // session's keydown stream) whose target id equals the previous
  // keydown's. Fewer than 2 intervals -> 0.
  const interKey: number[] = [];
  for (let i = 1; i < kdowns.length; i++) {
    if (kdowns[i]!.targetId === kdowns[i - 1]!.targetId) {
      const interval = kdowns[i]!.t - kdowns[i - 1]!.t;
      if (interval < 0) invalid("negative_inter_key");
      interKey.push(interval);
    }
  }
  const interKeyStd = interKey.length >= 2 ? popSD(interKey) : 0;
  const interKeyMean = interKey.length ? meanOf(interKey) : 0;

  return {
    valid: invalidReasons.length === 0,
    invalidReasons,
    mouseEventRate,
    clickDurationStd,
    keyHoldStd,
    interKeyStd,
    sType: sTypeOf(fields),
    descriptive: {
      keyHoldMean,
      interKeyMean,
      clickHoldMean,
      nKeydown: kdowns.length,
      nEvents: events.length,
      sessionSeconds,
    },
  };
}

function sTypeOf(fields: readonly HoldTypeFieldInput[]): number {
  // Per field: 0 keydowns and final length > 0 -> all its chars are
  // programmatic (the runner's implemented form, verbatim).
  let progChars = 0;
  let totalChars = 0;
  for (const f of fields) {
    totalChars += f.finalLength;
    if (f.keydownCount === 0 && f.finalLength > 0) progChars += f.finalLength;
  }
  return totalChars ? progChars / totalChars : 0;
}

/**
 * Build the frozen signed-z scorer over a host-supplied human
 * reference distribution. The reference is the host's responsibility:
 * the lab's reference was its scripted human population, and no
 * reference values ship with this module.
 */
export function createHoldTypeScorer(
  reference: HoldTypeReference,
): (features: HoldTypeFeatureValues) => HoldTypeScore {
  if (!reference || typeof reference.mean !== "object" || reference.mean === null ||
      typeof reference.sd !== "object" || reference.sd === null) {
    throw new TypeError("createHoldTypeScorer: reference mean and sd are required");
  }
  const means = { ...reference.mean };
  const scales = { ...reference.sd };
  return function score(features: HoldTypeFeatureValues): HoldTypeScore {
    const z = {} as Record<HoldTypeFeatureName, number>;
    let valid = !!features && (features as Partial<HoldTypeFeatures>).valid !== false;
    for (const name of FEATURE_NAMES) {
      const sd = scales[name];
      const mean = means[name];
      const value = features?.[name];
      if (!Number.isFinite(value)) valid = false;
      // Runner guard: sd = 0 -> z = 0. Non-finite reference stats are
      // treated the same way (no trustworthy scale, no z).
      z[name] = typeof sd === "number" && sd > 0 && Number.isFinite(sd) && Number.isFinite(mean) && Number.isFinite(value)
        ? SIGNS[name] * ((value - mean) / sd)
        : 0;
      if (!Number.isFinite(z[name])) valid = false;
    }
    const set2Score = (z.mouseEventRate + z.clickDurationStd) / 2;
    const typeScore = (z.sType + z.keyHoldStd + z.interKeyStd) / 3;
    const composite = FEATURE_NAMES.reduce((acc, name) => acc + z[name], 0) / FEATURE_NAMES.length;
    valid = valid && Number.isFinite(set2Score) && Number.isFinite(typeScore) && Number.isFinite(composite);
    if (!valid) {
      for (const name of FEATURE_NAMES) z[name] = 0;
      return { valid: false, set2Score: 0, typeScore: 0, composite: 0, z };
    }
    return { valid: true, set2Score, typeScore, composite, z };
  };
}
