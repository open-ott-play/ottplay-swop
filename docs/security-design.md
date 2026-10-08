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
