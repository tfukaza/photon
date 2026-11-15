#!/usr/bin/env bash
set -euo pipefail
npm run build
release_stage="$(mktemp -d)"
trap 'rm -rf "$release_stage"' EXIT
cp package.json package-lock.json README.md SPEC.md "$release_stage/"
for workspace in apps/server apps/web packages/contracts; do
  mkdir -p "$release_stage/$workspace"
  cp "$workspace/package.json" "$release_stage/$workspace/"
done
cp -R dist assets scripts docs "$release_stage/"
mkdir -p "$release_stage/apps/web"
cp -R apps/web/dist "$release_stage/apps/web/"
(cd "$release_stage" && npm ci --omit=dev)
mkdir -p release
tar -czf "release/photon-$(uname -s)-$(uname -m).tar.gz" -C "$release_stage" .
echo 'Release created. Native dependencies require matching the target OS and architecture.'
