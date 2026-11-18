/**
 * RSP-12: Batch amplification capture (opt-in honeypot capture semantics).
 *
 * A batch request is captured as one row per CARRYING sub-request
 * (a sub-request carrying a user or a pass), while the response
 * envelope is sized from ALL sub-requests. Both counts cap at 25;
 * hitting the cap is reported on the result (the lab's cap event
 * went to the tracing log only - here it is a field on the result,
 * never an extra capture row). The envelope rides on row 1 only.
 * No recursion into nested envelopes.
 *
 * Measured in the RSP Step-0 lab: batch of 3 gives 3 rows; batches
 * of 30 and 50 cap at 25 rows with the cap logged; the split at 30
 * sub-requests with 3 carrying is 3 rows but 25 sub-responses.
 * Honeypot-surface only, advisory, low tier.
 */
export const RSP_BATCH_CAP = 25;

export interface RspBatchSubRequest { user?: string | null; pass?: string | null }

export interface RspBatchRow { index: number; user: string | null; pass: string | null; hasEnvelope: boolean }

export interface RspBatchResult {
  rows: RspBatchRow[];
  subResponseCount: number;
  capHit: boolean;
  registryRecords: number;
}

export function rspProcessBatch(subRequests: readonly RspBatchSubRequest[]): RspBatchResult {
  const carrying = subRequests.filter((s) => (s.user != null && s.user !== "") || (s.pass != null && s.pass !== ""));
  const rowCount = Math.min(carrying.length, RSP_BATCH_CAP);
  const subResponseCount = Math.min(subRequests.length, RSP_BATCH_CAP);
  const rows: RspBatchRow[] = carrying.slice(0, rowCount).map((s, i) => ({
    index: i + 1,
    user: s.user ?? null,
    pass: s.pass ?? null,
    hasEnvelope: i === 0,
  }));
  const registryRecords = carrying.slice(0, rowCount).filter((s) => s.user != null && s.user !== "" && s.pass != null && s.pass !== "").length;
  return {
    rows,
    subResponseCount,
    capHit: carrying.length > RSP_BATCH_CAP || subRequests.length > RSP_BATCH_CAP,
    registryRecords,
  };
}
