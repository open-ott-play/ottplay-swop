# Terraform manages KV + Worker script upload.
# Build the Worker for code updates; imports preserve the deployed artifact.
# Existing custom domains can be adopted explicitly; see custom-domain.tf.

resource "cloudflare_workers_kv_namespace" "swop" {
  account_id = var.account
  title      = var.kv_title
}

# Cloudflare treats migrations as imperative upload operations. The provider
# re-sends configured migrations on every update, so inspect the live tag first.
# Listing also handles a fresh account where the Worker does not exist yet.
data "cloudflare_workers_scripts" "existing" {
  account_id = var.account
  max_items  = 10000
}

locals {
  existing_worker = [for script in data.cloudflare_workers_scripts.existing.result : script if script.id == var.worker_name]
  migration_tag   = try(local.existing_worker[0].migration_tag, null)
  bootstrap       = local.migration_tag == null || local.migration_tag == ""

  worker_bindings = concat(
    [
      {
        name         = "SWOP"
        type         = "kv_namespace"
        namespace_id = cloudflare_workers_kv_namespace.swop.id
      },
      {
        name       = "SESSIONS"
        type       = "durable_object_namespace"
        class_name = "SwopSession"
      },
      {
        name         = "REQUEST_RATE_LIMIT"
        type         = "ratelimit"
        namespace_id = "1001"
        simple = {
          limit  = 240
          period = 60
        }
      },
      {
        name = "PUBLIC_BASE_URL"
        type = "plain_text"
        text = var.public_base_url
      },
      {
        name = "SESSION_TTL_SECONDS"
        type = "plain_text"
        text = tostring(var.session_ttl_seconds)
      },
      {
        name = "VPORTAL_ENDPOINTS_JSON"
        type = "plain_text"
        text = jsonencode(var.vportal_endpoints)
      },
    ],
    var.admin_token != "" ? [
      {
        name = "ADMIN_TOKEN"
        type = "secret_text"
        text = var.admin_token
      },
    ] : [],
    var.installation_credentials_json != "" ? [
      {
        name = "INSTALLATION_CREDENTIALS_JSON"
        type = "secret_text"
        text = var.installation_credentials_json
      },
    ] : [],
  )
}

resource "cloudflare_workers_script" "swop" {
  account_id         = var.account
  script_name        = var.worker_name
  content_file       = "${path.module}/build/worker.js"
  content_sha256     = filesha256("${path.module}/build/worker.js")
  main_module        = "worker.js"
  compatibility_date = "2025-09-01"

  bindings = local.worker_bindings

  migrations = local.bootstrap ? {
    new_tag            = "swop-sessions-v1"
    new_sqlite_classes = ["SwopSession"]
  } : null

  lifecycle {
    precondition {
      condition     = length(data.cloudflare_workers_scripts.existing.result) < 10000
      error_message = "Worker inventory may be truncated; refuse to infer a missing migration tag."
    }
    precondition {
      condition     = local.bootstrap || local.migration_tag == "swop-sessions-v1"
      error_message = "Unexpected live Durable Object migration tag; review migration history before deploying."
    }
  }

  # Always keep secret_text bindings from the previous upload so an empty
  # empty secret variables do not wipe existing bindings. A nonempty variable
  # explicitly updates its corresponding secret.
  keep_bindings = ["secret_text"]
}
