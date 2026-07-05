#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ -n "${PYTHON:-}" ]; then
  py=$PYTHON
elif [ -x "$ROOT/.venv/bin/python" ]; then
  py=$ROOT/.venv/bin/python
elif command -v python3 >/dev/null 2>&1; then
  py=$(command -v python3)
elif command -v python >/dev/null 2>&1; then
  py=$(command -v python)
else
  echo "No Python interpreter found. Set PYTHON=/path/to/python or create .venv." >&2
  exit 1
fi

cd "$ROOT/backend"
PYTHONPATH=. "$py" -m pytest -q
