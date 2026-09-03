#!/bin/sh
# Run every end-to-end suite. Needs Google Chrome. Each suite gets a hard time limit so a hung
# browser fails the run in minutes instead of hanging the CI job.
set -e
cd "$(dirname "$0")/.."
LIMIT=${SUITE_TIMEOUT:-420}
run() {
  echo "--- $1"
  if command -v timeout >/dev/null 2>&1; then timeout -k 10 "$LIMIT" node "$1" || { echo "TIMED OUT or failed: $1"; exit 1; }
  else node "$1"; fi
}
run tools/e2e.mjs
run tools/e2e-scenarios.mjs
run tools/e2e-devreload.mjs
run tools/e2e-pip.mjs
run tools/e2e-text.mjs
