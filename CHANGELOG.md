# Changelog

## Unreleased

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
