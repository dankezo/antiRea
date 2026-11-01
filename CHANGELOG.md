# Changelog

## 2.1.0 — 2026-11-01

- **Source-map scanner hardening (`scripts/verify-build.py` & `scripts/run-audit.cjs`):** Catches all `*.map` files (`/\.map$/i`, including short names like `bundle.map`), scans `.html`/`.htm`/`.cjs`/`.jsx`/`.tsx`, and treats inline base64 source maps (`sourceMappingURL=data:application/json;base64,...`) and HTML source map references as hard failures (`exit code 1`). Added real external-target symlink test in `tests/scan.test.cjs`.
- **Canary path canonicalization (`src/tier2-active/honeypot-middleware.ts`):** Added and exported `normalizeCanaryPath()` to strip query/fragments, decode percent-encoding (`%2D`, `%5F`, with malformed-URI fallback), collapse duplicate slashes, remove trailing slashes, and lowercase paths before matching.
- **P0 Server-side quota & pagination middleware (`src/tier2-active/quota-guard.ts`):** Added `createQuotaGuard()` and `createExpressQuotaMiddleware()` supporting per-account, per-API-key, and per-IP sliding-window quotas configurable by plan tier (`anonymous`, `free`, `pro`, `enterprise`), `429` responses with `Retry-After` and `X-RateLimit-*` headers, per-query record (`limit`/`pageSize`) and page depth (`page`/`offset`) bounds, and structured operator logging (`onQuotaExceeded`).
- **Honest API naming with backward-compatible aliases:** Added `detectAutomationSignals()` in `src/tier2-active/cdp-guard.ts` (`initCdpGuard` retained as `@deprecated` alias) and `getClientDecoyRoutes()` in `src/tier2-active/honeypot-middleware.ts` and `route-obfuscator.ts` (`registerClientBundleCanaries` retained as `@deprecated` alias). Updated `.agents/skills/anti-rea/SKILL.md` to describe `signSvgPath` as a fragile provenance marker.
- **Bounded replay guard & documentation polish:** Upgraded `createInMemoryReplayGuard({ ttlMs, maxEntries })` to cap memory usage and updated `README.md` / `README.vi.md` to use it instead of an unbounded `Set()`. Restricted `/__benchmark/state` and `/__benchmark/reset` in `benchmark/demo/server.cjs` to loopback addresses, updated `configs/next.config.mjs` and `configs/vite.config.ts`, cited Vietnam's Decree 13/2023/ND-CP (PDPD) in `docs/LEGAL_PRIVACY.md`, and expanded unit test suite to 38 passing checks.

## 2.1.0-beta.3 — 2026-10-31

- Published scoped npm package `@dannyphan190/anti-rea` with updated repository, homepage, and issue tracker metadata.
- Added cross-platform `scripts/run-audit.cjs` runner and symlink permission skip handling in `tests/scan.test.cjs`.
- Recorded Windows patched Playwright rerun evidence (`docs/evidence/browser-windows-patched.json` and `docs/QA_2026-10-31.md`).

## 2.1.0-beta.2 — 2026-10-31

- Fixed clean-build TypeScript script ordering, CSV download verification in `benchmark/run_browser.py`, REA 6.8.0 CLI flags in `benchmark/rea/capture.sh` and `capture.ps1`, and Chromium network-idle handling on demo telemetry calls.
- Moved community health files (`SECURITY.md`, `CONTRIBUTING.md`) under `.github/` and added `docs/DISCOVERY.md` and `docs/LAUNCH.md`.

## 2.1.0-beta.1 — 2026-10-31

- Added synthetic **Northstar twin-SaaS** app: separate baseline/protected instances using the same frontend, fixtures and workflows.
- Protected demo imports **actual transpiled antiRea browser modules** and server canary middleware; adds server-only export quota and transparent watermark.
- Added repeatable Playwright cross-engine runner, screenshot/JSON evidence format, programmatic report, 30th Node HTTP integration test, GitHub CI browser workflows.
- Added official REA capture guide and operator-run CLI shell script; never substitutes simulated capture for real REA output.
- Added vetted local test targets (TodoMVC, RealWorld, OWASP Juice Shop) and controlled reconstruction research protocol.

## 2.0.0-beta.1 — 2026-10-31 (community beta, compatibility-breaking)

- Reframed project from “unclonable REA blocker” into evidence-led defensive SDK.
- Removed sabotage prompts, forceful CDP traps, WebMCP overrides, screenshot shortcut monitoring, and unsubstantiated screen-steganography decoder.
- Replaced prompt injector with a truthful rights notice; old `injectPromptPoisonDOM` name is a migration alias only.
- Rebuilt canary handling with exact paths, optional trusted-proxy IP, server-session attribution and no automatic sanctions.
- Replaced client-provided raw AES/HMAC strings with CryptoKey-based authenticated envelope and required caller replay guard; **old `encryptPayload`/`decryptPayload` call signatures changed**.
- Replaced raw identity screen overlay with opt-in opaque token; **`mountForensicWatermark` now requires `token` rather than `userId/email`**.
- Improved UTF-8 canary markers, added TS build, 29 automated checks, CI workflow, bilingual docs, limitations, scholarly references and community guidelines.

## 1.0.0 — supplied prototype

Prototype with four tiers and unverified performance/robustness statements. Do not deploy unreviewed code from v1.0 in production.
