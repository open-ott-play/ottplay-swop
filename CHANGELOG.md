# Changelog

## [0.1.2] - 2026-10-17

### Documentation

- Correct the Terraform setup instructions and remove unrelated copied guidance.
- Link the illustrated RC fuzzing process and its verification limits.

### Compatibility and rollback

The Worker implementation, API and stored session format are unchanged from
0.1.1. This release updates documentation and release identity. Deployment remains
an explicit operation; retain the previous immutable Worker bundle for rollback.

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
