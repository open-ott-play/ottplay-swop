# Terraform manages KV + Worker script upload.
# Always build worker artifact into terraform/build before plan/apply.
# Custom hostname swop.2560801.xyz stays outside Terraform for now.

resource "cloudflare_workers_kv_namespace" "swop" {
  account_id = var.account
  title      = var.kv_title
}

locals {
  worker_bindings = concat(
    [
      {
        name         = "SWOP"
        type         = "kv_namespace"
        namespace_id = cloudflare_workers_kv_namespace.swop.id
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
    ],
    var.admin_token != "" ? [
      {
        name = "ADMIN_TOKEN"
        type = "secret_text"
        text = var.admin_token
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

  # Always keep secret_text bindings from the previous upload so an empty
  # var.admin_token does not wipe the existing Wrangler ADMIN_TOKEN. When
  # var.admin_token is set, the ADMIN_TOKEN binding above updates it.
  keep_bindings = ["secret_text"]
}

