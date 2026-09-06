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
  description = "Cloudflare Worker script name managed by Terraform (cloudflare_workers_script)."
}

variable "kv_title" {
  type        = string
  default     = "ottplay-swop"
  description = "Title for the Workers KV namespace managed by Terraform."
}

variable "public_base_url" {
  type        = string
  default     = "https://swop.2560801.xyz"
  description = "Public base URL bound to the Worker as PUBLIC_BASE_URL (plain_text)."
}

variable "session_ttl_seconds" {
  type        = number
  default     = 600
  description = "Session TTL in seconds bound to the Worker as SESSION_TTL_SECONDS (plain_text)."
}

variable "admin_token" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Optional ADMIN_TOKEN secret_text binding. Leave empty to keep the existing Wrangler secret via keep_bindings."
}
