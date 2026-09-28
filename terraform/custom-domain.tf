variable "custom_domain_hostname" {
  type        = string
  default     = null
  description = "Optional existing production custom domain to adopt for this Worker. Null leaves custom domains unmanaged; this does not create a new route."
}

locals {
  custom_domains = var.custom_domain_hostname == null ? toset([]) : toset([var.custom_domain_hostname])
}

# Account/domain identifiers are resource IDs, never API credentials.
data "cloudflare_workers_custom_domains" "swop_existing" {
  for_each    = local.custom_domains
  account_id  = nonsensitive(var.account)
  hostname    = each.value
  service     = var.worker_name
  environment = "production"
  max_items   = 2
}

resource "cloudflare_workers_custom_domain" "swop" {
  for_each   = local.custom_domains
  account_id = nonsensitive(var.account)
  hostname   = each.value
  service    = var.worker_name
  zone_id    = one(data.cloudflare_workers_custom_domains.swop_existing[each.key].result).zone_id

  lifecycle {
    prevent_destroy = true
    precondition {
      condition = (
        length(data.cloudflare_workers_custom_domains.swop_existing[each.key].result) == 1 &&
        one(data.cloudflare_workers_custom_domains.swop_existing[each.key].result).hostname == each.value &&
        one(data.cloudflare_workers_custom_domains.swop_existing[each.key].result).service == var.worker_name &&
        one(data.cloudflare_workers_custom_domains.swop_existing[each.key].result).environment == "production"
      )
      error_message = "Exactly one existing custom domain for this production Worker is required; refuse to create or retarget a route."
    }
  }
}

import {
  for_each = local.custom_domains
  to       = cloudflare_workers_custom_domain.swop[each.key]
  id       = "${nonsensitive(var.account)}/${one(data.cloudflare_workers_custom_domains.swop_existing[each.key].result).id}"
}
