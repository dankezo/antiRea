# antiRea 2.1 — Browser benchmark evidence

Generated: 2026-10-31T02:44:02.300302+00:00

> **Scope:** controlled twin-SaaS lab only. This is NOT a measurement of REA defeating/being defeated or protection from independent clones.

| Engine | Mode | Functional/fixture assertions | Median load (ms) | Export HTTP statuses | JS errors |
|---|---|---:|---:|---|---|
| chromium | baseline | ERROR | — | — | Page.goto: net::ERR_BLOCKED_BY_ADMINISTRATOR at http://127.0.0.1:4173/ |
| chromium | protected | ERROR | — | — | Page.goto: net::ERR_BLOCKED_BY_ADMINISTRATOR at http://127.0.0.1:4174/ |

## Metric interpretations

- Server export limit: A `429` means the controlled benchmark server enforced an export threshold. It does not mean the browser UI/API is unobservable.
- Canary: an event proves a canary path was requested in this test; never infer malicious intent solely from the event.
- Browser timing: small local samples, no confidence intervals, uncontrolled system noise. Do not compare speed percentages from this run.
- Public DOM and network: expected to remain visible even in protected mode. Watermarks are removable, not a clone blocker.
- Strongest controls remain server authorization, business logic isolation, signed asset delivery, and properly scoped rate limiting.

## Checks

## Missing evidence

- REA live capture: see `benchmark/rea/README.md`; NOT run automatically by this Playwright script.
- External sites: not tested; use only owned/self-hosted fixtures.
- Threat actor cloning success: not tested; controlled independent reconstruction experiment required.

