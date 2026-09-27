#!/usr/bin/env python3
"""Test the real migration HCL with fixture inventory, isolated from live state.

Cloudflare's custom nested-list data source cannot be populated by Terraform's
override_data. Replace only its read-only inventory transport with a variable;
leave the production locals, resource arguments, and preconditions unchanged.
The provider is mocked, so these plans cannot read or change Cloudflare resources.
"""
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = root / "terraform"

with tempfile.TemporaryDirectory(prefix="swop-migration-tests-") as temporary:
    target = Path(temporary)
    for path in source.glob("*.tf"):
        text = path.read_text()
        if path.name == "versions.tf":
            text, count = re.subn(r"  cloud \{\n.*?\n  \}\n", "", text, flags=re.S)
            if count != 1:
                raise SystemExit("Expected exactly one cloud backend to remove from the test copy")
        if path.name == "main.tf":
            text, count = re.subn(
                r'data "cloudflare_workers_scripts" "existing" \{[^}]*\}',
                'variable "test_worker_inventory" {\n'
                '  type = list(object({ id = string, migration_tag = optional(string) }))\n}',
                text,
            )
            if count != 1:
                raise SystemExit("Expected exactly one read-only Worker inventory data source")
            text = text.replace("data.cloudflare_workers_scripts.existing.result", "var.test_worker_inventory")
        (target / path.name).write_text(text)
    (target / "build").mkdir()
    shutil.copyfile(source / "build/worker.js", target / "build/worker.js")
    shutil.copyfile(source / ".terraform.lock.hcl", target / ".terraform.lock.hcl")
    (target / "tests").mkdir()
    shutil.copyfile(root / "tests/terraform-migrations.tftest.hcl", target / "tests/migrations.tftest.hcl")
    subprocess.run([
        "terraform", "init", "-backend=false", "-input=false", "-no-color",
        f"-plugin-dir={source / '.terraform/providers'}",
    ], cwd=target, check=True)
    subprocess.run(["terraform", "test", "-no-color"], cwd=target, check=True)
