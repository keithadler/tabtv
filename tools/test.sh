#!/bin/sh
# Run every end-to-end suite. Needs Google Chrome.
set -e
cd "$(dirname "$0")/.."
node tools/e2e.mjs
node tools/e2e-scenarios.mjs
node tools/e2e-devreload.mjs
node tools/e2e-pip.mjs
node tools/e2e-text.mjs
