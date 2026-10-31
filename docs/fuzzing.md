# Release-candidate fuzzing

See the [illustrated RC fuzzing process and verified rollout results](https://github.com/victron-venus/venus-os-ci-toolkit/blob/main/docs/rc-fuzzing-results.md)
for the shared release flow, evidence requirements and a dated cross-project
snapshot. The project-specific scope and reproduction guidance below still apply.

Public RCs run the real production installation authorization and wire validators
under [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js). The shared
`venus-os-ci-toolkit` workflow is pinned in `.release-policy.json`; targets and
locked dependency setup are declared in `.github/fuzz.json`.

Only an explicit `rc` dispatch on the public default branch runs a mutation
campaign. Pull requests, pushes, beta and nightly builds retain their normal
checks without spending fuzzing minutes. Private repositories fail this gate's
eligibility check. This is repository-managed fuzzing, not membership in Google's
hosted OSS-Fuzz service.

## Coverage and limits

* `installation-auth` supplies synthetic Request headers and credential
  configurations to `requireInstallation`. It checks bearer-token requirements,
  exact origin and referrer policy, explicit trusted-proxy exceptions, cross-site
  denial, duplicate/invalid credential rejection and non-disclosure of credentials.
  Requests are constructed locally; they are never sent.
* `wire-contracts` checks production identifier validators against an independent
  ASCII/length oracle, validates arbitrary JSON command envelopes and numeric
  constraints, checks endpoint suffix handling and verifies non-mutation. The
  generated wire module remains generated; fixes to it must come through its
  canonical generator and schema.

Each target gets 60 seconds, a 10-second per-input timeout and a 2 GiB RSS cap.
Authentication input is bounded to 8 KiB, wire input to 64 KiB. The fuzz package
contains exact locked Jazzer.js and TypeScript versions. Setup transpiles the
actual TypeScript modules without substituting their implementation. No worker
deployment, account credentials, KV, Durable Objects or Cloudflare APIs are used.
These checks do not replace the existing workerd integration tests.

Dependency setup has network access; the shared Linux runner executes targets
inside a network namespace without it. Successful exit alone is insufficient:
positive libFuzzer execution evidence and the exact expected target inventory
are required.

## Reproduction

Use Node 24 and the isolated development dependencies:

```sh
npm ci --prefix fuzz --ignore-scripts --no-audit --no-fund
node fuzz/build.mjs
node fuzz/node_modules/@jazzer.js/core/dist/cli.js \
  fuzz/installation-auth.mjs -- -max_total_time=60 \
  -timeout=10 -rss_limit_mb=2048 fuzz/corpus/installation-auth
node fuzz/node_modules/@jazzer.js/core/dist/cli.js \
  fuzz/wire-contracts.mjs --sync -- -max_total_time=60 \
  -timeout=10 -rss_limit_mb=2048 fuzz/corpus/wire-contracts
```

Download `fuzz-diagnostics-<attempt>` from an unsuccessful release run. The
artifact contains logs, the campaign report, corpus and crash or timeout inputs.
Replay a saved input with the matching target and runtime:

```sh
node fuzz/node_modules/@jazzer.js/core/dist/cli.js \
  fuzz/wire-contracts.mjs --sync -- -runs=1 /path/to/saved-input
```

Keep a minimal synthetic seed and regression test with the fix, then request a
new RC from reviewed source. Never publish real installation tokens, account
bindings, private endpoints, customer payloads or production credentials.

## Release evidence

The publisher verifies `fuzz-report.json` and `release-inputs-fuzz.json` against
the repository, source SHA, run, attempt, manifest digest and successful target
inventory. Fuzz validation receipts are separate from platform build receipts.
An earlier release cannot retrospectively qualify under the new policy. Beta
does not imply fuzz qualification. Release publication packages the worker;
Cloudflare deployment remains an explicit separate operation.

## Deterministic target-contract checks

Ordinary CI now replays the real fuzz target exports using the checked-in
synthetic corpus, fixed malformed inputs and a bounded deterministic byte matrix.
It awaits asynchronous targets and propagates assertion failures. This catches
harness/production API drift without starting Jazzer or a mutation campaign.
The RC preflight repeats this check after its locked setup.

Run locally from the repository root:

```sh
npm ci --prefix fuzz --ignore-scripts --no-audit --no-fund
node fuzz/build.mjs
node fuzz/replay.mjs
```

The replay preserves the same offline boundaries as the targets above; it does
not qualify a release or substitute for the RC's isolated campaign.

## Artifact selection and retries

Release artifacts use `-run-<run_id>-attempt-<run_attempt>` names, and the collector selects only the current run and attempt.

Before publication starts, use **Re-run all jobs** only if the allocator and
release policy permit reuse of that run's reservation. Recreate every required
input in the same attempt; failed-only or individual retries can leave inputs
missing, and older artifacts must not fill those gaps.

For a fresh candidate or final build, once publication has started
(`begin_publication`), or its external publication result is partial or uncertain,
inspect the existing release, tags and assets before retrying. A consumed build
number requires a new workflow run and reservation authorized by the release
policy; an existing immutable tag may also require a new base version. Never
reset the release ledger, overwrite assets or retag to force a retry. Historical
byte promotion of an accepted RC keeps its reserved number and follows the
existing promotion policy.

Fuzzing still requires an explicit RC dispatch from the default branch of a public repository. Its report identifies one source revision and run; it does not prove complete platform coverage or device acceptance. Package receipts additionally bind fresh package publication to the current repository, source SHA, run ID and attempt. Historical promotion and retained-evidence validation keep their existing checks; complete package-set coverage remains a separate requirement. Receipts created before the migration or offline without an Actions identity cannot qualify fresh publication. Run all required producers in one complete workflow attempt after migration; existing release approval and acceptance policies still apply. See [the shared evidence contract](rc-fuzzing.md).
