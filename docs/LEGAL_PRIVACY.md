# Privacy and responsible use (not legal advice)

- **Transparency**: tell users if authenticated previews contain watermarks and if suspicious access signals are collected. State purpose, lawful basis where relevant, retention and contact route.
- **Data minimization**: never embed raw email, device fingerprint, address or IP in an image. Embed an opaque rotating token, and resolve it to identity in an access-controlled server ledger.
- **Fairness**: don't auto-disable features or ban users on `navigator.webdriver`, fast clicking or a canary hit. QA, accessibility tools and normal users can look unusual.
- **Retention**: avoid recording full keystrokes, request bodies, credentials or precise personal location. Define deletion windows and restrict investigative access.
- **Claims**: intellectual property, copyright and reverse-engineering law vary by jurisdiction and facts. A visible marker alone is not legal proof of copying. Do not assert DMCA §1201 applies without legal review.
- **Authorization**: run browser inspection / REA tests only on applications you own or are expressly allowed to examine. Do not make a website deliver poisoned instructions that tell third-party agents to sabotage software.
- **Compliance**: consult counsel for the EU GDPR, Vietnam's Decree 13/2023/ND-CP on Personal Data Protection (Nghị định 13/2023/NĐ-CP về Bảo vệ dữ liệu cá nhân - PDPD) and applicable Vietnamese data laws, employee monitoring rules, and consumer contracts. Jurisdiction-specific legal conclusions are intentionally excluded from this SDK.
