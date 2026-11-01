# antiRea

**Defend what actually powers your application. Do not rely on the illusion that client UI can be hidden from a browser.**

**Risk Assessment Toolkit · TypeScript SDK · AI Agent Skill**

[Tiếng Việt](README.vi.md) · [Threat Model](docs/THREAT_MODEL_REA.md) · [Limitations](docs/LIMITATIONS.md) · [QA Status](docs/QA_2026-10-31.md) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg)](https://www.npmjs.com/package/@dannyphan190/anti-rea)
[![CI](https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg)](https://github.com/dankezo/antiRea/actions/workflows/ci.yml)
[![dist line coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dankezo/antiRea/badges/badges/coverage.json)](https://github.com/dankezo/antiRea/blob/main/docs/LIMITATIONS.md)
[![tests](https://img.shields.io/badge/tests-85%20passing-informational)](tests/)

antiRea helps you audit what your website exposes, enforce server-side rate/pagination quotas, move critical logic to the server, and apply canary or watermark controls where appropriate. It **cannot** prevent users or agents from inspecting code delivered to their browser.

Install from npm:

```bash
npm install @dannyphan190/anti-rea
```

You can also install via [GitHub Release](https://github.com/dankezo/antiRea/releases).

## New in v2.2: Web Bot Auth Verification & Python/FastAPI Port

- **Signed-agent verification:** `createWebBotAuthVerifier()` checks Web Bot Auth signatures (IETF draft on RFC 9421 HTTP Message Signatures, Ed25519) so you can identify agents that sign their requests and key quota policy on that identity. A verified signature proves key possession for the covered request - it is not authorization and not a trust signal by itself.
- **Python/FastAPI port:** the quota guard now ships as a faithful Python port in [examples/python-fastapi](examples/python-fastapi), with the same tiers, wire format and pagination bounds, plus pytest parity tests against the TypeScript scenarios.

## Twin-SaaS Benchmark (v2.1)

We built **Northstar**, a synthetic SaaS app with dashboard, customer search, lead creation, CSV export, and chart views in both **baseline (`:4173`)** and **protected (`:4174`)** modes.

```bash
npm install
npm run build && npm run benchmark:build-sdk
python -m pip install playwright
python -m playwright install chromium firefox webkit
python benchmark/run_all.py --browsers chromium,firefox,webkit --iterations 5
```

To view the UI manually, open two terminals and run `npm run benchmark:baseline` alongside `npm run benchmark:demo`.

## What problem does antiRea address?

Tools like [morluto/rea](https://github.com/morluto/rea) assist in observing DOM structure, analyzing JavaScript bundles, tracing network traffic, and reconstructing web app UI.

The goal of this project is to help app owners implement **effective measures with minimal side effects**, backed by reproducible test benchmarks rather than security by obscurity.

## Four Tiers and Implementation Priority

| Priority | Feature | Expected Benefit | Limit |
|---|---|---|---|
| **P0 - Foundation** | Server-side quota/pagination middleware (`createQuotaGuard`), per-record authorization, secret isolation | Core anti-scraping & anti-cloning guarantee | Cannot hide data already served to an authorized user |
| **Tier 1** | Hide public source maps (`verify-build.py` / `run-audit.cjs`); copyright notices; SVG/text provenance signatures | Prevents accidental full-source exposure | Easily stripped by determined users |
| **Tier 2** | Normalized API canary traps (`handleCanaryTrapRequest`), low-confidence automation telemetry (`detectAutomationSignals`), and Web Bot Auth signature verification (`createWebBotAuthVerifier`) for agents that sign their requests | Logs abnormal probing for review; identifies signed agents so quota policy can key on a stable identity | Not a blocking access control; a verified signature is identity, not authorization |
| **Tier 3** | AES-GCM context-bound envelopes (`encryptPayload` / `decryptPayload`) with bounded replay protection (`createInMemoryReplayGuard`) | Prevents simple cross-endpoint replay | Client still holds decryption context if key is in browser |
| **Tier 4** | Ephemeral token watermark overlay (`mountForensicWatermark`) | Traceability for leaked screen captures | Screen overlays can be cropped or edited out |

**Default Recommendation:** Implement P0 first, then set up Tier 1. For key APIs, enable server quotas and canary traps.

## Installation and Testing

Requires Node.js 20+. The repo has **no runtime dependencies**; TypeScript is a devDependency for building.

```bash
npm install
npm run check
npm run build
```

`npm run check` compiles, runs **65 automated tests**, and performs static checks. Scan your public build directory before deployment with `node scripts/run-audit.cjs /path/to/dist` or `python3 scripts/verify-build.py /path/to/dist`.

## How to Integrate the SDK

### 1. P0 Server-Side Quota & Pagination Guard (Recommended First)

```ts
import { createExpressQuotaMiddleware } from "@dannyphan190/anti-rea";

app.use("/api/", createExpressQuotaMiddleware({
  trustedIpHeader: "cf-connecting-ip",
  tiers: {
    anonymous: { maxRequests: 30, windowMs: 60_000, maxPageSize: 25, maxPage: 5 },
    free: { maxRequests: 60, windowMs: 60_000, maxPageSize: 50, maxPage: 20 },
    pro: { maxRequests: 300, windowMs: 60_000, maxPageSize: 200, maxPage: 100 },
  },
  resolveIdentity: req => ({
    accountId: req.headers.get("x-verified-account") ?? undefined, // populate from server auth middleware
    apiKeyId: req.headers.get("x-verified-key-id") ?? undefined,
    tier: "free",
  }),
  onQuotaExceeded: event => {
    console.warn("[quota-exceeded]", event);
  },
}));
```

Returns HTTP `429` with `Retry-After` when account, API key, or IP thresholds are exceeded, enforces `limit`/`pageSize` and `page`/`offset` bounds, and logs structured events for operators.

### 2. Server Canary Endpoints (with URL Canonicalization)

```ts
import { handleCanaryTrapRequest, normalizeCanaryPath } from "@dannyphan190/anti-rea";

const result = await handleCanaryTrapRequest(request, {
  onAlert: async event => { /* send sanitized event to your monitoring platform */ },
  resolveUserId: () => trustedServerSession.userId,
});
if (result.isTrapped) return Response.json(result.body, { status: result.status });
```

`normalizeCanaryPath` automatically canonicalizes trailing slashes, uppercase paths, and percent-encoded characters (`%2D`, `%5F`) so route variants cannot bypass exact matching.

### 3. Optional Watermark for Authenticated Previews

```ts
import { mountForensicWatermark } from "@dannyphan190/anti-rea";
const remove = mountForensicWatermark({ token: "A7fK3w9Z", enabled: true });
// Resolve that token to a session only in your private server ledger.
```

Do not embed the person's email, IP, or raw user ID in pixels. Provide a privacy notice and retention policy.

### 4. Advanced Envelopes: Server-Owned Keys & Bounded Replay Guard

```ts
import {
  createEnvelopeKey,
  encryptPayload,
   verifyTransportEnvelope,
  createInMemoryReplayGuard,
} from "@dannyphan190/anti-rea";

const key = await createEnvelopeKey();
const scope = { purpose: "report-export", method: "POST", path: "/api/export", sessionBinding: "trusted-session-id" };
const env = await encryptPayload({ result: "ok" }, key, scope);

// Automatically purges expired nonces by TTL and caps entries to prevent unbounded RAM growth
const replayGuard = createInMemoryReplayGuard({
  ttlMs: 300_000,
  maxEntries: 10_000,
});

const decoded = await verifyTransportEnvelope(env, key, scope, { markNonceOnce: replayGuard });
```

Use this pattern for independently controlled server services or carefully designed session protocols (use Redis `SET ... NX PX` in multi-instance clusters).

### 5. Verify Signed Agents (Web Bot Auth)

Some crawlers and AI agents sign their requests under the Web Bot Auth profile (RFC 9421, Ed25519). The verifier reconstructs and checks the signature, enforces the validity window, and rejects replayed nonces. It never fetches keys itself - you supply them statically or through your own resolver (fetch `/.well-known/http-message-signatures-directory` from the agent's origin with your own cache and SSRF policy).

```ts
import { createWebBotAuthVerifier } from "@dannyphan190/anti-rea";

const verifier = createWebBotAuthVerifier({
  resolveKey: async ({ agent }) => {
    if (!agent) return undefined;
    const res = await fetch(new URL("/.well-known/http-message-signatures-directory", agent));
    return res.ok ? await res.json() : undefined;
  },
  maxValiditySeconds: 600, // tighten the draft's 24h ceiling
});

const verdict = await verifier.verify(request);
if (verdict.verified) {
  // verdict.agent / verdict.keyId identify the signer of THIS request.
  // Feed the identity into your quota tier decision - and keep your
  // authorization checks exactly as they are for unsigned traffic.
}
```

A runnable end-to-end demo (generate a key, sign a request, verify, then tamper and watch it fail) lives in [examples/web-bot-auth-verify.cjs](examples/web-bot-auth-verify.cjs).

### 6. Python / FastAPI

Running a Python backend? [examples/python-fastapi](examples/python-fastapi) ports the quota guard with identical tiers, `429` semantics, `X-RateLimit-*` headers and pagination bounds, plus a Starlette middleware and FastAPI dependencies. Its pytest suite mirrors the TypeScript test scenarios, so both implementations are held to the same contract.

## Why not "block CDP" or inject malicious prompts?

The old `Error.stack` serialization trick was weakened by V8 changes; independent research documents the limitations of client-side blocking. DOM prompt injections are untrusted data, not a reliable or ethical security control. See [references](docs/REFERENCES.md).

## Contributing / Security / Limitations

Read [CONTRIBUTING.md](.github/CONTRIBUTING.md), [SECURITY.md](.github/SECURITY.md), [docs/LEGAL_PRIVACY.md](docs/LEGAL_PRIVACY.md), [docs/LIMITATIONS.md](docs/LIMITATIONS.md), and [docs/QA_2026-10-31.md](docs/QA_2026-10-31.md).

**Project funding:** [Support the maintainer](https://www.paypal.com/paypalme/dannyphan190) (optional; never necessary to use).
