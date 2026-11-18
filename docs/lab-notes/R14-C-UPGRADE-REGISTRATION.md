# R14-C (CALNULL-C) UPGRADE - REGISTRATION (frozen before any number of this run)

Status: FROZEN before any measurement of the upgraded
mechanism. Written 2026-11-18 for the antiRea 3.1.0 build
program, item R14-C. Danny's decision of 2026-11-18: every
unbuilt PASS-LAB candidate gets a genuine build or upgrade
attempt; measured FP and effectiveness decide; no locked bar
is loosened.

## 0. Background on record (from the lab files, not from memory)

Branch C (R14-BRANCH-C-REGISTRATION.md, results in
R14-RESULTS-BRANCH-C.md): the module collects its own
bootstrap-window traffic as its reference population R (11
forests, 528 rows in the harness), freezes R, trims 10% of R
by distance to the medoid, calibrates once from the trimmed,
rank-flattened, permuted R, and scores later populations at
the frozen h_b.

- Main gates: PASS all 4 - CLEAN ARI 0.907, FLAT FMR 1.837%,
  EV-MERGE 0.704, EV-SWITCH 0.668, h_b = 0.40 in all 4 cells.
- 20% contamination cell: FAIL under the literal all-4-gates
  reading - the poisoned R selected h_b = 0.44 and FLAT FMR
  was 2.948% against the 2% bar (CLEAN 0.901, EV-MERGE 0.661,
  EV-SWITCH 0.698 still passed). Verdict: ADVISORY-CONTINUE.
- Contamination curve (R14-RESULTS-CONTAMINATION-CURVE.md):
  tolerance bracket [5%, 10%). At 10%, 20% and 30% the same
  single gate breaks (FLAT), by the same mechanism.
- Trim audit (branch-c-trim-audit): of the 53 rows the
  medoid-distance trim dropped, only 11 were bot rows (20.8%,
  exactly the base rate). 99 of 110 bot rows survived into the
  trimmed reference. The registered trim is blind to this
  contamination shape.
- The threshold-law half of branch C already shipped
  separately as RECOMB-05 selectEmpMixThreshold. It is not
  rebuilt here. The host-supplies-reference variant (branch
  B) stays rejected at the product level and is not
  resurrected.

## 1. Measured failure mechanism the upgrade must answer

Bot rows in the registered poison cell are independent flat
draws. Mixed into R they flatten its marginals, so the
calibration FMR curve of the poisoned R sits slightly BELOW
the clean curve - at h = 0.44 by only about 0.0005 across the
1% selection line (curve run: clean-equivalent 0.01036 at 5%
vs 0.00986 at 10%). That noise-scale dip flips h_b one grid
step (0.40 to 0.44), and at 0.44 flat populations over-merge
(FMR 2.85% to 2.95%). The partition machinery is not damaged
(CLEAN ARI under poisoned calibration stayed 0.901); the
reference's contamination moves the SELECTED THRESHOLD.

Medoid-distance trimming cannot see these rows: an independent
draw sits at a typical distance from the medoid, so it is
trimmed at the base rate. What separates a flat bot row from
a structured row is LOCAL: a structured row has lineage
siblings at lab distance about 0.2 to 0.3, while an
independent row's nearest neighbours are other independent
draws at about 0.55 to 0.65 (the independent-pair distance on
the lab metric: about 6 of 8 categorical traits differ plus
about 1.32 of numeric mass, over 12).

## 2. The ONE change (reference trimming only)

Replace the registered trim (drop 10% farthest from the
medoid) with an ISOLATION TRIM:

- isolation(row) = mean lab distance from the row to its 5
  nearest OTHER rows in R, computed on raw rows with the
  module's distance.
- Drop Math.round(0.25 * |R|) rows with the largest
  isolation. Boundary ties: lower original index is dropped
  first (mirroring branch C's tie handling). Kept rows retain
  their original order. R is otherwise used exactly as
  branch C used the trimmed reference.

The 25% fraction is locked here, before numbers: it is the
registered contamination level (20%) plus 5 points of slack
for imperfect targeting. The neighbour count 5 is locked
here: large enough to average out one lucky near neighbour,
small enough that a lineage of 8 siblings still reads as
locally dense. Neither number is tuned after seeing results.

## 3. NOT touched (verbatim from branch C)

- Window: closes when BOTH (a) at least 7 days since the
  module was enabled AND (b) at least 500 identities have
  been admitted to R. The time leg is production-only and
  unmeasurable in the harness (no time axis); the harness
  satisfies it with an injected clock and says so. R freezes
  at close; no online updates after close.
- Admission leg 2 (only identities touching no other signal
  during the window are admitted) remains a production-only
  control, unmeasured in the lab, and is not claimed by any
  number in this run.
- Null procedure on the trimmed R: rank-flatten (midrank,
  branch A procedure), then permutedRows; B = 40 nulls; seed
  = populationSeed(trimmed R raw rows); grid {0.08 ... 0.56}
  step 0.04; selection rule largest h with mean calibration
  FMR at most 1%.
- UPGMA average-linkage cut; lab distance; output contract
  (advisory only, enforcement "none", uncalibratable when no
  grid h earns the target; evaluate before close returns a
  structured not-ready result, never clusters).

## 4. Gates - ORIGINAL bars, all cells re-measured

Main cells (clean R, new trim), 40 scored forests per cell,
n = 48, pooled means:

| Cell | Bar |
|---|---|
| CLEAN ARI | >= 0.75 |
| HONEST-FLAT-48 FMR | <= 2% |
| EV-MERGE ARI | >= 0.50 |
| EV-SWITCH ARI | >= 0.50 |

Contamination cell: R built exactly as branch C registered
(rows 0..9 of each warm-up forest replaced by flat bot rows,
20%), calibrated with the new trim, and ALL FOUR gates
measured under that calibration on the registered scored
seeds (the literal reading branch C reported).

Build rule (from the task): the item is built only if the
20% cell passes all 4 gates AND the 4 main gates still hold.
Anything else: committed as EXCLUDED-AFTER-UPGRADE with the
full cell table. No second variant inside this registration.

## 5. Seeds - NEW family 20280xxx

Bounded grep over the study tree and the antirea-310 tree on
2026-11-18: 0 hits for 20280xxx. Allocation mirrors branch C
(i = 0..10 warm-up / bot, i = 0..39 scored):

- CLEAN warm-up 20280101 + i; CLEAN scored 20280151 + i
- FLAT warm-up 20280201 + i; FLAT scored 20280251 + i
- EV-MERGE warm-up 20280301 + i; EV-MERGE scored 20280351 + i
- EV-SWITCH warm-up 20280401 + i; EV-SWITCH scored 20280451 + i
- POISON warm-up base 20280501 + i; POISON bot source
  20280551 + i; POISON scored (CLEAN forests) 20280601 + i
- Poison diagnostic: the FLAT / EV-MERGE / EV-SWITCH scored
  seeds above, under the poisoned calibration (as branch C).

## 6. Honesty checks required in the run

1. Trim audit on the poisoned R: how many of the dropped rows
   are bot rows, against the 20.8% base rate and against the
   old trim's 11 of 53.
2. Cut equivalence: at the frozen h_b, the module's partition
   of each CLEAN scored forest must match the lab clusterAt
   partition at the same h (discordant pairs reported).
3. Determinism: closing the same R twice yields the same h_b
   and the same calibration curve.
4. All reported numbers come from the raw JSON of the run.

## 7. Blind spots declared before running

- Trimming 25% of a CLEAN reference removes its most isolated
  legitimate rows and biases calibration toward structure:
  the conservative direction for the FLAT gate, paid for in
  sensitivity. The main cells measure exactly this cost.
- The lab warm-up is fully structured (genForest). Real
  warm-up traffic mixes structured lineages with independent
  legitimate users, whose rows are locally isolated by
  nature; trimming them out of a CALIBRATION reference does
  not consequence them, but it does mean the reference is
  not a sample of real traffic. Unmeasured here.
- All numbers are simulation on synthetic lineages
  (harness-v2 substrate). No real bot population exists in
  this evidence. The 7-day leg and admission leg 2 are
  production parameters the lab cannot measure.
