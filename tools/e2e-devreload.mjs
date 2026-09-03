// TabTV. Copyright 2026 Keith Adler. SPDX-License-Identifier: MIT
// Unpacked installs notice a new version in manifest.json on disk: NEW badge, a RELOAD bar in
// the guide, and (unless switched off, or the guide is open) a self-reload. The reload itself
// cannot be observed here because extensions loaded over the DevTools protocol live only in
// memory, so the decision is tested in dry-run mode on a scratch copy of the extension.
import { launch, sleep, testPage, EXT } from './lib/harness.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const copy = mkdtempSync(path.join(os.tmpdir(), 'tabtv-copy-'));
for (const f of ['manifest.json', 'background.js', 'overview.html', 'overview.css', 'overview.js', 'options.html', 'options.css', 'options.js', 'icons']) cpSync(path.join(EXT, f), path.join(copy, f), { recursive: true });
const ORIGINAL_PERMS = JSON.parse(readFileSync(path.join(copy, 'manifest.json'), 'utf8')).permissions;
const bump = (v, addPermission) => { const m = JSON.parse(readFileSync(path.join(copy, 'manifest.json'), 'utf8')); m.version = v; m.permissions = addPermission ? [...ORIGINAL_PERMS, addPermission] : ORIGINAL_PERMS; writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(m, null, 2)); };

const h = await launch({ pages: { '/p1.html': testPage(1) }, port: 8782, name: 'devreload', extPath: copy });
const { check, evalSW } = h;
try {
  const running = await evalSW('chrome.runtime.getManifest().version');
  check('running the version we loaded', running === JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version, running);
  check('unpacked install detected', await evalSW('IS_UNPACKED') === true);
  check('dev-reload alarm is scheduled', !!(await evalSW(`chrome.alarms.get('dev-reload')`)));
  let d = await evalSW('devReloadDecision()');
  check('nothing to do while the version on disk is unchanged', d.newVersion === null && d.reload === false, JSON.stringify(d));
  check('badge shows the tab count meanwhile', await evalSW('chrome.action.getBadgeText({})') === '1');

  // keep the real alarm from reloading underneath the test
  await evalSW(`chrome.storage.local.set({ settings: { autoReload: false } })`);
  await sleep(200);
  const winA = (await h.tabs())[0].windowId;
  let g = await h.openGuide(winA);
  bump('9.9.9');
  d = await evalSW('devReloadDecision()');
  check('new version on disk is noticed', d.newVersion === '9.9.9', JSON.stringify(d));
  check('guide being open blocks a reload', d.guideOpen === true && d.reload === false);
  check('badge switches to NEW', await evalSW('chrome.action.getBadgeText({})') === 'NEW');
  await sleep(400);
  const bar = await g.evalP(`({ hidden: document.querySelector('#update').hidden, text: document.querySelector('#update-text').textContent })`);
  check('guide shows the update bar with both versions', !bar.hidden && bar.text.includes('9.9.9') && bar.text.includes(running), JSON.stringify(bar));
  check('update bar is actually displayed', await g.evalP(`getComputedStyle(document.querySelector('#update')).display`) === 'flex');
  await g.shot('update-bar.png');
  await g.key('Escape', { wait: 800 });

  d = await evalSW('devReloadDecision()');
  check('with the guide closed only the setting holds it back', d.guideOpen === false && d.autoReload === false && d.reload === false, JSON.stringify(d));
  check('badge still says NEW so you know', await evalSW('chrome.action.getBadgeText({})') === 'NEW');
  bump(running);
  d = await evalSW('devReloadDecision()');
  check('restoring the on-disk version clears the flag', d.newVersion === null && (await evalSW('chrome.action.getBadgeText({})')) === '1', JSON.stringify(d));
  await evalSW(`chrome.storage.local.set({ settings: { autoReload: true } })`);
  await sleep(200);
  d = await evalSW('devReloadDecision()');
  check('auto-reload on, same version: still nothing to do', d.autoReload === true && d.reload === false, JSON.stringify(d));
  // a version that asks for a new permission is never auto-reloaded
  bump('9.9.10', 'bookmarks');
  d = await evalSW('devReloadDecision()');
  check('a new permission on disk is detected', d.newVersion === '9.9.10' && d.needsPermissions.join() === 'bookmarks', JSON.stringify(d));
  check('and blocks the auto-reload even with the setting on', d.autoReload === true && d.guideOpen === false && d.reload === false);
  g = await h.openGuide(winA);
  await sleep(400);
  const permBar = await g.evalP(`({ text: document.querySelector('#update-text').textContent, reloadHidden: document.querySelector('#reload').hidden })`);
  check('the bar explains the permission and hides RELOAD', /NEW PERMISSION \(BOOKMARKS\)/.test(permBar.text) && permBar.reloadHidden, JSON.stringify(permBar));
  await g.key('Escape', { wait: 800 });
  bump(running);
  d = await evalSW('devReloadDecision()');
  check('back to normal once disk matches', d.newVersion === null && d.needsPermissions.length === 0, JSON.stringify(d));
  g = await h.openGuide(winA);
  check('update bar hidden again, and actually not displayed', await g.evalP(`document.querySelector('#update').hidden && getComputedStyle(document.querySelector('#update')).display === 'none'`) === true);
  check('help card is not displayed until asked', await g.evalP(`getComputedStyle(document.querySelector('#help')).display`) === 'none');
} catch (e) {
  check('no harness exception', false, e.stack || String(e));
}
process.exit(h.finish() ? 1 : 0);
