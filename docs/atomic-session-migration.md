# Atomic sessions and rate-limit rollout

This candidate replaces `sess:*` KV records with one SQLite-backed Durable Object
per normalized short code. KV remains the legacy client allowlist. Legacy HTTP
payloads and headers remain compatible with the 27 recorded wire fixtures.
Installation-authorized sessions add separate read/write capabilities; see README.

## State and auth

Allocation, submit and consume use storage transactions. A successful consume
replaces the payload with an expiry-only tombstone before returning the value.
The tombstone prevents reuse until expiry; no value is retained in it. Every
operation checks expiry even before an alarm runs. Alarm cleanup also handles a
submit that extended TTL after an earlier alarm was queued. A lost ready response
can still lose the value: this is at-most-once handoff, not guaranteed delivery.

For installation sessions the trusted backend supplies an installation secret,
and reads also require a random per-session capability and matching owner ID.
The phone needs its separate write capability, carried in the returned URL.
For legacy sessions only, the allowlisted Device UUID and short-code phone flow
remain unchanged; legacy credentials cannot read an installation session.
Allowlist revocation retains Cloudflare KV propagation semantics. Keep all
installation and admin secrets out of client distributions and artifacts.

## Required bindings

Both Wrangler and Terraform declare `SESSIONS` (`SwopSession`, SQLite migration
`swop-sessions-v1`) and `REQUEST_RATE_LIMIT` (namespace `1001`, 240 requests per
60 seconds per installation plus `CF-Connecting-IP` for authenticated installation
traffic, and per `CF-Connecting-IP` otherwise). Verify that the numeric rate-limit namespace
is appropriate for this account before applying it. A missing limiter returns
503 for all routes except health/OPTIONS; missing session storage returns 503
when a session operation is reached. Responses include `Cache-Control: no-store`.

The limiter includes admin, protected client and public code routes. Health and
CORS preflight are excluded. A shared NAT shares the budget: several players
polling behind one address can exhaust it. A denial returns 429 and
`Retry-After: 60`. Cloudflare rate-limit counters are local to a Cloudflare
location and permissive/eventually consistent; this is an abuse guard, not a
strict global quota or proof against distributed code guessing. Check zone/WAF
rules, origin routing and client retry behavior separately in the target account.

## Cutover and rollback

Terraform reads the live Worker inventory before each plan. It sends the initial
`swop-sessions-v1` migration only when the target Worker is absent or has no
migration tag. When that tag is already present, uploads omit `migrations` and
retain the existing SQLite namespace and its data. Re-sending the original
create operation would fail Cloudflare's migration-tag precondition on updates.
An unknown tag or potentially truncated inventory fails closed; future schema
migrations need a deliberate update to the expected tag and migration steps.
Do not delete/recreate the Worker or namespace to work around a tag mismatch.
Create a fresh plan after applying a configuration fix; an old saved plan still
contains the old migration operation. The account credential must permit listing
Workers as well as updating this Worker.

The behavior follows Cloudflare's [upload API migration preconditions](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
and the [Terraform provider migration schema](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/workers_script).
`python3 scripts/test-terraform-migrations.py` covers first creation, upgrading
a pre-DO Worker, ordinary updates after bootstrap, and rejecting an unexpected
tag. It copies the production HCL to a temporary directory, supplies fixture
inventory, and uses a mocked provider without the cloud backend or live state.

1. Validate the built candidate and review a Terraform plan in the existing
   workspace/account. Confirm the allowlist namespace and existing admin secret
   are preserved; check the live routes, rate-limit binding, SQLite class and
   migration state. Local validation does not inspect these production settings.
2. Choose a maintenance window. Stop new session creation/submission at the edge
   and wait the configured TTL before the switch, or explicitly invalidate active
   codes and ask users to generate new ones after deployment. The new Worker
   intentionally never reads old `sess:*` KV records. No plaintext session-copy
   migration is supplied.
3. Deploy via the repository's Terraform workflow. Confirm an authorized player's
   create→form→submit→consume path, cross-client rejection, repeated consume,
   waiting expiry and 429 recovery using synthetic data. Also verify missing/wrong
   installation credentials, a copied-site Origin, read/write capability isolation,
   and the here.now trusted-proxy transport without browser identity headers.
4. Roll back with a compatible Durable Object-aware Worker. Do not switch directly
   back to a KV-reading build while old KV session values may remain readable;
   it could re-expose a previously handed-off payload. If legacy rollback is
   unavoidable, disable session traffic, deliberately invalidate old codes and
   verify expiry/cleanup before reopening. Do not delete the Durable Object class
   as an incidental rollback step.

## Reproduce locally

`npm ci && npm test && npm run typecheck` runs immutable HTTP wire fixtures and
real workerd tests with SQLite storage. Coverage includes 32 concurrent submits,
32 consumes, cross-client rejection, storage persistence across a full runtime
restart, code collisions, TTL, no KV fallback and the real rate-limit binding.
Use the configured Wrangler dry-run and isolated backend-free `terraform validate`
to validate packaging; neither substitutes for a live plan/read-back.

Sources: [Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[Workers rate limits and consistency](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
[Terraform Worker script resource](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/workers_script).
