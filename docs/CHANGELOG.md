## 2.1.0-beta.1 — 2026-10-31

- Added synthetic **Northstar twin-SaaS** app: separate baseline/protected instances using the same frontend, fixtures and workflows.
- Protected demo imports **actual transpiled antiRea browser modules** and server canary middleware; adds server-only export quota and transparent watermark.
- Added repeatable Playwright cross-engine runner, screenshot/JSON evidence format, programmatic report, 30th Node HTTP integration test, GitHub CI browser workflows.
- Added official REA capture guide and operator-run CLI shell script; never substitutes simulated capture for real REA output.
- Added vetted local test targets (TodoMVC, RealWorld, OWASP Juice Shop) and controlled reconstruction research protocol.
- Known blocker: Chromium in the authoring environment has `ERR_BLOCKED_BY_ADMINISTRATOR` on local and data: navigations. Runner records failures; no REA live run has been claimed.

# Changelog

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
