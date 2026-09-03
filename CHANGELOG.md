# Changelog

## 1.0.0
First release. Everything below, plus a CI workflow, privacy and security policies, and a Web Store listing kit.

## 0.8.0
- Search what was on screen (opt-in): the words visible when a picture is taken are stored beside it and
  searched by the guide, with a SEEN snippet on matching cards. No dependencies, no page reads unless on.

## 0.7.0
- Picture-in-Picture from the guide: Shift+P or the PIP button on a playing tab pops its video out.
  Uses a one-shot script injection into that tab only, on your explicit action (new `scripting` permission).

## 0.6.x
- Documentation: ARCHITECTURE.md, CONTRIBUTING.md, doc comments on every function.
- Bookkeeping record per picture so housekeeping never reads screenshots.
- Shift+Enter brings a tab from another window here. Tab / Shift+Tab jump between window sections.
- Listbox roles, aria-selected, live regions for screen readers.
- ORDER cycles tabs / recent / site. Shift+Delete closes every tab shown. Picture age on hover.
- `tools/bump.sh` bumps the version, which is what deploys to a folder-loaded install.
- Fix: the update bar was always visible (author display rule beat the hidden attribute).
- Help card on ?, real shortcut shown in help and settings, SCAN progress and sleeping-tab confirmation, popup-window guard.

## 0.5.0
- Folder-loaded installs notice a new version on disk: NEW badge, RELOAD bar, self-reload (switchable).

## 0.4.0
- Settings page: never-photograph list, clear all pictures, shortcut link.
- Pictures of closed tabs kept seven days and matched back by URL after undo, restore, or restart.
- Private tabs never photographed. Idle-aware refresh. Release packaging and Web Store kit.

## 0.3.0
- Guide closes itself when you click another tab. Delete + Cmd+Z undo. Zoom. RECENT order.
- Big cached favicons on cards without a picture. Tab count badge.

## 0.2.0
- Tab group tags, sharper thumbnails, PageUp/PageDown, reduced-motion support.

## 0.1.0
- The guide: screenshot grid, arrow-key cursor, Enter, Escape, channel numbers, find, SCAN, beeps.
