# Anti-cloning benchmark protocol (not a claim of current test results)

## Goal

Measure *cost and information exposure* rather than pretending to achieve 100% blocking. Compare the same demo application **baseline vs antiRea + P0 server controls**, with an identical asset set and seed data.

## Required environments

- At least one modern stable Chromium and Firefox; repeat on mobile viewport / keyboard navigation.
- Unauthenticated and authenticated test accounts; never use production personal data.
- Inspect public build artifacts, requests, source map access, relevant REA observations (where permissioned), screenshots, direct API clients.
- Record versions and opt-in REA flags; avoid assuming observations expose raw data when they only report shapes.

## Four independent experiments

1. **Build exposure:** public `.map` count, original sources and strings in JS chunks; identify whether removed or just encoded. Measure bundle size, transfer and runtime overhead.
2. **App flow capture:** compare observed DOM/network/visual functionality using REA or another authorized inspector, with and without antiRea. Separately report the real server-side controls.
3. **Canary false positives:** simulate QA crawling, scanners, accessibility tools and scripted test automation; measure alerts per 1,000 legitimate sessions. Do not harm actual users.
4. **Watermark recovery:** retain token in reference screenshots, compare resizing, JPEG compression, crop, theme, screen recording; report exact successful/failed attempts, not a guessed success rate.

## Publish results like this

| Metric | Baseline | Protected | Version / tool | N | Confidence / notes |
|---|---|---|---|---|---|
| Original TS source-map files publicly fetchable | TBD | TBD | TBD | TBD | TBD |
| Requests revealing sensitive fields | TBD | TBD | TBD | TBD | TBD |
| Unauthorized high-value requests accepted | TBD | TBD | TBD | TBD | TBD |
| False positive alerts / 1000 sessions | TBD | TBD | TBD | TBD | TBD |
| Screenshot watermark token still visible | TBD | TBD | TBD | TBD | TBD |
| p95 input latency and CLS/accessibility | TBD | TBD | TBD | TBD | TBD |

**None of these experiments has been reported as completed for v1.1.** Unit tests do not replace them. Publish adversary successes and failed techniques too.
