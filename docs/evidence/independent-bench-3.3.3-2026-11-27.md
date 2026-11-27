# Independent bench synthesis — @dannyphan190/anti-rea@3.3.3 (2026-11-27/28)

Synthesis of every independent test run against the published 3.3.3 package
reported to the maintainer on 2026-11-27/28. Package identity was verified in
each run that got past the identity gate: npm `dist.shasum`
`eb2c30ef3978acf55262ed8abd2e39d995d71b80`. No run modified the package source.

## How to read this document (limits first)

- The runs below used **different configurations and different attacker
  models**, so their numbers must not be merged into one headline. In
  particular: "FULL" in run R3 means *every public module switched on by the
  harness* (decoy/trap modules are opt-in and off by default); the
  bench-package runs (R1/R2) separate FULL-DEFAULT from FULL-DECOY; run R4
  measures the buyer side only and says nothing about scraping resistance.
- In two runs the **nominal model label was not the model that actually
  served**: the LiteLLM proxy geo-routed requests to other backends. Only the
  actually-served model is recorded below. Any earlier reference to these runs
  as "gpt-5.4 results" is incorrect.
- Several cells are **NOT MEASURED** because of infrastructure failure
  (rate limits, free-tier latency storms, tool-schema limits). NOT MEASURED
  is not a pass and not a fail.

## The runs

| Run | Attacker / driver | Model actually served | What was measured |
|---|---|---|---|
| R1 — bench package, Groq attempt | rea-agents 6.10.1 + agent hand | gpt-oss-120b (Groq) | FP only; all 24 attack cells VOID |
| R2 — bench package, LiteLLM attempt (38 cells, 4h02m, Node 24.22.3) | rea-agents 6.10.1 + agent hand | nvidia/nemotron-3-ultra-550b-a55b:free (330/378 calls); openai/qwen3.8-flash for the first 48 calls only | FP 6/6 cells; Poison in 1 cell; Block/Cost NOT MEASURED |
| R3 — independent eval (Antigravity harness, 70 logged sessions) | rea-agents 6.10.1, tool set filtered to 8 core web/API/evidence tools (full 263-tool schema exceeded the proxy backend limit) | DeepSeek-V4.1-Flash (all sessions; requests sent as `openai/gpt-5.4` were geo-routed by the proxy) | All four gates, FULL and FULL+VDF vs BASE |
| R4 — V2 buyer-journey run (240 browser sessions, zip `antiRea-3.3.3-V2`) | Scripted buyer journeys, no attacker | n/a (no LLM) | Buyer completion / checkout quotes under BASE vs README config vs SPLIT quota, HOME vs shared-IP NAT |

## Consolidated gate table

| Gate | R1 | R2 | R3 | R4 |
|---|---|---|---|---|
| False positives (legit users broken) | **PASS** — 0/120 sessions broken across 3 configs | **PASS** — 0/120 across 6 cells | **PASS** — 0/50 (25 per app); added latency +0.066 ms (catalog) / +0.116 ms (SPA) per request | **1 failing cell** — see below |
| Blocking (task success FULL vs BASE) | NOT MEASURED (cells VOID) | NOT MEASURED (BASE null / FULL cells voided) | **PASS** — BASE 70.0% (14/20) → FULL 0.0% (0/20); FULL+VDF also 0.0% | not measured (by design) |
| Poison (≥80% of harvested records are decoys) | NOT MEASURED | **FAIL** — SPA/FULL-DECOY 10% (135 real + 15 decoy per agent session; 0/5 agent and 0/5 REA sessions claimed ≥100 records) | **FAIL** — median 0.0%, mean 5.0% (only 1/20 FULL sessions harvested 120/120 decoys) | not measured (by design) |
| Cost (attacker cost FULL / BASE, registered bar ≥3.0x, reference ≥2.0x) | NOT MEASURED | NOT MEASURED (no USD pricing recorded) | **FAIL** — 0.837x tokens / 0.870x USD overall; 0.921x / 0.912x on VALID sessions only; FULL+VDF 1.093x tokens / 1.097x USD, still below both bars | not measured (by design) |

## Findings that converge across runs

1. **Detection/quota false positives are consistently zero** in every
   attacker-bench run (0 broken legit sessions out of 120 + 120 + 50).
   The one real legit-user failure found anywhere is configuration-shaped,
   not detection-shaped: in R4, the SPA behind a **shared NAT IP with the
   README's single shared quota bucket** completed only 17/20 buyer flows
   and 12/15 checkout quotes (3 blocked users, 1 checkout HTTP 429).
   Splitting the checkout bucket from the read bucket (SPLIT, same limits)
   restored 20/20 flows and 15/15 quotes in every cell. The catalog app was
   unaffected in all configurations.
2. **Blocking, where it was cleanly measured (R3), worked — but not via
   decoys.** FULL drove task success to 0% mainly through invariant /
   self-verification traps (attackers reported totals of 2,040 instead of
   2,000 and 180 instead of 150, and learned decoy shipping rules, scoring
   3–7/10 vs 10/10 at BASE) and through quota/record-budget cuts that ended
   sessions early with 0–50 records.
3. **Poison failed in both runs that measured it, for different reasons.**
   In R3 the early session cuts starved decoy uptake (median 0%). In R2's
   SPA/FULL-DECOY cell, sessions ran but the decoy surface barely entered
   the served records (10%). This contradicts serving-level smoke checks in
   which decoy records were served in volume; whether the gap is in serving
   or in what agents choose to harvest is unresolved and is the first thing
   a re-run must instrument (served-decoy vs harvested-decoy as separate
   numbers).
4. **Cost failed wherever it was measured** (R3: below 1.0x overall; VDF
   raised it only to ~1.1x). This is consistent with 3.3.3's own release
   position: the cost gate failed at ship time, and 3.3.3 claims
   poison-the-map / break-the-task, never a cost tax. Note R3's VDF added
   13.5 s (catalog) / 13.3 s (SPA) of client compute for legit users across
   its 3 gates in that harness's configuration.
5. **Model-label integrity is a bench requirement, not a detail.** R2's
   nominal model served only the first 48 calls before its free quota was
   exhausted; the remaining 330 calls were served by a different model. R3's
   requested model was geo-blocked and silently substituted. Served-model
   headers must be logged per session and reported, as both runs ultimately
   did.
6. **Infrastructure, not the package, killed most cells.** R1: Groq
   8,000-token/min ceiling and a 128-tool limit vs REA's 263 tools. R2: a
   free-tier latency storm (9 consecutive calls >300 s, max 453.9 s,
   16:02–16:44Z) voided the catalog FULL cells under the
   two-voids-stop-replacements discipline, and REA sessions died in a
   `capture_browser_scenario` loop at the 30-minute cap. R3: 12
   FAILED_SESSION results from proxy HTTP 429s, which zeroed the medians of
   two cells. REA's token profile also matters for cost accounting: ~165k
   input tokens per turn (263-tool schema plus ~14 KB tool logs), an
   input/output ratio ~8x the agent hand's (R2 totals: 17,726,306 in /
   130,019 out).

## What these runs do NOT prove

- Nothing about the real `openai/gpt-5.4` as an attacker (never served).
- Nothing about REA with its full 263-tool set (R3 filtered to 8 tools;
  R1/R2 could not complete REA cells).
- Nothing about the out-of-the-box default configuration as an anti-scraping
  posture in R3 (its FULL had every opt-in module on); R2's FULL-DEFAULT
  attack cells were voided.
- Nothing at production scale or against adaptive, distributed, long-horizon
  attackers: 2 synthetic lab apps on localhost, 5 sessions per cell, single
  loopback identity, 20-action session caps.
- R4 proves nothing about scraping resistance, and its checkout is a quote
  step, not a paid transaction.

## Registered recommendations for the next run

1. Run on a paid, stable model with p95 call latency <120 s; add a fail-fast
   router at 120 s so one slow call cannot cascade VOIDs across a cell.
2. Keep the three columns separate — BASE / FULL-DEFAULT / FULL-DECOY — and
   never merge them.
3. Instrument served-decoy and harvested-decoy as separate metrics to close
   the poison question in finding 3.
4. Document the SPLIT quota layout (checkout bucket separate from read
   bucket) as the recommended configuration for shared-IP audiences, based
   on R4.
5. Log the served model per session from response headers and print it in
   the report header.
