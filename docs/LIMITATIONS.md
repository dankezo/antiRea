# Limitations and anti-claims

**This project does not make a public website “unclonable”.** If a browser can render a page, someone can capture its pixels and observe its network traffic. Client JavaScript and WebAssembly can be disassembled; Wasm is no enclave. Algorithms, data, model prompts, credentials, and authorisation decisions that must remain private belong on the server.

| Technique | What can be said | What cannot be claimed |
|---|---|---|
| No production source maps | Harder to recover original development sources from public assets | Bundle cannot be reversed; no sources exist elsewhere |
| Notice / terms | Provides provenance and published rights signals | An LLM must obey the notice |
| Canary route | Correlates suspicious access after an application is configured | Anyone hitting a decoy is malicious |
| `navigator.webdriver` | Weak signal for some browser automation | Detection of all Playwright, CDP or REA clients |
| Route encoding | Conceals clear strings from simple text grep | Cryptographic protection |
| AES-GCM envelope | Integrity/confidentiality against parties *without the key*, replay guard with shared storage | Hide JSON from a browser that possesses the key |
| Watermark overlay | Attribution clue if token remains visible and ledger is authentic | Reliable steganography or screenshot/video resistance |
| Zero-width/SVG markers | Byte-for-byte canary when they survive unchanged | Mathematical or legal proof of infringement |
| Client click/route heuristic | Potential anomaly data after calibration | Reliable intent classification or permission to disable paid users |
| Web Bot Auth signature (RFC 9421) | The request was signed by the holder of the published Ed25519 key for exactly the covered components, inside its validity window. `Signature-Agent` is accepted in both the draft dictionary form and the deprecated legacy bare-string form (production compatibility; the form used is reported on the verdict as `agentForm`) | The operator is trustworthy or well-behaved; identity is not authorization, and unsigned agents are not automatically abusive |

No performance percentages are supplied. Any new claim requires a test, adversary model, baseline control, confidence intervals, and evidence published using [BENCHMARK_PROTOCOL](BENCHMARK_PROTOCOL.md).
