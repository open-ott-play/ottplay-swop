mock_provider "cloudflare" {}

variables {
  account = "00000000000000000000000000000000"
  email   = "terraform-tests@example.invalid"
  key     = "mock-provider-only"
}

run "new_worker_bootstraps_sessions" {
  command = plan
  variables { test_worker_inventory = [] }
  assert {
    condition     = cloudflare_workers_script.swop.migrations.new_tag == "swop-sessions-v1" && cloudflare_workers_script.swop.migrations.new_sqlite_classes[0] == "SwopSession"
    error_message = "A new Worker must provision the SQLite session namespace once."
  }
  assert {
    condition     = length(cloudflare_workers_custom_domain.swop) == 0
    error_message = "Default installations must not adopt any project's custom domain."
  }
}

run "pre_durable_object_worker_bootstraps_sessions" {
  command = plan
  variables { test_worker_inventory = [{ id = "ottplay-swop", migration_tag = null }] }
  assert {
    condition     = cloudflare_workers_script.swop.migrations.new_tag == "swop-sessions-v1"
    error_message = "An existing Worker without a migration tag needs the initial migration."
  }
}

run "subsequent_upload_preserves_existing_sessions" {
  command = plan
  variables {
    session_ttl_seconds   = 601
    test_worker_inventory = [{ id = "unrelated-worker", migration_tag = "other-v1" }, { id = "ottplay-swop", migration_tag = "swop-sessions-v1" }]
  }
  assert {
    condition     = cloudflare_workers_script.swop.migrations == null
    error_message = "Normal updates must omit migration operations and preserve the namespace."
  }
}

run "unknown_migration_history_fails_closed" {
  command = plan
  variables { test_worker_inventory = [{ id = "ottplay-swop", migration_tag = "unexpected-v2" }] }
  expect_failures = [cloudflare_workers_script.swop]
}
