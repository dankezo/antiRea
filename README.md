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
  <a href="tests/"><img src="https://img.shields.io/badge/tests-1806%20total-informational" alt="tests: 1806 total"></a>
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

### v3.3.2 - The shadow release

The decoy surface learns to answer on the auth tier and on the write path, and antiRea grows its first client component - for one item only, under the DEC-1 decision, which breaks the server-only rule at exactly U2 and nowhere else. Everything is opt-in and OFF by default; runtime dependencies remain zero. A host that enables nothing gets byte-identical behavior to 3.3.1 on real surfaces.

- **Shadow auth tier (N-T3, `createShadowAuthTier`):** a decoy auth tier - a fake permission matrix and decoy records - served only to identities the host's own flag gate marks as flagged. The module accepts no host data source at all: everything it serves is synthetic. Measured (Neon tactics trial): a gpt-5.4-level agent absorbed the shadow tier as a real auth component in 2 of 3 deciding runs (P-T3a HIT 2/3 - the caveat travels with the claim); safety PASS with 0 real account ids in any shadow response, and clean identities received byte-identical refusals with the tier on and off. The shadow loop is closed over the documented public demo credentials only; a flagged identity presenting a valid real token passes through to the host's real flow.
- **Decoy write surface (B-N4, `createDecoyWriteSurface`):** a write-side decoy contract with a frozen fake constraint set - a fake required field, an inverted price format, a fake id space. Decoy 422 responses name the violated constraint, so a clone built against the decoy inherits the fake rules. The module holds no reference to any host store; writes land only in a module-owned sink, and the audit counts routed writes only. Measured (B-N4 trial): agent clones carried all three fake constraints into a clean twin, each producing exactly one purely fake-attributable failure; false positives PASS 36/36 byte-identical. The trial's one audit-gate incident is disclosed in full in the changelog (Addendum E).
- **Polymorphic challenge (U2, `createPolymorphicChallenge` + the DEC-1 client component):** each session, the server issues a JavaScript payload morphed from the session seed - identifiers rotated, step order shuffled, decoy steps mixed in - which the client component executes to answer a step-up; the server verifies arithmetically from the same seed. Challenges are short-lived and single-use: the first verify attempt consumes the challenge, pass or fail. Framing, frozen: U2 is an execution tax, not a wall - a real agent that executes JavaScript still passes. No effectiveness number exists for U2 and none is claimed.
- **REALTEST-3.3.2: LAUNCHABLE.** The canonical release test ran the real REA 6.9.0 attacker against this exact build: a single identity stopped at exactly 150 records with export at 0, the identity-rotation arm took 1,445 of 10,000 records while the 2.9.3 control drained all 10,000, and legitimate traffic saw zero false positives across every pattern. A confirmation re-run on 2026-11-23 against the byte-identical dist returned LAUNCHABLE again with every deciding number identical. Release gate 17/17. The four farm items are NOT in this release: the 2026-11-23 farm verdict failed RECOMB-01 and RECOMB-03 and left C26 and AN-02 inconclusive. The MCP wrapper remains at 2.8.2.

1806 tests: 1804 passed, none failed, 2 skipped.

### v3.3.1 - The provenance release

The decoy surface learns to reference itself, to speak GraphQL, to change shape per identity, and to sign the images it serves. Every feature is opt-in and OFF by default, server-side only, and runtime dependencies remain zero. A host that enables nothing gets byte-identical behavior to 3.3.0 on real surfaces.

- **Provenance fan-out (B2, `buildChainRouteMap` / `chainRoutes` + surface chain serving):** decoy records arranged as a chain of individually routed records - a level-1 record carries the next level's record id, and the next record lives at its own route - so extraction walks one metered fetch per record instead of one page per dataset. Measured (trial v4, arm FAN): real yield 150 -> 100 (-33.3%) under the harness's all-or-nothing page budget; under partial-page accounting the same arm yields 131 (-12.7%, below the registered -15% threshold), so the effect is quoted only with that framing. Decoy retention 78/78, meter 150 in every arm.
- **GraphQL decoy (B3, `buildGraphqlIntrospection`):** a phantom GraphQL schema layered over the host's declared real types - phantom object types, phantom Query fields, decoy fields on real types - served at the declared path as an introspection document. Measured (trial v4, arm GQL): 10/10 planted identifiers (3 phantom types, 3 phantom queries, 4 decoy fields) entered the capture with 0 flags at meter 150. The measured carrier was the endpoint's introspection response; no GraphQL execution ships.
- **Identity-bound variants (B4, `applyIdentityVariants`):** one decoy endpoint whose record list is reshaped per requesting identity - which skew fields exist, which enum values can appear, what the aliased fields are called. Measured (trial v4, arm S1, 2 classes): 8/10 skew fields appeared under exactly one identity; one identity's enum coverage was 60% of the universe; cross-identity field-name overlap was a 30% Jaccard. Not claimed: the mis-map leg - whether extraction code written against identity A's shape then fails on identity B's - was not measured.
- **Image attribution and visible fingerprint (B1 + B5 + B6):** every image the host declares on the surface can carry the requesting identity's AC-23 payload in a Y-DCT watermark (recovered 32/32 from inside the extractor's own output packages in 3/3 watermarked runs, in both image classes served), and record lists can carry a visible per-identity fingerprint woven into the decoy text and list order (all three channels legible in 3/3 fingerprinted runs). Both are attribution mechanisms, NOT recording prevention; the trial verdicts come from the extractor's deterministic + OCR pipeline - the VLM leg did not run.
- **REALTEST-3.3.1: LAUNCHABLE.** Release gate 17/17: a single identity stopped at 150 records with export at 0, the rotation arm lost 1,445 of 10,000 records while the 2.9.3 control drained all 10,000, and legit false positives were 0 across all arms - every deciding number identical to REALTEST-3.3. The four farm items are not in this release; the MCP wrapper remains at 2.8.2.

1772 tests: 1770 passed, none failed, 2 skipped.

### v3.3.0 - The decoy surface: the copy is built from our map

Metering caps how much an extractor takes; this release contaminates what the copies are built from. A host publishes a decoy surface - endpoints, a spec, worked examples - that exists only to be copied, while its real surface stays untouched. Everything is opt-in and OFF by default; a host that enables nothing ships exactly the 3.2.0 behavior.

- **Discovery pack and spec decoy (`generateDecoySurface`, `buildDecoyOpenApiSpec`, `createDecoySurface`):** one registry generates the robots disallow block, the sitemap and an OpenAPI spec declaring live decoys plus phantom endpoints that are never served. In the lab trials the machine-read channels carried 8/8 decoys into the extractor's capture with zero real-user footprint, and 4/4 live plus 2/2 phantom endpoints entered its map with 0 flags.
- **Contradictions that need two halves (A3 + A5 + A6):** a spec-endorsed feed and a worked example each measure at zero alone; combined, and joined by planted cross-route invariant violations inside decoy data, they put 36 authoritative contradiction pairs and 10/10 surviving join violations into the capture, with 0 inconsistencies reported by the extractor.
- **Identity-gated joins and budget-sink expandables (A7 + A8):** decoy joins resolve only under the identity that extracted them - a capture merged from two identities orphaned 30/30 joins (100%) against 0/30 under one identity - and spec-declared expansions bill synthetic subresources to the same record budget, cutting real yield per identity from 150 to 50 records (-66.7%).
- **Canary dose (`planCanaryInterleave`, opt-in, no default in code):** the host mixes its own synthetic records at a dose it states on every call (documented recommendation 10%); measured dose response is linear (10% planted extracted at exactly 10.0%; 25% at 24.7%), and each canary carries an HMAC tag keyed to the serving identity. Across the agent-loop trial the decoy surface multiplied an LLM extractor's token cost by 2.09x (median 7,101 vs 14,808 tokens per session) while the 150-record meter held in every arm.
- **REALTEST-3.3: LAUNCHABLE.** The canonical release test ran the real REA 6.9.0 attacker against this build: a single identity stopped at 150 records with export at 0, the rotation arm took 1,445 of 10,000 while the 2.9.3 control drained all 10,000, and legitimate traffic saw zero false positives. Release gate 17/17. The K1 line (instruction-bearing decoys) stays parked and is not in this release; the MCP wrapper remains at 2.8.2.

1725 tests: 1723 passed, none failed, 2 skipped.

### v3.2.0 - Per-host polymorph surface: anti-reverse that expires

The shipped canary trap paths were identical on every deployment - read the SDK once, know every site's traps forever. This release makes each deployment's surface a different, rotating shape. All of it is opt-in and advisory; no default changes.

- **Polymorph surface (`derivePolymorphCanaryPaths`, `derivePolymorphSurface`):** derive natural-looking canary trap paths from a host seed and a weekly epoch (deterministic, SHA-256 only, zero new dependencies) and pass them to the canary machinery you already use. Last epoch's paths come back as retired traps - detectors only, so a hit on one means old or stolen intel. The fake-endpoint paths stay exactly as shipped: they are the fixed scanner liturgy.
- **Variant integrity (`buildVariantManifest`, `verifyVariantManifest`):** SHA-256 manifests over a variant's files. Verification never throws and never blocks; it returns a signal object with per-file mismatch reasons for you to log or alert on.
- **Polymorph generator (`tools/polymorph/`):** a build-time tool that obfuscates the four surface modules (cursor, canary-echo, fake-endpoints, trap-paths) under your seed, embeds an inert, extractable host-fingerprint watermark for leak tracing (traitor tracing), appends plausible decoy dead code, and writes the surface manifest. javascript-obfuscator is an optional build-time tool for the generator only; the SDK runtime stays zero-dependency.
- **Measured (lab prototype, 2026-11-19):** transformed surface modules cost about 1.6x CPU on the cursor path and +11.7% size across the four modules; on a variant from this release's own generator, the 7 surface test files pass 72/72, a 2,000-case cursor differential fuzz is byte-identical to the clean dist, and echo tokens cross-verify 500/500 both ways. A live agent-readability trial has not been run, so no claim is made about how much harder automated analysis becomes.

1683 tests: 1681 passed, none failed, 2 skipped.

Earlier releases: see the [Changelog](CHANGELOG.md).

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

Working on the repo itself: `npm run check` compiles, runs **1683
automated tests** (1681 passing, none failing, 2 skipped) and
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
