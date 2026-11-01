---
name: anti-rea
description: Audit and responsibly harden web apps against data scraping, unauthorized feature enumeration, accidental source exposure, and automated browser observation. Prefer backend controls, auditability, and privacy-safe canaries over CDP interference or misleading prompt injection.
license: MIT
---

# antiRea — evidence-led web hardening skill

Read `docs/LIMITATIONS.md`, `docs/THREAT_MODEL_REA.md` and `docs/SERVER_SIDE_CONTROLS.md` first. This skill does NOT make sites unclonable or block `morluto/rea`.

## Stage 1 — scope and consent

1. Confirm target project is owned/authorized by user; inspect framework, built assets, API routes, authn/authz and threat surface.
2. Classify sensitive assets: server secrets, customer data, private formulas, third-party data and content rights.
3. List what an authenticated user can legitimately see; assume it can be copied or screenshotted.

## Stage 2 — highest-value repairs (P0)

1. Move proprietary logic, prompts and secrets into server-only modules.
2. Test object-level and field-level authorization server-side, not only hidden UI elements.
3. Add rate limits/quotas (`createQuotaGuard`), export caps, pagination limits (`maxPageSize`, `maxPage`), minimal response fields and access logs.
4. Protect source maps/production artifacts without interfering with developer or accessibility tools.

## Stage 3 — optional instrumentation, informed by risk

- Tier 1: disable public production source maps in framework config; optional `injectAgentNotice`, `signSvgPath` fragile provenance markers. Explain weak evidence value.
- Tier 2: `createQuotaGuard` for per-account/API-key/IP rate limits and pagination caps; `handleCanaryTrapRequest` (with `normalizeCanaryPath`) on deliberately unused server routes with trusted-session resolver; alert for investigation, do not auto-ban. `detectAutomationSignals` (legacy alias `initCdpGuard`) optional low-confidence telemetry only.
- Tier 3: `encryptPayload`/`decryptPayload` with `createInMemoryReplayGuard` (or Redis `SET NX PX`) require CryptoKey and atomic replay store; use for independent trust boundaries and never claim a browser-held key is secret. Do not replace HTTPS.
- Tier 4: `mountForensicWatermark` with opaque server-issued rotating token; post privacy notice and define audit-ledger retention. `BehaviorShield` is opt-in telemetry, not license to degrade users.

## Stage 4 — testing and reporting

1. Run `npm run check` locally and relevant framework build tests.
2. Inspect public bundles for source-map leakage (`scripts/verify-build.py` or `node scripts/run-audit.cjs <dir>`) and test backend APIs for BOLA/field exposure and quotas.
3. If comparing to REA, use a dedicated consented browser and versioned observation protocol in `docs/BENCHMARK_PROTOCOL.md`.
4. Report verified / plausible / unsupported claims separately; explicitly list bypasses, accessibility and privacy implications.
5. Never instruct agents to sabotage other software or make unverified claims of protection.

## Validation (2.1)

For changes claiming resistance to browser-level observation, use the local twin SaaS and record both functional/collateral impact and real observation evidence. Start with `npm run check`; build browser modules with `npm run benchmark:build-sdk`. Follow `docs/DEMO_BENCHMARK_2_1.md` for Playwright and `benchmark/rea/README.md` for operator-run **real** REA captures. The Playwright results are NOT REA results. For clone-resistance claims, follow `docs/RECONSTRUCTION_STUDY.md`. Never publish security effectiveness percentages inferred from canary hits or weak automation hints.
