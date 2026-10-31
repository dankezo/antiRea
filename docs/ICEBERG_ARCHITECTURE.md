# Iceberg architecture: protect what is not in the browser

This is an *architectural design pattern*, not a literal 90/10 quantitative law or an “unclonable” guarantee.

1. Keep system prompts, signing keys, custom rankings and proprietary decision rules in server-only services.
2. Verify identity and object-level permissions for every server request; never rely on a hidden button.
3. Return only fields necessary for the UI and paginate or cap exports; instrument per-account quotas.
4. Protect proprietary datasets and third-party integrations with contractual controls and rotation.
5. Treat WebAssembly as client portability/performance tooling, not secure isolation. It can be reverse engineered.
6. If a user legitimately sees a result, assume it can be screenshotted or transcribed. Use abuse prevention and provenance where appropriate.

For practical priority, see [SERVER_SIDE_CONTROLS.md](SERVER_SIDE_CONTROLS.md).
