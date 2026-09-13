#!/usr/bin/env bash
# Build local artifacts without publishing or deploying. Dependencies must be installed.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?Usage: release-build.sh X.Y.Z [nightly|beta|rc]}"
CHANNEL="${2:-rc}"
python3 scripts/check-release-version.py "$VERSION" "$CHANNEL"
mkdir -p release-output
CONFIG=$(mktemp "$PWD/.release-wrangler.XXXXXX.toml")
trap 'rm -f "$CONFIG"' EXIT
sed 's/YOUR_CLOUDFLARE_ACCOUNT_ID/00000000000000000000000000000000/g; s/YOUR_KV_NAMESPACE_ID/00000000000000000000000000000000/g' wrangler.toml.example > "$CONFIG"
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH="$PWD/release-output/wrangler.log" npx wrangler deploy --dry-run --config "$CONFIG" --outdir release-output/worker
mkdir -p terraform/build
cp release-output/worker/index.js terraform/build/worker.js
tar -czf release-output/ottplay-swop-worker.tar.gz -C release-output/worker .
