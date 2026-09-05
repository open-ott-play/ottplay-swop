terraform {
  required_version = ">= 1.15.7"
  cloud {
    organization = "victron-venus"
    workspaces { name = "ottplay-swop" }
  }
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}
