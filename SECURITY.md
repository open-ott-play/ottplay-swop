# Security policy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/open-ott-play/ottplay-swop/security/advisories/new).
If the form is unavailable, contact a maintainer through the repository's GitHub
profile to arrange a private channel before sharing sensitive details. Public
issues are for non-sensitive defects and feature requests.

Include the affected commit/release, prerequisites, a minimal synthetic
reproduction, expected and actual results, and impact. Do not include live
credentials, personal data or access to devices you do not own.

## Response and supported versions

Maintainers aim to acknowledge a private report within 14 days, investigate its
scope, and agree on remediation and disclosure with the reporter. If no reply
arrives within 14 days, follow up privately. Confirmed security defects are
prioritized by impact; critical defects take precedence over feature work.

Security fixes target the current default branch and latest published release,
where one exists. Older snapshots are not maintained security branches. Release
notes must identify security fixes, affected versions and upgrade actions without
disclosing credentials. This policy is a commitment for handling reports, not
a claim that no vulnerabilities exist or that past reports met a response SLA.

## Project boundary

This project provides a Cloudflare Worker for single-use remote text entry and approved portal relay.

Installation/admin credentials remain server-side. Read and write capabilities are independent, session-bound and hashed before storage. Origin checks complement backend credentials; they do not authenticate arbitrary non-browser clients. Preserve atomic consumption, expiry, rate limiting, same-origin relay admission and exact portal endpoint validation. Do not put tokens or submitted values in diagnostics.

See [security design and validation boundaries](docs/security-design.md).
