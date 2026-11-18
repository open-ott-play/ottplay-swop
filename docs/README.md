# Swop documentation

Reference material for the Cloudflare Worker that hands a one-time session from
a desktop to a mobile browser: the desktop creates a short code, the mobile
submits text, and the desktop burns the value after reading it.

- [Atomic sessions and rate-limit rollout](atomic-session-migration.md) — the Durable Object per short code that replaces `sess:*` KV records, and the read/write capabilities.
- [Release version inputs](release-versioning.md) — the `.release-policy.json` fields, the base version and the frozen release plan.
- [Release-candidate fuzzing](fuzzing.md) — the installation authorization and wire validators run under Jazzer.js.
- [Security design and verification](security-design.md) — scope, trust boundaries, credential handling and the checks behind them.
- [Documentation images](images/README.md) — the mobile entry page capture used by the hero and how it was taken.
