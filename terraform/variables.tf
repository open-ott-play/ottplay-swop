variable "account" {
  type        = string
  description = "Cloudflare Account ID. Set via TFC workspace variable or local terraform.tfvars / -var; do not commit real values."
}

variable "email" {
  type        = string
  description = "Cloudflare account email for Global API Key auth."
}

variable "key" {
  type        = string
  sensitive   = true
  description = "Cloudflare Global API Key. Prefer TFC workspace sensitive variable for remote runs. Do not commit."
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
