# Contributing

TabTV is MIT licensed. Bug reports, fixes, and ideas are welcome.

## Set up

```
git clone https://github.com/keithadler/tabtv.git
cd tabtv
```

There is nothing to install. Load the folder in Chrome from `chrome://extensions` with
Developer mode on and **Load unpacked**. Node 22 or newer and Google Chrome are needed
only for the tests and tools.

## Work on the look

Open `overview.html` from any static server (`python3 -m http.server`) and it renders a
demo set of tabs. Edit `overview.css` and reload the page. No extension reload needed.

## Work on behavior

Edit the source, then either press the reload arrow on the TabTV card in
`chrome://extensions` or run `tools/bump.sh patch`; a folder-loaded install notices the new
version and reloads itself within a minute while the guide is closed.

## Test

```
npm test            # or tools/test.sh
```

Runs three headless suites in a real Chrome (about two minutes). Each prints PASS/FAIL per
check and leaves screenshots in a temp folder. `DEBUG=1` dumps DevTools events on failure.
`CHROME=/path/to/chrome` picks another binary. Add a check for every behavior change; the
harness in `tools/lib/harness.mjs` is documented in ARCHITECTURE.md.

## Style

- Plain ES2022, no transpiling, no dependencies. Two-space indent, single quotes,
  semicolons.
- Comments explain why, not what. Every exported or top-level function has a one-line
  doc comment.
- Text in the guide is uppercase and terse, in the spirit of a 1990s on-screen display.
- American English. No em dashes.

## Release

```
tools/bump.sh minor      # or patch / major / X.Y.Z, also updates the self-reload trigger
tools/pack.sh            # dist/tabtv-<version>.zip for the Web Store
node tools/store-shots.mjs   # regenerates store/ screenshots when the look changed
```

Update CHANGELOG.md with every user-visible change.
