# How TabTV works

TabTV is a Manifest V3 Chrome extension with no build step and no dependencies. Three
pieces talk to each other through `chrome.storage` and `chrome.runtime` messages.

```
┌────────────────────┐   captureVisibleTab    ┌──────────────────────┐
│ background.js      │ ◄───────────────────── │ the tab in front     │
│ service worker     │                        └──────────────────────┘
│                    │  thumb:<id>, meta:<id>
│  capture, badge,   │ ───────────────────►  chrome.storage.local
│  housekeeping,     │ ◄───────────────────  settings
│  scan, self-reload │
└──────┬─────────────┘
       │ messages (scan, reconcile, stats, ...)        storage.session: lastActive, newVersion
┌──────┴─────────────┐                        ┌──────────────────────┐
│ overview.js        │                        │ options.js           │
│ the guide page     │                        │ the settings page    │
└────────────────────┘                        └──────────────────────┘
```

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest: permissions, the `open-overview` command, the options page. |
| `background.js` | Service worker. Takes pictures, keeps the badge, runs housekeeping, opens the guide, walks the window for SCAN, and reloads itself on folder-loaded installs when a new version appears on disk. |
| `overview.html/.css/.js` | The guide: full-tab page, one card per tab, arrow-key cursor. Runs in demo mode with fake data when opened outside the extension. |
| `options.html/.css/.js` | Settings: never-photograph list, clear pictures, auto-reload switch, shortcut. |
| `tools/` | Tests, screenshot generator, icon generator, bump and pack scripts. Not shipped. |

## Taking pictures

Chrome only lets an extension photograph the active tab of a window
(`chrome.tabs.captureVisibleTab`), so pictures are opportunistic:

1. `tabs.onActivated`, `tabs.onUpdated` (status complete on an active tab), and
   `windows.onFocusChanged` call `scheduleCapture`, which debounces per tab for 350 ms so
   the page has painted.
2. `captureTab` re-reads the tab, checks `allowed` (not incognito, http/https/file/ftp,
   not the guide itself, not on the never-list), grabs a JPEG, and `shrink`s it on an
   `OffscreenCanvas` to 720 px wide at quality 0.74. Typical size is 15 to 40 KB.
3. The picture and a small record are written together:
   - `thumb:<tabId>` = `{ data, url, title, at }` where `data` is a JPEG data URL
   - `meta:<tabId>` = `{ url, at, bytes }`
4. A 30 second alarm re-photographs the front tab of the focused window so long-lived
   tabs do not show their first-arrival frame forever. It skips when `chrome.idle` says
   the screen is locked.
5. Opening the guide photographs the current tab first so the NOW card is fresh.

Chrome throttles `captureVisibleTab` to about two calls per second. Failures (chrome://
pages, minimized windows, throttling) are swallowed; the card shows a snow screen.

## Housekeeping

Tab ids are not stable across undo, session restore, discard, or browser restart, so a
picture is never deleted when its tab closes. Instead `reconcile()` runs at install,
5 seconds after startup, every 10 minutes, and every time the guide opens:

- reads only the `meta:*` records (via `storage.local.getKeys()` when available)
- gives any pre-0.6 picture a record
- **adopts**: a live tab with no picture takes the newest orphaned picture with the same URL
- **expires**: orphaned pictures older than `DEAD_TTL` (7 days) or beyond `DEAD_MAX` (300)

`tabs.onReplaced` (Chrome's discard-and-replace) moves the picture, record, and
last-active time to the new id directly.

## Storage layout

| Area | Key | Value |
| --- | --- | --- |
| `storage.local` | `thumb:<tabId>` | `{ data, url, title, at }` |
| `storage.local` | `meta:<tabId>` | `{ url, at, bytes }` |
| `storage.local` | `text:<tabId>` | `{ text, at }` words on screen at capture time, only when `settings.readText` is on |
| `storage.local` | `settings` | `{ never: string[], autoReload: boolean, readText: boolean }` |
| `storage.session` | `lastActive` | `{ [tabId]: timestamp }` our own most-recently-used clock |
| `storage.session` | `newVersion` | version string on disk when newer than the one running, else null |
| guide `localStorage` | `tabtv-sound`, `tabtv-zoom`, `tabtv-order` | per-browser UI preferences |

`unlimitedStorage` lifts the default 10 MB quota. Nothing is synced or sent anywhere.

## The guide page

`overview.html?from=<tabId>&win=<windowId>` is opened as a tab next to the current one.
`from` is the tab to return to on Escape; `win` is the window whose tabs come first.

- `loadData()` asks the background to reconcile, then reads tabs, windows, tab groups,
  the pictures for live tabs only, the never-list, and the last-active clock. Each tab
  becomes a plain object with `thumb`, `thumbAt`, `channel`, `group`, `dupes`, and so on.
- `render()` builds one `.group` section per window (this window first) with a
  `role=listbox` grid of `.card` elements, applying the filter and the ORDER mode.
- `select(i)` moves the highlight; `placeCursor()` positions the yellow cursor element in
  document coordinates so scrolling does not disturb it. `moveVertical` and `page` use
  geometry (bounding rects) rather than assuming a column count, which is what makes
  navigation work across sections and zoom levels.
- Actions: `go` (activate tab, focus its window, close the guide), `bringHere` (move the
  tab into this window first), `back`, `closeCard`, `closeAllVisible`, `undoClose`
  (`chrome.sessions.restore`), `scanAll`.
- Live updates: `storage.onChanged` swaps in new pictures, `tabs.onRemoved` drops cards,
  `tabs.onCreated` reloads, `tabs.onUpdated` patches titles, and `tabs.onActivated`
  closes the guide when the user switches away by hand (`busy` and
  `ignoreActivationUntil` suppress this during SCAN and undo).
- Demo mode: when `chrome.tabs` is absent the page renders `demoData()` with canvas-drawn
  pictures, so the look can be tweaked in any browser.

## Messages

All messages go through `chrome.runtime.sendMessage` to the background worker.

| `type` | From | Response |
| --- | --- | --- |
| `scan` `{ windowId, skipSleeping }` | guide | `{ scanned, skipped }` after walking the window |
| `scan-preview` `{ windowId }` | guide | `{ total, sleeping }` so the guide can ask first |
| `scan-progress` `{ done, total }` | background → guide | none; drives the SCANNING n/m status |
| `reconcile` | guide | `{ ok }` |
| `refresh-thumb` `{ tabId }` | any | `{ ok }` |
| `picture-stats` | options | `{ n, bytes }` |
| `clear-pictures` | options | `{ ok }` |
| `clear-text` | options | `{ ok }` forgets every stored on-screen text |
| `drop-pictures-matching` `{ never }` | options | `{ dropped }` |
| `get-shortcut` | guide, options | `{ shortcut }` from `chrome.commands.getAll` |
| `open-shortcuts` | options | opens `chrome://extensions/shortcuts` |
| `check-dev-reload` | any | `{ newVersion, guideOpen, autoReload, reload }` |
| `dev-reload` | guide | closes guide tabs, then `chrome.runtime.reload()` |
| `pip` `{ tabId }` | guide | `{ ok, action: 'enter'|'exit' }` or `{ ok: false, reason }` after a one-shot `chrome.scripting.executeScript` of `pipInPage` into that tab |

## Self-reload on folder-loaded installs

`IS_UNPACKED` is true when the manifest has no `update_url`, which is the case for Load
unpacked installs and false for Web Store installs. Every 30 seconds
`devReloadDecision()` fetches `manifest.json` (Chrome serves it from disk for unpacked
extensions), compares the version with the running one, records the newer version in
`storage.session.newVersion` (badge NEW, bar in the guide), and reloads unless the
setting is off, a guide tab is open, or the manifest on disk asks for permissions the
running one does not have. In that last case the bar names the permission and asks for
the reload arrow in `chrome://extensions`, because Chrome disables an extension whose
permissions grew until someone approves them.

## Tests

`tools/lib/harness.mjs` launches headless Google Chrome with `--remote-debugging-pipe`
and `--enable-unsafe-extension-debugging`, loads the extension with the
`Extensions.loadUnpacked` DevTools command (current Chrome ignores `--load-extension`),
serves test pages from an in-process HTTP server, and exposes helpers: `evalSW` runs code
in the service worker, `openGuide` opens the guide exactly as the toolbar does and attaches
to it, `attachPage(...).key/type/shot` drive a page. Every DevTools call has a 20 second
timeout. Three suites use it:

- `e2e.mjs`: the core loop and every feature in isolation
- `e2e-scenarios.mjs`: multiple windows, chrome:// pages, sleeping and pinned tabs, live
  updates, find, channels, order modes, close-all, help, SCAN, a 43-tab window
- `e2e-devreload.mjs`: the self-reload decision, on a scratch copy of the extension
- `e2e-pip.mjs`: Picture-in-Picture with three tabs playing video

Things the harness cannot observe: an actual `chrome.runtime.reload()` (extensions loaded
over the protocol live only in memory), incognito, and the real keyboard shortcut.

## Security and privacy notes

- No network requests, no remote code, no analytics. The `<all_urls>` host permission
  exists solely because `captureVisibleTab` requires it.
- The extension has no content scripts. It injects a one-shot script in exactly two cases:
  `pipInPage` for Picture-in-Picture, on Shift+P or the PIP button, touching only `<video>`
  elements; and `visibleTextInPage`, only when the user has turned on "search what was on
  screen", which returns the text nodes inside the viewport (never form fields) at the
  moment a picture is taken. Turning the switch off deletes all stored text.
- Titles and URLs are inserted with `textContent`, never HTML.
- Pictures are stored only in the local profile and can be wiped from Settings.
- Incognito tabs and never-listed sites are excluded at capture time, not just hidden.
