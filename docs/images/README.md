# Documentation images

The hero shows the real Worker-rendered **Enter text for your TV** page at a
432 × 768 mobile viewport. The code field is empty: `ABCDEF-GHJKLM` is the
application's built-in placeholder, not a working session code.

## Capture

The checked-in [`swop-entry.jpg`](swop-entry.jpg) is a browser screenshot of the
unmodified entry page from `src/index.ts`. A loopback-only Node harness called
that Worker's `fetch` handler for `GET /`, with only a successful local
rate-limit binding. No credentials, session storage or external services were
configured, and no form was submitted. This documents the entry-page layout,
not a completed handoff or production acceptance.

For a future capture, follow the repository's local Worker development setup,
open its root page in a fresh browser origin/profile, set a 432 × 768 viewport,
and capture the page without browser chrome. Leave the TV-code field empty.
Do not use a real pairing link or configure production credentials. The source
commit, image hash and context are in
[capture-provenance.json](capture-provenance.json).

## Regenerate the hero

Install ImageMagick 7, then run from the repository root:

```sh
./scripts/render-docs-hero.sh
```

The renderer checks the source dimensions before applying perspective, rounded
outer corners, a neutral background and a soft shadow. It does not redraw any
application content. The flat original is preserved and linked from the README.
When replacing it, update the provenance and caption and review the composition.
