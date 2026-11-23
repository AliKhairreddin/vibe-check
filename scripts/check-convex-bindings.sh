#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
exec "$root/scripts/with-local-convex.sh" -- bash -ec '
  if ! diff -ru "$CONVEX_SOURCE_ROOT/convex/_generated" convex/_generated; then
    echo "Run pnpm exec convex codegen for your development deployment and commit convex/_generated." >&2
    exit 1
  fi
'
