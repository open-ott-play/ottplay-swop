# Security design and verification

## Scope and trust boundaries

The project provides a Cloudflare Worker for single-use remote text entry and approved portal relay.

Installation/admin credentials remain server-side. Read and write capabilities are independent, session-bound and hashed before storage. Origin checks complement backend credentials; they do not authenticate arbitrary non-browser clients. Preserve atomic consumption, expiry, rate limiting, same-origin relay admission and exact portal endpoint validation. Do not put tokens or submitted values in diagnostics.

## Source and operating documentation

- [src/index.ts](../src/index.ts)
- [src/session.ts](../src/session.ts)
- [src/wire-contracts.ts](../src/wire-contracts.ts)
- [docs/atomic-session-migration.md](../docs/atomic-session-migration.md)

## Regression evidence

- [src/test/admission.test.ts](../src/test/admission.test.ts)
- [src/test/sessions.integration.test.ts](../src/test/sessions.integration.test.ts)
- [src/test/vportal.integration.test.ts](../src/test/vportal.integration.test.ts)

Run the documented commands in [CONTRIBUTING.md](../CONTRIBUTING.md) and the
[CI workflow](../.github/workflows/ci.yml). Preserve negative tests for rejected inputs,
unavailable dependencies, authorization failures and cancellation. A passing
test run describes its fixtures and environment; it does not certify every
upstream service, hardware model or production deployment.

## Remaining security assessment

Refresh server-side dependency alerts after merge and review current release/security notes and all cryptography/dynamic-analysis criteria. A local zero-vulnerability npm audit is scoped to its registry snapshot.

Report new issues through [SECURITY.md](../SECURITY.md). An OpenSSF assessment
records evidence and applicability; it is not a guarantee that a system is safe.


## Supported strict cryptographic profile

For deployments requiring a verified minimum cryptographic strength, use a
Cloudflare custom hostname with HTTPS only and minimum TLS 1.2. Select an edge
certificate with an RSA key of at least 2048 bits or an ECDSA P-256/P-384 key.
Cloudflare's [custom certificate requirements](https://developers.cloudflare.com/ssl/edge-certificates/custom-certificates/uploading/)
reject RSA keys below 2048 bits and ECDSA keys below 225 bits. Follow its
[minimum TLS configuration](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/)
and use TLS 1.3 or ECDHE with AES-GCM/ChaCha20-Poly1305 for TLS 1.2. Verify the
served certificate and enabled suites for the deployment hostname before use.
This describes an operator-selectable profile, not an assertion about a current
hosted deployment or every Cloudflare plan's default settings.

Keep `VPORTAL_ENDPOINTS_JSON = "[]"`, the supplied example's default. This
completely disables the optional outbound portal relay; both HTTP and HTTPS
portal requests return 503 before an outbound fetch. The core single-use text
sessions continue to work. The workerd integration regression tests this
boundary. Workers do not expose peer certificate key sizes to application
`fetch`, so an arbitrary enabled portal must not be represented as satisfying
this strict profile without separate deployment evidence. Do not log portal keys.

The application's remaining cryptographic operations use WebCrypto's 256-bit
random capabilities and SHA-256 hashes. These exceed the 112-bit symmetric and
224-bit hash minima. The strict profile therefore has no unverified outgoing TLS
key-size dependency; selecting a legacy portal is an explicit alternate profile.
