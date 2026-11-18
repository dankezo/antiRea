/**
 * Header anomaly checks (NHS-06, antiRea 3.1.0).
 *
 * WHAT IT IS. Four structural header checks from sentinel_header.c,
 * evaluated in source order with FIRST MATCH winning: the result
 * names the single firing check, or 0 when none fires.
 *   1: HTTP version exactly 1.1 and no Host header
 *   2: Content-Length and Transfer-Encoding both present
 *   3: more than one Host header (name count is case-insensitive)
 *   4: User-Agent absent AND no Accept header
 * Header input is an ordered name/value pair list, because check 3
 * is about DUPLICATED names, which a record-shaped header map
 * cannot express.
 *
 * RECORDED GAP (documented, not fixed): an HTTP/2 request without a
 * Host header does NOT fire check 1 - the source compares the
 * version to 1.1 exactly. HTTP/1.0 without Host does not fire it
 * either, and a request carrying Accept but no User-Agent does not
 * fire check 4; both exceptions are part of the frozen semantics.
 *
 * Advisory only (enforcement: "none"): an anomaly is a malformed or
 * unusual request shape, an investigation signal, never by itself
 * proof of malice and never a sole blocking key.
 *
 * LAB EVIDENCE (Step-0, nhs-lab/nhs06.cjs, RESULTS-NHS-STEP0.md).
 * Each single-violation row fires exactly its own check (1, 2, 3, 4);
 * clean rows fire 0; the double-violation row fires check 1 only
 * (first match); the HTTP/2 gap above is the lab's descriptive row.
 */

export type HeaderAnomalyCheck = 0 | 1 | 2 | 3 | 4;

export const HEADER_ANOMALY_NAMES: Readonly<Record<Exclude<HeaderAnomalyCheck, 0>, string>> = Object.freeze({
  1: "http11_without_host",
  2: "content_length_and_transfer_encoding",
  3: "duplicate_host",
  4: "no_user_agent_no_accept",
});

export interface HeaderAnomalyRequest {
  /** HTTP version as a number (1.0, 1.1, 2). Compared exactly for check 1. */
  httpVersion: number;
  /** Header name/value pairs in wire order; duplicates are meaningful. */
  headers: ReadonlyArray<readonly [string, string]>;
}

export interface HeaderAnomalyResult {
  kind: "header_anomaly";
  /** The firing check id, or 0 when no check fires. */
  check: HeaderAnomalyCheck;
  /** The firing check's name, or null when check is 0. */
  name: string | null;
  flagged: boolean;
  /** Always "none": this module enforces nothing. */
  enforcement: "none";
}

/** Run the four NHS-06 anomaly checks on one request. Pure, no state. */
export function analyzeHeaderAnomaly(request: HeaderAnomalyRequest): HeaderAnomalyResult {
  const names = (request.headers ?? []).map(([n]) => String(n).toLowerCase());
  const count = (n: string): number => names.filter((x) => x === n).length;
  const has = (n: string): boolean => count(n) > 0;

  let check: HeaderAnomalyCheck = 0;
  if (request.httpVersion === 1.1 && !has("host")) check = 1;
  else if (has("content-length") && has("transfer-encoding")) check = 2;
  else if (count("host") > 1) check = 3;
  else if (!has("user-agent") && count("accept") === 0) check = 4;

  return {
    kind: "header_anomaly",
    check,
    name: check === 0 ? null : (HEADER_ANOMALY_NAMES[check] ?? null),
    flagged: check !== 0,
    enforcement: "none",
  };
}
