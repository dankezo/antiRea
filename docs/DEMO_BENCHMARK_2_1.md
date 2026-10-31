# v2.1 Twin-SaaS benchmark: a test you can reproduce

Status (2026-10-31): **HTTP/server integration tests passed locally. Playwright attempted but failed before rendering due to environment-level Chromium navigation policy (`ERR_BLOCKED_BY_ADMINISTRATOR`) on both variants, including `data:` URLs. REA binary not available in this environment; REA measurements are NOT claimed.** The attempted Playwright evidence is stored in `benchmark/results/browser.json`. The browser harness and independent workflow are ready for execution on a machine where navigation is enabled.

## Why use our own twin demo instead of probing public SaaS sites?

A/B results only make sense when the app, tasks, sample data, viewports and server capabilities are equal. Northstar is a synthetic account-management dashboard under `benchmark/demo/`, deliberately designed as a substantial but controlled UI: summary metrics, charts, customer-table search, navigation, request creation, CSV export, a modal and responsive styles.

**Baseline** `http://127.0.0.1:4173`: no antiRea imports, canary alerts, or export quota.

**Protected** `http://127.0.0.1:4174`: same public UI and business data, plus the *actual compiled source* of `src/tier1-passive/dom-poison.ts`, `src/tier4-forensic/watermark.ts`, and `src/tier2-active/cdp-guard.ts`; `handleCanaryTrapRequest` handles a path canary and server-side quota limits CSV export to 4 per 60 seconds; strict demo CSP prevents third-party script execution and embedding. The protected demo displays a low-opacity, short-lived opaque attribution token.

**Fairness caveat:** export rate-limiting is a **server-side** anti-abuse control, not a feature of the published 2.1 antiRea library. We demonstrate it as a documented production pattern, not misattribute it to a client guard. The customer-facing business functions are intentionally identical at normal usage rates. The protected version intentionally exposes additional SDK scripts; that is **extra**, not hidden, client-side code.

A static visual preview is committed at `benchmark/demo/preview.png`, rendered by Chromium with fixture DOM and inline CSS, **not** the HTTP E2E test. No real users/accounts/secrets. Synthetic static fixtures. The benchmark reset endpoint is for local tests only and must not be deployed on a production domain.

## Quick run

```sh
npm install
npm run build
npm run benchmark:build-sdk
python -m pip install playwright
python -m playwright install chromium firefox webkit
python benchmark/run_all.py --browsers chromium,firefox,webkit --iterations 5
```

This starts both local servers, runs the same browser workflow twice per engine, records screenshots and JSON under `benchmark/results`, and generates `REPORT.md` from the *actual* evidence. When browsers are missing, the report marks them skipped. If a tested scenario fails, the process exits nonzero. Browser samples are exploratory and cannot support production latency guarantees.

Manual alternative:

```sh
npm run benchmark:baseline  # terminal 1
npm run benchmark:demo      # terminal 2
# Open the two localhost origins in browsers; use a fresh profile for each.
```

## What is measured and what is not

- `summary`, `search`, `navigation`, `new request`, `CSV export`, keyboard-focus check: functional parity.
- `DOM node count`, `script paths`, `accessible landmarks`, `browser page errors`: observable browser structure. Protection of these is **not** expected; their continued visibility is a test result.
- `GET /api/v1/internal/schema-export`: exact known canary path. Confirm server recorded an alert *only* on protected. This is a **forced test probe**, not evidence of tool discovering a decoy autonomously.
- 6 repeated exports: rate-limit HTTP statuses, not an estimate of all scraping resistance.
- 3+ fresh navigations: coarse load time only; no remote-vs-local comparison, confidence interval, p95, or stable environment.
- `REA` captures: only when operator independently installs and runs official CLI (see `benchmark/rea/README.md`). The Playwright runner is not a REA replacement.
- No autonomous clone attempts, no infringement classification, no screenshot watermark resilience test. Use the separate independent-reconstruction rubric if you want efficacy claims.

## Valid criteria for community contribution

Publish raw evidence JSON, versions, command lines, environment details, failures/skips and provenance. Mark any claims `measured`, `derived`, `hypothesis`, or `not tested`. No "unclonable", "100% blocked", or false positive percentages from nonrepresentative fixture samples.

## References

- REA actual browser observation, flags, and completeness: https://github.com/morluto/rea/blob/main/docs/browser-observation.md
- Playwright browser installation: https://playwright.dev/python/docs/browsers
- OWASP's scraping-oriented risk classification and server controls: https://owasp.org/www-project-automated-threats-to-web-applications/
- Benchmark third-party options: [TARGETS](TARGETS.md)
