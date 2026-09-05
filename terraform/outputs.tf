output "kv_namespace_id" {
  description = "Workers KV namespace ID to put in wrangler.toml [[kv_namespaces]].id"
  value       = cloudflare_workers_kv_namespace.swop.id
}

output "worker_name" {
  description = "Logical Worker name (wrangler name / deploy target)"
  value       = var.worker_name
}

output "wrangler_toml_hint" {
  description = "How to fill wrangler.toml from Terraform outputs (not a secret file)"
  value       = <<-EOT
    # After terraform apply, copy into local wrangler.toml (from wrangler.toml.example):
    # name = "${var.worker_name}"
    # [[kv_namespaces]]
    # binding = "SWOP"
    # id = "${cloudflare_workers_kv_namespace.swop.id}"
    # [vars]
    # PUBLIC_BASE_URL = "<set after first wrangler deploy, or var.public_base_url if set>"
    # SESSION_TTL_SECONDS = "${var.session_ttl_seconds}"
  EOT
}
