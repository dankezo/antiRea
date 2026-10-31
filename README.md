<div align="center">

# antiRea
### Protect the valuable parts of your web app, not the illusion that its UI is invisible.

**Web application reverse engineering risk assessment - Anti-scraping guidance - TypeScript security toolkit**

[Tiếng Việt](README.vi.md) - [Threat model](docs/THREAT_MODEL_REA.md) - [Limitations](docs/LIMITATIONS.md) - [QA evidence](docs/QA_2026-10-31.md) - [Discovery guide](docs/DISCOVERY.md) - [Contributing](CONTRIBUTING.md)

![MIT](https://img.shields.io/badge/license-MIT-blue) ![status](https://img.shields.io/badge/status-beta-orange)

</div>

Built a SaaS app and worried someone could copy it? antiRea helps you identify what is exposed, move sensitive logic to your server, and add optional canaries and attribution. It cannot stop someone from inspecting code or data already sent to their browser.

**Try the beta:** install the package, then use the examples in [Quick start](#quick-start). No npm account is needed to download it.

## v2.1: controlled twin-SaaS benchmark

[View the Northstar synthetic SaaS preview](benchmark/demo/preview.png)

**New:** a complete synthetic Northstar SaaS dashboard with **baseline (`:4173`) and protected (`:4174`)** variants, identical UI and business fixtures, actual compiled antiRea SDK imports, local canaries, 4-per-minute server-side export quota, a browser test runner and evidence JSON for Chromium/Firefox/WebKit. No external assets or services are used by the demo. GitHub Actions runs the checks and Chromium benchmark; the three-engine matrix is also available as a manual workflow.

```bash
npm install
npm run build && npm run benchmark:build-sdk
python -m pip install playwright
python -m playwright install chromium firefox webkit
python benchmark/run_all.py --browsers chromium,firefox,webkit --iterations 5
```

Or run `npm run benchmark:baseline` and `npm run benchmark:demo` in separate terminals to view the two demo apps. **Browser benchmark is not a REA measurement:** official REA operator workflow is in [benchmark/rea/README.md](benchmark/rea/README.md); [test status and limitations](docs/DEMO_BENCHMARK_2_1.md), [optional external reference targets](docs/TARGETS.md), and [independent reconstruction protocol](docs/RECONSTRUCTION_STUDY.md). The original v2.1 benchmark contained defects; see [independent QA and release status](docs/QA_2026-10-31.md). Benchmark results are environment-specific and do not prove cloning resistance.

## What is it?

antiRea helps owners and authorized maintainers make *economically valuable* application behaviour harder to copy. It was motivated by tools such as [morluto/rea](https://github.com/morluto/rea) but is not a blocker for REA, Playwright, CDP or browser screenshots. A client-controlled browser can read client code, network responses and rendered output. There is no reliable JavaScript switch that prevents an owner of that browser from inspecting it.

The original v1.0 prototype included forceful prompt injection, CDP debugger traps, unreliable invisible screenshot fingerprints, and claims of strong protection not supported by tests. **v2.0 beta changed to a safer, evidence-led model.** See [CHANGELOG](CHANGELOG.md) and [v1.0 audit](docs/AUDIT_2026-10-31.md).

## What protects what?

| Layer | Ship status | Realistic benefit | Cannot do |
|---|---|---|---|
| **P0 Server architecture** | Design guide | Keep secrets and proprietary workflows server-side; authorization, field minimization, quotas | Hide everything already served to an authorized user |
| **Tier 1: passive** | SDK + config samples | No public source maps; truthful reuse notice; fragile asset provenance markers | Block DOM inspection or prove copyright ownership |
| **Tier 2: canaries and signals** | SDK, opt-in | Identify suspicious requests to dedicated decoy endpoints; weak automation hints | Identify every bot or force tools to stop |
| **Tier 3: authenticated envelope** | SDK, advanced/server-use | Integrity, context binding and replay checking of short-lived messages | Hide API plaintext from a browser possessing its decryption key |
| **Tier 4: on-screen attribution** | SDK, opt-in | Display a short-lived opaque token which may appear in screenshots | Stop recording, survive cropping, or prove account guilt unaided |

**Default recommendation: P0 architecture + Tier 1.** Enable server canaries after review. Opt in to client-side instrumentation only where the value and privacy trade-offs are justified. No measured latency or false-positive rate is claimed.

## Quick start

Requirements: Node.js 20+. The SDK has no runtime dependencies.

Install the beta into your app from GitHub Releases:

```bash
npm install https://github.com/dankezo/antiRea/releases/download/v2.1.0-beta.3/dannyphan190-anti-rea-2.1.0-beta.3.tgz
```

The scoped npm publication is being processed by the registry and may not yet be available. Once available, use `npm install @dannyphan190/anti-rea@beta`.

To build and test this repository from source:

```bash
npm install
npm run check
npm run build
```

To package a local working copy:

```bash
npm pack
# npm install ../antiRea/dannyphan190-anti-rea-2.1.0-beta.3.tgz   (from your app directory)
```

### 1. Publish an honest rights notice (optional)

```ts
import { injectAgentNotice } from "@dannyphan190/anti-rea";
const cleanup = injectAgentNotice({
  brandName: "Example SaaS",
  canonicalOrigin: "https://app.example.com",
  termsUrl: "https://app.example.com/terms",
});
// On SPA teardown: cleanup();
```

This does not control agents; it communicates usage terms.

### 2. Deploy a server canary

```ts
import { handleCanaryTrapRequest } from "@dannyphan190/anti-rea";

const result = await handleCanaryTrapRequest(request, {
  onAlert: async event => { /* send sanitized event to your monitoring platform */ },
  resolveUserId: () => trustedServerSession.userId,
});
if (result.isTrapped) return Response.json(result.body, { status: result.status });
```

`request` must provide `{url, method?, headers.get()}`; handle on your existing server routes. Never rely on a browser-supplied `x-user-id`, and only configure `trustedIpHeader` if your trusted proxy replaces that field. Do not automatically ban on a single hit. Full examples: [Node server](examples/node-canary-server.cjs), [server checklist](docs/SERVER_SIDE_CONTROLS.md).

### 3. Optional watermark for authenticated previews

```ts
import { mountForensicWatermark } from "@dannyphan190/anti-rea";
const remove = mountForensicWatermark({ token: "A7fK3w9Z", enabled: true });
// Resolve that token to a session only in your private server ledger.
```

Do not embed the person's email, IP or raw user ID in pixels. Give a privacy notice and retention policy.

### 4. Advanced envelopes: server-owned keys only

```ts
import { createEnvelopeKey, encryptPayload, decryptPayload } from "@dannyphan190/anti-rea";
const key = await createEnvelopeKey(); // demo: key lifetime ends with process
const scope = { purpose: "report-export", method: "POST", path: "/api/export", sessionBinding: "trusted-session-id" };
const env = await encryptPayload({ result: "ok" }, key, scope);
const seen = new Set<string>(); // DEMO ONLY: production needs atomic Redis SET NX PX
const decoded = await decryptPayload(env, key, scope, { markNonceOnce: k => !seen.has(k) && (seen.add(k), true) });
```

Use this pattern for independently controlled server services or carefully designed session protocols. If the client holds the key, it can decrypt the data. AES-GCM already authenticates the ciphertext; extra HMAC is not automatically required. TLS, authentication and authorization remain mandatory.

## Why not “block CDP” or inject malicious prompts?

The old `Error.stack` serialization trick was weakened by V8 changes; independent research in 2025 documents the break. DOM prompt injections are lower-trust data, not instructions that can legitimately control a coding agent. Injecting instructions to sabotage reconstructed code or mislead an agent's user harms legitimate audits and is not an ethical security strategy. See [references](docs/REFERENCES.md).

## Test, verify, measure

Run `npm run check` for automated tests and static repo guardrails. Scan the exact public output directory using `python3 scripts/verify-build.py /path/to/public-assets`. Local browser tests are not proof of anti-cloning effectiveness. For any effectiveness claim use the [test protocol](docs/BENCHMARK_PROTOCOL.md), collect screenshots/build/network comparisons and publish reproducible evidence and failures.

## Contributing / security / limitations

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [docs/LEGAL_PRIVACY.md](docs/LEGAL_PRIVACY.md) and [docs/LIMITATIONS.md](docs/LIMITATIONS.md). The AI skill lives in [`.agents/skills/anti-rea/SKILL.md`](.agents/skills/anti-rea/SKILL.md); it begins with consent and auditing, not automatic installation of aggressive traps. You may use the MIT-licensed code with attribution as the license requires.

**Project funding:** [Support the maintainer](https://www.paypal.com/paypalme/dannyphan190) (optional; never necessary to use the project).
