"use strict";
/*
 * Verification for the declared-cohort union budget pattern.
 *
 * Simulates a minimal host serving path - a per-identity record budget
 * (150 distinct / 24 h) PLUS the pattern wiring from
 * declared-cohort-budget.cjs - over a 500-record dataset, and checks
 * the three registered cells:
 *
 *   S1 declared herd: 4 declared identities, disjoint ranges, pages of
 *      50 (the burst shape measured on the antirea-range prototype,
 *      2026-11-13). The cohort union must stop at exactly 150 distinct
 *      records; the remaining members get cohort refusals, not
 *      per-identity ones.
 *   S2 undeclared herd: identical traffic, no declaration. Nothing
 *      changes: the herd takes all 500 records. The pattern is
 *      declaration-gated by design (hard ceilings are lawful only for
 *      cohorts the host itself declares).
 *   S3 declared solo: a cohort of one behaves exactly like its
 *      per-identity budget - 150 served, never refused earlier.
 *
 * Run: node verify.cjs   (exit 0 = PASS, 1 = FAIL)
 */
const path = require("node:path");
const sdk = require(path.resolve(__dirname, "..", "..", "dist", "index.js"));
const { createDeclaredCohortBudgets } = require("./declared-cohort-budget.cjs");

const RECORDS = Array.from({ length: 500 }, (_, i) => `rec-${String(i + 1).padStart(4, "0")}`);
const PAGE = 50;
const BUDGET = 150;

function makeHost(declarations) {
  const personalById = new Map();
  const cohorts = createDeclaredCohortBudgets(sdk, declarations);
  const per = (identity) => {
    if (!personalById.has(identity)) {
      personalById.set(identity, sdk.createRecordBudget({ maxDistinctPerWindow: BUDGET, windowMs: 86_400_000 }));
    }
    return personalById.get(identity);
  };
  return {
    servePage(identity, offset) {
      const mine = per(identity);
      if (!mine.check(identity, PAGE).allowed) return { status: 429, error: "record_budget_exceeded" };
      const gate = cohorts.gate(identity, PAGE);
      if (!gate.allowed) return { status: 429, error: "cohort_budget_exceeded" };
      const ids = RECORDS.slice(offset, offset + PAGE);
      mine.consume(identity, ids);
      cohorts.consume(identity, ids);
      return { status: 200, ids };
    },
  };
}

function herdRun(declarations) {
  const host = makeHost(declarations);
  const seen = new Set();
  const perIdentity = {};
  let cohort429 = 0;
  let personal429 = 0;
  const plan = [
    ["herd-0", [0, 50, 100]],
    ["herd-1", [150, 200, 250]],
    ["herd-2", [300, 350, 400]],
    ["herd-3", [450]],
  ];
  for (const [identity, offsets] of plan) {
    perIdentity[identity] = 0;
    for (const offset of offsets) {
      const r = host.servePage(identity, offset);
      if (r.status === 200) {
        for (const id of r.ids) {
          if (!seen.has(id)) {
            seen.add(id);
            perIdentity[identity]++;
          }
        }
      } else if (r.error === "cohort_budget_exceeded") cohort429++;
      else if (r.error === "record_budget_exceeded") personal429++;
    }
  }
  return { distinct: seen.size, perIdentity, cohort429, personal429 };
}

let failures = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " - " + detail : ""}`);
  if (!cond) failures++;
};

// S1: declared herd stops at the union ceiling.
{
  const r = herdRun([{ id: "team", ceiling: 150, members: ["herd-0", "herd-1", "herd-2", "herd-3"] }]);
  ok("S1 declared herd union stops at exactly 150", r.distinct === 150, `distinct=${r.distinct}`);
  ok("S1 first member served its 150, the rest 0", r.perIdentity["herd-0"] === 150 && r.perIdentity["herd-1"] === 0 && r.perIdentity["herd-2"] === 0 && r.perIdentity["herd-3"] === 0, JSON.stringify(r.perIdentity));
  ok("S1 refusals are cohort refusals (7), none personal", r.cohort429 === 7 && r.personal429 === 0, `cohort429=${r.cohort429} personal429=${r.personal429}`);
}
// S2: undeclared herd is untouched by the pattern.
{
  const r = herdRun([]);
  ok("S2 undeclared herd takes all 500 (declaration-gated)", r.distinct === 500 && r.cohort429 === 0, `distinct=${r.distinct} cohort429=${r.cohort429}`);
}
// S3: a declared cohort of one equals its per-identity budget.
{
  const host = makeHost([{ id: "solo-team", ceiling: 150, members: ["solo"] }]);
  let served = 0;
  let first429At = null;
  for (const offset of [0, 50, 100, 150]) {
    const r = host.servePage("solo", offset);
    if (r.status === 200) served += r.ids.length;
    else if (first429At === null) first429At = offset;
  }
  ok("S3 declared solo serves exactly 150, refused only at the 4th page", served === 150 && first429At === 150, `served=${served} first429At=${first429At}`);
}

console.log(failures === 0 ? "\nVERIFY: PASS" : `\nVERIFY: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
