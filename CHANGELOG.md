# Changelog

## [0.1.5] - Unreleased

### Fixed

- Reject JSON `null`, arrays and scalar request bodies with HTTP 400 when
  creating sessions, submitting values or adding allowed clients. Invalid
  request shapes no longer become internal server errors. Empty session
  creation requests retain their existing default-caption behavior.

### Changed

- Update Vitest, Wrangler and Cloudflare Workers type definitions together with
  the reviewed lockfile, and refresh the CodeQL and Python setup action pins.

### Upgrade

Run `npm ci --ignore-scripts` to refresh development dependencies. Worker APIs,
stored session records and deployment configuration remain compatible. Deploy
only the archived Worker bundle through the existing explicit procedure;
publication does not deploy it. Retain the previous bundle for rollback.

### Security

- Pin the transitive Undici development dependency to 7.30.1, addressing
  GHSA-xjj6-f33q-929c and the upstream 7.30.1 security fixes.

Existing authentication, origin checks and single-use session boundaries are
unchanged. Automated validation uses synthetic inputs; this release does not
claim a new production or hardware acceptance test.

## [0.1.4] - 2026-10-24

### Fixed

- Expose explicit cursors and completion state when listing admin clients, so
  entries beyond the first KV page are reachable, including after empty pages.
- Bound each page to 100 clients and four simultaneous metadata reads. Reject
  invalid cursors and malformed continuation responses without looping.

### Upgrade

Admin callers that need the full allowlist must follow the returned cursor until
`list_complete` is true. The existing `clients` array remains, with additive
pagination fields. Stored sessions and allowlist records are unchanged. Deploy
the immutable Worker bundle explicitly; retain the previous bundle for rollback.

### Security

Every page requires the existing admin token. Errors remain sanitized and tests
use synthetic KV records, without production credentials or Cloudflare writes.

## [0.1.3] - 2026-10-18

### Changed

- Update the Cloudflare Workers type definitions and Wrangler tooling, harden the CI runner configuration, and declare repository code owners.

### Upgrade

Worker APIs and stored session formats are unchanged. Deployment remains an explicit operation; retain the previous immutable Worker bundle for rollback.

### Security

Existing authentication, origin checks, and single-use session boundaries are preserved. Release validation uses synthetic inputs, not production credentials.

## [0.1.2] - 2026-10-17

### Documentation

- Correct the Terraform setup instructions and remove unrelated copied guidance.
- Link the illustrated RC fuzzing process and its verification limits.

### Upgrade

The Worker implementation, API and stored session format are unchanged from
0.1.1. This release updates documentation and release identity. Deployment remains
an explicit operation; retain the previous immutable Worker bundle for rollback.

### Security

This documentation release preserves existing authentication, origin checks and
single-use session boundaries. It introduces no runtime vulnerability fix and
does not claim validation against production credentials or a live deployment.

## [0.1.1] - Development line

### Changed

- Qualify this release with a bounded RC fuzz campaign, offline target execution, and deterministic seed replay checks.
- Bind release evidence to the exact source and toolkit revision, validate seed corpora, and retain engine execution counts and diagnostic artifacts.
- Document the fuzzing scope, resource limits, and the distinction between synthetic checks and target acceptance.

### Upgrade

Use the existing installation or update procedure. This release changes validation
and release tooling; existing user configuration and data formats are preserved.
Keep the previous immutable release for rollback. Test the exact RC package on the
intended target before accepting a stable promotion.

### Security

Fuzz targets and deterministic preflight commands run offline on synthetic
inputs. Setup and dependency installation may use the runner network. The
campaign rejects missing or invalid seed corpora and incomplete execution
evidence. These checks do not establish untested hardware, integrations,
credentials, or deployment behavior.

## Unreleased

- Use an explicit ESM Vitest configuration without changing Worker behavior.
- Document governance, private reporting and current OpenSSF evidence limits.

## [0.1.0] - Development line

### Security

- Qualify public RCs with bounded, offline Jazzer.js mutation campaigns for
  installation authorization and wire validation. Beta and ordinary PR checks
  remain free of mutation campaigns.

- Pin the Miniflare toolchain's transitive `sharp` and `undici` dependencies to
  0.35.5 and 7.29.1 and refresh `source-map-js` to 1.2.2. Reinstall development
  dependencies with `npm ci --ignore-scripts`. These are build/test tools; the
  Worker API and stored session format are unchanged.

### Maintenance

- Place the example Wrangler `account_id` at the TOML root so it is not parsed
  as a rate-limit setting.
- Add contribution, security and partial OpenSSF evidence documentation. This
  does not claim a badge or production deployment.

### Release publication

- Read reviewed release notes from the exact package source commit and validate
  them before writing evidence or advancing the durable publication counter.

- Version updates preserve quoted TOML keys containing `=` or `#`, including
  unrelated keys, without changing comments or surrounding file layout.

- Release notes accept optional closing hashes in Markdown headings while
  continuing to reject duplicate version sections.

### Upgrade

Run `npm ci --ignore-scripts` to obtain the corrected build/test dependencies.
Existing Worker API calls and stored session records remain compatible. Review
the root-level example `account_id` before preparing a local configuration. Deploy
the archived Worker bundle only through the documented explicit operator procedure;
publishing or promoting a release does not deploy it.
