# Changelog

## 2.3.0 — Unreleased

- **Canary Maze (`src/tier2-active/honeypot-middleware.ts`):** Added opt-in `createCanaryMaze()` plus the `canaryTrapLink()` and `canaryRobotsTxt()` helpers. The maze serves a deterministic, seed-derived space of neutral wordlist-filler pages under a configurable prefix (default `/_canary/`): the same URL always renders the same page with no stored state, every page carries a `noindex,nofollow` meta, and every generated link stays inside the prefix, so no trap link can point at real content. Serving budgets are hard caps rather than tuning hints - a bounded per-IP window counter plus a global daily served-pages cap, after which the handler answers a plain 404 (or a configured 429) - so the trap cannot become a self-DDoS surface; an optional response drip defaults to off. Hits reuse the canary `onAlert` channel with two additive payload fields (`maze`, `depth`), and the alert semantics are unchanged: a hit is an investigation signal, never proof of malice and never an auto-ban. Content is neutral filler by design - no poisoned text, no payloads. Evidence so far is unit tests only (determinism, link containment, caps, kill switch, alert payload, trap-link and robots helpers) in `tests/canary-maze.test.cjs`; no crawler-consumption or accessibility measurement is published, and no effectiveness percentage is claimed - see the Canary Maze row in `docs/LIMITATIONS.md`.

## 2.2.0 — 2026-11-01

- **Web Bot Auth verifier (`src/tier2-active/web-bot-auth.ts`):** Added `createWebBotAuthVerifier()` implementing the IETF Web Bot Auth profile (draft-ietf-webbotauth-httpsig-protocol) on RFC 9421 HTTP Message Signatures: Ed25519 verification of covered components, `keyid` bound to the RFC 7638 JWK thumbprint, required `created`/`expires` with a capped validity window, and a bounded in-memory nonce replay guard. Keys resolve through a caller-injected resolver or a parsed signature-agent key directory (JWK Set shapes); the module performs no network fetching. A verified signature proves key possession for the covered request only - it is not authorization and not evidence of good behavior. Documented composition maps a verified verdict onto a caller-owned quota tier in `createQuotaGuard()` without changing quota-guard. 33 dedicated tests (real Ed25519 keys, tamper/expiry/replay cases). Interop is tested against the reference implementation: cross-signing with Cloudflare's `web-bot-auth` package passes in both directions and the IETF draft's published Ed25519 vector verifies (`tests/web-bot-auth-interop.test.cjs`, `scripts/interop-web-bot-auth.cjs`, weekly CI). Cloudflare's older architecture-v1 vectors exposed two profile divergences, each pinned by a named test with the reference signatures independently proven valid: requests without a `Signature-Agent` header are rejected (required by draft-ietf-webbotauth-httpsig-protocol-00 §5.2.1), and the legacy bare-string `Signature-Agent` form is handled by dual-form acceptance (below). **Dual-form `Signature-Agent` acceptance:** the verifier accepts both the draft dictionary form (`sig="https://..."`, the form -00 mandates for signers) and the legacy bare-string form (`Signature-Agent: "https://..."`). Rationale: the draft mandates the dictionary form, but Cloudflare's production verifier still requires the bare string and production signers send it deliberately, so a dictionary-only verifier would reject the deployed ecosystem; §5.2.1 expressly permits a verifier to accept the legacy form (MAY). The legacy form is a deprecated compatibility path, accepted only under a fail-closed guardrail (exactly one signature may cover the `signature-agent` field, via the whole-field component with no `;key` binding; ambiguous multi-signature coverage keeps being rejected), and every verdict reports the form used via the new additive `agentForm` field (`"dictionary"` | `"legacy"`) so operators can measure remaining legacy usage. Revisit this acceptance when the draft becomes an RFC or Cloudflare's production verifier flips to the dictionary form.
- **Python/FastAPI quota-guard port (`examples/python-fastapi/`):** Faithful port of `createQuotaGuard()` semantics to Python: identical tiers, sliding-window decisions, `429` + `Retry-After` / `X-RateLimit-*` wire format, and pagination bounds, with a `QuotaWindowStore` protocol (bounded in-memory implementation plus a Redis implementation against a duck-typed client via Lua scripts), a Starlette middleware, and FastAPI dependencies. 26 pytest parity tests mirror the TypeScript scenarios assertion-for-assertion; divergences (snake_case API, Starlette error path) are documented in the example README. The port is an example, not a published package. The Redis store is covered by unit tests against an in-memory fake plus real-Redis integration tests (gated by `REDIS_URL`) that also run in CI against a Redis service container; Redis failure modes and Cluster/Sentinel topologies remain untested and are documented as such in the example README.

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
