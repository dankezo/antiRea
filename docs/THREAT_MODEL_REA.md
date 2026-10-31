# Threat model: REA and other observation workflows

Scope: applications you own or are authorized to test. Source reviewed: [REA browser observation](https://github.com/morluto/rea/blob/main/docs/browser-observation.md), accessed 2026-10-31. That repository changes frequently; verify it again for every major release.

## Attacker capability, not a caricature

- A0: reads publicly served HTML/CSS/JS, including source maps if exposed. Defensive measure: do not publish secrets/source maps; use server-only modules.
- A1: attaches to a browser with CDP; can inspect structure, script metadata, navigation, and scoped observations. REA's documented default DOM snapshot stores node types/names/attribute names, not text or values; more revealing capture is optional. Defensive measure: avoid sensitive frontend state; do not rely on prompt injection.
- A2: analyzes built JS and optionally source maps; extracts candidates, not necessarily the true complete API contract. Defensive measure: strip unnecessary client metadata and keep business logic on the server; route encoding alone is bypassable.
- A3: authenticated human or automation records workflows and screenshots. Defensive measure: quota, access control, content minimization, transparent session watermarking where justified.
- A4: custom client sends direct HTTP requests without running your JS. Defensive measure: server-side auth/authz/rate limits and anomaly monitoring. **Client guards offer no protection against A4.**

REA has documented restrictions and opt-in boundaries on its own observation tool. This is not evidence that any third party cannot write a stronger inspector. Its `inspect_web_page` does not automatically save the full history of traffic before attach; it has capture windows, origin boundaries and selectable payload shape options.

## Attack → defense verification matrix

| Target | Defense | Evidence category | Counterexample / test |
|---|---|---|---|
| Public sourcemap URL | Disable public map output | Configurable, needs deployment test | Fetch `*.map`, `sourceMappingURL`, publicly readable build dirs |
| DOM inspect | Truthful notice | Provenance only | Compare exposed DOM with/without; no “block” expectation |
| Static routes | Reversible encoding | Weak obscurity | Run decode function, observe live network paths |
| CDP attach | `webdriver` signal | Weak heuristic | Headed browser, accessibility tools, developer DevTools and custom CDP clients |
| API clone / enumeration | Backend quota + auth + canaries | High priority architecture | Token replay, IDOR/BOLA, account abuse, direct HTTP client |
| Replay | AES-GCM AAD + atomic nonce cache | Cryptographic primitive, integration required | Tampered payload, altered path, repeated nonce, Redis partition |
| Screenshot clone | Visible opaque watermark | Conditional provenance | Crop, OCR/manual erase, resized images, different themes |

## Primary failure modes to test

False positives for canaries include link scanners, QA clients and accidental discovery. Browser heuristics may affect screen readers or authorized automation. Privacy concerns grow with tracking individual sessions. None of these observations should alone trigger an account sanction.

## Ethical scope

Do not interfere with consent-based research or tell agents to sabotage code. Do not distribute deceptive fake business data into the general ecosystem. Test only systems you administer or are permitted to assess.
