# Protective decoys - public disclosure

antiRea is a defensive toolkit. Since 3.3.0, hosts that opt in
can publish a **decoy surface**: synthetic endpoints, records
and documentation metadata that describe a system which does
not exist. This is a deliberate protective measure against
automated extraction and unauthorized cloning, comparable to
honeypot fields in forms. antiRea publishes this disclosure so
that reviewers, researchers and platform evaluators can
distinguish intentional protective deception aimed at
extraction agents from defects, and from attempts to mislead
legitimate users.

## What the decoy surface contains

All of it is opt-in, per host, and off by default. A host that
enables nothing serves no decoys, and its real API behavior is
exactly what it was without this release.

- **Discovery pack** - robots.txt disallow lines and sitemap
  entries, generated from the host's decoy registry, that point
  crawlers at decoy paths through machine-read channels only.
- **Spec decoy** - an OpenAPI document that declares the decoy
  endpoints (including "phantom" endpoints that are declared
  but never served) alongside the host's real paths.
- **Contradiction combo** - the spec endorses a decoy feed
  whose values deliberately disagree with the host's real
  values (for example a partner price factor), so a merged
  capture contains pairs that cannot both be true.
- **Worked-example decoy** - a documented calculation rule
  whose worked example, served by a decoy endpoint, does not
  match the rule's own arithmetic.
- **Cross-route invariant poisoning** - decoy record sets whose
  aggregate totals disagree with the sum of their detail parts
  on another route. The violations exist only inside decoy
  data; real records are never inputs.
- **Identity-gated decoy joins** - decoy datasets whose record
  ids are rewritten per requesting identity, so a set captured
  under one identity joins cleanly, while a capture merged from
  two identities silently orphans.
- **Budget-sink expandables** - decoy endpoints that declare
  expand/include variants; following one generates synthetic
  subresources that the host bills to the same record budget as
  real records.
- **Canary records** - synthetic records a host mixes into a
  dataset it serves, at a dose the host chooses, each carrying
  a keyed tag naming the identity the dataset was served to.
  This is the one family that is mixed into a served dataset
  rather than confined to decoy-only routes; see the exposure
  section below.

Nothing in the decoy surface is part of the host's real API
contract: legitimate integrations must follow the host's
official documentation, and any endpoint, field or note that
appears only inside the decoy surface is fictional by design.

## Two-layer disclosure

The disclosure is deliberately two-layered:

- **Public, permanently:** the mechanism, its purpose and its
  scope - this page, the section in `SECURITY.md`, and the
  release notes of every version that ships decoy features.
- **Never published:** per-host parameters - seeds, registry
  contents, which paths are decoys on a given host, rotation
  epochs and canary keys. Publishing those would hand an
  extractor the exact map the surface exists to deny it.

The disclosure lives out-of-band, in the project's own
documentation. It is not embedded in the decoy surface itself.

## Canary exposure - mandatory reading before enabling A4

Canary records are synthetic data inside a dataset real
consumers may read. Hosts must classify their surface before
choosing a dose:

- **Class (b) - bulk API surface.** Consumers are machines and
  integrators working from the host's official documentation.
  Canary records contaminate an unauthorized extraction; a
  legitimate integrator following the documented contract is
  the host's responsibility to keep whole - do not plant
  canaries in responses a documented integration depends on
  field-by-field.
- **Class (c) - public storefront or any human-facing
  surface.** Real visitors may see synthetic records. The
  guardrails are stricter: keep the dose at or below the
  recommended level below; never plant a canary where a
  synthetic record could trigger a real-world action (a
  purchase, a booking, a payment, or any medical, legal or
  safety decision); and mark canary records in the host's own
  admin tooling so staff are never confused by them. When in
  doubt, use the decoy-only families (discovery, spec,
  contradictions, joins, expandables) and skip canaries.

**Recommended dose: 10%.** The dose response was measured
three times independently: a 10% planted dose was extracted at
exactly 10.0%, a 25% dose at 24.7%. The code sets no default -
the host must state its dose on every call - and doses above
25% are refused.

## Fragility warning - the worked-example decoy

The worked-example decoy is the most fragile item in this
release (panel review, item L5): it lives next to correct
documentation by design, so a careful human reader who checks
the documented rule against the served example can spot the
inconsistency. Treat it as a weak, supplementary layer. Never
rely on it as the only decoy measure, and do not place it where
a spotted inconsistency would damage trust in the host's real
documentation.

## Measured basis

Every effect claimed for this surface was measured in the lab
before it shipped, against extractor agents on loopback twins:
the decoy surface multiplied an extracting agent's token cost
by 2.09x (median 7,101 to 14,808 tokens per session); machine-
read discovery channels carried 8 of 8 decoys with zero
real-user footprint; planted invariant violations survived
into captures 10 of 10 with zero inconsistencies reported by
the extractor; identity-gated joins orphaned 0% within one
identity and 100% across two; and billed expansions cut real
yield per identity from 150 to 50 records (-66.7%). The full
numbers are in the 3.3.0 changelog entry. What was not
measured is not claimed.
