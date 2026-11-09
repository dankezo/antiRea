# antiRea

Server-side TypeScript library that meters dataset access per identity and flags coordinated bot abuse for web apps and SaaS. It caps bulk extraction and dataset cloning with per-identity record budgets, signed pagination cursors, export guards and Web Bot Auth verification (RFC 9421), and it detects coordinated cohorts that no single-account check can see: scheduler-driven herds, seat squatting, vote brigading, room hopping and reconnect storms.

Every signal is advisory only. antiRea measures and reports with `enforcement: "none"` and the host application decides the response, typically a step-up check for new actions only. Version 2.8.0 adds the combined room guard and an evidence layer with config provenance hashes, verified-neutral identity facts, single-use step-up proofs and evidentiary roles, so verdicts stay auditable.

Install with `npm install @dannyphan190/anti-rea`. Requires Node.js 20 or newer, zero runtime dependencies, MIT licensed. This plugin bundles the antiRea integration skill, which teaches Claude how to wire each module correctly, respect the advisory-only rule, and run the post-integration verification checklist. All effectiveness numbers in the skill come from seeded lab simulation, not production traffic, and are presented that way.
