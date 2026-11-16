# antiRea 2.9.2 audit evidence

Release prepared on 2026-11-14, Asia/Bangkok. Numerical audit runs below executed on 2026-11-13. All attack and false-positive populations are seeded synthetic data unless a row explicitly says real HTTP. They are not production traffic.

## Verification and limits

- Full suite: 963 tests, 960 pass, 0 fail, 3 skips on native Windows. Baseline on this machine: 890 tests, 887 pass, 3 skips. Added: 73 tests. Two skips are the existing RSA-PSS profile exclusions; one needs Windows symlink privileges.
- Full checks also passed on Node 20.20.2 and LTS 26.13.1. A strict consumer references all 205 public runtime exports. CJS and ESM smoke passed. Deno 2.9.8 exercised three factories through the local shim with an explicit candidate mapping and CommonJS named-export adapter; this is not registry verification.
- Hand-made mutation catalog: 252 mutants across seven modules, at least 34 per module. Tests killed 251; the remaining D2 mutant is equivalent because observe already excludes its branch. No meaningful survivor remains. Raw manifests and controls are in audit-evidence/.
- 402 response shape: 1,000 exact JSON comparisons. Frozen declaration pure-chain vectors: 200 entries, 200 tamper rejections, plus 5,000 seeded append/import operations. SDK hash payload and earliest-inclusive predates semantics intentionally generalize the lab; they are not byte-identical chain formats.
- Volume rank: 4,480 comparisons reproduce rank/flag outputs and MID detection 0.90/0.85/0.85. Lab generator-component strata differ from SDK volume-derived strata. The latter has HIGH 1/115 false flags at kappa 1000, so the historical 0.007 per-stratum bound does not transfer.
- EMP: arithmetic matches 65 frozen curve points. Hold-type: 90 recorded sessions, 450 feature and 270 score comparisons match exactly for valid sessions.
- D2: the original estimator matches on 25 independent fixtures and 5,925 ticks. Original registered seed streams remain NOT VERIFIED: the bundle omits roomguard-lab dependencies. EMP full generation and the full declaration/watermark experiment also have missing dependencies. (Resolution, 2026-11-16: the dependencies were located in the study tree and all three were reproduced exactly in the Phase 1 reruns - D2 seed streams, EMP full generation, and the full declaration/watermark experiment, canonical hash 079b0033...; see the amendment at the end of this summary.)
- Older room and seat signals: 2,480 outputs per module agree with the prior estimators on independent valid fixtures, apart from new diagnostic fields. Capacity overflow, future account creation, activity retention and non-progressing float tick loops now have executable regressions.

## Performance methodology

Windows x64, Node 24.19.0, AMD Ryzen 7 H 255, 16 logical CPUs, 33,580,437,504 bytes RAM. Five fresh sequential processes per microbenchmark. Ownership includes 100,000 verdict-returning touches after 2,000 warmup touches; verdict latency is an average over 10,000 reads per run. Declaration verifies an in-memory 10,000-entry chain. Payload construction and module loading are outside the surface-scan timers.

| Metric | Measured median | Scope |
|---|---|---|
| Ownership 100,000 touches | 128.3943 ms | Baseline same-machine 118.6079 ms; intermediate hardening 294.8996 ms before descriptor-allocation optimization |
| Ownership verdict read | 0.00046952 ms | Per-read average, then median across processes |
| Declaration verify, 10,000 entries | 39.667 ms | Whole verification |
| Surface 100,000 fields, default cap | 42.5796 ms | truncated=true; same-method original module 42.6875 ms; historical VM claim was 36 ms |
| Surface complete 100,000-field scan | 116.3217 ms | maxScanNodes=200001, truncated=false; a different workload from the capped claim |
| Full npm run check | 12.0906062 s | Median of five successful fresh commands, includes compilation and static audit |
| dist | 124 files, 1,632,577 bytes | Rebuilt source artifact |

## Decisions

The preregistered FAST-only D2 candidate reduced flags in an independent synthetic lurker family from 53/512 to 3/512, but lost the minority attack cell from 512/512 to 0/512. It failed the declared gates and was not shipped. The inherited law therefore retains a measured thin-margin limitation; this audit does not certify it as production-safe.

RECOMB-03 remains unbuilt. A new independent pair experiment, explicitly not the missing original lineage gate, detected all 1,250 bulk attackers under both pairs but left review-team false flags between 16.3% and 85.8% across legs/replicates. All five replicates failed the preregistered persona gate. No frozen threshold was retuned.

## Reproduction map

The owner-delivered evidence archive contains:

- audit-evidence/parity-log-402/: original shape and chain probes, property tests, 68 mutation receipts.
- audit-evidence/parity-volume-emp/: frozen R04 rerun, 65 EMP points and 70 mutation receipts.
- audit-evidence/parity-d2-hold/: valid-session parity and 77 mutation receipts, including the equivalent D2 case.
- audit-evidence/ownership-mutation-results.json and ownership-mutants/: 37 isolated mutation receipts.
- audit-evidence/runtime-smoke/: strict consumer, final Node 20/26 checks, CJS/ESM/Deno and README smoke logs.
- audit-evidence/benchmark-*.json: raw five-run timings, hardware and methods.
- audit-evidence/claims.csv: quantitative-claim inventory, including explicit NOT VERIFIED rows.
- antirea-study-2026-11-01/overnight-2026-11-02/audit292-d2-margin-lab/: registration before measurement, runner and raw results.
- audit-evidence/audit-292-recomb03/: independent pair registration, runner and raw results.

Full mandatory release gate, packaging and publication receipts are recorded in the release sweep. An authenticated channel being available is not evidence that a publication happened.

## Amendment (2026-11-16, Phase 1 audit close-out)

This summary's NOT VERIFIED marks were revisited in the Phase 1 audit reruns (study record: PHASE1-SLICE2-2026-11-16 in the study tree). The generators the bundle lacked were located in the study tree, and the four claim areas behind the marks were reproduced exactly: B1 D2 original seed streams (fast +690 s, DELAY-300 +960 s, drip +1440 s, lurker d2maxRatio 0.3333); B2 EMP full population (h_b_emp = 0.36 at every contamination level); B3 declaration/watermark full experiment (531/531 harness-v2 validation leaves identical; canonical hash 079b0033...); B4 RECOMB-03 lineage numbers (emp pair novel30 >= 1508 and total30 >= 2522). RECOMB-03 remains UNBUILT in the SDK; its pin side is superseded by the farm track (FC-01R/FC-02R/FC-06 KILL for the (novel, total) forms; FC-07 PASS-LAB-WITH-COST).

The `audit-evidence/claims.csv` inventory referenced above was hunted for and NOT recovered: it is absent from every local tree and bundle checked and from the GitHub repo (code search, path lookups on main, tags v2.9.2 and v2.9.3, and branch badges, plus commit search, all returned nothing). It existed only in the owner-delivered evidence archive, which was never committed. The residual NOT VERIFIED material is therefore exactly: claims.csv rows beyond B1-B5; the independent RECOMB-03 pair-experiment receipts (audit-evidence/audit-292-recomb03/); the raw receipts behind the 252-mutant catalog, parity and runtime-smoke statements; and the audit292-d2-margin-lab raw runner. The reference to claims.csv above is retained as the historical record of what the 2.9.2 audit used.
