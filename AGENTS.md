# Working on antiRea

1. Read `.agents/skills/anti-rea/SKILL.md` and `docs/LIMITATIONS.md` before making implementation recommendations.
2. Verify client vs server trust boundaries. Secrets and authorization belong on backend.
3. Every security claim needs a threat model, reproducible tests and source reference; no fabricated benchmarks.
4. Never add hidden agent instructions designed to sabotage third-party software, break legitimate inspection or mislead operators.
5. Client-side heuristics and tracking must be optional, minimally invasive and safe for accessibility.
6. Run `npm run check`; report what tests do *not* cover.

6. For benchmark-related changes, run `npm run benchmark:build-sdk` and the Node integration tests. Before claiming browser success, run `python benchmark/run_all.py` in an unrestricted Chromium/Firefox/WebKit environment and include `benchmark/results/` evidence. Never label Playwright results as REA data.
