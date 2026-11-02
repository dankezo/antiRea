# antiRea

**Defend what actually powers your application. Do not rely on the illusion that client UI can be hidden from a browser.**

**Risk Assessment Toolkit · TypeScript SDK · AI Agent Skill**

[Tiếng Việt](README.vi.md) · [Threat Model](docs/THREAT_MODEL_REA.md) · [Limitations](docs/LIMITATIONS.md) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg)](https://www.npmjs.com/package/@dannyphan190/anti-rea)
[![CI](https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg)](https://github.com/dankezo/antiRea/actions/workflows/ci.yml)
[![dist line coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dankezo/antiRea/badges/badges/coverage.json)](https://github.com/dankezo/antiRea/blob/main/docs/LIMITATIONS.md)
[![tests](https://img.shields.io/badge/tests-178%20passing-informational)](tests/)

antiRea helps you audit what your website exposes, enforce server-side rate/pagination quotas, move critical logic to the server, and apply canary or watermark controls where appropriate. It **cannot** prevent users or agents from inspecting code delivered to their browser.

## The short story

**A normal web app, unprotected.** Anyone with an account can take the data home. In our tests, one account and a single export call walked away with the entire 10,000-record dataset in under 200 requests - quietly, leaving nothing unusual behind.

**The same app with antiRea.** Real users notice nothing. But data is metered per record: one identity can only ever receive a capped slice (20% of the dataset in our test setup), so bulk extraction stops being an export and becomes an identity problem. Spread the work across many accounts and the herd detector flags the coordination. Measured outcome: the run that took 1 account unprotected took **18 identities, 272 requests, and got flagged twice**.

Unprotected, your data leaves **whole, free, and invisible**. Protected, it leaves **in slices, at a cost, and on the record**. The full numbers live in [Measured results](#does-it-work-measured-results) below.

Install from npm:

```bash
npm install @dannyphan190/anti-rea
```

You can also install via [GitHub Release](https://github.com/dankezo/antiRea/releases).

## New in v2.3: Data Economics & Herd Detection

- **Per-record budgets:** `createRecordBudget()` caps how many *distinct records* one identity can ever receive per window, priced exports via `createExportGuard()`, and session-chained cursors (`mintCursor` / `verifyCursor`) - the layer that decides how much of your dataset a single account can take home. See the measured results below.
- **Herd detection:** `createHerdDetector()` watches many identities at once and flags groups that jointly tile your dataset, even across different IPs; `applyHerdLadder()` cuts a flagged group's budgets. Signal layers grew too: a deterministic canary maze (`createCanaryMaze()`) and decoy routes (`createDecoyMirage()`).
- **Carried over from v2.2:** Web Bot Auth signature verification (`createWebBotAuthVerifier()`, RFC 9421 / Ed25519) and the Python/FastAPI quota-guard port in [examples/python-fastapi](examples/python-fastapi).

## New in v2.4: Evidence Engine, Transactional Ledger & Tiered Enforcement

v2.4 productizes the SDK-contract design from an overnight adversarial review (the full synthesis lives in the study notes): evidence primitives, a sequential evidence engine, an exact disclosure ledger with a shared campaign ceiling, and store-bound cursors - all held to one rule, **no enforcement without a transaction, and no hard consequence on inferred evidence alone - friction, however, is on by default.**

- **Transactional disclosure ledger:** `createDisclosureLedger()` enforces a *shared* ceiling over a whole cohort (linked identities draw from one exact union of served records, however they rotate) through `reserveDisclosure()`, the single atomic enforcement point. The store contract is honest about its own strength: a store implementing `transactLedger()` (CAS on `ledgerVersion`, covering the union bitmap, reservations, ceiling, bucket and evidence in one transaction) gets `mode: "enforce"`; a get/put-only store gets `mode: "audit_only"` and decisions carry `enforced: false` - the SDK never claims a ceiling a racy store cannot hold. Reservations are bounded (60s TTL, at most 2 outstanding and 500 reserved records per subject by default, optional cohort cap, a separate host-authorized long-reservation path for slow exports), and a declared cohort registry fails closed for unregistered subjects, because the lab measured a partial registry silently degrading a campaign guard to per-member protection. A shipped conformance test proves parallel reservations against a slow async store never jointly overspend the ceiling.
- **Sequential evidence (CUSUM tripwire):** `createCusumTripwire()` fuses four streams - predicate adjacency, exact-set disjoint tiling, cold-ID misses, cursor velocity - into one one-sided mixture GLR-CUSUM accumulator per cohort (zero floor, boundary `ln(1/alpha)`), replacing independent fixed thresholds that an attacker can sit under at 85% each. Tiling excludes records already explained by adjacency predicates, so correlated streams are not double-counted. **Honest default:** the bundled `r6-calib-1` tables were fitted on scripted lab traces (N_eff = 189) and ship labeled `uncalibrated: true` with the notice "uncalibrated - audit only"; the engine defaults to `enforce` mode, but ONLY at the step-up tier - an eligible crossing enrolls step-up friction and cohort pacing, and nothing harder can engage on these tables. Because the tables are uncalibrated, the default claims friction on strong scripted evidence, never detection rates; `mode: "observe"` remains available for telemetry-only deployments. Crossings are telemetry at any scale, but consequences require absolute scale: below a consequence floor of 150 exact union records by default (the tiling stream's evaluation-gate constant, host-configurable via `consequences.minUnionRecords`), a crossing enrolls nobody into step-up and paces nothing - snapshots mark it `consequenceEligible: false`.
- **The tiering law, in code:** `clampEnforcement()` caps cohorts *inferred* from behavior at the **friction tier**: step-up plus a soft budget step-down that may lower a member's budget but never below 500 distinct records (`SOFT_BUDGET_FLOOR_RECORDS` - derived from the ledger's per-subject reservation bound; `softBudgetStepDown()` lands a demand to cut to zero exactly on that floor). Friction is the default: `defaultHerdBandResponse()` maps both herd bands to it for inferred cohorts, and the CUSUM tripwire ships in `enforce` mode. A hard ceiling requires a host-declared cohort or a calibration manifest at the top tier (`evaluateCalibrationManifest()` - model version, sample sizes, held-out FP/FN, method, attester, expiry; no boolean "calibrated" flag). The herd detector's `graduated_only` band carries zero price by construction, and `validateHerdResponseConfig()` rejects configurations that attach one - the lab prototype that priced that band (with a cold-fetch multiplier stacked on the override) hard-cut a simulated compliance team at 46% of its legitimate work, and that wiring mistake is now a startup error instead of a silent cut.
- **Protected cohorts:** the measured false-positive shape - a small team systematically reviewing a full segment - is rare in practice and, in real organizations, a *declared* activity (audits are scheduled, pentests run under rules of engagement). So instead of weakening detection for everyone, declare them: `createProtectedCohortRegistry()` records the compliance/audit/support/pentest subjects (with reason and optional expiry), and protected subjects accrue full telemetry while receiving **zero** consequences from inferred evidence - no step-up, no budget step-down, no pacing. Protection never covers consequences the host itself authorized, nor direct per-subject evidence (a protected subject's own decoy hit still taints it).
- **Cursor V2:** `mintCursorV2()` / `verifyCursorV2()` bind pagination to server-side authority: the payload carries only position, subject/cohort/scope binding, chain sequence and `ledgerVersion` - never LLR or evidence state - and on any conflict **the store wins**: stale or future versions and sequence mismatches are rejected, never silently upgraded. V1 cursors are unchanged.
- **Attribution & reviewer hook:** `createEvidenceAttributor()` credits evidence to the acting subject only; cross-subject contribution needs a host-declared relationship and is capped and decayed, inferred links are observation-only, unknown links are quarantined to audit. `createReviewerChannel()` is the defender-agent idea reduced to its safe slice: a host-side reviewer (cheap model, rules, human queue) receives bounded aggregate bundles and may return schema-validated *advisory* proposals from a fixed vocabulary - it has no budget, no deny, and its output can never flow back into the evidence stream (that would count the same observations twice; a test proves the one-way property against a live tripwire).

## Browser benchmark harness

The repo ships a Playwright harness that runs a synthetic SaaS (**Northstar**: dashboard, customer search, lead creation, CSV export, chart views) in **baseline (`:4173`)** and **protected (`:4174`)** modes across Chromium, Firefox and WebKit - the reproducible in-repo companion to the measured results below.

```bash
npm install
npm run build && npm run benchmark:build-sdk
python -m pip install playwright
python -m playwright install chromium firefox webkit
python benchmark/run_all.py --browsers chromium,firefox,webkit --iterations 5
```

## What problem does antiRea address?

Tools like [morluto/rea](https://github.com/morluto/rea) assist in observing DOM structure, analyzing JavaScript bundles, tracing network traffic, and reconstructing web app UI.

The goal of this project is to help app owners implement **effective measures with minimal side effects**, backed by reproducible test benchmarks rather than security by obscurity.

## Does it work? Measured results

**Method.** We test against **Ledgerly**, a synthetic SaaS holding 10,000 records behind 120 accounts, run twice: a baseline instance with no protection and a protected instance of the *same* app with antiRea wired in. Attack runs are driven by REA 6.8.0 (`rea-agents`) and by general-purpose agents following the standard clone workflow: authenticate, enumerate, probe boundaries, paginate to full coverage, burst exports. (One finding shapes everything below: REA itself only *perceives* - it reads a running browser over CDP and sends zero requests of its own. The behavior a server can observe, meter and price is the driving workflow, so that is what the defenses target.) Polite-user control runs measure the cost to legitimate traffic. An independent benchmark of this repository was also published in [issue #1](https://github.com/dankezo/antiRea/issues/1); most claims held up under it, and every gap it found is fixed in v2.3.0.

| Layer | What we measured | Result |
|---|---|---|
| No protection (baseline) | Full extraction of the 10,000-record dataset | **160-193 requests total**; a single export call returns everything |
| P0 quota + pagination bounds | Export and pagination abuse | Bulk export dumps rejected (HTTP 422), page size and depth capped - necessary, not sufficient on its own |
| Record budget + export guard + chained cursors | How much one identity can take (budget set to 2,000 distinct records/day) | Per-identity ceiling held at exactly **20% of the dataset**; cross-session cursor replay blocked; full extraction now needs many identities instead of one account |
| Herd detector | Coordinated multi-identity extraction | Scripted 6-identity herd **flagged after 301 records** of joint coverage and ladder-capped; a dispersed herd (separate IPs, staggered signups) still **flagged at 2,400 records** via coverage-complement grouping; a state-of-the-art REA-first run was stopped at roughly **15%** of the dataset |
| Canary maze + decoy mirage | Signal quality and safety | Correctness and accessibility verified (Playwright + axe, **0 violations**), hard caps enforced (240 hits / 10 min / IP, 10,000 pages/day, then HTTP 404). These are detection layers - we claim no extraction-blocking percentage for them |
| Full stack vs. adaptive attacker | Attacker deliberately spreads work across 18 identities and dilutes its pattern | Extraction still completed - but took **18 identities and 272 requests** instead of 1 account and 1 export call, and was **flagged twice** on the way. Both flags scored in the low-tiling band, which by design triggers graduated response only, not an automatic budget cut. This is the stack's main known limit; see [Limitations](docs/LIMITATIONS.md) |
| Legitimate users | Dense onboarding clusters, shared-IP (NAT) cohorts, polite control runs | **Zero flags, zero added friction** in every lab and control run |

**What this adds up to.** The stack removes the casual one-shot clone, and turns bulk extraction into an identity problem: every additional slice of the dataset costs another account and more visibility. It does not stop a determined, well-resourced rebuilder, and the real price of an identity (signup friction, verified accounts, payment) is set by you, the host - which is why budgets are enforced per identity and why herd flags distinguish "cut the budget" from "step up scrutiny" instead of firing one blunt response.

## Four Tiers and Implementation Priority

| Priority | Feature | Expected Benefit | Limit |
|---|---|---|---|
| **P0 - Foundation** | Server-side quota/pagination middleware (`createQuotaGuard`), per-record authorization, secret isolation | Core anti-scraping & anti-cloning guarantee | Cannot hide data already served to an authorized user |
| **Tier 1** | Hide public source maps (`verify-build.py` / `run-audit.cjs`); copyright notices; SVG/text provenance signatures | Prevents accidental full-source exposure | Easily stripped by determined users |
| **Tier 2** | Normalized API canary traps (`handleCanaryTrapRequest`), a deterministic canary maze (`createCanaryMaze`), decoy routes (`createDecoyMirage`), low-confidence automation telemetry (`detectAutomationSignals`), and Web Bot Auth signature verification (`createWebBotAuthVerifier`) for agents that sign their requests | Logs abnormal probing for review; identifies signed agents so quota policy can key on a stable identity | Not a blocking access control; a verified signature is identity, not authorization |
| **Tier 2 - Data economics** | Per-record budget (`createRecordBudget`), priced exports (`createExportGuard`), session-chained cursors (`mintCursor` / `verifyCursor`), sequence flow scoring (`createFlowScorer`) | Caps how much of the dataset any one identity can ever receive; makes full extraction cost many identities (measured: 20% ceiling per identity in our tests) | Attackers rotate identities - pair with real signup cost on the host side |
| **Tier 2 - Herd detection** | Cross-identity herd detector (`createHerdDetector`) with response ladder (`applyHerdLadder`) | Flags groups of identities jointly tiling the dataset, including across IPs; high-tiling groups get budget cuts, low-tiling groups get graduated response | Detection is not enforcement for low-tiling herds - a disciplined adaptive herd was flagged yet still finished (see measured results) |
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

`npm run check` compiles, runs **180 automated tests** (178 passing, 2 skipped RSA-PSS vectors), and performs static checks. Scan your public build directory before deployment with `node scripts/run-audit.cjs /path/to/dist` or `python3 scripts/verify-build.py /path/to/dist`.

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

### 7. Meter the Data Itself (Record Budget + Herd Detection)

Request quotas cap *speed*; a record budget caps *how much of the dataset* an identity can ever receive, however politely it paginates. Feed the same serving events to the herd detector so coordinated groups surface too.

```ts
import { createRecordBudget, createHerdDetector } from "@dannyphan190/anti-rea";

// One identity receives at most 2,000 distinct records per day.
const budget = createRecordBudget({ maxDistinctPerWindow: 2_000 });
const herd = createHerdDetector({
  onFlag: snap => { /* snap.band: "budget_cut_supported" | "graduated_only" */ },
});

// Gate before the handler runs, then record what the response actually served:
if (!budget.check("account:123", 1).allowed) { /* return 429 */ }
// ... handler runs, authorization passes, recordIdsServed is final ...
budget.consume("account:123", recordIdsServed);
herd.observe({ type: "list", identity: "account:123", ip: serverSeenIp, recordIds: recordIdsServed });
```

Use the same identity string (`account:<id>`) in both, so a herd flag can be fed straight into `applyHerdLadder()` or a budget override.

### 8. Shared Ceilings & Evidence (v2.4)

For cohorts, per-identity budgets dilute by rotation; a shared ceiling does not - but only if reservation is transactional. Declare the cohort, reserve before serving, commit after:

```ts
import {
  createDisclosureLedger, createInMemoryTransactionalStore,
  createCusumTripwire, clampEnforcement,
  createProtectedCohortRegistry, defaultHerdBandResponse,
} from "@dannyphan190/anti-rea";

const ledger = createDisclosureLedger({
  store: createInMemoryTransactionalStore(), // CAS store => mode "enforce"
  ceilingLimit: 2_000,                        // shared across the whole cohort
});
await ledger.declareRegistry(memberIds);      // unregistered subjects fail closed

const reservation = await ledger.reserveDisclosure({ subject: "account:123", recordIds: idsToServe });
if (!reservation.allowed) { /* 429: ceiling_exceeded | rate_limited | ... */ }
// ... serve ...
await ledger.commitReservation(reservation.reservationId);

// Declare the subjects inference must never consequence: the
// compliance team's reviewers, the support floor, an agreed pentest
// window. Their telemetry still accrues - only consequences are
// suppressed - and the declaration is an auditable record.
const protectedCohorts = createProtectedCohortRegistry();
protectedCohorts.declareProtected(["account:auditor-1", "account:auditor-2"], {
  reason: "Q3 compliance review",
});

// Evidence accumulates separately. The tripwire's default mode is
// enforce, but with the bundled uncalibrated tables an inferred
// cohort's consequence is capped at the friction tier (step-up, plus
// a soft budget step-down that never goes below 500 records).
// Anything harder needs a host-declared cohort or a ceiling-tier
// calibration manifest - clampEnforcement() is the check.
const tripwire = createCusumTripwire({ isProtected: id => protectedCohorts.isProtected(id) });
await tripwire.observe({ type: "list", identity: "account:123", recordIds: idsToServe });

// Herd flags get the same default: for an inferred cohort,
// defaultHerdBandResponse() returns friction (stepUp: true,
// budgetStepDownFloorRecords: 500, ladder: false) on both bands -
// partition the members through the registry before applying it.
```

With a get/put-only store the ledger reports `mode: "audit_only"` and `enforced: false` on every decision - measure first, enforce when your store can actually transact. Full semantics and limits: [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Why not "block CDP" or inject malicious prompts?

The old `Error.stack` serialization trick was weakened by V8 changes; independent research documents the limitations of client-side blocking. DOM prompt injections are untrusted data, not a reliable or ethical security control. See [references](docs/REFERENCES.md).

## Contributing / Security / Limitations

Read [CONTRIBUTING.md](.github/CONTRIBUTING.md), [SECURITY.md](.github/SECURITY.md), [docs/LEGAL_PRIVACY.md](docs/LEGAL_PRIVACY.md), and [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

**Project funding:** [Support the maintainer](https://www.paypal.com/paypalme/dannyphan190) (optional; never necessary to use).
