# Changelog

## [0.1.0] - Development line

### Security

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

### Upgrade

Run `npm ci --ignore-scripts` to obtain the corrected build/test dependencies.
Existing Worker API calls and stored session records remain compatible. Review
the root-level example `account_id` before preparing a local configuration. Deploy
the archived Worker bundle only through the documented explicit operator procedure;
publishing or promoting a release does not deploy it.
