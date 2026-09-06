output "kv_namespace_id" {
  description = "Workers KV namespace ID (SWOP binding)."
  value       = cloudflare_workers_kv_namespace.swop.id
}

output "worker_name" {
  description = "Cloudflare Worker script name managed by Terraform."
  value       = cloudflare_workers_script.swop.script_name
}

output "worker_script_id" {
  description = "Cloudflare Worker script id (same as script_name)."
  value       = cloudflare_workers_script.swop.id
}

output "deploy_hint" {
  description = "How to deploy: build artifact, then terraform apply (not wrangler deploy for production)."
  value       = <<-EOT
    # From repo root, before plan/apply:
    #   ./scripts/build-worker-for-terraform.sh
    # Then:
    #   cd terraform && terraform plan && terraform apply
    # Worker: ${cloudflare_workers_script.swop.script_name}
    # KV:     ${cloudflare_workers_kv_namespace.swop.id}
    # PUBLIC_BASE_URL / SESSION_TTL_SECONDS come from Terraform variables.
    # ADMIN_TOKEN: set TFC sensitive var admin_token, or leave unset to preserve the existing Wrangler secret.
    # Custom hostname swop.2560801.xyz remains outside Terraform for now.
  EOT
}
