// TabTV. Copyright 2026 Keith Adler. SPDX-License-Identifier: MIT
// Lifecycle: Chrome starts this worker on install, on browser start, and whenever an event
// it listens to fires; it may be terminated after 30 idle seconds, so nothing important lives
// in memory. Everything durable is in chrome.storage (see ARCHITECTURE.md for the layout).

// TabTV background worker: keeps a screenshot of every tab you have looked at,
// and opens the guide page on command.
'use strict';

const THUMB_WIDTH = 720;          // stored thumbnail width in px (cards can be wide on big displays)
const CAPTURE_DELAY = 350;        // ms after activation before we grab a frame
const OVERVIEW_URL = chrome.runtime.getURL('overview.html');
const pending = new Map();        // tabId -> timeout handle

const key = (tabId) => 'thumb:' + tabId;
const metaKey = (tabId) => 'meta:' + tabId;
const textKey = (tabId) => 'text:' + tabId;
const TEXT_MAX = 6000;             // characters of on-screen text kept per picture
// Small bookkeeping record per picture so housekeeping never loads the pictures themselves.
async function allMeta() {
  let keys;
  if (chrome.storage.local.getKeys) keys = await chrome.storage.local.getKeys();
  else keys = Object.keys(await chrome.storage.local.get(null));
  const thumbKeys = keys.filter((k) => k.startsWith('thumb:'));
  const metas = await chrome.storage.local.get(thumbKeys.map((k) => 'meta:' + k.slice(6)));
  const out = {};
  for (const k of thumbKeys) {
    const id = k.slice(6);
    out[id] = metas['meta:' + id] || null;   // null: a picture with no record (pre-0.6 install)
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IS_UNPACKED = !chrome.runtime.getManifest().update_url;  // store installs carry update_url
const DEAD_TTL = 7 * 864e5;        // keep pictures of closed tabs this long (restore, undo, restart)
const DEAD_MAX = 300;              // and never more than this many

let settingsCache = null;
/**
 * User settings from storage.local with defaults applied, cached until they change.
 * @returns {Promise<{never: string[], autoReload: boolean}>}
 */
async function getSettings() {
  if (!settingsCache) {
    const { settings } = await chrome.storage.local.get('settings');
    settingsCache = { never: [], autoReload: true, readText: false, ...(settings || {}) };
  }
  return settingsCache;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) settingsCache = null;
});

/**
 * True when the URL's hostname equals one of the patterns or is a subdomain of it.
 * A leading "*." on a pattern is ignored so "*.bank.com" and "bank.com" mean the same.
 * @param {string} url
 * @param {string[]} patterns hostnames, case-insensitive
 */
function hostMatches(url, patterns) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return patterns.some((p) => {
    p = String(p).trim().toLowerCase().replace(/^\*\./, '');
    return p && (host === p || host.endsWith('.' + p));
  });
}

/**
 * Whether Chrome would let us photograph a page at this URL at all.
 * chrome://, the Web Store, and the guide itself are out.
 */
function isCapturable(url) {
  return !!url && /^(https?|file|ftp):/.test(url) && !url.startsWith(OVERVIEW_URL);
}
/**
 * Whether we may photograph this tab: capturable URL, not incognito, not on the never-list.
 * @param {chrome.tabs.Tab} tab
 */
async function allowed(tab) {
  if (!tab || tab.incognito || !isCapturable(tab.url)) return false;
  const { never } = await getSettings();
  return !hostMatches(tab.url, never);
}

/**
 * Photograph a tab shortly, replacing any capture already scheduled for it.
 * The delay gives the page time to paint after it comes to the front.
 */
function scheduleCapture(tabId, delay = CAPTURE_DELAY) {
  clearTimeout(pending.get(tabId));
  pending.set(tabId, setTimeout(() => {
    pending.delete(tabId);
    captureTab(tabId);
  }, delay));
}

/**
 * Photograph a tab now if it is in front and allowed, and store the picture with its record.
 * Errors from captureVisibleTab (minimized window, throttling, protected page) are swallowed.
 */
async function captureTab(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!tab.active || !(await allowed(tab))) return;
  try {
    const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 82 });
    const data = await shrink(raw);
    const at = Date.now();
    const writes = {
      [key(tabId)]: { data, url: tab.url, title: tab.title, at },
      [metaKey(tabId)]: { url: tab.url, at, bytes: data.length },
    };
    if ((await getSettings()).readText) {
      const text = await readVisibleText(tabId);
      if (text) writes[textKey(tabId)] = { text, at };
    }
    await chrome.storage.local.set(writes);
  } catch {
    // chrome:// pages, minimized windows, or Chrome's capture rate limit. Try again later.
  }
}

/**
 * Scale a captured frame down to THUMB_WIDTH and re-encode as JPEG.
 * @param {string} dataUrl the full-size capture
 * @returns {Promise<string>} a smaller JPEG data URL
 */
async function shrink(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, THUMB_WIDTH / bmp.width);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.74 });
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(out);
  });
}

// Our own "last looked at" clock. Chrome's tab.lastAccessed resets when a tab is
// discarded or replaced, which would float sleeping tabs to the top of RECENT order.
async function noteActive(tabId) {
  try {
    const { lastActive = {} } = await chrome.storage.session.get('lastActive');
    lastActive[tabId] = Date.now();
    const ids = Object.keys(lastActive);
    if (ids.length > 2000) for (const id of ids.sort((a, b) => lastActive[a] - lastActive[b]).slice(0, 500)) delete lastActive[id];
    await chrome.storage.session.set({ lastActive });
  } catch {}
}
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  try {
    const { lastActive = {} } = await chrome.storage.session.get('lastActive');
    if (lastActive[removedTabId]) { lastActive[addedTabId] = lastActive[removedTabId]; delete lastActive[removedTabId]; await chrome.storage.session.set({ lastActive }); }
    const old = await chrome.storage.local.get([key(removedTabId), metaKey(removedTabId), textKey(removedTabId)]);
    if (old[key(removedTabId)]) {
      const writes = { [key(addedTabId)]: old[key(removedTabId)], [metaKey(addedTabId)]: old[metaKey(removedTabId)] || { url: old[key(removedTabId)].url, at: old[key(removedTabId)].at, bytes: old[key(removedTabId)].data.length } };
      if (old[textKey(removedTabId)]) writes[textKey(addedTabId)] = old[textKey(removedTabId)];
      await chrome.storage.local.set(writes);
      await chrome.storage.local.remove([key(removedTabId), metaKey(removedTabId), textKey(removedTabId)]);
    }
  } catch {}
});

// Capture whenever a tab comes to the front or finishes loading in front.
chrome.tabs.onActivated.addListener(({ tabId }) => { noteActive(tabId); scheduleCapture(tabId); });
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.active) scheduleCapture(tabId, 600);
  if (info.url) updateBadge();
if (IS_UNPACKED) setTimeout(() => checkDevReload(), 3000);
});
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) scheduleCapture(tab.id);
});

// Refresh the front tab of the focused window periodically so a long-lived tab
// does not show a stale first-arrival frame forever.
chrome.alarms.create('refresh', { periodInMinutes: 0.5 });
chrome.alarms.create('reconcile', { periodInMinutes: 10 });
if (IS_UNPACKED) chrome.alarms.create('dev-reload', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'reconcile' || alarm.name === 'reconcile-once') { reconcile(); return; }
  if (alarm.name === 'dev-reload') { checkDevReload(); return; }
  if (alarm.name !== 'refresh') return;
  try { if ((await chrome.idle.queryState(120)) === 'locked') return; } catch {}
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) captureTab(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(pending.get(tabId));
  pending.delete(tabId);
  // The picture stays for a while so undo, session restore, and browser restart
  // can adopt it by URL. reconcile() expires it.
  updateBadge();
});
chrome.tabs.onCreated.addListener(updateBadge);

// Tab count on the toolbar icon, gold like the guide.
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const n = tabs.filter((t) => !(t.url || t.pendingUrl || '').startsWith(OVERVIEW_URL)).length;
    const { newVersion } = await chrome.storage.session.get('newVersion');
    await chrome.action.setBadgeBackgroundColor({ color: newVersion ? '#5dff6a' : '#f2c14e' });
    await chrome.action.setBadgeTextColor({ color: '#000000' });
    await chrome.action.setBadgeText({ text: newVersion ? 'NEW' : String(n) });
    await chrome.action.setTitle({ title: newVersion ? `TabTV ${newVersion} is on disk. Open the guide and press RELOAD.` : 'TabTV guide (Cmd+Shift+Space)' });
  } catch {}
}

// Developer convenience. An unpacked install (no update_url, so not from the Web Store)
// reads its files from disk, so when the version in manifest.json changes on disk we
// reload ourselves rather than waiting for someone to press the arrow in chrome://extensions.
// A version that adds permissions still needs a click there, and we never reload while
// the guide is open in front of someone.
async function setNewVersion(version, needsPermissions = []) {
  try {
    const cur = await chrome.storage.session.get(['newVersion', 'needsPermissions']);
    const same = (cur.newVersion || null) === version && JSON.stringify(cur.needsPermissions || []) === JSON.stringify(needsPermissions);
    if (same) return;
    await chrome.storage.session.set({ newVersion: version, needsPermissions });
    await updateBadge();
  } catch {}
}
// What we know: is a newer version on disk, is the guide open, is auto-reload allowed.
async function devReloadDecision() {
  const out = { newVersion: null, guideOpen: false, autoReload: true, needsPermissions: [], reload: false };
  if (!IS_UNPACKED) return out;
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const disk = await res.json();
    const running = chrome.runtime.getManifest();
    if (disk.version && disk.version !== running.version) out.newVersion = disk.version;
    // A reload into a manifest that asks for more would leave the extension disabled until
    // someone approves it in chrome://extensions, so that case gets the bar but no auto-reload.
    const have = new Set([...(running.permissions || []), ...(running.host_permissions || [])]);
    out.needsPermissions = [...(disk.permissions || []), ...(disk.host_permissions || [])].filter((p) => !have.has(p));
    await setNewVersion(out.newVersion, out.needsPermissions);
    out.autoReload = (await getSettings()).autoReload !== false;
    out.guideOpen = (await chrome.tabs.query({ url: OVERVIEW_URL + '*' })).length > 0;
    out.reload = !!out.newVersion && out.autoReload && !out.guideOpen && !out.needsPermissions.length;
  } catch {}
  return out;
}
/**
 * Alarm handler: self-reload when devReloadDecision() says so.
 * @returns {Promise<boolean>} whether a reload was started
 */
async function checkDevReload() {
  const d = await devReloadDecision();
  if (d.reload) chrome.runtime.reload();
  return d.reload;
}
// Explicit reload from the guide's RELOAD button: close guide tabs first so nobody is
// left staring at a dead extension page.
async function reloadNow() {
  const guides = await chrome.tabs.query({ url: OVERVIEW_URL + '*' });
  if (guides.length) await chrome.tabs.remove(guides.map((t) => t.id));
  chrome.runtime.reload();
}

// Match pictures of closed tabs to live tabs with the same URL (session restore,
// undo close, browser restart give tabs new ids), then expire what is left over.
async function reconcile() {
  const meta = await allMeta();
  // pictures from before 0.6 have no record: read them once to make one
  const missing = Object.keys(meta).filter((id) => !meta[id]);
  if (missing.length) {
    const old = await chrome.storage.local.get(missing.map((id) => key(id)));
    const writes = {};
    for (const id of missing) { const e = old[key(id)]; if (e) { meta[id] = { url: e.url, at: e.at, bytes: (e.data || '').length }; writes[metaKey(id)] = meta[id]; } }
    if (Object.keys(writes).length) await chrome.storage.local.set(writes);
  }
  const tabs = await chrome.tabs.query({});
  const live = new Set(tabs.map((t) => String(t.id)));
  const dead = Object.keys(meta).filter((id) => !live.has(id) && meta[id]).map((id) => [id, meta[id]]);
  dead.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  // adopt: a live tab with no picture takes the newest dead picture of the same URL
  const used = new Set();
  const adoptions = [];
  for (const t of tabs) {
    if (meta[String(t.id)] || !t.url || t.incognito) continue;
    const hit = dead.find(([id, m]) => !used.has(id) && m.url === t.url);
    if (hit) { used.add(hit[0]); adoptions.push([hit[0], t.id]); }
  }
  if (adoptions.length) {
    const src = await chrome.storage.local.get(adoptions.flatMap(([id]) => [key(id), textKey(id)]));
    const writes = {};
    for (const [from, to] of adoptions) {
      if (!src[key(from)]) continue;
      writes[key(to)] = src[key(from)];
      writes[metaKey(to)] = meta[from];
      if (src[textKey(from)]) writes[textKey(to)] = src[textKey(from)];
    }
    await chrome.storage.local.set(writes);
  }
  const cutoff = Date.now() - DEAD_TTL;
  const removes = [];
  let kept = 0;
  for (const [id, m] of dead) {
    if (used.has(id) || !(m.at > cutoff) || kept >= DEAD_MAX) removes.push(key(id), metaKey(id), textKey(id)); else kept++;
  }
  if (removes.length) await chrome.storage.local.remove(removes);
}
chrome.runtime.onStartup.addListener(() => {
  // session restore is still creating tabs when this fires; give it a moment
  chrome.alarms.create('reconcile-once', { when: Date.now() + 5000 });
  updateBadge();
});
chrome.runtime.onInstalled.addListener(() => { reconcile(); updateBadge(); });
updateBadge();

// Open the guide in the given window. Grab a fresh frame of the current tab first
// so the "NOW" card is up to date.
async function openOverview(windowId) {
  let win;
  try {
    win = windowId != null
      ? await chrome.windows.get(windowId, { populate: true })
      : await chrome.windows.getLastFocused({ populate: true });
  } catch { return; }
  if (win.type !== 'normal') {
    // a popup or app window has no tab strip to speak of; use the last normal window instead
    const normals = (await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }));
    win = normals.find((w) => w.focused) || normals[0];
    if (!win) return;
  }
  const active = win.tabs.find((t) => t.active);
  if (active && (active.url || '').startsWith(OVERVIEW_URL)) return;
  if (active) {
    clearTimeout(pending.get(active.id));
    pending.delete(active.id);
    await captureTab(active.id);
  }
  const url = `${OVERVIEW_URL}?from=${active ? active.id : ''}&win=${win.id}`;
  const existing = win.tabs.find((t) => (t.url || '').startsWith(OVERVIEW_URL));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, url });
  } else {
    await chrome.tabs.create({ windowId: win.id, url, index: active ? active.index + 1 : undefined });
  }
}

chrome.action.onClicked.addListener((tab) => openOverview(tab.windowId));
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === 'open-overview') openOverview(tab ? tab.windowId : undefined);
});

// Walk every tab in a window so each one gets a screenshot, then come back.
// Progress goes to the guide as messages; sleeping tabs can be skipped since
// activating them makes Chrome reload them.
async function scanWindow(windowId, overviewTabId, { skipSleeping = false } = {}) {
  const tabs = (await chrome.tabs.query({ windowId })).filter((t) => t.id !== overviewTabId);
  const todo = [];
  for (const t of tabs) if (await allowed(t) && !(skipSleeping && t.discarded)) todo.push(t);
  let done = 0;
  const report = () => chrome.runtime.sendMessage({ type: 'scan-progress', done, total: todo.length }).catch(() => {});
  report();
  for (const t of todo) {
    try {
      await chrome.tabs.update(t.id, { active: true });
      clearTimeout(pending.get(t.id));
      pending.delete(t.id);
      await sleep(t.discarded ? 1500 : 650);
      await captureTab(t.id);
    } catch { /* tab vanished mid-scan */ }
    done++;
    report();
  }
  try { await chrome.tabs.update(overviewTabId, { active: true }); } catch {}
  return { scanned: done, skipped: tabs.length - todo.length };
}

/**
 * Runs inside a tab (via chrome.scripting) and returns the words currently on screen:
 * text nodes whose first box intersects the viewport, skipping scripts, styles, and form
 * fields. Self-contained; it is serialized into the page. Capped so a wall of text stays cheap.
 */
function visibleTextInPage(max) {
  try {
    const vw = innerWidth;
    const vh = innerHeight;
    const out = [];
    let total = 0;
    let visited = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|INPUT|SELECT|OPTION)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode()) && total < max && visited++ < 4000) {
      const r = document.createRange();
      r.selectNodeContents(n);
      const b = r.getClientRects()[0];
      if (!b || b.bottom < 0 || b.top > vh || b.right < 0 || b.left > vw || (b.width === 0 && b.height === 0)) continue;
      const st = getComputedStyle(n.parentElement);
      if (st.visibility === 'hidden' || st.opacity === '0') continue;
      const s = n.nodeValue.replace(/\s+/g, ' ').trim();
      out.push(s);
      total += s.length + 1;
    }
    return out.join(' ').slice(0, max);
  } catch (e) { return ''; }
}

/** Words on screen in a tab, or '' when the page cannot be scripted. Opt-in via settings.readText. */
async function readVisibleText(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: visibleTextInPage, args: [TEXT_MAX] });
    return (r && typeof r.result === 'string') ? r.result : '';
  } catch { return ''; }
}

/**
 * Runs inside a tab (via chrome.scripting) to toggle Picture-in-Picture on its best video:
 * the one playing, else the largest with media loaded. Returns a small result object.
 * Must stay self-contained: it is serialized and executed in the page.
 */
function pipInPage() {
  try {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
      return { ok: true, action: 'exit' };
    }
    const vids = [...document.querySelectorAll('video')].filter((v) => v.readyState >= 1 && v.videoWidth > 0);
    if (!vids.length) return { ok: false, reason: 'no-video' };
    vids.sort((a, b) => (Number(!b.paused) - Number(!a.paused)) || (b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight));
    const v = vids[0];
    v.disablePictureInPicture = false;
    return v.requestPictureInPicture().then(() => ({ ok: true, action: 'enter', title: document.title }), (e) => ({ ok: false, reason: e.name + ': ' + e.message }));
  } catch (e) { return { ok: false, reason: e.message }; }
}

/**
 * Toggle Picture-in-Picture for a tab's video. Injects pipInPage into every frame of that
 * tab once (some players live in iframes); the first frame that succeeds wins.
 * @returns {Promise<{ok: boolean, action?: string, reason?: string}>}
 */
async function pipTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: pipInPage });
    const rs = results.map((r) => r.result).filter(Boolean);
    return rs.find((r) => r.ok) || rs.find((r) => r.reason !== 'no-video') || { ok: false, reason: 'no-video' };
  } catch (e) {
    return { ok: false, reason: /cannot be scripted|Cannot access/.test(e.message) ? 'protected-page' : e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg && msg.type === 'pip' && msg.tabId != null) {
    pipTab(msg.tabId).then(respond);
    return true;
  }
  if (msg && msg.type === 'scan' && sender.tab) {
    scanWindow(msg.windowId ?? sender.tab.windowId, sender.tab.id, { skipSleeping: !!msg.skipSleeping }).then((r) => respond({ ok: true, ...r }));
    return true;
  }
  if (msg && msg.type === 'scan-preview' && sender.tab) {
    (async () => {
      const tabs = (await chrome.tabs.query({ windowId: msg.windowId ?? sender.tab.windowId })).filter((t) => t.id !== sender.tab.id);
      let total = 0;
      let sleeping = 0;
      for (const t of tabs) if (await allowed(t)) { total++; if (t.discarded) sleeping++; }
      respond({ ok: true, total, sleeping });
    })();
    return true;
  }
  if (msg && msg.type === 'get-shortcut') {
    chrome.commands.getAll().then((cmds) => respond({ ok: true, shortcut: (cmds.find((c) => c.name === 'open-overview') || {}).shortcut || '' }));
    return true;
  }
  if (msg && msg.type === 'reconcile') {
    reconcile().then(() => respond({ ok: true }));
    return true;
  }
  if (msg && msg.type === 'clear-pictures') {
    allMeta().then((meta) => chrome.storage.local.remove(Object.keys(meta).flatMap((id) => [key(id), metaKey(id), textKey(id)]))).then(() => respond({ ok: true }));
    return true;
  }
  if (msg && msg.type === 'clear-text') {
    // the switch was turned off: forget every word we read
    allMeta().then((meta) => chrome.storage.local.remove(Object.keys(meta).map((id) => textKey(id)))).then(() => respond({ ok: true }));
    return true;
  }
  if (msg && msg.type === 'picture-stats') {
    allMeta().then((meta) => {
      let n = 0;
      let bytes = 0;
      for (const id in meta) { n++; bytes += (meta[id] && meta[id].bytes) || 0; }
      respond({ ok: true, n, bytes });
    });
    return true;
  }
  if (msg && msg.type === 'drop-pictures-matching' && Array.isArray(msg.never)) {
    allMeta().then((meta) => {
      const drop = Object.keys(meta).filter((id) => meta[id] && hostMatches(meta[id].url, msg.never)).flatMap((id) => [key(id), metaKey(id), textKey(id)]);
      return chrome.storage.local.remove(drop).then(() => respond({ ok: true, dropped: drop.length / 3 }));
    });
    return true;
  }
  if (msg && msg.type === 'dev-reload') {
    reloadNow();
    respond({ ok: true });
    return false;
  }
  if (msg && msg.type === 'check-dev-reload') {
    devReloadDecision().then((d) => respond({ ok: true, ...d }));
    return true;
  }
  if (msg && msg.type === 'open-shortcuts') {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).then(() => respond({ ok: true }));
    return true;
  }
  if (msg && msg.type === 'refresh-thumb' && msg.tabId != null) {
    captureTab(msg.tabId).then(() => respond({ ok: true }));
    return true;
  }
});
