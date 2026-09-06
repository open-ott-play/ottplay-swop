#!/usr/bin/env bash
# Bundle Worker into terraform/build for TF content_file.
# Run from repo root before terraform plan/apply.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
test -f dist/index.js
mkdir -p terraform/build
cp dist/index.js terraform/build/worker.js
echo Wrote terraform/build/worker.js
