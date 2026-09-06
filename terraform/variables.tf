variable "account_xyz" {
  type        = string
  description = "Cloudflare Account ID. Prefer TF_VAR_account_xyz from the shell (same as ~/1/1/home/cloudflare/rules_lists) or a TFC workspace variable; do not commit real values."
}

variable "email_xyz" {
  type        = string
  description = "Cloudflare account email for Global API Key auth. Prefer TF_VAR_email_xyz."
}

variable "key_xyz" {
  type        = string
  sensitive   = true
  description = "Cloudflare Global API Key. Prefer TF_VAR_key_xyz. Do not commit."
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
