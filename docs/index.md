---
layout: home

hero:
  name: antiRea
  text: Evidence-led anti-cloning documentation
  tagline: antiRea does not make a website unclonable. These pages state what each technique can and cannot do, who it works against, and how to verify it with tests.
  actions:
    - theme: brand
      text: Read the limitations first
      link: /LIMITATIONS
    - theme: alt
      text: Threat model
      link: /THREAT_MODEL_REA

features:
  - title: Server-side controls first
    details: Quotas, pagination caps, object-level authorization and minimal responses are enforced on the backend. Client-side measures never substitute for them.
    link: /SERVER_SIDE_CONTROLS
  - title: Honest about bypasses
    details: Every technique ships with its counterexample. A verified Web Bot Auth signature identifies a key holder for one request; it is not authorization and not proof of good behaviour.
    link: /LIMITATIONS
  - title: Benchmarks are protocols, not slogans
    details: No performance or blocking percentages are published. The benchmark protocol and the twin-SaaS demo describe how to produce evidence you can reproduce.
    link: /BENCHMARK_PROTOCOL
---
