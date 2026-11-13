# Declared-cohort union budget - the pattern

A per-identity record budget has one structural dilution: an extractor
who rotates identities gets a fresh budget per identity. Four identities
with a 150-record budget each take a 500-record dataset in full - this
exact shape was measured live on the antirea-range test app (real
REA 6.9.0, 2026-11-12: 500/500 in about 15 s, export refused, single
identities capped exactly at 150).

The lawful hard answer is a **union budget over a cohort the host
declares**: the whole cohort shares one distinct-record ceiling,
however many identities it rotates through. Under this project's
tiering law, hard ceilings are reserved for host-declared cohorts -
behavior-inferred cohorts receive observation and step-up friction
only, never a hard cap - so the declaration is the host's own
authorization decision, made from its own account data.

## The pattern (no new API)

One shipped `createRecordBudget`, keyed by the cohort id instead of an
identity:

```js
const { createRecordBudget } = require("@dannyphan190/anti-rea");

// Host configuration, resolved server-side - NEVER from client input.
const cohortBudget = createRecordBudget({ maxDistinctPerWindow: 150, windowMs: 86_400_000 });
const COHORT_OF = { "acct-1": "partner-acme", "acct-2": "partner-acme" };

// In the serving path, next to the per-identity budget:
const cohort = COHORT_OF[identity];
if (cohort && !cohortBudget.check(cohort, pageSize).allowed) {
  return reply429("cohort_budget_exceeded");
}
// ...serve the page...
if (cohort) cohortBudget.consume(cohort, servedRecordIds);
```

`declared-cohort-budget.cjs` in this folder is that wiring packaged as
copy-and-adapt material for hosts with several cohorts, and
`verify.cjs` proves the three registered cells against the built SDK:

```sh
node verify.cjs
# S1 declared herd: union stops at exactly 150 of 500 (7 cohort refusals)
# S2 undeclared herd: untouched, takes all 500 - declaration-gated
# S3 declared solo member: exactly 150, never refused earlier
```

The same numbers were measured over real HTTP on the range prototype
that motivated the pattern (declared herd 150/500 with 7 cohort 429s;
undeclared 500/500; range release gate 6/6 PASS, 2026-11-13).

## Why this lives in `examples/` and is not an SDK export

1. **It adds no capability.** A `createCohortBudget` wrapper would be a
   second name for the shipped primitive's counting, with its own
   test, documentation and deprecation surface. What hosts were missing
   is the wiring knowledge, not code.
2. **The store is single-process.** The bundled record budget is
   in-memory; a named export would invite horizontally scaled hosts to
   mistake this pattern for the production ceiling. Scaled hosts
   already have the real path: `createDisclosureLedger`
   (`reserveDisclosure` over a transactional store - see
   `examples/sqlite-ledger-store/`) or the declared campaign ceiling
   of `createCusumTripwire` (`reserveServe`), both measured exact
   under concurrency. Use this pattern when one process serves the
   surface, or to prototype a declaration before wiring the ledger.

## Limits, stated plainly

- **Undeclared groups are invisible to it.** A rotation the host never
  declares keeps only its per-identity budgets; detecting it is the
  herd/CUSUM layers' job, and their consequences stay at the friction
  tier by law.
- **False positives are the declaration's own doing.** A legitimate
  team the host declares into one cohort shares the ceiling and will
  be refused when it is spent. Declare cohorts you mean - a whole
  user tier is not a cohort.
- **Declaration from client input voids the pattern.** If the caller
  can choose or omit its cohort, the ceiling is decorative.
