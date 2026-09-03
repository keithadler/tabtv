# TabTV

Version 1.0. Source: https://github.com/keithadler/tabtv

MIT licensed. See [LICENSE](LICENSE). How it works: [ARCHITECTURE.md](ARCHITECTURE.md). Helping out: [CONTRIBUTING.md](CONTRIBUTING.md).

A WebTV-style channel guide for your Chrome tabs. Press the shortcut and the whole
window becomes a grid of big page screenshots. Drive the glowing cursor with the
arrow keys, press Enter to switch, punch in a channel number to jump, type to find.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Optional: set the shortcut at `chrome://extensions/shortcuts`. Default is
   Cmd+Shift+Space on macOS, Ctrl+Shift+Space elsewhere. Clicking the toolbar icon works too.

### Staying current when loaded unpacked

An unpacked install checks `manifest.json` on disk every 30 seconds. When the version
number there is newer than the one running, the toolbar badge turns green and says NEW,
the guide shows a bar with a RELOAD button, and by default the extension reloads itself
the next time the guide is not open. Turn the automatic part off in Settings if you would
rather press the button. A version that adds permissions still needs the reload arrow in
`chrome://extensions` so you can approve them; the bar says which permission and does not
auto-reload in that case. Store installs skip all of this.

## Keys

| Key | Action |
| --- | --- |
| Arrows | Move the cursor (left/right wrap, up/down pick the nearest card in the next row) |
| Enter or Space | Switch to that tab (Space types a space while you are searching) |
| Shift+Enter or Shift+click | Bring a tab from another window into this one and switch to it |
| Tab / Shift+Tab | Jump to the next / previous window section |
| Esc or Backspace | Go back to the tab you came from |
| Delete | Close the highlighted tab |
| Shift+Delete | Close every tab currently shown (press twice; useful after a search) |
| Shift+P or the PIP button | Pop that tab's video into a floating Picture-in-Picture window and go back to what you were doing |
| 0-9 | Channel number, like a TV remote. Pause and it jumps. |
| Letters | Find by title or URL. Esc clears. |
| ? | Help card with every key and your actual shortcut |
| Home / End | First / last card |
| PageUp / PageDown | Jump a screenful up or down |
| + / - | Bigger or smaller cards (remembered) |
| Cmd+Z or Ctrl+Z | Reopen the tab you just closed |
| Middle click | Close that tab |

Cards in a Chrome tab group carry the group's color and name in the corner. Tabs open
more than once show an orange ×2 badge so you can close the extras. Hover the domain
line to see the full URL.

The **ORDER** button cycles tab-strip order, most-recently-used first, and grouped by site.
Channel numbers always mean tab-strip position, so punching in a number works either way.

Click any other tab while the guide is open and the guide closes itself. The toolbar icon
shows your tab count.

## How pictures get taken

Chrome only lets an extension screenshot the tab you are looking at. TabTV grabs a
frame each time a tab comes to the front or finishes loading, and refreshes the front
tab every 30 seconds. Tabs you have not visited since installing show a NO PREVIEW
snow screen with the site favicon; hover a picture to see when it was taken. Press **SCAN** in the top bar to visit every tab in
the window once and fill them all in; it shows progress, and if some tabs are asleep it
asks first because visiting them wakes them up (press S to skip those).

Pages Chrome refuses to capture (`chrome://`, the Web Store, some PDF viewers) keep the
snow screen.

Thumbnails are stored locally in `chrome.storage.local`. Nothing leaves your machine.
When a tab closes its picture is kept for seven days (at most 300 of them) so that undo,
session restore, and a browser restart can match it back to the same URL. Private
(incognito) tabs are never photographed.

## Settings

Right-click the toolbar icon and choose Options, or open the extension's details page.
You can list sites that must never be photographed (subdomains match), clear every
stored picture, and jump to Chrome's shortcut page.

**Search what was on screen** is off by default. Turn it on and TabTV also notes the
words visible on the page whenever it takes a picture, so typing in the guide finds a tab
by what you saw there. Matching cards show a SEEN line with the words around the match.
The text lives beside the picture on your computer, never leaves it, skips never-listed
sites, and is wiped when you turn the switch off. Nothing is read from a page unless this
is on.

## Packaging

```
tools/pack.sh
```

writes `dist/tabtv-<version>.zip`, ready for the Chrome Web Store dashboard.
[STORE.md](STORE.md) has the listing copy, permission justifications, and privacy text
to paste into the dashboard, and `node tools/store-shots.mjs` regenerates the 1280×800
screenshots and promo tile in `store/` from a real Chrome.

## Demo mode

Open `overview.html` as a plain file or over a local server and it renders fake tabs,
so the look can be tweaked without reloading the extension. Scan and tab switching
are stubbed there.

## Tests

```
tools/test.sh
```

Runs two headless suites against a real Google Chrome with a throwaway profile, loading
the extension through the DevTools protocol (Chrome 126 or newer; the old
`--load-extension` flag is ignored by current Chrome):

- `tools/e2e.mjs` covers the core loop: capture, the guide page, arrow keys, Enter,
  Escape, SCAN, group tags, badge, undo, auto-close, the never-list, picture expiry,
  and the options page.
- `tools/e2e-scenarios.mjs` covers the awkward cases: multiple windows, chrome://
  pages, pinned and sleeping tabs, tabs opening and closing while the guide is up,
  find and channel keys, RECENT order, and a 43-tab window.

Both print PASS/FAIL per check and leave screenshots in a temp folder. Set `DEBUG=1`
to dump DevTools events on a failure. `CHROME=/path/to/chrome` overrides the binary.

## Files

- `manifest.json` MV3 manifest
- `background.js` capture, storage, guide opener, scan
- `overview.html` / `overview.css` / `overview.js` the guide page
- `tools/make_icons.py` regenerates the icons with Pillow
- `options.html` / `options.css` / `options.js` the settings page
- `tools/e2e.mjs`, `tools/e2e-scenarios.mjs`, `tools/e2e-devreload.mjs`, `tools/lib/harness.mjs` headless tests
- `tools/test.sh` runs both suites
- `tools/pack.sh` zips a release
- `tools/store-shots.mjs` regenerates the Web Store screenshots in `store/`
- `STORE.md` Web Store listing kit
- `LICENSE` MIT
- `ARCHITECTURE.md` how the pieces fit, storage layout, message protocol
- `CONTRIBUTING.md` workflow, style, release steps
- `CHANGELOG.md` what changed when
- `PRIVACY.md` the privacy policy (host this URL for the store listing)
- `SECURITY.md` how to report a security problem
- `.github/workflows/test.yml` runs every suite on push

## License

[MIT](LICENSE). Copyright 2026 Keith Adler. Use it, fork it, ship it.
