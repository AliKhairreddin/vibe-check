#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
python=${PYTHON:-"$root/.venv/bin/python"}
if [[ ! -x "$python" ]]; then python=$(command -v python3); fi
if [[ $# -eq 1 ]]; then
  set -- --ref "$1"
elif [[ $# -gt 1 ]]; then
  echo "Usage: scripts/test-batch-db.sh [git-ref]" >&2
  exit 2
fi
exec "$root/scripts/with-local-convex.sh" "$@" -- bash -ec '
  export PYTHONPATH="$PWD/backend" JOB_DATA_DIR="$PWD/jobs" CONVEX_HTTP_SECRET=batch-completion-test
  ./node_modules/.bin/convex env set CONVEX_HTTP_SECRET "$CONVEX_HTTP_SECRET"
  exec "$1" -m pytest -q "$CONVEX_SOURCE_ROOT/tests/e2e/test_batch_completion.py"
' bash "$python"
