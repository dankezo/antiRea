# antiRea 2.1 — Browser benchmark evidence

Generated: 2026-11-13T15:07:47.731442+00:00

> **Scope:** controlled twin-SaaS lab only. This is NOT a measurement of REA defeating/being defeated or protection from independent clones.

| Engine | Mode | Functional/fixture assertions | Median load (ms) | Export HTTP statuses | JS errors |
|---|---|---:|---:|---|---|
| chromium | baseline | 12/12 | 672.1 | 200,200,200,200,200,200 | 0 |
| chromium | protected | 12/12 | 686.0 | 200,200,200,429,429,429 | 0 |
| firefox | baseline | 12/12 | 626.4 | 200,200,200,200,200,200 | 0 |
| firefox | protected | 12/12 | 673.9 | 200,200,200,429,429,429 | 0 |
| webkit | baseline | 12/12 | 632.0 | 200,200,200,200,200,200 | 0 |
| webkit | protected | 12/12 | 670.4 | 200,200,200,429,429,429 | 0 |

## Metric interpretations

- Server export limit: A `429` means the controlled benchmark server enforced an export threshold. It does not mean the browser UI/API is unobservable.
- Canary: an event proves a canary path was requested in this test; never infer malicious intent solely from the event.
- Browser timing: small local samples, no confidence intervals, uncontrolled system noise. Do not compare speed percentages from this run.
- Public DOM and network: expected to remain visible even in protected mode. Watermarks are removable, not a clone blocker.
- Strongest controls remain server authorization, business logic isolation, signed asset delivery, and properly scoped rate limiting.

## Checks

### chromium · baseline
- PASS: `initial_summary`
- PASS: `initial_accounts`
- PASS: `keyboard_accessible_search`
- PASS: `navigation`
- PASS: `search`
- PASS: `create_ticket`
- PASS: `export_download`
- PASS: `focus_search`
- PASS: `canary_returns_404`
- PASS: `rate_limit_protected`
- PASS: `canary_alert_protected`
- PASS: `public_content_remains_visible`

### chromium · protected
- PASS: `initial_summary`
- PASS: `initial_accounts`
- PASS: `keyboard_accessible_search`
- PASS: `navigation`
- PASS: `search`
- PASS: `create_ticket`
- PASS: `export_download`
- PASS: `focus_search`
- PASS: `canary_returns_404`
- PASS: `rate_limit_protected`
- PASS: `canary_alert_protected`
- PASS: `public_content_remains_visible`

### firefox · baseline
- PASS: `initial_summary`
- PASS: `initial_accounts`
- PASS: `keyboard_accessible_search`
- PASS: `navigation`
- PASS: `search`
- PASS: `create_ticket`
- PASS: `export_download`
- PASS: `focus_search`
- PASS: `canary_returns_404`
- PASS: `rate_limit_protected`
- PASS: `canary_alert_protected`
- PASS: `public_content_remains_visible`

### firefox · protected
- PASS: `initial_summary`
- PASS: `initial_accounts`
- PASS: `keyboard_accessible_search`
- PASS: `navigation`
- PASS: `search`
- PASS: `create_ticket`
- PASS: `export_download`
- PASS: `focus_search`
- PASS: `canary_returns_404`
- PASS: `rate_limit_protected`
- PASS: `canary_alert_protected`
- PASS: `public_content_remains_visible`

### webkit · baseline
- PASS: `initial_summary`
- PASS: `initial_accounts`
- PASS: `keyboard_accessible_search`
- PASS: `navigation`
- PASS: `search`
- PASS: `create_ticket`
- PASS: `export_download`
- PASS: `focus_search`
- PASS: `canary_returns_404`
- PASS: `rate_limit_protected`
- PASS: `canary_alert_protected`
- PASS: `public_content_remains_visible`

### webkit · protected
- PASS: `initial_summary`
- PASS: `initial_accounts`
- PASS: `keyboard_accessible_search`
- PASS: `navigation`
- PASS: `search`
- PASS: `create_ticket`
- PASS: `export_download`
- PASS: `focus_search`
- PASS: `canary_returns_404`
- PASS: `rate_limit_protected`
- PASS: `canary_alert_protected`
- PASS: `public_content_remains_visible`

## Missing evidence

- REA live capture: see `benchmark/rea/README.md`; NOT run automatically by this Playwright script.
- External sites: not tested; use only owned/self-hosted fixtures.
- Threat actor cloning success: not tested; controlled independent reconstruction experiment required.

