# antiRea

**Defend what actually powers your application. Do not rely on the illusion that client UI can be hidden from a browser.**

**Risk Assessment Toolkit · TypeScript SDK · AI Agent Skill**

[Tiếng Việt](README.vi.md) · [中文](README.zh.md) · [Español](README.es.md) · [Threat Model](docs/THREAT_MODEL_REA.md) · [Limitations](docs/LIMITATIONS.md) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg)](https://www.npmjs.com/package/@dannyphan190/anti-rea)
[![CI](https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg)](https://github.com/dankezo/antiRea/actions/workflows/ci.yml)
[![dist line coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dankezo/antiRea/badges/badges/coverage.json)](https://github.com/dankezo/antiRea/blob/main/docs/LIMITATIONS.md)
[![tests](https://img.shields.io/badge/tests-583%20passing-informational)](tests/)

antiRea helps you audit what your website exposes, enforce server-side rate/pagination quotas, move critical logic to the server, and apply canary or watermark controls where appropriate. It **cannot** prevent users or agents from inspecting code delivered to their browser.

## The short story

**A normal web app, unprotected.** Anyone with an account can take the data home. In our tests, one account and a single export call walked away with the entire 10,000-record dataset in under 200 requests - quietly, leaving nothing unusual behind.

**The same app with antiRea.** Real users notice nothing. But data is metered per record: one identity can only ever receive a capped slice (20% of the dataset in our test setup), so bulk extraction stops being an export and becomes an identity problem. Spread the work across many accounts and the herd detector flags the coordination. Measured outcome (v2.5.0 classic round): the REA-style run that took 1 account unprotected was **stopped at 5% of the dataset**, and a scripted slicing crew that insisted on finishing needed **25 identities and ~19 minutes**, flagged by both the herd detector and the evidence engine on the way.

Unprotected, your data leaves **whole, free, and invisible**. Protected, it leaves **in slices, at a cost, and on the record**. The full numbers live in [Measured results](#does-it-work-measured-results) below.

Install from npm:

```bash
npm install @dannyphan190/anti-rea
```

You can also install via [GitHub Release](https://github.com/dankezo/antiRea/releases).

## New in v2.7.0

The short version: the alarm system used to rely on thresholds fitted in a lab - good numbers, but no promise behind them. v2.7.0 adds an evidence engine with a mathematical false-alarm promise, two new advisory signals, and a hardening merge underneath.

- **An alarm with a promise attached.** The new e-value tripwire (opt-in) works like a careful gambler's bankroll: if your legitimate users stay under an intensity bound you set, the chance it *ever* fires falsely is at most the level you picked (say 5%) - guaranteed by construction. In 10,000 simulated legitimate runs it fired 0 times; at the hardest honest boundary, 4.2% against the 5% promise. It caught slicing at a median of 400 records vs 1,225 for the current engine.
- **A second shape for quiet-then-loud attacks.** The plain bankroll reacts slowly after a long quiet spell, so a Shiryaev-Roberts mode ships alongside: median 14 steps to catch an attack after the quiet period, vs 774 - under its own, different guarantee, stated plainly. A calibration helper measures the bound from your own traffic.
- **The honest catch, printed on the box.** The promise is exactly as good as your bound: a legitimate workflow running hotter than the bound *will* eventually trip it - hot-but-honest jobs like bulk importers belong in the declared lanes or need their own bound.
- **Hard ceilings, exact in a crowd.** Forty workers hammering a declared cap of 600 records overshot to 1,575 on the old check-then-serve path. The new reserve-first path holds exactly 600, zero overshoot - and its holds now expire on a monotonic clock, so a system-clock jump can't stretch or kill them.
- **A new signal for feature enumeration (advisory).** Input-space coverage watches *which* features and resources an account touches, not just how much data it takes. In the lab it flags sweep and random-probe enumeration 9 of 9 at the first checkpoint (the current engine: 0 of 9) and a work-splitting herd 72 of 72 members - at a 1.15% legitimate flag rate. It only scores what you declare, and it never blocks anything by itself.
- **A new signal for crawler-shaped browsers (advisory).** The asset/referrer profile notices browsers that never load images and never carry referrers: 0 false flags in the lab (6,658 legitimate streams, 923 sale-week streams), crawlers flagged 9 of 9 - and shipped deliberately slower-but-surer, needing two bad windows in a row before it flags.
- **Verified users stop getting re-challenged.** Pass a step-up check once and a new grace window (24 h by default) leaves you alone at ordinary evidence levels. It breaks instantly if evidence jumps to twice the flag line - and it never lifts any budget or ceiling.
- **A real bug found and fixed.** New heavy-search attack tests caught a bystander being swept into an attack group's flag - worse, the accident *shielded* one attacker from friction. The grouping rule is fixed: bystander clean, all 16 attackers enrolled.
- **Signed-bot verification, re-checked.** An independent conformance pack for the RFC 9421 verifier, built from the specification's own example keys: all 12 broken signature variants rejected, false accepts 0.
- **Your policy, in the formats agents read.** A small generator emits your data-use policy as robots.txt signals, a TDM reservation file and a policy JSON - correct format only, no enforcement claimed.
- **All recent hardening, merged in.** Every fix shipped in the 2.6.1-2.6.3 patches (idempotency binding, atomic quota enforcement, priced CSV exports, tamper-proof clocks, and more) is part of this line - a pre-release audit caught that the 2.7 development tree had forked before them, and nothing shipped until they were merged back and re-verified.

Full technical write-up with every mechanism, derivation and measurement: [v2.7.0 deep dive](docs/v2.7.0-deep-dive.md). What the previous patch line changed: [v2.6.3 deep dive](docs/v2.6.3-deep-dive.md).

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

**Method.** We test against **Ledgerly**, a synthetic SaaS holding 10,000 records behind 120 accounts, run twice: a baseline instance with no protection and a protected instance of the *same* app with antiRea wired in. Attack runs are driven by REA 6.8.0 (`rea-agents`) and by general-purpose agents following the standard clone workflow: authenticate, enumerate, probe boundaries, paginate to full coverage, burst exports. (One finding shapes everything below: REA itself only *perceives* - it reads a running browser over CDP and sends zero requests of its own. The behavior a server can observe, meter and price is the driving workflow, so that is what the defenses target.) Polite-user control runs measure the cost to legitimate traffic. An independent benchmark of this repository was also published in [issue #1](https://github.com/dankezo/antiRea/issues/1); most claims held up under it, and the gaps it found are fixed and recorded in the changelog.

| Layer | What we measured | Result |
|---|---|---|
| No protection (baseline) | Full extraction of the 10,000-record dataset | **160-193 requests total**; a single export call returns everything |
| P0 quota + pagination bounds | Export and pagination abuse | Bulk export dumps rejected (HTTP 422), page size and depth capped - necessary, not sufficient on its own |
| Record budget + export guard + chained cursors | How much one identity can take (budget set to 2,000 distinct records/day) | Per-identity ceiling held at exactly **20% of the dataset**; cross-session cursor replay blocked; full extraction now needs many identities instead of one account |
| Herd detector + CUSUM evidence engine | Coordinated multi-identity extraction (v2.5.0 classic round) | A REA-style identity rotation was stopped at **5%** of the dataset; slicing and ID-walk crews were flagged by BOTH detectors - the evidence engine's first crossings landed at **1,800** and **900** union records (both shapes were invisible to it before 2.5.0), and the herd flag/consequence set covered **18 of 18** phase-1 slicing identities (8 of 18 in 2.4.0). Herd flags carry per-member coverage, so zero-contribution members of a flagged group receive no friction (measured in the legitimate-users row below) |
| Canary maze + decoy mirage | Signal quality and safety | Correctness and accessibility verified (Playwright + axe, **0 violations**), hard caps enforced (240 hits / 10 min / IP, 10,000 pages/day, then HTTP 404). These are detection layers - we claim no extraction-blocking percentage for them |
| Shared cohort ceiling (declared cohort + ceiling-tier manifest) | Does the lawful hard-ceiling path work end-to-end? (v2.5.0 classic round; declared ceiling 600 records) | Armed at declaration and re-tested: the declared cohort's union stopped at **exactly 600 distinct records** in both runs (the crossing-gated first attempt overshot to 2,700), every one of the 18 declared walkers blocked, **710-714 ceiling refusals** per run and 0 records served past the cap, controls in the same instance unaffected (compliance 1,200/1,200, zero friction). Declared cohorts without a ceiling-tier manifest arm nothing; inferred cohorts keep the crossing-gated path; see [Limitations](docs/LIMITATIONS.md) |
| Full stack vs. adaptive attacker | Attacker deliberately spreads work across 18 identities and dilutes its pattern (v2.5.0 classic round) | Extraction still completed via rotation - but phase 1 (18 identities) was held to **78%** after ~18 minutes of step-up friction, session expiries and soft budget step-downs, every phase-1 identity inside the flagged/consequenced set, and finishing took **25 identities and ~19 minutes** overall. The ID-walk crew's phase 1 was held to **90.0%** - exactly 500 records per walker, the soft floor for inferred cohorts - with all 18 walkers capped and 324 phase-1 session interrupts (before this round: 91.0%, 224 interrupts, 2 walkers over the floor). Rotation remains the stack's main known limit; see [Limitations](docs/LIMITATIONS.md) |
| Legitimate users | Declared compliance team, undeclared systematic review, polite users, shared-IP (NAT) cohorts (v2.5.0 classic round, re-measured) | Declared (protected) compliance: **1,200/1,200 records, zero friction**. Undeclared systematic review: flagged and frictioned (step-up + soft step-down) but **zero data loss - 1,200/1,200 served**. Polite users and NAT groups: **zero consequences** - including polite users who kept browsing mid-session inside a group while it was being flagged (contribution targeting, new in 2.5.0) |
| Action budget vs. feature-abuse herd (lab) | Scripted herd splitting expensive actions across 24 identities (v2.6.0 feature classic, protected side, lab measurement) | Baseline (no protection): **80/80 operations completed in 241 ms, 0 interrupts**. Protected, after the fix round: **16/80 completed (20.0%)**, max distinct targets per identity held at **500**, and friction coverage measured by enrollment was **24/24** identities (the flag-union counter read 14/24 - attempt-time enrollment stops joiners before they generate the observations that counter counts; both numbers are reported in the deep dive). Attacker economics in the same round: 220 attempts, 108 interrupts, 96 HTTP 429 rate-limit responses, wall clock 480,445 ms (driver cap reached) |
| Feature-side legitimate users (lab) | Declared team, undeclared teams, ordinary users under the action layer (v2.6.0 feature classic, protected side, lab measurement) | Declared team of 6: **40/40 operations, 0 friction, 0 enrolled**. Undeclared team of 6: **40/40, 0 work lost, no hard denial**. Undeclared team of 8: at the 15-minute mark **20/40 completed** over 3,205 attempts with 3,185 friction events - all at the step-up + soft-floor tier, **0 hard denials**; work is never refused outright, it flows at the published capped rate. Ordinary users (8): **48/48 first-attempt successes, 0 consequences** |
| Canary actions (lab) | Registered fake action targets (a promo / export slice no real UI emits) touched by an attacker identity (v2.6.0 feature classic, protected side, lab measurement) | Touching the canary target (slice 40) tainted only the toucher, linked it into the flagged group via `taintedMembers`, and enrolled it in step-up on direct evidence; the bystander in the same cell measured **0 taint, 0 enrollments, 0 overrides**. Round 1 of this cell failed its bystander sub-check on raw-cost materiality; the fix round's contribution-based materiality passed all four sub-checks - see the deep dive |
| Declared ceiling under parallel load (lab) | 40 concurrent workers hammering a declared cohort's hard ceiling of 600 (v2.7.0 classic cell) | The old check-then-serve path overshot: union **639** (1-record requests) and **1,575** (25-record requests). The new reservation path (`reserveServe`) held **exactly 600, zero overshoot**, both shapes; the declared-protected control lane served **1,200/1,200** with zero interference |
| Anytime-valid evidence engine (lab, simulation) | E-value tripwire (`createEvalueTripwire`): false-flag guarantee by construction (Ville) under a host-set legitimate-intensity bound; pre-registered simulation, seeded and reproducible | **0 false crossings in 10,000** legitimate runs at nominal 5% and 1%; at the hardest boundary (legitimate mean exactly at the bound, maximum variance) **4.2% vs the 5% promise**. Detection: slicing caught at median **400** union records (CUSUM on the same traces: 1,225). Printed costs: a legitimate class running just above the bound is flagged with probability near 1 (the bound is the guarantee's condition - a calibration helper ships with the engine), per-record feeding is blind to slow ID-walks, and the plain product shape needed a median **774** steps to catch an attack after a long quiet history - the Shiryaev-Roberts shape shipped alongside cuts that to **14** under its own average-run-length guarantee |
| Feature-side attack cells S2 + S3, LLM attacker (lab) | Heavy-search herd (16 identities), promo farming (12 identities), and a live LLM-driven attacker on the export cell (v2.7.0, protected side) | Heavy search: flag covered **10/16**, completion **30%** of baseline - the cell also caught a real grouping bug (a bystander absorbed into the flag, shielding one attacker); after the fix, completion **25%**, bystander in **no** flag, **16/16** attackers enrolled. Promo farming: **12/12** flagged, per-identity grants capped at **2-3 per minute-window**, control's first claim clean. LLM attacker (single model, SambaNova gemma-4-31B-it, 2 runs): **16/80 (20%)** - identical outcome to the scripted herd, **24/24** enrolled; it never tried the under-the-floor counter-strategy described in its own prompt |

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

`npm run check` compiles, runs **585 automated tests** (583 passing, 2 skipped RSA-PSS vectors), and performs static checks. Scan your public build directory before deployment with `node scripts/run-audit.cjs /path/to/dist` or `python3 scripts/verify-build.py /path/to/dist`.

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

### 8. Shared Ceilings & Evidence (v2.5.0)

For cohorts, per-identity budgets dilute by rotation; a shared ceiling does not - but only if reservation is transactional. Declare the cohort, reserve before serving, commit after:

```ts
import {
  createDisclosureLedger, createInMemoryTransactionalStore,
  createCusumTripwire, clampEnforcement, consequenceTargets,
  createProtectedCohortRegistry, defaultHerdBandResponse, herdFrictionTargets,
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
// budgetStepDownFloorRecords: 500, ladder: false) on both bands.
// Apply that friction only to the members who produced the
// evidence (2.5.0): herdFrictionTargets(snap) keeps members whose
// unique coverage is material, consequenceTargets(snapshot)
// keeps net contributors - then partition through the registry
// so protected subjects stay at zero.

// Canary-echo (2.5.0): mint a signed reference FOR this identity
// and embed it in its own surface (a record, a hidden link); when
// a different identity presents it back, link the two cohorts.
const echoId = mintEchoId(secret, { mintedFor: "account:123" });
const ref = mintEchoRecord(secret, { mintedFor: "account:123" });
// ...later, on the detail route, before the record lookup:
const echoFrom = resolveEchoFrom(secret, presentedId);
if (echoFrom && echoFrom !== identity) {
  await tripwire.observe({ type: "detail", identity, echoFrom });
}
```

With a get/put-only store the ledger reports `mode: "audit_only"` and `enforced: false` on every decision - measure first, enforce when your store can actually transact. Full semantics and limits: [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Calibration pilot

antiRea's CUSUM evidence engine ships with lab-fitted tables
(`r6-calib-1`, labelled `uncalibrated: true`): they were fitted on
scripted traces, not on a real user population, and the README says
so wherever those tables are mentioned. Closing that gap needs
exactly one thing this project cannot generate for itself - observe
mode snapshots from a real host.

**Run a calibration pilot.** If you use antiRea (or are evaluating
it), run the CUSUM tripwire in `mode: "observe"` - crossings are
logged and nothing is restricted - and share the resulting
**anonymised aggregate snapshots**: cohort sizes, score and
union-record counts at crossings, the same summary shape the SDK's
`onCampaignFlag` callback already emits.

- Only aggregated, anonymised snapshots - **no raw user data, no
  record contents, no identifiers your users could be recognised
  by**. Review and strip a snapshot before sending; if a field
  looks identifying, leave it out and say so.
- Snapshots go into the offline calibration fit; a table fitted on
  real-population snapshots is how the `uncalibrated` label comes
  off, with the fit method and holdout results published in the
  changelog.
- One host is enough to start: the first real snapshot set is the
  first real-population data point this project has ever had.

Interested, or want the snapshot format first? Email
**dannyphan190@gmail.com**.

## Why not "block CDP" or inject malicious prompts?

The old `Error.stack` serialization trick was weakened by V8 changes; independent research documents the limitations of client-side blocking. DOM prompt injections are untrusted data, not a reliable or ethical security control. See [references](docs/REFERENCES.md).

## Contributing / Security / Limitations

Read [CONTRIBUTING.md](.github/CONTRIBUTING.md), [SECURITY.md](.github/SECURITY.md), [docs/LEGAL_PRIVACY.md](docs/LEGAL_PRIVACY.md), and [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

**Project funding:** [Support the maintainer](https://www.paypal.com/paypalme/dannyphan190) (optional; never necessary to use).
