"use strict";
/*
 * Declared-cohort union budget - the wiring pattern, as copy-and-adapt
 * example material (not an SDK export).
 *
 * The pattern in one sentence: give every cohort the HOST declares ONE
 * shipped `createRecordBudget` keyed by the cohort id, so all members
 * draw from the same distinct-record union and rotating identities
 * inside a declared cohort no longer dilutes the cap.
 *
 * Why this is an example and not a new SDK module:
 * 1. It adds no capability over the shipped primitive - a wrapper API
 *    would be a second name for the same counting, with its own tests,
 *    docs and deprecation surface to maintain forever.
 * 2. The bundled budget store is single-process in-memory. A named
 *    helper would invite horizontally scaled hosts to mistake it for
 *    the production ceiling; the scaled path already ships as
 *    `createDisclosureLedger` (reserveDisclosure over a transactional
 *    store) and the declared campaign ceiling of `createCusumTripwire`.
 *    This pattern is the right tool for single-process hosts and for
 *    prototyping the declaration itself.
 *
 * The declaration is HOST configuration, resolved server-side from the
 * host's own account data - never from client input. A client-chosen
 * cohort lets an attacker simply not declare, or declare into a
 * victim's cohort.
 *
 * Usage (host serving path, per record-bearing response):
 *   const cohorts = createDeclaredCohortBudgets(require("@dannyphan190/anti-rea"), [
 *     { id: "partner-acme", members: ["acct-1", "acct-2"], ceiling: 150 },
 *   ]);
 *   const gate = cohorts.gate(identity, pageSize);   // before serving
 *   if (!gate.allowed) -> 429
 *   serve...
 *   cohorts.consume(identity, servedRecordIds);       // after serving
 *   // exports: cohorts.consume(identity, ids, true) with gate(identity, totalRows)
 */
function createDeclaredCohortBudgets(sdk, declarations, options = {}) {
  if (!sdk || typeof sdk.createRecordBudget !== "function") {
    throw new TypeError("createDeclaredCohortBudgets: sdk.createRecordBudget is required");
  }
  const windowMs = options.windowMs ?? 86_400_000;
  const budgets = new Map(); // cohortId -> budget instance
  const cohortOf = new Map(); // identity -> cohortId
  for (const d of declarations || []) {
    if (!d || typeof d.id !== "string" || !Array.isArray(d.members)) {
      throw new TypeError("createDeclaredCohortBudgets: each declaration needs { id: string, members: string[] }");
    }
    const ceiling = d.ceiling ?? options.ceiling ?? 150;
    budgets.set(d.id, sdk.createRecordBudget({ maxDistinctPerWindow: ceiling, windowMs }));
    for (const m of d.members) cohortOf.set(String(m), d.id);
  }
  return {
    cohortOf: (identity) => cohortOf.get(String(identity)) ?? null,
    gate(identity, additionalCount) {
      const cid = cohortOf.get(String(identity));
      if (!cid) return { cohort: null, allowed: true, usage: null };
      const usage = budgets.get(cid).check(cid, additionalCount);
      return { cohort: cid, allowed: usage.allowed, usage };
    },
    consume(identity, recordIds, exported = false) {
      const cid = cohortOf.get(String(identity));
      if (!cid) return;
      const b = budgets.get(cid);
      if (exported) b.consumeExported(cid, recordIds);
      else b.consume(cid, recordIds);
    },
    usage(identity) {
      const cid = cohortOf.get(String(identity));
      if (!cid) return null;
      return { cohort: cid, ...budgets.get(cid).check(cid) };
    },
  };
}

module.exports = { createDeclaredCohortBudgets };
