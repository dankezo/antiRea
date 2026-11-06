# antiRea

**Defend what actually powers your application. Do not rely on the illusion that client UI can be hidden from a browser.**

**Risk Assessment Toolkit · TypeScript SDK · AI Agent Skill**

[Tiếng Việt](README.vi.md) · [中文](README.zh.md) · [Español](README.es.md) · [Threat Model](docs/THREAT_MODEL_REA.md) · [Limitations](docs/LIMITATIONS.md) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg)](https://www.npmjs.com/package/@dannyphan190/anti-rea)
[![CI](https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg)](https://github.com/dankezo/antiRea/actions/workflows/ci.yml)
[![dist line coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dankezo/antiRea/badges/badges/coverage.json)](https://github.com/dankezo/antiRea/blob/main/docs/LIMITATIONS.md)
[![tests](https://img.shields.io/badge/tests-746%20passing-informational)](tests/)

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

## New in v2.7.3

The short version: this release is for **live rooms** - watch-together cinemas, karaoke rooms, live streams - after a real platform's rooms kept getting crashed by bot swarms at the application layer. Six new advisory signals ship, each past its own pre-registered lab test; one designed module **did not pass its lab and was kept out**; and the integration docs are now written for the AI coding agent who does most of the wiring. Nothing on the default path changes.

- **The fleet on one timer.** The new herd-phase signal watches *when* accounts act, not how much: feed it one kind of repeated timestamp (room joins, session starts, retries) and it detects a fleet whose actions lock onto the same 900-second timer **at the same offset** - the fingerprint of one scheduler driving many bots. The cohort check is the whole point: an account locked to *its own* timer (a personal cron job, a lone bot) is never named. In the labs, a 60-bot rejoin herd on a shared timer was confirmed (60/60, R_cohort 0.9978), the same herd on individual timers was **not** confirmed (R_cohort 0.0421), and ordinary room life - steady viewing, a 50-user raid after a streamer drops a link, 60 users joining in the same minute for an announced showtime, karaoke prime time - produced no confirmation and no false flags. Advisory only, like everything in this tier: it names a confirmed fleet as evidence; it blocks nothing.
- **Five more room signals, each past its own frozen lab.** *Seat occupancy* is population-only (it describes a room, never a person): it flags when fresh, silent accounts hold half a room's seats for 10 minutes - and a second, slower profile catches the drip variant (a third of seats held silent for a full hour); a silent-audience karaoke cell peaked at 0.13 of the 0.50 line. *Activity-phase* runs the herd-phase law over chat/emote timestamps instead of joins - a room full of real viewers reacting to the same film moment measured **zero** locked members. *Vote brigading* accumulates evidence across minutes: one mass skip by first-time visitors cannot flag a room (it measured a bigger single spike than a brigade makes), two wrecked songs in a row can. *Room-hop* flags an identity joining 16+ distinct rooms in an hour (legit surfers measured at most 11) and disarms itself, naming nobody, if a quarter of the platform suddenly looks like that. *Reconnect storms* flag a source cycling 40+ sub-5-second sessions in 10 minutes (flaky phones measured 13, train commuters 21), with the same self-disarm - and one stated blind spot: a storm spread thin across many sources flags nobody, because rush-hour commutes reach storm-like totals at population level.
- **The module that is not here.** A combined room-guard module (join floods, churn, seat squatting) was designed for this release and passed most of its lab: floods flagged in 60 seconds, slow drips in 31 minutes, churn in 30 seconds, zero false alarms on legitimate rooms. But it **missed seat squatting completely** - bots that quietly take all 30 karaoke seats and just sit there attack occupancy, not join speed, and the pre-registered signals had no occupancy leg. The rules here do not allow loosening the test after seeing the result, so the module was excluded rather than shipped half-blind. There is still no `createRoomGuard` in v2.7.3. The missing occupancy leg was instead re-registered on its own, passed its own frozen lab (above), and ships as the separate seat-occupancy signal - the combined guard remains unbuilt, stated plainly instead of papered over.
- **Docs your agent can execute.** The new [Agent Guide](docs/AGENT-GUIDE.md) maps symptom -> module, gives copy-paste wiring with safe defaults, a never-do list (never hard-block on advisory output; never touch members already in the room), and a verification checklist. If an AI agent integrates antiRea for you, point it there first.
- **Honest layering.** antiRea guards the room door - fake users joining, holding, cycling at the application layer. It does not stop network-layer DDoS; that is your CDN/firewall's job, and this release does not pretend otherwise. All numbers above are seeded simulation, not real-traffic measurements.

Full technical write-up, including the failed gate and its mechanism: [v2.7.3 deep dive](docs/v2.7.3-deep-dive.md). What the previous release changed: [v2.7.2 deep dive](docs/v2.7.2-deep-dive.md).

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

**Method, in short.** We test against **Ledgerly**, a synthetic SaaS holding 10,000 records behind 120 accounts, run twice: a baseline instance with no protection and a protected instance of the *same* app with antiRea wired in. Attack runs are driven by REA 6.8.0 (`rea-agents`) and by general-purpose agents following the standard clone workflow; polite-user control runs measure the cost to legitimate traffic. An independent benchmark of this repository was published in [issue #1](https://github.com/dankezo/antiRea/issues/1); most claims held up under it, and the gaps it found are fixed and recorded in the changelog. The full method note and the complete per-layer table live in [docs/EVIDENCE.md](docs/EVIDENCE.md).

| Layer | Headline result |
|---|---|
| No protection (baseline) | The full 10,000-record dataset leaves in **160-193 requests** |
| Record budget | One identity is capped at exactly **20%** of the dataset |
| Herd detector + CUSUM evidence | REA-style identity rotation stopped at **5%**; an adaptive crew needed **25 identities and ~19 minutes** |
| Declared cohort ceiling | The cohort union stopped at exactly **600 records**, zero served past the cap |
| Legitimate users | Declared team **1,200/1,200 with zero friction**; polite users zero consequences |
| Action budget (lab) | Feature-abuse herd completed **16/80 operations (20%)**; ordinary users **48/48**, zero consequences |
| Advisory signals (lab) | Five slow-shape signals: **0-1.67%** false flags on legitimate traffic - per-signal numbers in the full table |

Full per-layer table, including the blind spots recorded inside its own cells: [docs/EVIDENCE.md](docs/EVIDENCE.md).

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

`npm run check` compiles, runs **748 automated tests** (746 passing, 2 skipped RSA-PSS vectors), and performs static checks. Scan your public build directory before deployment with `node scripts/run-audit.cjs /path/to/dist` or `python3 scripts/verify-build.py /path/to/dist`.

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
