# Research & authoritative references

Checked or inspected via public search on **2026-10-31**. Each entry is linked to a direct primary publisher or original repository; a paper showing a technique is **not evidence antiRea implements it**. Where no runtime replication was performed, status is **reference verified, mechanism not benchmarked**.

| Topic | Primary source / direct link | Relevance and caution |
|---|---|---|
| REA | [morluto/rea: browser-observation.md](https://github.com/morluto/rea/blob/main/docs/browser-observation.md) | Actual shipped surfaces, default data minimization and opt-in capture options; tool evolves quickly |
| REA guide | [REA browser guide](https://morluto.github.io/rea/guides/browser/) | Real observation workflow and window limitations |
| Bot detection | Antoine Vastel (Castle, 2025), [why a classic CDP bot detection signal stopped working](https://blog.castle.io/why-a-classic-cdp-bot-detection-signal-suddenly-stopped-working-and-nobody-noticed/) | Shows why `Error.stack` getter trap is not robust |
| Automated scraping | [OWASP OAT-011 Scraping](https://owasp.github.io/www-project-automated-threats-to-web-applications/assets/oats/EN/OAT-011_Scraping.html) | Threat taxonomy, not a promise that blocking is complete |
| API authorization | [OWASP API Security Top 10 2023](https://api-security.owasp.org/editions/2023/en/0x11-t10/) | Broken object/field authorization; unrestricted resource use; sensitive flows |
| Indirect prompt injection | Kai Greshake et al. (2023), [arXiv:2302.12173](https://arxiv.org/abs/2302.12173) | Explains the risk of embedded instructions in untrusted data - not endorsement of sabotaging other agents |
| Instruction priority | Eric Wallace et al. (2024), [arXiv:2404.13208](https://arxiv.org/abs/2404.13208) | Why lower-trust web content should not override an agent's legitimate instructions |
| Authenticated encryption | NIST SP 800-38D, [doi:10.6028/NIST.SP.800-38D](https://doi.org/10.6028/NIST.SP.800-38D) | AES-GCM and authenticated additional data; key secrecy and IV uniqueness matter |
| Browser cryptography | [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/) | Standard primitives; nonextractable keys do not make an untrusted browser a secure enclave |
| Physical watermark research | Matthew Tancik, Ben Mildenhall, Ren Ng, [StegaStamp, CVPR 2020](https://openaccess.thecvf.com/content_CVPR_2020/html/Tancik_StegaStamp_Invisible_Hyperlinks_in_Physical_Photographs_CVPR_2020_paper.html) | Specialized trained system, **not** implemented by antiRea; cannot justify claims about simple pixel strips |
| Agent skill standard | [Agent Skills specification](https://agentskills.io/specification) | Format for `.agents/skills/anti-rea/SKILL.md` |
| Relevant similar project | [Thinkst Canarytokens](https://github.com/thinkst/canarytokens) | Established canary token practice, distinct product |
| Bot-detection research | [rebrowser-bot-detector](https://github.com/rebrowser/rebrowser-bot-detector) | Open-source dynamic detection experiments, techniques change rapidly |

For publication, recheck source titles, authors, dates, versions and DOI before final citation. Do not import speculative effectiveness percentages from blogs, marketing material, or models.

## 2.1 benchmark and reference applications (verified 2026-10-31)

- REA upstream homepage / official CLI distribution: https://github.com/morluto/rea
- REA website capture capabilities and evidence boundaries: https://github.com/morluto/rea/blob/main/docs/browser-observation.md
- Playwright officially supported browser engines and install instructions: https://playwright.dev/python/docs/browsers
- TodoMVC (MIT licensed, app spec limitations): https://github.com/tastejs/todomvc
- RealWorld full-stack spec (select exact implementation and license): https://github.com/realworld-apps/realworld
- OWASP Juice Shop (intentionally vulnerable, use isolated localhost instance): https://owasp.org/www-project-juice-shop/

All three referenced example apps are **recommendations for locally authorized testing**, not third-party websites that were scanned in this release.
