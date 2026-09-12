# ottplay-swop

Cloudflare Worker for one-time session handoff: desktop creates a short code, mobile fills a form, desktop polls and burns the value after read.

<!-- ci-release-process:start -->
## Release process

See the [release strategy](RELEASING.md) for validation, nightly, beta, RC and stable promotion rules, and the [operator runbook](docs/release-workflow.md) for local commands.
<!-- ci-release-process:end -->

## How it works

```mermaid
sequenceDiagram
  autonumber
  actor Admin as Operator
  actor TV as TV / desktop<br/>(ottplay-foss)
  participant W as Worker + KV
  actor Phone as Phone browser

  Note over Admin,W: Optional once: allowlist client id
  Admin->>W: POST /admin/clients<br/>(Bearer ADMIN_TOKEN)
  W-->>Admin: 201 allowed

  TV->>W: POST /session<br/>X-Swop-Client-Id + caption/draft
  Note over W: Fail closed if id missing / not allowlisted
  W-->>TV: code, url, expiresIn
  Note over TV: Show QR / link / code
  Phone->>W: GET /?c=CODE
  W-->>Phone: HTML form (no client id)
  Phone->>W: POST /submit<br/>(code, value)
  W-->>Phone: ok
  loop Poll until ready / gone / TTL
    TV->>W: GET /val?c=CODE<br/>X-Swop-Client-Id
    alt waiting
      W-->>TV: status waiting
    else ready (burn-after-read)
      W-->>TV: status ready + value
      Note over W: Session deleted from KV
    else missing / burned / expired
      W-->>TV: status gone
    else client mismatch
      W-->>TV: 403 client mismatch
    end
  end
```

## API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /session | allowlisted `X-Swop-Client-Id` | Create session; stores clientId; returns code, url, expiresIn |
| GET | /?c=CODE | none | Mobile HTML form for the session |
| POST | /submit | none | Submit value (code, value); sets status ready |
| GET | /val?c=CODE | allowlisted client id; must match session | Poll waiting/ready/gone; burn-after-read on ready |
| GET | /health | none | ok true |
| POST | /admin/clients | Bearer `ADMIN_TOKEN` | Allowlist a client id |
| DELETE | /admin/clients?id=… | Bearer `ADMIN_TOKEN` | Remove allowlist entry |
| GET | /admin/clients | Bearer `ADMIN_TOKEN` | List allowlisted client ids |

CORS enabled for GET, POST, DELETE, OPTIONS.

## Access control

Operator guide for keeping Cloudflare KV (and Worker invocations) limited to
**your** installs. Random FOSS downloads that point `swopBaseUrl` at your Worker
must not be able to create sessions or poll `/val`.

### Why

Anyone can download a FOSS ottplay binary and point it at our Worker. A shared
secret in the repo would not help: every downloader would have it. "Vasya
Pupkin" installs must not burn KV quota by creating sessions or polling `/val`.

The fix is an **allowlist**: only TVs/desktops whose stable client id is stored
in KV under `allow:{clientId}` can call protected routes. Phone browsers that
open the QR session URL do **not** send a client id and do not need one.

### Client id

Reuse the player **Device UUID** (`dev_…`):

- Shown in **About** / **Settings → Remote control**
- Stored in browser `localStorage` as `deviceId`
- Example shape: `dev_a1b2c3d4e5`

**Rules:** trim whitespace; length **8–128**; charset `[A-Za-z0-9._:-]`.

**Headers** (either name works):

- `X-Swop-Client-Id: <stable-id>`
- `X-Ottplay-Client-Id: <stable-id>` (alias)

### What is protected / not

See the [API](#api) table above. Summary:

| Kind | Routes |
|------|--------|
| **Protected** (allowlisted client id) | `POST /session`, `GET /val` |
| **Unprotected** (by design) | `GET /?c=`, `POST /submit`, `GET /health`, `OPTIONS` |
| **Admin** (Bearer ADMIN_TOKEN) | `/admin/clients*` |

If ADMIN_TOKEN is unset, admin routes return **503** and client routes still
**fail closed** (nobody is allowlisted until you configure the token and add ids).

**Errors:** missing/invalid id -> 401 missing client id; not allowlisted -> 403 client not allowed; /val mismatch -> 403 client mismatch.

### Admin setup (exact steps)

1. Set the admin secret (never put it in `[vars]` or commit it):

   ```bash
   wrangler secret put ADMIN_TOKEN
   ```

2. Deploy the Worker (npm run deploy / CI).

3. Set your base URL (workers.dev or custom domain):

   ```bash
   BASE=https://ottplay-swop.<account>.workers.dev
   ```

4. Allowlist / list / revoke clients (optional note field for humans):

   ```bash
   # Allowlist
   curl -X POST "$BASE/admin/clients" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"clientId":"dev_a1b2c3d4e5","note":"living-room"}'

   # List
   curl -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/admin/clients"

   # Revoke
   curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
     "$BASE/admin/clients?id=dev_a1b2c3d4e5"
   ```

### Manual authorize flow

1. Open the player on the TV/desktop.
2. Copy Device ID from About / Settings → Remote control (or localStorage.deviceId).
3. Run the POST admin/clients example above with that id.
4. Confirm the player sends X-Swop-Client-Id (or alias) on /session and /val, and swopBaseUrl points at your Worker.

### Can `deploy.sh` auto-add clients?

**Today:** `ottplay-foss/deploy.sh` only pulls/runs Docker. It does **not** know
a browser `deviceId` — that id is created on first player load in
`localStorage`, after the container is already up. So the current script cannot
auto-allowlist.

**Yes, we can extend it** for *our* operator installs (optional path, not
default):

| Piece | Notes |
|-------|--------|
| Env on deploy host | `SWOP_BASE_URL`, `SWOP_ADMIN_TOKEN` (secret on the host only — **never** in the image or git), optional `SWOP_CLIENT_ID` |
| If `SWOP_CLIENT_ID` unset | Generate once (`dev_<hex>` UUID) and persist next to the container (host file / volume) |
| After container is up | `curl -X POST "$SWOP_BASE_URL/admin/clients" -H "Authorization: Bearer $SWOP_ADMIN_TOKEN" …` |
| Inject the same id | Future: docker env / settings bootstrap / server-injected config so the player sends that header |

Until the foss client is wired to send the header and use `swopBaseUrl`,
auto-allow alone is **not** enough.

**Public Docker Hub image** must **not** ship `ADMIN_TOKEN` or a pre-allowlisted
id.

### Future foss work (checklist)

- [ ] Generate/persist Device UUID (already exists as `deviceId`)
- [ ] Setting `swopBaseUrl` (empty = remote text entry disabled)
- [ ] ♥™ / remote VKB: `POST /session` + poll `GET /val` with
      `X-Swop-Client-Id` (or alias)
- [ ] Hide key / entry UI when base URL is empty
- [ ] Link player docs to this repo's Access control section

Client wiring lives in [ottplay-foss](https://github.com/open-ott-play/ottplay-foss);
this Worker PR only ships the allowlist API.

## Setup

1. Copy example wrangler config to wrangler.toml; fill placeholders.
2. Install project dependencies.
3. Use package scripts for local development; production Worker updates go through Terraform (see Infrastructure).

wrangler.toml is gitignored and must never be committed with real credentials.

Note: no CF credentials in terraform; keep them outside .tf and state.

## Infrastructure (Terraform Cloud)

Durable Cloudflare resources — Workers KV namespace **and** the Worker script — are managed with Terraform Cloud.

- **Organization:** `open-ott-play`
- **Workspace:** `ottplay-swop` — create in the TFC UI if it does not exist yet
- **Working directory:** `terraform`
- **Execution mode:** Remote (CLI-driven runs upload local `terraform/`, including `terraform/build/worker.js`)
- **VCS:** optional — connect this GitHub repo in the TFC UI via the org OAuth app when available; until then use CLI-driven remote runs (same pattern as sibling workspaces)
- **VCS trigger patterns** (when connected): `terraform/**/*`
- **Credentials** (never commit; Global API Key auth like personal CF terraform):
  - `account` — Cloudflare Account ID
  - `email` — Cloudflare login email
  - `key` (sensitive) — Cloudflare Global API Key
  - `public_base_url` — bound to the Worker as `PUBLIC_BASE_URL` (default `https://swop.2560801.xyz`)
  - `session_ttl_seconds` — bound as `SESSION_TTL_SECONDS` (default `600`)
  - `admin_token` (sensitive, optional) — when set, Terraform manages the `ADMIN_TOKEN` secret_text binding; when empty, `keep_bindings = ["secret_text"]` preserves the existing Wrangler secret
  - TFC remote runs (this workspace is remote): set workspace variables above — local bashrc `TF_VAR_*` is **not** used by the TFC runner
  - Local overrides only if you switch execution to local or use `terraform.tfvars` / `-var`

### Build the Worker artifact (required before plan/apply)

Terraform uploads `terraform/build/worker.js` via `cloudflare_workers_script`. Always rebuild the bundle into that path before plan/apply (see package script `build:terraform` and the matching helper in `scripts/`). The package `build` step produces `dist/index.js`, which must be copied to `terraform/build/worker.js` (gitignored; `terraform/build/.gitkeep` is kept).

Then from `terraform/`: `terraform init`, `terraform plan`, `terraform apply`.

**What Terraform owns:** KV namespace (`cloudflare_workers_kv_namespace.swop`) and Worker script (`cloudflare_workers_script.swop`) with KV + plain_text bindings.

**Outside Terraform for now:** custom hostname / route for `swop.2560801.xyz` (already live). Do not remove it from the Cloudflare dashboard unless you are ready to manage it in TF with the correct zone id.

**Wrangler still useful for:** local `dev` / `tail` and secret experiments. Prefer Terraform apply for production script updates.

**Credentials never in git.** Root and `terraform/` gitignores exclude wrangler.toml, tfvars, `.env*`, credential material, `terraform/build/worker.js`, and local Terraform state/plan files.

### Running locally (disconnect from Terraform Cloud)

Use this when you want `terraform plan` / `apply` on your machine **without** HCP Terraform remote execution or remote state.

Work from the Terraform root: `cd terraform`. The `cloud {}` block lives in `terraform/versions.tf` (organization `open-ott-play`, workspace `ottplay-swop`).

#### Temporary detach (recommended for experiments)

1. Comment out the entire `cloud { ... }` block in `terraform/versions.tf`.
2. Clear the local backend cache:
   ```bash
   cd terraform
   rm -rf .terraform
   ```
3. Re-init (local state by default):
   ```bash
   terraform init
   ```
4. Provide variables locally — TFC workspace variables are **not** used when detached:
   ```bash
   # e.g. terraform.tfvars (gitignored) or:
   # export TF_VAR_account=... TF_VAR_email=... TF_VAR_key=...
   terraform plan
   terraform apply
   ```

#### Keep existing remote state locally (optional)

While still attached to TFC (from `terraform/`):

```bash
terraform state pull > terraform.tfstate
```

Then comment out `cloud {}` in `versions.tf`, `rm -rf .terraform`, `terraform init`, and confirm with `terraform state list`. Keep `terraform.tfstate` **gitignored** — never commit it.

#### Warnings

- Do not apply from both TFC and local against the same resources without coordinating state (drift / conflicts).
- To re-enable TFC: uncomment `cloud {}`, remove local `.terraform` (and local state if migrating back), then `terraform init`. Only `state push` / migrate if you know what you are doing.
- Never commit credentials, `terraform.tfvars` with secrets, or state files.

Requires Terraform ≥ 1.5 (HCP Terraform `cloud {}` block; not the old `backend "remote"` syntax).

## Scripts

- package script:dev -> wrangler-dev (local)
- package script:deploy -> wrangler-deploy (prefer Terraform apply for production)
- package script:tail -> wrangler-tail
- package script:cf-typegen -> wrangler-types
- package script:build:terraform -> helper that fills `terraform/build/worker.js`
- `scripts/build-worker-for-terraform.sh` — required before `terraform plan`/`apply`
- `scripts/render-wrangler.sh` — fill local `wrangler.toml` from terraform outputs for dev/tail (run from **repo root**)
