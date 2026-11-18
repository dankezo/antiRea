# R14-v2b UPGRADE - REGISTRATION (frozen before any number of this run)

Status: FROZEN before any measurement of the upgraded mechanism.
Written 2026-11-18 for the antiRea 3.1.0 build program, item
R14-v2b. Danny's decision of 2026-11-18: every unbuilt PASS-LAB
candidate gets a genuine build or upgrade attempt; measured FP
and effectiveness decide; no locked bar is loosened.

## 0. Background on record (from the lab files, not from memory)

- Lab R14-v2b (flat empirical calibration, h_b = 0.32): PASS-lab.
  CLEAN ARI 0.768, HONEST-FLAT-48 FMR 0.532%, EV-MERGE 0.709,
  EV-SWITCH 0.540 (R14-RESULTS-V2.md; stability pooled CLEAN
  0.782, EV-SWITCH 0.532).
- SDK port (per-population trait-permutation null): FAILED its
  locked recheck (SDK-RECHECK-RESULTS.md): CLEAN ARI 0.622
  against the 0.75 bar, EV-SWITCH 0.439 against the 0.50 bar,
  EV-MERGE 0.527 and flat FMR 0.645% passed. Not shipped in
  2.7.2. The ledger's own next action: none without a new
  registration for the calibration step. This file is that
  registration.
- CALNULL branch A (rank-flattened marginals before
  permutation): FAIL on its own fresh seeds - CLEAN 0.702,
  EV-SWITCH 0.458 (R14-RESULTS-CALNULL.md). Branch B (host
  supplies a flat reference population): PASS on all 4 gates,
  but Danny rejected that contract at the product level on
  2026-11-05. Branch C is a separate item (R14-C).

## 1. Measured diagnosis the upgrade must answer

The port's cut is bit-identical to the lab's clusterAt at any
fixed h (0 discordant co-membership pairs in the recheck). The
failure is in the calibration null only:

- The lab null is a fresh flat population from the generator:
  categorical traits independent and uniform over 4 values,
  numeric traits independent and uniform on 0..100.
- The port null permutes the OBSERVED population's columns. On
  a structured population the categorical marginals are lumpy
  (mass concentrated on the 6 lineage roots), so two permuted
  rows collide on a categorical trait with probability sum(p^2),
  which is larger than the flat null's 0.25. Permuted rows sit
  closer together, calibration FMR at any h is higher, and the
  largest-h-with-FMR-at-most-1% rule picks h_b = 0.24 to 0.28
  instead of 0.32. Sensitivity pays: CLEAN and EV-SWITCH fall
  below their bars.
- Branch A rank-flattening cannot repair the categorical half
  by construction: midrank u preserves equality exactly (u is
  equal if and only if the original values are equal), so the
  categorical collision probability sum(p^2) survives it
  unchanged. Branch A fixed only the numeric half (expected
  absolute quantile difference about 1/3, matching the flat
  null) and moved CLEAN only from 0.658 to 0.702 on the same
  seeds.

## 2. The ONE change (calibration null construction only)

The calibration null is rebuilt so that BOTH halves match the
flat null's construction, while still deriving everything from
the observed population (self-contained; no host-supplied
reference - branch B stays rejected):

- Categorical traits (the first categoricalTraitCount traits):
  each null column is drawn i.i.d. uniform over the trait's
  OBSERVED DISTINCT VALUES (its support in this population),
  one draw per row. The lumpy empirical frequencies are NOT
  preserved; the support is.
- Numeric traits: branch A's procedure, kept verbatim - the
  column is mapped to midrank quantiles u, rescaled to
  u * numericScale, and the flattened column is permuted with
  Fisher-Yates.
- Consumption order (deterministic): one mulberry32 stream
  seeded by populationSeed(raw observed rows), exactly as the
  port derived it. For each null b = 0..B-1, traits are
  processed in ascending trait order; a categorical trait
  consumes n uniform draws (row order), a numeric trait
  consumes n-1 Fisher-Yates draws on the flattened column.
- Distance on null rows: the lab distance applied to the
  hybrid null row (categorical entries are drawn support
  values in the original encoding; numeric entries are
  flattened values on the numericScale). The merge-sequence /
  FMR machinery over the grid is the port's, unchanged.

Name: uniformized-marginal flat null (UM-null).

## 3. NOT touched (verbatim from the rechecked port)

- Distance on observed rows; the UPGMA average-linkage cut on
  the raw observed rows at h_b.
- Grid {0.08, 0.12, ..., 0.56} step 0.04; selection rule:
  largest grid h whose mean calibration FMR is at most 1%;
  B = 40 nulls.
- Output contract: advisory only, enforcement "none",
  status "uncalibratable" with h_b null and no clusters when
  no grid h earns the target. No fallback threshold.
- populationSeed (FNV-1a over IEEE-754 bits) and mulberry32.
- If the host supplies distanceFn, it is applied to hybrid
  null rows exactly as to observed rows; the UM construction
  still assumes the first categoricalTraitCount traits are
  the categorical ones. Declared here, not discovered later.

## 4. Gates - ORIGINAL bars, not loosened

Protocol: lab common.cjs verbatim (generator, ari(),
falseMergeRate()); 40 forests per cell, n = 48; every forest
self-calibrates through the built SDK module (dist) with
traits = [...cat, ...num]; pooled means against:

| Cell | Bar |
|---|---|
| CLEAN ARI (pooled mean) | >= 0.75 |
| HONEST-FLAT-48 FMR (pooled mean) | <= 2% |
| EV-MERGE ARI (pooled mean) | >= 0.50 |
| EV-SWITCH ARI (pooled mean) | >= 0.50 |

All four must pass for the item to be built as a normal item.
Any failure: the item is committed as EXCLUDED-AFTER-UPGRADE
with the measured table. No second mechanism variant is tried
inside this registration after seeing numbers.

## 5. Seeds - NEW family 20279xxx

Bounded grep (digit-boundary pattern) over the whole study
tree and the antirea-310 tree on 2026-11-18: 0 hits for
20279xxx (and for 20280xxx, reserved for R14-C). Allocation,
i = 0..39:

- CLEAN: 20279101 + i
- HONEST-FLAT-48: 20279201 + i (genForestFlat(seed, 48))
- EV-MERGE: 20279301 + i
- EV-SWITCH: 20279401 + i (scored on .leaves)

## 6. Honesty checks required in the run

1. Cut equivalence: at the h_b the module selects for each
   CLEAN forest, the module's partition must match the lab
   clusterAt partition at the same h (discordant co-membership
   pairs reported; expected 0 up to floating-point tie noise,
   any non-zero count is reported, not hidden).
2. Determinism: the same population evaluated twice yields
   byte-identical h_b and clusters.
3. All reported numbers come from the raw JSON of the run.

## 7. Blind spots declared before running

- Uniform-over-support is exactly right for the lab generator
  (flat categorical marginals ARE uniform over 4 values). A
  genuinely flat real population whose categorical marginal is
  naturally skewed would be under-calibrated by this null
  (calibration FMR underestimated, h_b too high, flat FMR
  risk). The HONEST-FLAT-48 cell guards this only inside the
  lab generator's world; real-traffic skew is unmeasured.
- A categorical trait with a single distinct value degenerates
  to a constant null column (no information, no error).
- All numbers are simulation on synthetic lineages with ground
  truth (harness-v2 substrate). No real bot population exists
  in this evidence; nothing here is a real-traffic rate.
