// TabTV. Copyright 2026 Keith Adler. SPDX-License-Identifier: MIT
// The guide runs as an extension page (overview.html?from=<tabId>&win=<windowId>) opened next
// to the current tab. State lives in a few module-level variables below; the DOM is rebuilt by
// render() and the yellow cursor is a single absolutely positioned element moved by placeCursor().
// Without chrome.* APIs (a plain web page) the file switches to demo mode with fake data.

// TabTV guide page. Runs inside the extension; falls back to a demo dataset
// when opened as a plain web page so the look can be checked in any browser.
'use strict';

const DEMO = !(globalThis.chrome && chrome.tabs && chrome.storage);
const params = new URLSearchParams(location.search);
const RETURN_TO = Number(params.get('from')) || null;
const HOME_WIN = Number(params.get('win')) || null;

const $ = (s) => document.querySelector(s);
const screenEl = $('#screen');
const cursor = $('#cursor');
const countEl = $('#count');
const statusEl = $('#status');
const osd = $('#osd');
const searchEl = $('#search');
const searchText = $('#search-text');
const toastEl = $('#toast');

let groups = [];   // [{ id, label, tabs: [...] }]
let cards = [];    // visible card elements in reading order
let sel = 0;
let filter = '';
let chanBuf = '';
let chanTimer = null;
let osdTimer = null;
let toastTimer = null;
let ownTabId = null;
let ownWindowId = null;
let busy = false;
let closing = false;
let ignoreActivationUntil = 0;
let undoable = 0;
const ZOOM_LEVELS = [200, 270, 350, 450];
let zoom = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, Number(localStorage.getItem('tabtv-zoom') ?? 1)));
const ORDERS = ['tab', 'recent', 'site'];
let order = ORDERS.includes(localStorage.getItem('tabtv-order')) ? localStorage.getItem('tabtv-order') : 'tab';
let armedCloseAll = 0;

/* ---------- remote-control beeps ---------- */
const sound = {
  on: localStorage.getItem('tabtv-sound') !== 'off',
  ctx: null,
  play(kind) {
    if (!this.on) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const c = this.ctx;
      if (c.state === 'suspended') c.resume();
      const now = c.currentTime;
      const notes = {
        move:  [[880, 0, .05]],
        go:    [[660, 0, .07], [990, .07, .14]],
        back:  [[660, 0, .06], [440, .06, .13]],
        close: [[440, 0, .06], [220, .06, .12]],
        digit: [[1320, 0, .04]],
        nope:  [[200, 0, .12]],
      }[kind] || [[330, 0, .08]];
      for (const [f, st, en] of notes) {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = 'square';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, now + st);
        g.gain.exponentialRampToValueAtTime(0.06, now + st + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, now + en);
        o.connect(g).connect(c.destination);
        o.start(now + st);
        o.stop(now + en + 0.02);
      }
    } catch { /* no audio, no problem */ }
  },
  toggle() {
    this.on = !this.on;
    localStorage.setItem('tabtv-sound', this.on ? 'on' : 'off');
    updateSoundButton();
    if (this.on) this.play('move');
  },
};
/** Dim the SOUND button when beeps are off. */
function updateSoundButton() { $('#sound').classList.toggle('off', !sound.on); }

/* ---------- helpers ---------- */
/** Create an element with an optional class. */
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
/**
 * Short label for a URL: hostname without www., or the scheme for chrome:// and friends.
 */
function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'chrome:' || u.protocol === 'chrome-extension:') return u.protocol + '//' + u.host;
    if (u.protocol === 'file:') return 'local file';
    return u.hostname.replace(/^www\./, '');
  } catch { return ''; }
}
/**
 * Same rule as the background's hostMatches: exact host or subdomain of a never-list entry.
 */
function neverMatches(url, patterns) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return patterns.some((p) => { p = String(p).trim().toLowerCase().replace(/^\*\./, ''); return p && (host === p || host.endsWith('.' + p)); });
}
/**
 * Human-friendly age of a timestamp: just now, 5 min ago, 3 h ago, 2 d ago.
 */
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
/** A short piece of on-screen text around a match, with ellipses. */
function snippet(text, i, len) {
  const start = Math.max(0, i - 40);
  const end = Math.min(text.length, i + len + 60);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}
/**
 * URL of Chrome's cached favicon for a page at 64 px (needs the favicon permission).
 */
function bigFavicon(url) {
  if (DEMO || !url || !chrome.runtime) return '';
  return chrome.runtime.getURL('/_favicon/?pageUrl=' + encodeURIComponent(url) + '&size=64');
}
/**
 * An <img> for a tab's favicon: the page's own for labels, Chrome's big cached one for snow screens.
 * @returns {HTMLImageElement|null}
 */
function favEl(t, big) {
  const src = big ? (bigFavicon(t.url) || t.favicon) : (t.favicon || bigFavicon(t.url));
  if (!src) return null;
  const img = new Image();
  img.className = 'fav';
  img.src = src;
  img.alt = '';
  img.draggable = false;
  img.addEventListener('error', () => img.remove());
  return img;
}
/** A small gold badge (NOW, PIN, ON AIR, ×2). */
function badge(text, cls) { const b = el('span', 'badge' + (cls ? ' ' + cls : '')); b.textContent = text; return b; }
/** Show a message at the bottom for a moment. */
function toast(msg, ms = 1600) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}
/** Green status text in the top bar (SCANNING 3/12). Empty string hides it. */
function setStatus(msg) { statusEl.textContent = msg || ''; }

/** Channel numbers are tab-strip positions, 1-based, per window. */
function renumber() {
  for (const g of groups) g.tabs.forEach((t, i) => { t.channel = i + 1; });
}

/* ---------- data ---------- */
/**
 * Build the window groups from live browser state.
 * Asks the background to reconcile first, then reads tabs, windows, tab groups, the pictures for
 * live tabs only, the never-list, and the last-active clock. In demo mode returns fake data.
 * @returns {Promise<Array<{id:number, label:string, tabs:Object[]}>>}
 */
async function loadData() {
  if (DEMO) return demoData();
  try { await chrome.runtime.sendMessage({ type: 'reconcile' }); } catch {}
  const [tabs, wins, tabGroups, session] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getAll(),
    chrome.tabGroups ? chrome.tabGroups.query({}).catch(() => []) : [],
    chrome.storage.session ? chrome.storage.session.get('lastActive').catch(() => ({})) : {},
  ]);
  const lastActive = (session && session.lastActive) || {};
  const groupsById = {};
  for (const g of tabGroups) groupsById[g.id] = { title: g.title || '', color: g.color };
  // only the pictures of tabs that exist, not the retained ones of closed tabs
  const store = await chrome.storage.local.get(tabs.flatMap((t) => ['thumb:' + t.id, 'text:' + t.id]));
  const never = ((await chrome.storage.local.get('settings')).settings || {}).never || [];
  const thumbs = {};
  const texts = {};
  for (const k in store) { if (k.startsWith('thumb:')) thumbs[k.slice(6)] = store[k]; else if (k.startsWith('text:')) texts[k.slice(5)] = store[k].text; }
  const urlCount = {};
  for (const t of tabs) if (t.url) urlCount[t.url] = (urlCount[t.url] || 0) + 1;
  const own = chrome.runtime.getURL('overview.html');
  const normal = wins.filter((w) => w.type === 'normal');
  normal.sort((a, b) => (a.id === HOME_WIN ? -1 : 0) - (b.id === HOME_WIN ? -1 : 0));
  let n = 0;
  return normal.map((w) => {
    n++;
    const list = tabs
      .filter((t) => t.windowId === w.id && !(t.url || '').startsWith(own))
      .sort((a, b) => a.index - b.index)
      .map((t) => ({
        id: t.id,
        windowId: t.windowId,
        title: t.title || t.url || 'Untitled',
        url: t.url || '',
        favicon: t.favIconUrl || '',
        thumb: thumbs[t.id] ? thumbs[t.id].data : null,
        thumbAt: thumbs[t.id] ? thumbs[t.id].at : 0,
        text: texts[t.id] || '',
        excluded: neverMatches(t.url, never),
        audible: !!t.audible,
        pinned: !!t.pinned,
        discarded: !!t.discarded,
        incognito: !!t.incognito,
        dupes: t.url ? urlCount[t.url] : 1,
        // our own clock first; Chrome's lastAccessed only for tabs we have never seen activate
        lastAccessed: lastActive[t.id] || (t.discarded ? 0 : t.lastAccessed || 0),
        group: t.groupId != null && t.groupId >= 0 ? groupsById[t.groupId] || null : null,
      }));
    return { id: w.id, label: w.id === HOME_WIN ? 'THIS WINDOW' : `WINDOW ${n}`, tabs: list };
  });
}

/* ---------- render ---------- */
/** Push the current zoom level into the grid's --card-min custom property. */
function applyZoom() {
  screenEl.style.setProperty('--card-min', ZOOM_LEVELS[zoom] + 'px');
}
/** Step the card size up or down one level and remember it. */
function setZoom(delta) {
  const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, zoom + delta));
  if (next === zoom) { sound.play('nope'); return; }
  zoom = next;
  localStorage.setItem('tabtv-zoom', String(zoom));
  sound.play('move');
  applyZoom();
  requestAnimationFrame(placeCursor);
}
/** Label the ORDER button for the current mode. */
function updateOrderButton() {
  $('#order').textContent = { tab: 'ORDER: TABS', recent: 'ORDER: RECENT', site: 'ORDER: SITE' }[order];
}
/** Cycle tab order → recent → site, keeping the highlighted tab if it is still visible. */
function toggleOrder() {
  order = ORDERS[(ORDERS.indexOf(order) + 1) % ORDERS.length];
  localStorage.setItem('tabtv-order', order);
  updateOrderButton();
  sound.play('move');
  const keep = cards[sel] ? cards[sel].tab.id : null;
  render();
  const i = cards.findIndex((c) => c.tab.id === keep);
  if (i >= 0) select(i, false);
}
/**
 * Rebuild the whole grid from `groups`, honoring the filter and ORDER mode.
 * Also refreshes the count, the empty state, and the current selection.
 */
function render() {
  screenEl.innerHTML = '';
  cards = [];
  const q = filter.trim().toLowerCase();
  let total = 0;
  let shown = 0;
  for (const g of groups) {
    total += g.tabs.length;
    let visible = g.tabs.filter((t) => {
      if (!q) { t.seen = ''; return true; }
      if (t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)) { t.seen = ''; return true; }
      const i = (t.text || '').toLowerCase().indexOf(q);
      if (i < 0) return false;
      t.seen = snippet(t.text, i, q.length);
      return true;
    });
    if (order === 'recent') visible = visible.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (order === 'site') visible = visible.slice().sort((a, b) => hostOf(a.url).localeCompare(hostOf(b.url)) || a.channel - b.channel);
    if (!visible.length) continue;
    const sec = el('section', 'group');
    const h = el('h2');
    h.textContent = g.label;
    sec.appendChild(h);
    const grid = el('div', 'grid');
    grid.setAttribute('role', 'listbox');
    grid.setAttribute('aria-label', g.label);
    for (const t of visible) {
      const c = makeCard(t);
      grid.appendChild(c);
      cards.push(c);
      shown++;
    }
    sec.appendChild(grid);
    screenEl.appendChild(sec);
  }
  countEl.textContent = q ? `${shown} OF ${total} TABS` : `${total} TAB${total === 1 ? '' : 'S'}`;
  if (!cards.length) {
    const e = el('div', 'empty');
    e.textContent = q ? 'NO MATCHING TABS' : 'NO TABS';
    screenEl.appendChild(e);
    cursor.hidden = true;
    return;
  }
  select(Math.min(sel, cards.length - 1), false);
}

/**
 * Build one card: picture or snow screen, channel number, badges, group tag, close button,
 * title, host. Wires click, shift-click, middle-click, and hover-to-select.
 * @param {Object} t a tab object from loadData
 * @returns {HTMLAnchorElement}
 */
function makeCard(t) {
  const c = el('a', 'card');
  c.href = '#';
  c.tabIndex = -1;
  c.setAttribute('role', 'option');
  c.setAttribute('aria-selected', 'false');
  c.setAttribute('aria-label', `${t.title}, ${hostOf(t.url)}${t.windowId !== HOME_WIN ? ', other window' : ''}`);
  c.dataset.id = t.id;
  c.tab = t;

  const frame = el('div', 'frame');
  if (t.thumb) {
    const img = new Image();
    img.src = t.thumb;
    img.alt = '';
    img.draggable = false;
    img.loading = 'lazy';
    img.decoding = 'async';
    frame.appendChild(img);
    if (t.thumbAt) frame.title = `Picture taken ${ago(t.thumbAt)}`;
  } else {
    const ns = el('div', 'nosignal');
    const fav = favEl(t, true);
    if (fav) ns.appendChild(fav);
    const txt = el('span');
    txt.textContent = t.incognito ? 'PRIVATE' : t.excluded ? 'NOT PHOTOGRAPHED' : t.discarded ? 'SLEEPING' : 'NO PREVIEW';
    if (t.excluded) frame.title = 'This site is on your never-photograph list (Settings)';
    ns.appendChild(txt);
    frame.appendChild(ns);
  }
  const ch = el('span', 'ch');
  ch.textContent = 'CH ' + String(t.channel).padStart(2, '0');
  frame.appendChild(ch);

  const badges = el('span', 'badges');
  if (t.id === RETURN_TO) badges.appendChild(badge('NOW', 'now'));
  if (t.audible) badges.appendChild(badge('♪ ON AIR'));
  if (t.pinned) badges.appendChild(badge('PIN'));
  if (t.dupes > 1) badges.appendChild(badge('×' + t.dupes, 'dup'));
  if (badges.childNodes.length) frame.appendChild(badges);

  if (t.group) {
    const tag = el('span', 'gtag');
    tag.dataset.color = t.group.color;
    tag.textContent = t.group.title || '';
    tag.title = t.group.title ? `Group: ${t.group.title}` : 'Tab group';
    frame.appendChild(tag);
  }

  if (t.audible) {
    const pip = el('button', 'pip');
    pip.type = 'button';
    pip.title = 'Pop the video out (Shift+P)';
    pip.textContent = 'PIP';
    pip.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); pipCard(c); });
    frame.appendChild(pip);
  }

  const x = el('button', 'close');
  x.type = 'button';
  x.title = 'Close this tab';
  x.textContent = '✕';
  x.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeCard(c); });
  frame.appendChild(x);
  c.appendChild(frame);

  const label = el('div', 'label');
  const fav = favEl(t);
  if (fav) label.appendChild(fav);
  const title = el('span', 'title');
  title.textContent = t.title;
  title.title = t.title;
  label.appendChild(title);
  c.appendChild(label);

  const host = el('div', 'host');
  host.textContent = hostOf(t.url);
  host.title = t.url;
  c.appendChild(host);
  if (t.seen) {
    const seen = el('div', 'seen');
    const lab = el('span', 'seen-label');
    lab.textContent = 'SEEN ';
    seen.appendChild(lab);
    seen.appendChild(document.createTextNode(t.seen));
    seen.title = 'Matched words that were on screen when the picture was taken';
    c.appendChild(seen);
  }

  c.addEventListener('click', (e) => { e.preventDefault(); if (e.shiftKey) bringHere(c); else go(c); });
  c.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeCard(c); } });
  c.addEventListener('mousemove', () => {
    const i = cards.indexOf(c);
    if (i >= 0 && i !== sel) select(i);
  });
  return c;
}

/* ---------- selection ---------- */
/**
 * Move the highlight to card i, scroll it into view, place the cursor, update ARIA state.
 */
function select(i, beep = true) {
  if (!cards.length) return;
  i = Math.max(0, Math.min(cards.length - 1, i));
  if (cards[sel]) { cards[sel].classList.remove('selected'); cards[sel].setAttribute('aria-selected', 'false'); }
  sel = i;
  const c = cards[sel];
  c.classList.add('selected');
  c.setAttribute('aria-selected', 'true');
  c.id = 'card-' + c.tab.id;
  screenEl.setAttribute('aria-activedescendant', c.id);
  c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  document.body.classList.toggle('other-window', c.tab.windowId !== HOME_WIN && !DEMO);
  placeCursor();
  if (beep) sound.play('move');
}
/**
 * Position the yellow cursor over the selected card using document coordinates,
 * so it stays put while the page scrolls.
 */
function placeCursor() {
  const c = cards[sel];
  if (!c) { cursor.hidden = true; return; }
  const r = c.getBoundingClientRect();
  cursor.hidden = false;
  cursor.style.transform = `translate(${r.left + scrollX - 7}px, ${r.top + scrollY - 7}px)`;
  cursor.style.width = (r.width + 14) + 'px';
  cursor.style.height = (r.height + 14) + 'px';
}
/**
 * Up or down: the nearest card in the next row by vertical distance then horizontal offset.
 * Works across window sections and any zoom level because it uses geometry, not a column count.
 */
function moveVertical(dir) {
  if (!cards[sel]) return;
  const cur = cards[sel].getBoundingClientRect();
  const cx = (cur.left + cur.right) / 2;
  let best = -1;
  let bestScore = Infinity;
  cards.forEach((c, i) => {
    if (i === sel) return;
    const r = c.getBoundingClientRect();
    const dy = dir < 0 ? cur.top - r.bottom : r.top - cur.bottom;
    if (dy < -1) return;
    const dx = Math.abs((r.left + r.right) / 2 - cx);
    const score = dy * 1000 + dx;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  if (best >= 0) select(best); else sound.play('nope');
}
/** PageUp / PageDown: about a screenful in the same column. */
function page(dir) {
  // jump a screenful in the same column
  if (!cards[sel]) return;
  const cur = cards[sel].getBoundingClientRect();
  const cx = (cur.left + cur.right) / 2;
  const target = cur.top + dir * (innerHeight - 200);
  let best = sel;
  let bestScore = Infinity;
  cards.forEach((c, i) => {
    const r = c.getBoundingClientRect();
    if (dir < 0 ? r.top >= cur.top : r.top <= cur.top) return;
    const score = Math.abs(r.top - target) * 4 + Math.abs((r.left + r.right) / 2 - cx);
    if (score < bestScore) { bestScore = score; best = i; }
  });
  if (best !== sel) select(best); else sound.play('nope');
}
/** Big green channel readout in the corner, like a TV. */
function showOsd(text) {
  osd.textContent = text;
  osd.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => osd.classList.remove('show'), 900);
}
/** Highlight the card with channel n in this window, or show -- if there is none. */
function jumpChannel(n) {
  const home = groups[0];
  const t = home && home.tabs.find((x) => x.channel === n);
  const i = t ? cards.findIndex((c) => c.tab === t) : -1;
  if (i >= 0) select(i); else { showOsd('--'); sound.play('nope'); }
}

/* ---------- actions ---------- */
/**
 * Enter / click: switch to the card's tab, focus its window if needed, close the guide.
 */
async function go(c) {
  if (busy) return;
  busy = true;
  const t = c.tab;
  sound.play('go');
  c.classList.add('zap');
  const unzap = () => setTimeout(() => { c.classList.remove('zap'); busy = false; }, 400);
  if (DEMO) { toast(`SWITCH TO CH ${String(t.channel).padStart(2, '0')}`); unzap(); return; }
  try {
    await chrome.tabs.update(t.id, { active: true });
    if (t.windowId !== HOME_WIN) await chrome.windows.update(t.windowId, { focused: true });
  } catch { toast('THAT TAB IS GONE'); c.classList.remove('zap'); busy = false; await reload(); return; }
  closeSelf();
}
/**
 * Shift+Enter: move the card's tab into this window (at the end), switch to it, close the guide.
 */
async function bringHere(c) {
  const t = c.tab;
  if (DEMO) return toast('BRING HERE NEEDS THE REAL EXTENSION');
  if (t.windowId === HOME_WIN) return go(c);
  if (busy) return;
  busy = true;
  sound.play('go');
  try {
    await chrome.tabs.move(t.id, { windowId: HOME_WIN, index: -1 });
    await chrome.tabs.update(t.id, { active: true });
  } catch { toast('COULD NOT MOVE THAT TAB'); busy = false; await reload(); return; }
  closeSelf();
}
/**
 * Shift+P or the PIP button: pop the card's video into a floating Picture-in-Picture
 * window, then go back to the tab the guide was opened from so you can keep working.
 */
async function pipCard(c) {
  const t = c.tab;
  if (DEMO) return toast('PICTURE-IN-PICTURE NEEDS THE REAL EXTENSION');
  if (busy) return;
  busy = true;
  sound.play('digit');
  let r = null;
  try { r = await chrome.runtime.sendMessage({ type: 'pip', tabId: t.id }); } catch {}
  busy = false;
  if (r && r.ok && r.action === 'enter') {
    sound.play('go');
    toast('PICTURE-IN-PICTURE ON', 1200);
    setTimeout(back, 500);
    return;
  }
  if (r && r.ok && r.action === 'exit') { toast('PICTURE-IN-PICTURE OFF'); return; }
  sound.play('nope');
  const why = { 'no-video': 'NO VIDEO ON THAT TAB', 'protected-page': 'CHROME WON\'T LET ME TOUCH THAT PAGE' }[r && r.reason] || 'THAT VIDEO REFUSED';
  toast(why, 2200);
}
/** Tab / Shift+Tab: the first card of the next or previous window section. */
function jumpSection(dir) {
  // Tab / Shift+Tab: first card of the next / previous window section
  if (!cards[sel]) return;
  const sections = [...document.querySelectorAll('.group')];
  const cur = sections.findIndex((s) => s.contains(cards[sel]));
  const next = sections[cur + dir];
  if (!next) { sound.play('nope'); return; }
  const first = next.querySelector('.card');
  const i = cards.indexOf(first);
  if (i >= 0) select(i);
}
/** Escape: return to the tab the guide was opened from and close the guide. */
async function back() {
  sound.play('back');
  if (DEMO) return toast('BACK');
  if (RETURN_TO) { try { await chrome.tabs.update(RETURN_TO, { active: true }); } catch {} }
  closeSelf();
}
/** Close the guide tab once; later calls are no-ops. */
function closeSelf() {
  if (closing) return;
  closing = true;
  if (!DEMO && ownTabId != null) chrome.tabs.remove(ownTabId).catch(() => {}); else window.close();
}
/** Delete: close one tab, keep the cursor nearby, offer undo. */
async function closeCard(c) {
  const i = cards.indexOf(c);
  const t = c.tab;
  sound.play('close');
  if (!DEMO) { try { await chrome.tabs.remove(t.id); } catch {} }
  removeTab(t.id);
  undoable++;
  sel = Math.max(0, Math.min(i, cards.length - 2));
  render();
  toast(`CLOSED  ·  ${navigator.platform.startsWith('Mac') ? '⌘' : 'CTRL+'}Z TO UNDO`, 2500);
}
/**
 * Shift+Delete: close every card currently shown. Asks for a second press within 3 seconds first.
 */
async function closeAllVisible() {
  if (!cards.length) return;
  const n = cards.length;
  if (Date.now() > armedCloseAll) {
    armedCloseAll = Date.now() + 3000;
    sound.play('digit');
    toast(`CLOSE ${n} TAB${n === 1 ? '' : 'S'}? PRESS SHIFT+DEL AGAIN`, 3000);
    return;
  }
  armedCloseAll = 0;
  sound.play('close');
  const ids = cards.map((c) => c.tab.id);
  if (!DEMO) { try { await chrome.tabs.remove(ids); } catch {} }
  for (const id of ids) removeTab(id);
  undoable += ids.length;
  filter = '';
  updateSearch();
  sel = 0;
  render();
  toast(`CLOSED ${n}  ·  ${navigator.platform.startsWith('Mac') ? '⌘' : 'CTRL+'}Z RESTORES ONE AT A TIME`, 3000);
}
/**
 * Cmd+Z / Ctrl+Z: reopen the most recently closed tab via chrome.sessions, keeping the guide in front.
 */
async function undoClose() {
  if (!undoable) { sound.play('nope'); return; }
  if (DEMO) { toast('UNDO NEEDS THE REAL EXTENSION'); return; }
  busy = true;
  ignoreActivationUntil = Date.now() + 1500;
  try {
    await chrome.sessions.restore();
    undoable--;
    sound.play('go');
    if (ownTabId != null) await chrome.tabs.update(ownTabId, { active: true });
    await reload();
    toast('RESTORED');
  } catch { toast('NOTHING TO RESTORE'); }
  busy = false;
}
/** Drop a tab from the in-memory groups and renumber channels. */
function removeTab(id) {
  for (const g of groups) g.tabs = g.tabs.filter((x) => x.id !== id);
  renumber();
}
/** Reload everything from the browser, keeping the highlighted tab if it still exists. */
async function reload() {
  const keepId = cards[sel] ? cards[sel].tab.id : null;
  groups = await loadData();
  renumber();
  render();
  const i = cards.findIndex((c) => c.tab.id === keepId);
  if (i >= 0) select(i, false);
}
let scanArmed = null;   // { total, sleeping, until }
/**
 * SCAN button: ask the background to photograph every tab in this window.
 * If some tabs are asleep, asks first (press again, or S to skip them) because visiting them wakes them.
 */
async function scanAll() {
  if (busy) return;
  if (DEMO) return toast('SCAN NEEDS THE REAL EXTENSION');
  const now = Date.now();
  if (!scanArmed || now > scanArmed.until) {
    const p = await chrome.runtime.sendMessage({ type: 'scan-preview', windowId: HOME_WIN });
    if (!p || !p.total) { toast('NOTHING TO SCAN'); return; }
    if (p.sleeping) {
      scanArmed = { ...p, until: now + 5000 };
      sound.play('digit');
      toast(`SCAN ${p.total} TABS? ${p.sleeping} SLEEPING WOULD WAKE UP · PRESS SCAN AGAIN, OR S TO SKIP THEM`, 5000);
      return;
    }
    scanArmed = { ...p, until: now };
  }
  const skipSleeping = !!scanArmed.skipSleeping;
  scanArmed = null;
  busy = true;
  setStatus('SCANNING');
  let result = null;
  try { result = await chrome.runtime.sendMessage({ type: 'scan', windowId: HOME_WIN, skipSleeping }); } catch {}
  setStatus('');
  busy = false;
  await reload();
  if (result) toast(`SCANNED ${result.scanned} TAB${result.scanned === 1 ? '' : 'S'}${result.skipped ? ` · ${result.skipped} SKIPPED` : ''}`, 2500);
}
/** S while a SCAN question is showing: scan but leave sleeping tabs alone. */
function scanSkippingSleeping() {
  if (!scanArmed || Date.now() > scanArmed.until) return false;
  scanArmed.skipSleeping = true;
  scanArmed.until = Date.now();
  scanAll();
  return true;
}
/** ? key or button: show or hide the help card. */
function toggleHelp() {
  const el = $('#help');
  el.hidden = !el.hidden;
  sound.play(el.hidden ? 'back' : 'move');
}
/** Put the real keyboard shortcut (from chrome.commands) into the help card. */
async function showShortcut() {
  if (DEMO) return;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'get-shortcut' });
    const s = r && r.shortcut;
    $('#help-shortcut').textContent = s ? `Open the guide from any page with ${s}.` : 'No keyboard shortcut is set. Assign one at chrome://extensions/shortcuts, or use the toolbar icon.';
  } catch {}
}
/** Reflect the current filter in the FIND box and the footer hints. */
function updateSearch() {
  searchEl.hidden = !filter;
  searchText.textContent = filter;
  document.body.classList.toggle('filtering', !!filter);
}

/* ---------- keys ---------- */
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undoClose(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(1); return; }
  if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(-1); return; }
  switch (e.key) {
    case 'ArrowLeft':  e.preventDefault(); select(sel === 0 ? cards.length - 1 : sel - 1); return;
    case 'ArrowRight': e.preventDefault(); select(sel === cards.length - 1 ? 0 : sel + 1); return;
    case 'ArrowUp':    e.preventDefault(); moveVertical(-1); return;
    case 'ArrowDown':  e.preventDefault(); moveVertical(1); return;
    case 'Home':       e.preventDefault(); select(0); return;
    case 'PageUp':     e.preventDefault(); page(-1); return;
    case 'PageDown':   e.preventDefault(); page(1); return;
    case 'End':        e.preventDefault(); select(cards.length - 1); return;
    case ' ':
      if (filter) break;                 // a space inside a search is just a space
      // falls through
    case 'Enter':
      e.preventDefault();
      if (!cards[sel]) return;
      if (e.shiftKey) bringHere(cards[sel]); else go(cards[sel]);
      return;
    case 'Escape':
      e.preventDefault();
      if (!$('#help').hidden) { toggleHelp(); return; }
      if (filter) { filter = ''; updateSearch(); render(); } else back();
      return;
    case 'Backspace':
      e.preventDefault();
      if (filter) { filter = filter.slice(0, -1); updateSearch(); render(); } else back();
      return;
    case 'Delete':
      e.preventDefault();
      if (e.shiftKey) closeAllVisible(); else if (cards[sel]) closeCard(cards[sel]);
      return;
    case 'Tab':        e.preventDefault(); jumpSection(e.shiftKey ? -1 : 1); return;
  }
  if (/^[0-9]$/.test(e.key) && !filter) {
    e.preventDefault();
    sound.play('digit');
    chanBuf = (chanBuf + e.key).slice(-3);
    showOsd('CH ' + chanBuf);
    clearTimeout(chanTimer);
    chanTimer = setTimeout(() => { jumpChannel(Number(chanBuf)); chanBuf = ''; }, 700);
    return;
  }
  if (e.key === '?' && !filter) { e.preventDefault(); toggleHelp(); return; }
  if (e.key === 'P' && e.shiftKey && !filter) { e.preventDefault(); if (cards[sel]) pipCard(cards[sel]); return; }
  if ((e.key === 's' || e.key === 'S') && !filter && scanSkippingSleeping()) { e.preventDefault(); return; }
  if (e.key.length === 1) {
    e.preventDefault();
    filter += e.key;
    sel = 0;
    updateSearch();
    render();
  }
});

$('#scan').addEventListener('click', scanAll);
$('#help-btn').addEventListener('click', toggleHelp);
$('#help').addEventListener('click', (e) => { if (e.target.id === 'help') toggleHelp(); });
$('#reload').addEventListener('click', () => { sound.play('go'); chrome.runtime.sendMessage({ type: 'dev-reload' }); });
/**
 * Show the green bar when a newer version is on disk (folder-loaded installs only).
 */
async function showUpdateBar() {
  if (DEMO || !chrome.storage.session) return;
  try {
    const { newVersion, needsPermissions = [] } = await chrome.storage.session.get(['newVersion', 'needsPermissions']);
    const bar = $('#update');
    bar.hidden = !newVersion;
    if (newVersion) {
      const base = `VERSION ${newVersion} IS ON DISK · RUNNING ${chrome.runtime.getManifest().version}`;
      $('#update-text').textContent = needsPermissions.length
        ? `${base} · IT NEEDS NEW PERMISSION${needsPermissions.length === 1 ? '' : 'S'} (${needsPermissions.join(', ').toUpperCase()}) SO PRESS THE RELOAD ARROW IN CHROME://EXTENSIONS`
        : base;
      $('#reload').hidden = needsPermissions.length > 0;
    }
  } catch {}
}
$('#order').addEventListener('click', toggleOrder);
$('#zoom-in').addEventListener('click', () => setZoom(1));
$('#zoom-out').addEventListener('click', () => setZoom(-1));
$('#sound').addEventListener('click', () => sound.toggle());
window.addEventListener('resize', placeCursor);

/* ---------- boot ---------- */
/**
 * Boot: wire browser listeners, load data, render, put the cursor on the tab we came from.
 */
async function init() {
  updateSoundButton();
  updateOrderButton();
  applyZoom();
  if (!DEMO) {
    try { const me = await chrome.tabs.getCurrent(); ownTabId = me ? me.id : null; ownWindowId = me ? me.windowId : null; } catch {}
    // If you click some other tab while the guide is open, the guide gets out of the way.
    chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
      if (windowId !== ownWindowId || tabId === ownTabId) return;
      if (busy || Date.now() < ignoreActivationUntil) return;
      closeSelf();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const k in changes) {
        if (!k.startsWith('thumb:') || !changes[k].newValue) continue;
        const id = Number(k.slice(6));
        for (const g of groups) for (const t of g.tabs) if (t.id === id) t.thumb = changes[k].newValue.data;
        const c = cards.find((x) => x.tab.id === id);
        if (!c) continue;
        const frame = c.querySelector('.frame');
        let img = frame.querySelector('img');
        const ns = frame.querySelector('.nosignal');
        if (!img) { img = new Image(); img.alt = ''; img.draggable = false; frame.insertBefore(img, frame.firstChild); }
        img.src = changes[k].newValue.data;
        if (ns) ns.remove();
      }
    });
    chrome.tabs.onRemoved.addListener((id) => {
      if (id === ownTabId) return;
      const i = cards.findIndex((c) => c.tab.id === id);
      if (i < 0) return;
      removeTab(id);
      if (i < sel) sel--;
      render();
    });
    chrome.tabs.onCreated.addListener(() => reload());
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'scan-progress') setStatus(msg.total ? `SCANNING ${msg.done}/${msg.total}` : 'SCANNING');
    });
    chrome.tabs.onUpdated.addListener((id, info) => {
      if (id === ownTabId || !(info.title || info.favIconUrl || info.url)) return;
      const c = cards.find((x) => x.tab.id === id);
      if (!c) return;
      const t = c.tab;
      if (info.title) { t.title = info.title; const e = c.querySelector('.label .title'); e.textContent = info.title; e.title = info.title; }
      if (info.url) { t.url = info.url; const h = c.querySelector('.host'); h.textContent = hostOf(info.url); h.title = info.url; }
      if (info.favIconUrl) { t.favicon = info.favIconUrl; const f = c.querySelector('.label .fav'); if (f) f.src = info.favIconUrl; }
    });
  }
  showUpdateBar();
  showShortcut();
  if (!DEMO) chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.newVersion) showUpdateBar(); });
  groups = await loadData();
  renumber();
  render();
  const i = cards.findIndex((c) => c.tab.id === RETURN_TO);
  if (i >= 0) select(i, false);
  const crt = $('#crt');
  crt.addEventListener('animationend', () => crt.classList.add('done'), { once: true });
  requestAnimationFrame(placeCursor);
  if (DEMO) toast('DEMO MODE', 2000);
}

/* ---------- demo dataset (plain-browser preview only) ---------- */
/** Fake tabs for demo mode (the page opened outside the extension). */
function demoData() {
  const mk = (title, url, hue, thumb = true) => ({
    id: Math.floor(Math.random() * 1e6), windowId: 1, title, url,
    favicon: fakeFavicon(hue), thumb: thumb ? fakeThumb(hue, title) : null,
    audible: false, pinned: false, discarded: false, incognito: false, dupes: 1, group: null, thumbAt: Date.now() - 300e3, excluded: false, text: '',
  });
  const a = [
    mk('Hacker News', 'https://news.ycombinator.com/', 25),
    mk('WebTV - Wikipedia', 'https://en.wikipedia.org/wiki/MSN_TV', 210),
    mk('Fly.io Dashboard', 'https://fly.io/dashboard', 270),
    mk('GitHub: pull requests', 'https://github.com/pulls', 0, false),
    mk('YouTube', 'https://www.youtube.com/', 0),
    mk('Scan the Block', 'https://scantheblock.com/', 160),
    mk('Chrome Extensions docs: tabs API', 'https://developer.chrome.com/docs/extensions/reference/api/tabs', 200),
    mk('Weather', 'https://weather.gov/', 40, false),
  ];
  a[1].audible = true;
  a[0].pinned = true;
  a[2].group = { title: 'WORK', color: 'blue' };
  a[5].group = { title: 'WORK', color: 'blue' };
  a[4].group = { title: '', color: 'red' };
  a[6].dupes = 2;
  a[2].text = 'Machines overview. tabtv-gateway is running 2 machines in sjc. Last deploy 12 minutes ago by keith. Volumes: none.';
  const b = [
    mk('Gmail', 'https://mail.google.com/', 5),
    mk('Calendar', 'https://calendar.google.com/', 215),
    mk('Notes about the tank shooter', 'file:///Users/admin/cyloid/NOTES.md', 100, false),
  ];
  b.forEach((t) => { t.windowId = 2; });
  return [{ id: 1, label: 'THIS WINDOW', tabs: a }, { id: 2, label: 'WINDOW 2', tabs: b }];
}
/** A canvas-drawn favicon for demo mode. */
function fakeFavicon(hue) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = `hsl(${hue} 70% 45%)`;
  g.beginPath(); g.roundRect(2, 2, 28, 28, 7); g.fill();
  g.fillStyle = '#fff';
  g.fillRect(9, 9, 14, 3); g.fillRect(9, 15, 14, 3); g.fillRect(9, 21, 9, 3);
  return c.toDataURL();
}
/** A canvas-drawn page picture for demo mode. */
function fakeThumb(hue, title) {
  const c = document.createElement('canvas');
  c.width = 560; c.height = 350;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, 560, 350);
  g.fillStyle = `hsl(${hue} 60% 40%)`; g.fillRect(0, 0, 560, 54);
  g.fillStyle = '#fff'; g.font = 'bold 22px Helvetica'; g.fillText(title, 18, 35);
  let y = 84;
  for (let i = 0; i < 7; i++) {
    g.fillStyle = i % 3 === 0 ? '#333' : '#bbb';
    const w = 120 + ((i * 97) % 380);
    g.fillRect(24, y, w, i % 3 === 0 ? 16 : 10);
    y += i % 3 === 0 ? 30 : 22;
  }
  g.fillStyle = `hsl(${hue} 50% 85%)`; g.fillRect(360, 90, 170, 110);
  return c.toDataURL('image/jpeg', 0.8);
}

init();
