# ottplay-swop

Cloudflare Worker for one-time session handoff: desktop creates a short code, mobile fills a form, desktop polls and burns the value after read.

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | /session | Create session; optional caption and draft; returns code, url, expiresIn |
| GET | /?c=CODE | Mobile HTML form for the session |
| POST | /submit | Submit value (code, value); sets status ready |
| GET | /val?c=CODE | Poll waiting/ready/gone; burn-after-read on ready |
| GET | /health | ok true |

CORS enabled for GET, POST, OPTIONS.

## Setup

1. Copy example wrangler config to wrangler.toml; fill placeholders.
2. Install project dependencies.
3. Run local dev or deploy via package scripts.

wrangler.toml is gitignored and must never be committed with real credentials.

Note: no CF credentials in terraform; keep them outside .tf and state.

## Scripts

- package script:dev -> wrangler-dev
- package script:deploy -> wrangler-deploy
- package script:tail -> wrangler-tail
- package script:cf-typegen -> wrangler-types
