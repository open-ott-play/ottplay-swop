# Quality and assessment scope

This assessment covers the Worker, wire contracts, deployment definitions and release helpers. It does not award a badge to
upstream Home Assistant, firmware, hosted platforms or downstream installations.

## Verification

Use the commands in [CONTRIBUTING](../CONTRIBUTING.md) and the current GitHub
Actions workflows. Keep the source commit, tool versions, command and outcome
with any evidence. A green job describes the checks it actually executed; a
path-filtered skipped job is not a fresh execution of those checks.

Compiler/safe-language warnings, static security analysis and dynamic tests have
different scopes. Document individual accepted warnings rather than disabling
rules globally. A successful simulated test or compilation does not establish
physical device behavior.

## Security argument

The front Worker authenticates installation/admin access. Durable Objects own atomic single-use session state. Read and write capabilities are independent, hashed, expiring and excluded from logs. Portal relay endpoints remain allowlisted.

The security policy and implementation-specific tests describe the controls
for those boundaries. This is a compact engineering argument, not an independent
security certification or a completed formal assurance case.

## Current limits

Whole-project statement coverage of at least 80% has not been established by
this assessment. Test counts are not a coverage percentage. The maintainer has
confirmed knowledge of secure design and common vulnerability classes; knowledge
does not replace the implementation evidence. Governance records the absence of
a tested backup-maintainer/recovery arrangement, so Silver continuity is unmet.

Only a saved and verified public OpenSSF assessment establishes an awarded badge.
Missing evidence stays unmet until it is actually produced.

## Assessment record — 2026-10-14

The current GitHub inventory found no non-PR issues, public project advisories
or open dependency alerts. Pull requests came from the maintainer and maintenance
bots. The maintainer confirmed no outside-GitHub bug, enhancement or vulnerability
reports in the preceding 12 months. Private vulnerability reporting is enabled.
Gitleaks scanned 194 available Git commits without a finding. These observations
are dated evidence, not a permanent guarantee or a claim of zero future defects.

Local verification passed TypeScript checking, 124 Vitest tests and 27 wire
contract checks. `vitest.config.mts` declares its ESM format explicitly, removing
the future native-loader warning without changing the Worker.

The local npm audit endpoint was unavailable during this review. It is not
counted as a successful zero-finding npm audit; dependency-review CI and the
dated GitHub advisory inventory provide separate evidence.
