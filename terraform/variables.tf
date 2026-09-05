variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  description = "Cloudflare API token with Workers Scripts Edit and Workers KV Storage Edit/Read permissions."
}

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID. Prefer setting via Terraform Cloud workspace variables; do not commit real values."
}

variable "worker_name" {
  type        = string
  default     = "ottplay-swop"
  description = "Logical Worker name (deployed via wrangler/CI, not uploaded by Terraform)."
}

variable "kv_title" {
  type        = string
  default     = "ottplay-swop"
  description = "Title for the Workers KV namespace managed by Terraform."
}

variable "public_base_url" {
  type        = string
  default     = ""
  description = "Optional override for the workers.dev URL after first wrangler deploy. Set this after you know the deployed workers.dev hostname."
}

variable "session_ttl_seconds" {
  type        = number
  default     = 600
  description = "Session TTL in seconds (documented for wrangler [vars]; not applied by Terraform to the Worker)."
}
