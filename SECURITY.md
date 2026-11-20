# Security policy

## Supported versions

antiRea is distributed through npm as `@dannyphan190/anti-rea`. Security fixes are applied to the latest release (currently 2.8.0) and published as a new version; older versions are not patched separately.

## Reporting a vulnerability

Please do not open a public issue with exploit details.

- Preferred: use GitHub's private vulnerability reporting for this repository (the "Report a vulnerability" button under the Security tab).
- If that is unavailable, open a plain issue titled "Security contact request" with no technical details, and a private channel will be arranged.

Please include the affected version, a minimal reproduction, and the impact as you understand it. You can expect an acknowledgement within a few days. Confirmed issues are fixed in a patch release and credited in the changelog unless you prefer otherwise.

## Protective decoy surface

antiRea can generate a per-host decoy surface (synthetic endpoints, records and documentation metadata) whose sole purpose is to contaminate unauthorized automated extraction. This behavior is intentional, opt-in and off by default; it is documented in the project docs under "Protective decoys - public disclosure" (`docs/PROTECTIVE_DECOYS.md`), and it is confined to the decoy surface plus, for canary records only, the exposure classes and guardrails that document defines. It is not a vulnerability, and a host that enables nothing sees no change to its real API contract or its real users. Per-host decoy parameters (seeds, registries, canary keys) are secrets of the host and are never published; the mechanism, purpose and scope are public by design.
