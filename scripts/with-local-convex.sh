#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
ref=""
if [[ ${1:-} == --ref ]]; then
  ref=${2:?Missing git revision}
  shift 2
fi
if [[ ${1:-} != -- || $# -lt 2 ]]; then
  echo "Usage: scripts/with-local-convex.sh [--ref REVISION] -- COMMAND [ARG...]" >&2
  exit 2
fi
shift

project=$(mktemp -d)
trap 'rm -rf "$project"' EXIT
cd "$root"
if [[ -n "$ref" ]]; then
  sources=(convex convex.json frontend/src backend/app package.json)
  if git cat-file -e "$ref:shared" 2>/dev/null; then sources+=(shared); fi
  git archive --output="$project/source.tar" "$ref" "${sources[@]}"
  tar -xf "$project/source.tar" -C "$project"
  rm "$project/source.tar"
else
  cp -R convex shared convex.json package.json "$project/"
  mkdir "$project/frontend" "$project/backend"
  ln -s "$root/frontend/src" "$project/frontend/src"
  ln -s "$root/backend/app" "$project/backend/app"
fi
ln -s "$root/node_modules" "$project/node_modules"

cd "$project"
{
  echo 'set -euo pipefail'
  echo 'set -a'
  echo '. ./.env.local'
  echo 'set +a'
  printf '%q ' "$@"
  echo
  echo 'touch check-passed'
} > run-check.sh
env -i PATH="$PATH" CONVEX_AGENT_MODE=anonymous CONVEX_SOURCE_ROOT="$root" \
  python3 "$root/scripts/local-convex-ports.py" ./node_modules/.bin/convex dev --once --codegen enable --typecheck disable \
  --local-backend-version "${CONVEX_TEST_BACKEND_VERSION:-precompiled-2026-11-21-cf39368}" --start 'bash run-check.sh'
if [[ ! -f check-passed ]]; then
  echo "The local Convex check did not finish successfully." >&2
  exit 1
fi
