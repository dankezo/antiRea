/**
 * Canary dose + per-identity canary tags (antiRea 3.3.0, A4) -
 * OPT-IN, and deliberately default-free: this module plants
 * nothing unless the host passes an explicit dose. DEC-2 ships
 * canary features opt-in and OFF by default with mandatory
 * exposure documentation (docs/PROTECTIVE_DECOYS.md); DEC-5 puts
 * the recommended 10% dose in the documentation only - the code
 * sets no default, so `planCanaryInterleave` requires the host
 * to state its dose on every call.
 *
 * WHAT IT DOES. A host mixes synthetic canary records into the
 * dataset it serves, at a chosen dose (0-25%). An extractor that
 * drains the dataset takes the canaries at exactly the planted
 * share, and every canary record served to an identity carries a
 * tag derived from that identity, so a copy of the dataset found
 * later names the identity it was served to - IF a copy is
 * observed (the attribution claim is scoped to exactly that, per
 * the panel's L4 rebuttal). Tags are HMAC-SHA256 over the
 * identity under a host secret, truncated to 6 hex chars in the
 * trial shape `B-xxxxxx`; unlike the lab twin's unkeyed hash,
 * tags cannot be precomputed or forged without the secret.
 *
 * MEASURED BASIS. Dose response is linear and was measured
 * three times independently: planting every 10th record (10%)
 * yielded canaries at exactly 10.0% of the extraction
 * (decoy-map trial v1: 15/150; trial v2 DOSE arm at 25%:
 * 24.7% extracted, real yield 113/150), and the agent-loop
 * trial (a real LLM agent over HTTP) again extracted canaries
 * at precisely the planted 10.0% share in every decoy-arm run.
 * The per-identity tag was verified in trial v2's COMBO arm:
 * the identity that walked the surface received its own tag on
 * 15/15 canary records, and a probe identity received a
 * different tag.
 *
 * EXPOSURE HONESTY. Canary records are synthetic data mixed
 * into a served dataset. On a bulk API surface that is class
 * (b) exposure; on a public storefront it is class (c) - real
 * visitors may see synthetic records. The guardrails live in
 * docs/PROTECTIVE_DECOYS.md and are part of this feature's
 * contract: the dose is the host's decision, the records are
 * the host's content, and this module never invents records -
 * it only plans positions and tags the records the host gives
 * it.
 */

import { rspHmacHex } from "../internal/rsp-crypto";

/** Maximum supported canary dose, in percent (the registered A4 range is 0-25). */
export const MAX_CANARY_DOSE_PCT = 25;

/** Default field the per-identity tag is written to (the trial shape). */
export const DEFAULT_CANARY_TAG_FIELD = "batchCode";

export class CanaryDoseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanaryDoseError";
  }
}

function assertDose(dosePct: number): void {
  if (typeof dosePct !== "number" || !Number.isFinite(dosePct) || dosePct < 0 || dosePct > MAX_CANARY_DOSE_PCT) {
    throw new CanaryDoseError(`canary dose must be a number in [0, ${MAX_CANARY_DOSE_PCT}] percent, got ${String(dosePct)}`);
  }
}

export interface CanaryPlan {
  /** Interleave stride: a canary replaces every `every`-th record (1-based). 0 when the dose is 0. */
  every: number;
  /** Number of canary positions in a dataset of the planned size. */
  canaryCount: number;
  /** 0-based indices the canary records occupy. */
  positions: number[];
}

/**
 * Plan a canary interleave for `totalRecords` at `dosePct`
 * percent. The planting is the trials' shape: at 10% every 10th
 * record is a canary, at 25% every 4th - so the planted share
 * equals the dose exactly whenever the total divides evenly,
 * which is why the measured extraction share matched the dose.
 * Dose 0 returns an empty plan. There is intentionally no
 * default dose (DEC-5).
 */
export function planCanaryInterleave(totalRecords: number, dosePct: number): CanaryPlan {
  assertDose(dosePct);
  if (!Number.isInteger(totalRecords) || totalRecords < 0) {
    throw new CanaryDoseError(`totalRecords must be a non-negative integer, got ${String(totalRecords)}`);
  }
  if (dosePct === 0 || totalRecords === 0) return { every: 0, canaryCount: 0, positions: [] };
  const every = Math.max(1, Math.round(100 / dosePct));
  const positions: number[] = [];
  for (let i = every - 1; i < totalRecords; i += every) positions.push(i);
  return { every, canaryCount: positions.length, positions };
}

/**
 * Substitute canary records into a dataset at the planned
 * positions (the trial planting: total length is preserved, a
 * canary replaces the record at its position). `canaryRecords`
 * must provide at least as many records as the plan needs.
 * Inputs are not mutated.
 */
export function interleaveCanaries<T>(records: readonly T[], canaryRecords: readonly T[], dosePct: number): T[] {
  const plan = planCanaryInterleave(records.length, dosePct);
  if (plan.canaryCount === 0) return [...records];
  if (canaryRecords.length < plan.canaryCount) {
    throw new CanaryDoseError(`dose ${dosePct}% over ${records.length} records needs ${plan.canaryCount} canary records, got ${canaryRecords.length}`);
  }
  const out = [...records];
  plan.positions.forEach((pos, k) => {
    const canary = canaryRecords[k];
    if (canary !== undefined) out[pos] = canary;
  });
  return out;
}

/**
 * The per-identity canary tag: `B-` + 6 hex chars of
 * HMAC-SHA256(secret, "canary-tag:" + identity). Deterministic
 * per (secret, identity); different identities get different
 * tags; the secret never leaves the host.
 */
export function canaryTagForIdentity(secret: string | Uint8Array, identity: string): string {
  if (typeof identity !== "string" || identity.length === 0) throw new CanaryDoseError("identity must be a non-empty string");
  return "B-" + rspHmacHex(secret, `canary-tag:${identity}`).slice(0, 6);
}

function tagTarget<T extends Record<string, unknown>>(record: T): Record<string, unknown> {
  const fields = record["fields"];
  if (fields && typeof fields === "object" && !Array.isArray(fields)) return fields as Record<string, unknown>;
  return record;
}

/**
 * Return a copy of `record` carrying the identity's canary tag.
 * Records shaped like the range's (`{..., fields: {...}}`) get
 * the tag inside `fields`; flat records get it at the top level.
 * The input is not mutated.
 */
export function applyCanaryTag<T extends Record<string, unknown>>(
  record: T,
  secret: string | Uint8Array,
  identity: string,
  field: string = DEFAULT_CANARY_TAG_FIELD,
): T {
  const tag = canaryTagForIdentity(secret, identity);
  const fields = record["fields"];
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    return { ...record, fields: { ...(fields as Record<string, unknown>), [field]: tag } };
  }
  return { ...record, [field]: tag };
}

/** True when the record carries exactly the tag expected for (secret, identity). */
export function verifyCanaryTag<T extends Record<string, unknown>>(
  record: T,
  secret: string | Uint8Array,
  identity: string,
  field: string = DEFAULT_CANARY_TAG_FIELD,
): boolean {
  const target = tagTarget(record);
  return target[field] === canaryTagForIdentity(secret, identity);
}

/**
 * Attribution: given an observed tag and the candidate
 * identities, return the identity the tag was minted for, or
 * null. This names the extracting identity IF a tagged copy is
 * observed - it is a forensic lookup, not a detection.
 */
export function identifyCanaryTag(
  tag: string,
  secret: string | Uint8Array,
  candidateIdentities: readonly string[],
): string | null {
  for (const identity of candidateIdentities) {
    if (canaryTagForIdentity(secret, identity) === tag) return identity;
  }
  return null;
}
