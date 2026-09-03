#!/bin/sh
# Bump the version in manifest.json: tools/bump.sh [major|minor|patch|X.Y.Z]. Default: patch.
# For folder-loaded installs a new version number is what triggers the self-reload.
set -e
cd "$(dirname "$0")/.."
python3 - "${1:-patch}" <<'PY'
import json, sys
m = json.load(open('manifest.json'))
a, b, c = (int(x) for x in m['version'].split('.'))
arg = sys.argv[1]
if arg == 'major': a, b, c = a + 1, 0, 0
elif arg == 'minor': a, b, c = a, b + 1, 0
elif arg == 'patch': c += 1
else: a, b, c = (int(x) for x in arg.split('.'))
m['version'] = f'{a}.{b}.{c}'
json.dump(m, open('manifest.json', 'w'), indent=2)
open('manifest.json', 'a').write('\n')
print(m['version'])
PY
