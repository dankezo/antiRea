# Server-side controls (higher priority than browser traps)

Ordered checklist; implement in your host app, not automatically installed by antiRea.

**P0**: server-side permission checks by tenant/object/field; strict least-data responses; secret storage; per-account/burst quotas; authenticated export endpoints; pagination; hard upper request cost limits; revoke tokens at logout. Map to [OWASP API Security Top 10](https://api-security.owasp.org/editions/2023/en/0x11-t10/).

**P1**: shared-store nonce replay checks; origin/CSRF strategy appropriate to auth; signed short-lived download URLs; decoy endpoint alerts with monitoring/incident triage; separate privileges for trial accounts; WAF/bot reputation if justified.

**P2**: opaque per-session forensic token ledger; documented retention and access review; product-specific selective canary content; contracts and accepted terms; audit of scraped-content complaints.

**DO NOT** treat a client IP, a fingerprint or a canary hit as conclusive evidence of intent. Do not store full request bodies/credentials in alerts. Only trust identity established in server authentication middleware. Client-held encryption keys and code obfuscation do not protect backend secrets.

## Production replay cache pattern

Use a truly atomic shared datastore operation, such as `SET antirea:nonce:<hashed-key> 1 NX PX <ttlMs>`, and return `true` only if the store confirms insertion. Do not ship the sample in-memory `createInMemoryReplayGuard()` in a horizontally scaled environment. Bind the server-derived session ID, method, route and purpose into AEAD additional authenticated data. Rotate keys on a documented schedule; enforce HTTPS.
