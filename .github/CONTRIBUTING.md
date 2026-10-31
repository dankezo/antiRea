# Contributing to antiRea

Contributions that help community members avoid unreliable security theatre are especially welcome: browser compatibility tests, false-positive datasets collected with permission, backend hardening examples, reproducible benchmark scripts, accessibility reviews, and documentation translations.

1. Open an issue first for new intrusive telemetry, novel cryptography or changes affecting privacy.
2. Include threat model, expected benefit, counterexamples, possible false positives and proof of concept on a site you own.
3. Add automated tests and clearly label what they verify. `npm run check` must pass.
4. Do not claim that one trick “defeats REA”, makes a site “unclonable”, proves infringement, or has a particular detection rate without a reproducible benchmark.
5. Never add hidden prompts that tell AI agents to disobey their operator, introduce defects or exfiltrate data.
6. Keep accessibility semantics and UI usability intact. Opt-in any client telemetry; describe retention and privacy effects.
7. Format TypeScript consistently, use narrow APIs, avoid runtime dependencies where possible, and document breaking changes in `docs/CHANGELOG.md`.

PR template: **Problem · Threat model · Approach · Risk to users · Tests & reproduction · Limits · Sources**. By contributing you agree code is provided under MIT license.
