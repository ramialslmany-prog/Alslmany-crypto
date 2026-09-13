#!/usr/bin/env bash
# One command to get a working checkout.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> installing the backend (editable, with dev extras)"
python3 -m venv backend/.venv
backend/.venv/bin/pip install --quiet --upgrade pip
backend/.venv/bin/pip install --quiet -e "backend[dev]"

# The pre-push hook lives in the repository rather than in .git/hooks, so it is
# version-controlled and reviewable. Git needs to be told where to look.
echo "==> installing the pre-push hook"
git config core.hooksPath .githooks

echo
echo "Done."
echo "  run:     backend/.venv/bin/python -m uvicorn app.main:app --reload --app-dir backend"
echo "  verify:  ./backend/verify.sh"
