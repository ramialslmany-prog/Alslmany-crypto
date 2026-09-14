#!/usr/bin/env bash
# The backend's half of `npm run verify`: lint, format check, and the suite.
#
# Kept as a script rather than inlined into the hook so the same command runs
# locally, in the hook, and in CI — one definition of what passing means.
set -euo pipefail

cd "$(dirname "$0")"

PY=".venv/bin/python"
if [ ! -x "$PY" ]; then
  # CI installs into the ambient environment rather than a checked-in venv.
  PY="$(command -v python3)"
fi

echo "backend: ruff check"
"$PY" -m ruff check app tests

echo "backend: ruff format --check"
"$PY" -m ruff format --check app tests

echo "backend: pytest"
"$PY" -m pytest tests -q

echo "backend: all green"
