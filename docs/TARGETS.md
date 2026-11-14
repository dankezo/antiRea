# Candidate sample apps and ethical test boundaries - checked 2026-10-31

**Do not run active, automated adversarial anti-REA testing against random third-party websites.** A public demo being reachable does not grant permission to scan it, flood endpoints, or install JavaScript protections. Fork and run locally, check each project's license and rules, and use synthetic data. These are optional *external reference targets*, not benchmark results.

| Priority | Project | Why it fits / limits | License / safety | Official URL |
|---|---|---|---|---|
| **1 (primary)** | Northstar twin SaaS (this repo) | Exact same app and fixture in two modes; can measure UI, APIs, DOM, canaries, export limits, privacy | Owned synthetic data, local only. Best for A/B causal comparisons. | `benchmark/demo/` |
| **2 (UI baseline)** | TodoMVC (`tastejs/todomvc`) | Small, familiar list UX, many frameworks, deterministic todo actions; easy for Playwright/REA to understand. Lacks backend/authentication for meaningful API protection. | MIT according to upstream; self-host app for tests. | https://github.com/tastejs/todomvc |
| **3 (full stack)** | RealWorld / Conduit (`realworld-apps/realworld`) | Standard article/feed/profile API and workflows, multiple fullstack implementations. Good for measuring route/model exposure and server-side boundaries; higher setup variability. | Check exact selected implementation license before copying/modifying code; use local stack. | https://github.com/realworld-apps/realworld |
| **4 (security lab)** | OWASP Juice Shop | Purpose-built intentionally vulnerable Node/Angular/Express app, suitable for testing endpoint protection and potential security regressions. Not an anti-cloning control benchmark on its own. | Vulnerable by design: **never expose locally deployed instance to the public internet**. Follow OWASP instructions. | https://owasp.org/www-project-juice-shop/ |

### Recommended experiment ladder

1. **Twin SaaS** for controlled A/B with unit tests and real browsers.
2. **TodoMVC** for keyboard, accessibility and front-end inspection false positives, locally.
3. **RealWorld** when you need authenticated server-side API workflows and business-state comparison.
4. **Juice Shop** only for isolated security-hardening regression analysis; keep separate from efficacy marketing.

The existence of a demo URL or repository does not establish permission to perform external security tests. Direct captures/automations must be run only against your own deployment or with explicit authorization.
