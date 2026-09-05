#!/usr/bin/env bash
# Render wrangler.toml from wrangler.toml.example using Terraform outputs.
# Requires: terraform apply already done (or outputs available in the TFC workspace).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE="$ROOT/wrangler.toml.example"
OUT="$ROOT/wrangler.toml"

if [[ ! -f "$EXAMPLE" ]]; then
  echo "error: missing $EXAMPLE" >&2
  exit 1
fi

KV_ID="$(terraform -chdir="$ROOT/terraform" output -raw kv_namespace_id)"
WORKER_NAME="$(terraform -chdir="$ROOT/terraform" output -raw worker_name 2>/dev/null || echo "ottplay-swop")"

# Prefer PUBLIC_BASE_URL from env; else leave example placeholder for user to set after first deploy.
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://example.workers.dev}"
SESSION_TTL_SECONDS="${SESSION_TTL_SECONDS:-600}"

cp "$EXAMPLE" "$OUT"
# macOS sed -i needs '' for in-place; also support GNU sed.
if sed --version >/dev/null 2>&1; then
  SED_INPLACE=(sed -i)
else
  SED_INPLACE=(sed -i '')
fi

"${SED_INPLACE[@]}" "s/YOUR_KV_NAMESPACE_ID/${KV_ID}/g" "$OUT"
"${SED_INPLACE[@]}" "s/^name = \".*\"/name = \"${WORKER_NAME}\"/" "$OUT"
"${SED_INPLACE[@]}" "s|PUBLIC_BASE_URL = \".*\"|PUBLIC_BASE_URL = \"${PUBLIC_BASE_URL}\"|" "$OUT"
"${SED_INPLACE[@]}" "s|SESSION_TTL_SECONDS = \".*\"|SESSION_TTL_SECONDS = \"${SESSION_TTL_SECONDS}\"|" "$OUT"

echo "Wrote $OUT (gitignored) with kv_namespace_id=$KV_ID"
echo "Set PUBLIC_BASE_URL after first wrangler deploy if still using the example hostname."
