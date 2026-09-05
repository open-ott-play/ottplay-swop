# Worker script deploy stays with wrangler/CI because TypeScript must be
# bundled before upload. Terraform owns durable Cloudflare infra only —
# here the KV namespace id used in wrangler bindings.
resource "cloudflare_workers_kv_namespace" "swop" {
  account_id = var.cloudflare_account_id
  title      = var.kv_title
}
