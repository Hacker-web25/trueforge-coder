#!/usr/bin/env bash
# Prepares the fixed demo repository: pallets/flask at tag 3.1.3 (commit 22d92470) with a virtualenv.
# Usage: demo/prepare-flask.sh [target-dir]   (default: ./flask-demo)
set -euo pipefail
DIR="${1:-flask-demo}"
if [ ! -d "$DIR/.git" ]; then
  git clone https://github.com/pallets/flask.git "$DIR"
fi
cd "$DIR"
git fetch --tags --quiet || true
git checkout --quiet 3.1.3
echo "HEAD is $(git rev-parse --short=8 HEAD) (expected 22d92470)"
git reset --hard --quiet && git clean -fdq -e .venv
python3 -m venv .venv
. .venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -e . "pytest==8.4.2" asgiref python-dotenv greenlet  # 8.4.2 runs on Python >= 3.9 (macOS system python is 3.9) and passes tests/test_cli.py; pytest 9.x needs Python >= 3.10
echo "--- baseline: this must pass before you record ---"
pytest tests/test_cli.py -q
echo "--- Task A baseline: FLASK_DEBUG=off is currently truthy (prints True) ---"
FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
git status --short | grep -v '^?? .venv' || true
echo "Ready. Open this folder in VS Code and set trueforgeCoder.commandPreamble to '. .venv/bin/activate &&'"
