# Independent reconstruction study (proposed, NOT executed)

**Research question:** given the same time and resources, does deployment of specific antiRea controls measurably increase the effort required for an authorized red team to reproduce *non-public* behavior? A visually identical screenshot is not the sole outcome.

## Pre-registration

- Publicly fix source revision, SHA-256, REA + browser versions, permitted tools, scenario tasks and scoring rubric *before* seeing results.
- Create randomized matched pairs: baseline and protected copies have identical synthetic data and exposed capabilities; independent participants receive access to only one version. Blind the graders to participant condition. Randomize order across teams to limit learning effects.
- Keep all usage authorized, local, isolated, and self-hosted. Never ask an AI to violate user terms or mislead/poison unrelated projects.
- Define target workflows: search account, add a request, export a report, navigate, reproduce one server-only feature under quota. Capture attempts, time spent, and exactly which artifacts were used.

## Outcome measures (do not fabricate)

- **Function fidelity:** percentage of task assertions passed against cloned apps, measured by a sealed independent test suite.
- **Visual fidelity:** screenshot comparison for same viewport / state; watermark pixels should be masked when comparing *legitimate* visual parity.
- **Resource fidelity:** external API endpoints, protected fields, and authorization boundaries correctly replicated; distinguish public interface from proprietary server logic.
- **Work effort:** elapsed minutes, manual interactions, tokens/tool calls if observable; report median and quartiles, exclusions and failures.
- **Collateral damage:** accessibility failures, real-user task failures, performance p95, false positives from assistive technologies and authorized QA; include screen readers where possible.

## Analysis and interpretation

If protections merely watermark or add factual notices, expect little resistance to screenshot copying; **do not publish "blocked" percentages** for those. Server-side authorization and rate limits protect specific operations but do not prevent reconstructing UI. Mark unattested/unsupported outcomes missing, not zero; publish raw anonymized evidence and limitations. Seek external review before a stable release.
