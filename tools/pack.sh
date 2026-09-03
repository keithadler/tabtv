#!/bin/sh
# Zip the extension for the Chrome Web Store (or for sharing). Output: dist/tabtv-<version>.zip
set -e
cd "$(dirname "$0")/.."
V=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
mkdir -p dist
rm -f "dist/tabtv-$V.zip"
zip -qr "dist/tabtv-$V.zip" manifest.json background.js overview.html overview.css overview.js options.html options.css options.js LICENSE icons -x '*.DS_Store'
echo "dist/tabtv-$V.zip"
