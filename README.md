<p align="center">
  <img src="logo.svg" alt="antiRea logo" width="104">
</p>

<h1 align="center">antiRea</h1>

<p align="center">
  <strong>Build it. Ship it. Keep it yours.</strong>
</p>

<p align="center">
  antiRea is a server-side TypeScript library that meters dataset access
  per identity and flags coordinated bot abuse - bulk extraction crews,
  scheduler-driven herds, seat squatting. Advisory only: it flags, you decide.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://www.npmjs.com/package/@dannyphan190/anti-rea"><img src="https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg" alt="npm version"></a>
  <a href="https://github.com/dankezo/antiRea/actions/workflows/ci.yml"><img src="https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="tests/"><img src="https://img.shields.io/badge/tests-963%20total-informational" alt="tests: 963 total"></a>
</p>

<p align="center">
  <a href="https://antirea.dannyphan.me">Website</a> -
  <a href="docs/THREAT_MODEL_REA.md">Threat model</a> -
  <a href="docs/LIMITATIONS.md">Limitations</a> -
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  English - <a href="README.vi.md">Tiếng Việt</a> - <a href="README.zh.md">中文</a> - <a href="README.es.md">Español</a>
</p>

---

## The problem, in 30 seconds

Cloning tools can watch your app's pages, bundles and traffic, then
rebuild what they saw. You cannot hide code a browser has already
received - so antiRea defends the other side: the data itself.

**Unprotected.** Anyone with an account can take your data home.
In our tests, one account walked away with the entire 10,000-record
dataset in under 200 requests. Quietly. Nothing unusual in the logs.

**Protected.** Real users notice nothing.
Each identity can only ever receive a capped slice - 20% of the
dataset in our test setup - so copying stops being an export and
becomes an identity problem.
Split the work across many accounts, and the herd detector flags
the coordination.

- The run that took everything with 1 account was **stopped at 5%**.
- A scripted crew that insisted on finishing needed **25 identities
  and about 19 minutes** - and was flagged on the way.

> Unprotected, your data leaves whole, free and invisible.
> Protected, it leaves in slices, at a cost, and on the record.

Full numbers: [Measured results](#does-it-work-measured-results).

## Install

```bash
npm install @dannyphan190/anti-rea
```

Node.js 20+. Zero runtime dependencies.
Also available via [GitHub Release](https://github.com/dankezo/antiRea/releases).

## Quick start

Request quotas cap speed. A record budget caps how much of the
dataset one identity can ever receive, however politely it asks.

```ts
import { createRecordBudget, createHerdDetector } from "@dannyphan190/anti-rea";

// One identity receives at most 2,000 distinct records per day.
const budget = createRecordBudget({ maxDistinctPerWindow: 2_000 });
const herd = createHerdDetector({
  onFlag: snap => { /* snap.band: "budget_cut_supported" | "graduated_only" */ },
});

// Check before the handler runs:
if (!budget.check("account:123", 1).allowed) { /* return 429 */ }

// Then record what the response actually served:
budget.consume("account:123", recordIdsServed);
herd.observe({ type: "list", identity: "account:123", ip: serverSeenIp, recordIds: recordIdsServed });
```

Use the same identity string (`account:<id>`) in both, and a herd
flag can feed straight into a budget cut via `applyHerdLadder()`.

## What's inside

Five groups. Start at the top; each layer is independent.

| Group | What it does, in plain words | Main pieces | Honest limit |
|---|---|---|---|
| **Meter** | Caps how much data any one identity can ever receive, and how fast | Record budget (`createRecordBudget`), quota and pagination guard (`createQuotaGuard`), priced exports (`createExportGuard`), session cursors (`mintCursor` / `verifyCursor`), flow scoring (`createFlowScorer`) | Attackers can rotate identities - pair with real signup cost on your side |
| **Surface** | Controls WHAT may cross the boundary: fields a response never declared (the password hash in a profile payload) and fields a request was never offered (the `role` in a profile update) | Field guard, both directions (`createSurfaceGuard`) - built-in sensitive/privileged denylists plus per-route schema allowlists; advisory by default, strip or block only when the host says so | Sees field names, not values or ownership - a declared field filled with someone else's data is still your authorization logic's job |
| **Ownership** | Spots one identity sweeping through other people's objects (the BOLA/IDOR walk - sequential ids, random ids, or a slow spread over hours) and reports it with evidence | Ownership probe (`createOwnershipProbe`) - per-identity distinct-owner ratio over rolling windows (1 h by default, add 6 h for slow sweeps), public routes exempt, incremental state with O(1) verdict reads; advisory only | A flag is a shape, not proof - authorization stays your job, and a sweep under the floors or concentrated on few owners is out of reach |
| **Watch** | Spots coordination: many identities quietly tiling your dataset, probing decoys, or crowding a room | Herd detector (`createHerdDetector` + `applyHerdLadder`), phase signals (`createHerdPhaseSignal`, `createActivityPhaseSignal`), room guard (`createRoomGuard`), canary traps and decoys (`handleCanaryTrapRequest`, `createCanaryMaze`, `createDecoyMirage`), automation telemetry (`detectAutomationSignals`), source-map hygiene (`verify-build.py` / `run-audit.cjs`), volume-rank rule (`applyVolumeRankRule`), empirical-mix calibration (`selectEmpMixThreshold`), session-timing features (`computeHoldTypeFeatures` / `createHoldTypeScorer`), early-minimal occupancy signal (`createOccupancyEarlyMinimalSignal`) | Detection is not enforcement - low-tiling herds get a graduated response, and one adaptive herd was flagged yet still finished |
| **Prove** | Pins down what a verdict means: which config produced it, who actually signed, what may ground a consequence | Config provenance (`createConfigProvenance`), Web Bot Auth verification (`createWebBotAuthVerifier`), step-up proofs (`issueStepUpProof`, `createStepUpProofVerifier`), step-up consequence shaping (`createStepUp402Responder`), evidence roles (`evidentiaryRoleOf`, `auditEvidencePack`, `decorateSignalResult`) | A verified signature is identity, not authorization - your auth checks stay exactly as they are |
| **Trace** | Optional client-side aids for leaks and replay | Context-bound envelopes (`encryptPayload` / `decryptPayload`, `createInMemoryReplayGuard`), forensic watermark (`mountForensicWatermark`), preference declaration log (`createDeclarationLog`) | Traceability, not access control - overlays can be cropped, and the browser holds its own context |

**Recommended order:** quota guard first (see below), then the
record budget, then herd detection.

## Does it work? Measured results

**Method, in short.** We test against **Ledgerly**, a synthetic SaaS
holding 10,000 records behind 120 accounts, run twice: unprotected,
and the same app with antiRea wired in. Attack runs are driven by
REA 6.8.0 (`rea-agents`) and by general-purpose agents following the
standard clone workflow; polite-user runs measure the cost to
legitimate traffic. An independent benchmark was published in
[issue #1](https://github.com/dankezo/antiRea/issues/1) - most claims
held up, and the gaps it found are fixed and in the changelog.
Full method and per-layer table: [docs/EVIDENCE.md](docs/EVIDENCE.md).

| Layer | Headline result |
|---|---|
| No protection (baseline) | The full 10,000-record dataset leaves in **160-193 requests** |
| Record budget | One identity is capped at exactly **20%** of the dataset |
| Herd detector + CUSUM evidence | REA-style identity rotation stopped at **5%**; an adaptive crew needed **25 identities and ~19 minutes** |
| Declared cohort ceiling | The cohort union stopped at exactly **600 records**, zero served past the cap |
| Legitimate users | Declared team **1,200/1,200 with zero friction**; polite users zero consequences |
| Action budget (lab) | Feature-abuse herd completed **16/80 operations (20%)**; ordinary users **48/48**, zero consequences |
| Advisory signals (lab) | Five slow-shape signals: **0-1.67%** false flags on legitimate traffic - per-signal numbers in the full table |

**What this adds up to.** The casual one-shot clone is gone. Bulk
extraction becomes an identity problem: every extra slice costs
another account and more visibility. It does not stop a determined,
well-resourced rebuilder - and the real price of an identity
(signup friction, verified accounts, payment) is set by you, which
is why budgets are per identity and herd flags distinguish "cut
the budget" from "step up scrutiny".

## Also speaks MCP

antiRea ships an official MCP server for AI agents:
[`@dannyphan190/anti-rea-mcp`](https://www.npmjs.com/package/@dannyphan190/anti-rea-mcp)
([source](https://github.com/dankezo/anti-rea-mcp)), built on the
official `@modelcontextprotocol/sdk`, speaking MCP over stdio.

It exposes the library's eight advisory signal kinds as six tools -
`list_signals`, `create_signal`, `observe`, `observe_reference`,
`evaluate`, `close_signal` - so an agent can open a signal session,
feed it events and read the verdict.

```json
{
  "mcpServers": {
    "anti-rea": {
      "command": "npx",
      "args": ["-y", "@dannyphan190/anti-rea-mcp"]
    }
  }
}
```

It is an evaluation and demo channel. Production protection still
belongs in-process, in your own app.

## Latest release

### v2.9.2 - Audit and hardening

Exact token matching, bounded telemetry state, correct late-event ownership windows, finite invalid-session features, and cycle-safe surface inspection. The host still decides every consequence; runtime dependencies remain zero.

The local Windows audit ran 963 tests: 960 passed, none failed, and 3 skipped (two RSA-PSS vectors and one symlink privilege case). Historical lab figures below retain their original scope; missing generators are explicitly NOT VERIFIED in the audit.

[2.9.2 deep dive](docs/v2.9.2-deep-dive.md) | [Audit measurements](docs/audit-2.9.2.json)

### v2.9.1 - the 402 step-up answer, and five lab graduates

[2.9.1 deep dive](docs/v2.9.1-deep-dive.md)

> Volume-rank lab strata are generator components. The SDK groups by observed volume: the rerun found 1/115 HIGH false flags at kappa 1000, so the historical 0.007 bound is not a universal bound for SDK regrouping.


- **Problem:** a step-up challenge tells a machine caller to
  stop but hands it nothing machine-readable to act on - and
  five research-lab graduates were still sitting unbuilt,
  including the declared A1 hole in the room occupancy laws.
- **New module - `createStepUp402Responder`:** shapes the
  consequence of a step-up trigger as an HTTP 402 response in
  x402 style - an `X-Payment-Required` header plus a manifest
  body with pay, appeal and continue-free next steps, and
  `checkAssertion` for the session token. No settlement and
  no payment processing; the price is a signal. Measured in
  the lab (RECOMB-09, PASS-lab): cooperative agents retreated
  in 94.5% of sessions and presented a valid assertion in
  94.0%; 0 legitimate dead-ends across 200 browser and 200
  API sessions. Agents that ignore the manifest are
  unaffected - that is the format's honest ceiling.
- **New module - `createDeclarationLog`:** an append-only,
  hash-chained host-side log proving a preference
  declaration (robots.txt Content-Signal, an RSL License
  line, aipref Content-Usage) existed before a republished
  copy appeared; it pairs with the C39 value watermark
  (`createValueWatermark`), which is what survives
  republication. Measured in the lab (RECOMB-10, PASS-lab):
  the declaration arm matched watermark-only at 18/18 gated
  cells (100%), 0 mis-attributions on 200 honest datasets,
  the log verified 200/200. The log proves ordering and
  integrity only - not crawler compliance, not legal
  recognition.
- **New signal - `applyVolumeRankRule`:** the R2 rule over
  volume strata (frozen boundaries 63.2 / 632.5): an
  identity is flagged when at least 2 of its rare cells
  rank in the top 5% of all cells by two-component EB05
  score (top 10% reported descriptively). Measured in the
  lab (RECOMB-04, PASS-lab): walker detection in the MID
  stratum 0.90 / 0.85 / 0.85 at kappa 100 / 300 / 1000,
  legitimate false positives at most 0.007 at gated kappa 100/300/1000 in every stratum
  with at least 20 legit identities; detection was measured
  in MID only, where every walker lived.
- **New helper - `selectEmpMixThreshold`:** the
  empirical-mix calibration law for clustering-threshold
  selection: mixed FMR is read over a 50/50 calibration set
  (null permutations plus flat empirical forests), choosing
  the largest grid point whose mixed FMR stays at most 1%,
  or null when none qualifies. Measured in the lab
  (RECOMB-05, PASS-lab, R14 branch-C frame only): the mixed
  set held the selection at h = 0.36 across 0-30%
  contamination, while the null-only set flipped at 10% and
  failed the flat false-positive gate.
- **New features - `computeHoldTypeFeatures` /
  `createHoldTypeScorer`:** five session-timing features
  (mouse event rate, click duration SD, key hold SD,
  inter-key SD, programmatic-type ratio s_type) and the
  frozen signed-z composite S_R2 with set2/type sub-scores,
  against a host-supplied human reference. RECOMB-02 is
  PASS-LAB Step 0 only: feature separation was measured,
  and NO detection claim ships - thresholds stay host-side
  (the lab used the outer-5% tail of the human composite
  distribution).
- **New signal - `createOccupancyEarlyMinimalSignal`:**
  the A1 counter for fresh identities - sessions of
  identities created less than 24 h before join, holding
  1-2 activities so far, every activity within 300 s of
  join; D2-FAST flags a ratio of at least 0.50 sustained
  600 s, D2-DRIP at least 0.34 sustained 3600 s. Measured
  in the lab (A1-COUNTER-D2, PASS-lab): fast squats flagged
  at +690 s, DELAY-300 at +960 s, drip at +1440 s, and the
  legit twins and new-lurker cell unflagged - but the
  lurker gate passed with exactly one session of headroom
  (d2max 0.3333 against the 0.34 drip bar), first-activity
  delays in the (300 s, ~630 s) band evade both laws by
  design, and 3-activity squats evade by construction.
  Advisory only.

### v2.9.0 - the surface guard, and the declared-cohort pattern

- **Problem:** budgets cap how MUCH an identity takes, not WHAT a
  response carries. The recurring real-world leak is one over-broad
  payload: a profile or search response riding along the password
  hash, national id and bank account (Spoutible 2024, the eHUST
  student-search leak, Power Apps 2021). The mirror image on the way
  in is mass assignment - a write that binds `role` or `owner_id`
  because the caller submitted it.
- **New module - `createSurfaceGuard`:** inspects JSON payloads in
  both directions against a built-in sensitive/privileged field
  denylist plus your per-route allowlists. Advisory by default;
  strip or block only when you say so. Measured on seeded corpora:
  0 false positives on 2,000 legitimate responses and 2,000
  requests; 1,194 of 1,194 injected sensitive fields and 918 of
  918 injected privileged fields caught.
- **New pattern - declared-cohort union budget:** the herd burst
  that drained the test range in 15 seconds gets its documented
  answer: one record budget keyed by a host-declared cohort id, so
  rotation inside a declared cohort stops diluting the cap
  (runnable example with verification:
  [examples/declared-cohort-budget](examples/declared-cohort-budget)).
- Write-up: [v2.9.0 deep dive](docs/v2.9.0-deep-dive.md) -
  previous: [v2.8.1 deep dive](docs/v2.8.1-deep-dive.md).

### v2.8.1 - the span gate fix

- **Problem:** inside a fraction of one grid period (900 s by
  default), the herd-phase and activity-phase signals could confirm
  a group that was only briefly in sync. On this project's own test
  range, 12 legitimate readers were confirmed over a 40 s window.
- **Fix:** a member now counts only when its event span covers at
  least one full grid period; only eligible members are named, and
  results carry the new `spanEligibleMembers` field.
- Write-up: [v2.8.1 deep dive](docs/v2.8.1-deep-dive.md).

### v2.8.0 - the room guard, plus an evidence layer

- **`createRoomGuard`** watches a shared room on 30-second ticks:
  join bursts, churn, and seats held by fresh, silent accounts. It
  recommends step-up for new joins only - seated members are never
  named or touched. One hole is declared openly: a squatter who
  chats even 1-2 messages leaves the occupancy definition.
- **An evidence layer** of four small modules pins down what every
  verdict means: the exact configuration behind it (CS-02), what
  identity verification does and does not prove (BS-01), single-use
  proof that a step-up was passed (CAP-01), and which evidence may
  ground a consequence (KT-01).
- In the lab pin, flood flagged at +60 s, churn at +30 s, seat
  squatting at +690 s - and pressure never fired on five legitimate
  cells, including an audience where 60% of seated sessions never
  say a word.
- Everything is additive and advisory; defaults are unchanged.
- Write-up: [v2.8.0 deep dive](docs/v2.8.0-deep-dive.md) -
  previous: [v2.7.4 deep dive](docs/v2.7.4-deep-dive.md).

## First step: the quota guard

Server-side quotas and pagination bounds, enforced per account,
API key and IP. Returns HTTP `429` with `Retry-After`, and logs
structured events for operators.

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
    accountId: req.headers.get("x-verified-account") ?? undefined, // from your server auth
    apiKeyId: req.headers.get("x-verified-key-id") ?? undefined,
    tier: "free",
  }),
  onQuotaExceeded: event => {
    console.warn("[quota-exceeded]", event);
  },
}));
```

### More patterns

- **Canary endpoints** - trap routes that log abnormal probing,
  with path canonicalization so variants cannot slip past.
  Runnable example: [examples/node-canary-server.cjs](examples/node-canary-server.cjs).
- **Signed agents** - verify Web Bot Auth (RFC 9421) signatures and
  key quota policy on a stable identity. Runnable end-to-end demo:
  [examples/web-bot-auth-verify.cjs](examples/web-bot-auth-verify.cjs).
- **Python / FastAPI** - the quota guard ported with identical
  tiers, `429` semantics and pagination bounds, held to the same
  test contract: [examples/python-fastapi](examples/python-fastapi).
- **Shared cohort ceilings and the CUSUM evidence engine** -
  transactional reservation across a whole declared cohort, with
  protected cohorts whose telemetry accrues but never draws a
  consequence: semantics in [docs/LIMITATIONS.md](docs/LIMITATIONS.md).
- **Declared-cohort union budget** - the single-process form of the
  same law: one `createRecordBudget` keyed by a host-declared cohort
  id, so identity rotation inside a declared cohort stops diluting
  the cap. Pattern with runnable verification:
  [examples/declared-cohort-budget](examples/declared-cohort-budget).
- **Watermark and envelopes** - see the Trace group above; never
  embed a person's email, IP or raw user ID in watermark pixels.

## Honest limits

- It **cannot** hide code delivered to a browser, or prevent anyone
  from inspecting what their own browser downloaded.
- It **cannot** stop a determined, well-resourced rebuilder. It
  makes bulk copying slow, costly and visible instead.
- The evidence engine's built-in tables were fitted on lab traces,
  not a real user population, and are labelled `uncalibrated: true`
  wherever they are mentioned. See the calibration pilot below.
- Client-side pieces are traceability aids, not access control.
- No client-side bot-blocking tricks and no prompt injections:
  they do not hold up, and they are not ethical controls.
  See [docs/REFERENCES.md](docs/REFERENCES.md).

Full list: [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Reproduce the numbers

The repo ships a Playwright harness that runs a synthetic SaaS
(**Northstar**: dashboard, customer search, lead creation, CSV
export, chart views) in baseline (`:4173`) and protected (`:4174`)
modes, across Chromium, Firefox and WebKit.

```bash
npm install
npm run build && npm run benchmark:build-sdk
python -m pip install playwright
python -m playwright install chromium firefox webkit
python benchmark/run_all.py --browsers chromium,firefox,webkit --iterations 5
```

Working on the repo itself: `npm run check` compiles, runs **963
automated tests** (960 passing, 3 skipped on this Windows machine: two RSA-PSS vectors and one symlink privilege case) and
performs static checks. Scan a public build before deploying with
`node scripts/run-audit.cjs /path/to/dist` or
`python3 scripts/verify-build.py /path/to/dist`.

## Help calibrate it

The one thing this project cannot generate for itself is real
traffic. If you run antiRea (or are evaluating it), run the CUSUM
tripwire in `mode: "observe"` - crossings are logged, nothing is
restricted - and share the **anonymised aggregate snapshots** it
emits: cohort sizes, scores, union-record counts.

No raw user data, no record contents, no identifiers. Review and
strip a snapshot before sending; if a field looks identifying,
leave it out and say so. The first real snapshot set is how the
`uncalibrated` label comes off.

Interested, or want the snapshot format first?
Email **dannyphan190@gmail.com**.

## Documentation

- [Threat model](docs/THREAT_MODEL_REA.md) - what antiRea assumes about attackers
- [Limitations](docs/LIMITATIONS.md) - what it does not do
- [Evidence](docs/EVIDENCE.md) - full measured results and method
- [Legal and privacy notes](docs/LEGAL_PRIVACY.md)
- Deep dives: [v2.9.0](docs/v2.9.0-deep-dive.md) - [v2.8.1](docs/v2.8.1-deep-dive.md) - [v2.8.0](docs/v2.8.0-deep-dive.md)
- [v2.9.1 deep dive](docs/v2.9.1-deep-dive.md)
- [v2.9.2 deep dive](docs/v2.9.2-deep-dive.md)
- [Changelog](CHANGELOG.md)

## Contributing and security

Read [CONTRIBUTING.md](.github/CONTRIBUTING.md) and
[SECURITY.md](.github/SECURITY.md) before opening a pull request
or a vulnerability report.

**Project funding:** [Support the maintainer](https://www.paypal.com/paypalme/dannyphan190)
(optional; never necessary to use).

<p>
  Featured on
  <a href="https://launchnest.io/p/antirea" target="_blank"><img src="https://launchnest.io/badge/antirea.svg?variant=featured" alt="antiRea on LaunchNest" width="160" height="40" /></a>
</p>
