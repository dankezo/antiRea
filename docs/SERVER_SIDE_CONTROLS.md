# Server-side controls (higher priority than browser traps)

Ordered checklist; implement in your host app, not automatically installed by antiRea.

**P0**: server-side permission checks by tenant/object/field; strict least-data responses; secret storage; per-account/burst quotas; authenticated export endpoints; pagination; hard upper request cost limits; revoke tokens at logout. Map to [OWASP API Security Top 10](https://api-security.owasp.org/editions/2023/en/0x11-t10/).

**P1**: shared-store nonce replay checks; origin/CSRF strategy appropriate to auth; signed short-lived download URLs; decoy endpoint alerts with monitoring/incident triage; separate privileges for trial accounts; WAF/bot reputation if justified.

**P2**: opaque per-session forensic token ledger; documented retention and access review; product-specific selective canary content; contracts and accepted terms; audit of scraped-content complaints.

**DO NOT** treat a client IP, a fingerprint or a canary hit as conclusive evidence of intent. Do not store full request bodies/credentials in alerts. Only trust identity established in server authentication middleware. Client-held encryption keys and code obfuscation do not protect backend secrets.

## Field surface control (P0/P1)

Metering caps how MUCH leaves; the surface guard caps WHAT leaves and what may enter. `createSurfaceGuard` inspects JSON payloads in both directions: responses are checked against a built-in sensitive-field denylist (password hashes, secrets, national ids, bank accounts) plus your per-route field allowlist - the exact failure behind the Spoutible and eHUST leaks, where one over-broad response carried credential material no budget could have caught. Requests get the mirror check against privileged fields (`role`, `is_superuser`, `owner_id`) for mass assignment. Default mode is advisory (report only); strip or block only when you choose. GraphQL hosts: the same field discipline applies per resolved field, and the record budget should be charged per record a query resolves (count at the resolver/data-loader), so over-fetching is metered exactly like REST paging.

## Ownership sweep signal (BOLA/IDOR)

Neither budgets nor field checks see the IDOR walk: one identity requesting object after object that belongs to other users, each response individually well-formed. Authorization per object stays the host's job - but the authorization layer is what is broken in a BOLA incident, so `createOwnershipProbe` adds an independent advisory observation on top: feed it every object access (`observe(identity, { objectId, route, ts })`, owner resolved by your server-side callback) and it tracks, per identity and rolling window, how many distinct owners were touched out of how many touches. Declare public routes so public content is exempt from both numerator and denominator, and run the 1 h window together with a 6 h window if slow sweeps matter (the lab measured the 1 h window alone blind to the 6 h spread). A flag is evidence for review or step-up, never a block decision by itself: legitimate cross-owner tooling (support, migrations, indexing) has the same shape until you exempt or tune it.

## Step-up consequence shaping (HTTP 402)

A step-up trigger answered with a bare challenge gives a machine caller nothing to act on. When your step-up layer fires, `createStepUp402Responder` shapes the consequence as an HTTP 402 response in x402 style: an `X-Payment-Required` header plus a manifest body whose next steps are pay, appeal and continue-free, with `checkAssertion` checking the session token the manifest issued. There is no settlement and no payment processing - the price is a signal. The lab measurement (RECOMB-09) is an effect on cooperative callers: 94.5% retreated and 94.0% presented a valid assertion, with 0 legitimate dead-ends across 200 browser and 200 API sessions. Call it only after a step-up trigger fires, never as a first response to an untriggered identity, and expect callers that ignore the manifest to be unaffected.

## Preference declaration log

A preference declaration (a robots.txt Content-Signal line, an RSL License link, an aipref Content-Usage line) lives on the host and never travels with a republished copy, so after the fact the host cannot show the declaration predates the copy. `createDeclarationLog` keeps an append-only, hash-chained host-side record of declarations as they are published; paired with the C39 value watermark (`createValueWatermark`) - the part that does survive republication - the log anchors when the terms were stated. It proves ordering and integrity of the host's own records only: not that any crawler complied with the declaration, and not legal recognition in any jurisdiction.

## Declared-cohort union budget pattern

When several accounts belong to one principal the host itself knows about (a partner integration, a team plan, a reseller), declare them as one cohort and meter them with ONE `createRecordBudget` keyed by the cohort id, next to the per-identity budgets: every member draws from the same distinct-record union, so rotating identities inside the cohort stops diluting the cap. The declaration is host configuration resolved from server-side account data - never client input. Worked example with runnable verification: [examples/declared-cohort-budget](../examples/declared-cohort-budget). Single-process only; horizontally scaled hosts use the disclosure ledger's `reserveDisclosure` or the tripwire's declared-ceiling `reserveServe` instead. Hard ceilings belong to declared cohorts only - a group the host never declared is handled by detection plus friction, not by a cap invented from inferred evidence.

## Production replay cache pattern

Use a truly atomic shared datastore operation, such as `SET antirea:nonce:<hashed-key> 1 NX PX <ttlMs>`, and return `true` only if the store confirms insertion. Do not ship the sample in-memory `createInMemoryReplayGuard()` in a horizontally scaled environment. Bind the server-derived session ID, method, route and purpose into AEAD additional authenticated data. Rotate keys on a documented schedule; enforce HTTPS.
