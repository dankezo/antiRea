# Test fixtures

## `web_bot_auth_architecture_v1.json`

Official Web Bot Auth test vectors from the reference implementation,
vendored **unmodified** for the interoperability tests in
`tests/web-bot-auth-interop.test.cjs`.

- **Source:** https://raw.githubusercontent.com/cloudflare/web-bot-auth/main/packages/web-bot-auth/test/test_data/web_bot_auth_architecture_v1.json
  (repository: https://github.com/cloudflare/web-bot-auth, path
  `packages/web-bot-auth/test/test_data/web_bot_auth_architecture_v1.json`)
- **Retrieved:** 2026-11-01
- **SHA-256 of the vendored copy:** `12ed35aaf50368d9cf6d3c704b8942e6603b1ef2bbd119c3040868b87e596ef4`
- **Upstream license:** Apache License 2.0 (Copyright 2025 Cloudflare, Inc.) —
  see the `LICENSE` file at the root of the upstream repository. This fixture
  is redistributed under those terms; it is test data, not part of the
  antiRea runtime.

### Vector inventory (4 vectors, all targeting `https://example.com/path/to/resource`)

| # | Key | Label | Covered components | Notes |
|---|-----|-------|--------------------|-------|
| 0 | RSA-PSS (`PS512`, RFC 9421 App. B.1.2 test key, `kid: test-key-rsa-pss`) | `sig1` | `"@authority"` | No `Signature-Agent` header |
| 1 | RSA-PSS (`PS512`, RFC 9421 App. B.1.2 test key) | `sig2` | `"@authority" "signature-agent"` | Legacy bare-string `Signature-Agent` |
| 2 | Ed25519 (`OKP`, RFC 9421 App. B.1.4 test key, `kid: test-key-ed25519`) | `sig1` | `"@authority"` | No `Signature-Agent` header |
| 3 | Ed25519 (`OKP`, RFC 9421 App. B.1.4 test key) | `sig2` | `"@authority" "signature-agent"` | Legacy bare-string `Signature-Agent` |

So: vectors 0-1 are **RSA-PSS**, vectors 2-3 are **Ed25519**. The Ed25519
`keyid` used in the signatures is the RFC 7638 JWK thumbprint of the test
key, `poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U` — not the JWK `kid`.

All keys in this file (including the Ed25519 private component `d`) are
**published specification test keys**. They are safe to commit and must
never be used to sign production traffic.

### Profile note

These vectors were generated for the earlier `draft-meunier-web-bot-auth-architecture`
profile. The verifier in `src/tier2-active/web-bot-auth.ts` implements the
later `draft-ietf-webbotauth-httpsig-protocol-00` profile, which requires a
`Signature-Agent` header (§5.2.1: "A signed request MUST carry the
Signature-Agent header") and coverage of a `signature-agent` member.
`tests/web-bot-auth-interop.test.cjs` documents, per vector, where the two
profiles agree and where they diverge; the underlying RFC 9421 signatures
in the Ed25519 vectors are cryptographically valid, which the interop
tests also assert independently of the verifier's profile gates.
