// TabTV. Copyright 2026 Keith Adler. SPDX-License-Identifier: MIT
// Scenario tests: multiple windows, chrome:// pages, sleeping/pinned tabs, live updates,
// find and channel keys, the toolbar path, recent ordering, and a 40-tab stress run.
import { launch, sleep, testPage } from './lib/harness.mjs';

const pages = {};
for (let i = 1; i <= 45; i++) pages[`/p${i}.html`] = testPage(i);
const h = await launch({ pages, port: 8778, name: 'scenarios' });
const { check, log, evalSW } = h;
const probe = async (label, g) => { if (!process.env.DEBUG) return; let ok; try { await g.evalP('1'); ok = 'alive'; } catch { ok = 'DEAD'; } log('probe', label, ok, 'guide:', !!(await h.guideTarget())); };

try {
  // ---- setup: three visited pages in window A
  const all0 = await h.tabs();
  const winA = all0[0].windowId;
  const p1 = all0[0];
  const p2 = await h.openTab('/p2.html');
  const p3 = await h.openTab('/p3.html');
  await h.activate(p1.id);

  // ---- 1. toolbar path captures the current tab first, then opens the guide once
  await evalSW('chrome.storage.local.remove("thumb:' + p1.id + '")');
  let g = await h.openGuide(winA);
  let th = await h.thumbs();
  check('opening the guide grabs a fresh picture of the tab you were on', !!th[p1.id], JSON.stringify(Object.keys(th)));
  await evalSW(`openOverview(${winA})`);
  await sleep(800);
  const guideCount = (await h.tabs()).filter((t) => t.url.includes('/overview.html')).length;
  check('opening the guide twice reuses the same tab', guideCount === 1, `guide tabs=${guideCount}`);
  let st = await h.guideState(g);
  check('guide reflects three tabs with pictures', st.cards === 3 && st.imgs === 3, JSON.stringify(st));

  // ---- 2. live updates while the guide is open
  const p4 = await h.openTab('/p4.html', { windowId: winA, activate: false });
  await sleep(900);
  st = await h.guideState(g);
  check('a tab opened in the background appears in the guide live', st.cards === 4 && st.titles.includes('Test page 4'), JSON.stringify(st.titles));
  await evalSW(`chrome.tabs.remove(${p3.id})`);
  await sleep(700);
  st = await h.guideState(g);
  check('a tab closed elsewhere disappears from the guide live', st.cards === 3 && !st.titles.includes('Test page 3'), JSON.stringify(st.titles));
  const guideStill = await h.guideTarget();
  check('guide survives those changes', !!guideStill);

  // ---- 2b. live title change and duplicate badge
  const p1Target = (await h.b.send('Target.getTargets')).targetInfos.find((x) => x.type === 'page' && /p1\.html$/.test(x.url));
  const p1Page = await h.attachPage(p1Target.targetId);
  await p1Page.evalP(`document.title = 'Renamed page 1'`);
  await sleep(500);
  const renamed = await g.evalP(`[...document.querySelectorAll('.card .title')].map(e => e.textContent)`);
  check('title change on a page updates its card live', renamed.includes('Renamed page 1'), JSON.stringify(renamed));
  await p1Page.evalP(`document.title = 'Test page 1'`);
  await sleep(400);
  const dupTab = await h.openTab('/p2.html', { windowId: winA, activate: false });
  await sleep(900);
  const dupBadges = await g.evalP(`[...document.querySelectorAll('.badge.dup')].map(e => e.textContent)`);
  check('tabs open twice get a ×2 badge on both cards', dupBadges.length === 2 && dupBadges.every((x) => x === '×2'), JSON.stringify(dupBadges));
  await evalSW(`chrome.tabs.remove(${dupTab.id})`);
  await sleep(600);
  const hostTitle = await g.evalP(`document.querySelector('.card .host').title`);
  check('hovering the domain shows the full URL', /^http:\/\/localhost:8778\/p\d\.html$/.test(hostTitle), hostTitle);

  // ---- 3. pinned badge and sleeping tab
  await evalSW(`chrome.tabs.update(${p2.id}, { pinned: true })`);
  await evalSW(`chrome.tabs.discard(${p4.id})`);
  await sleep(700);
  await g.evalP('reload()');
  await sleep(600);
  const pinBadge = await g.evalP(`[...document.querySelectorAll('.card')].find(c => c.querySelector('.title').textContent === 'Test page 2')?.querySelector('.badge')?.textContent`);
  check('pinned tab shows PIN badge', pinBadge === 'PIN', String(pinBadge));
  const sleeping = await g.evalP(`[...document.querySelectorAll('.card')].find(c => c.querySelector('.title').textContent === 'Test page 4')?.querySelector('.nosignal span')?.textContent`);
  check('discarded tab that was never seen shows SLEEPING', sleeping === 'SLEEPING', String(sleeping));
  await probe('after sleeping check', g);
  await sleep(500);
  await probe('after 500ms', g);

  // ---- 3b. help card and the real shortcut
  await g.key('?');
  let help = await g.evalP(`({ hidden: document.querySelector('#help').hidden, text: document.querySelector('#help-shortcut').textContent })`);
  check('? opens the help card with the real shortcut', !help.hidden && /(Command\+Shift\+Space|Ctrl\+Shift\+Space|⇧⌘Space|No keyboard shortcut)/.test(help.text), JSON.stringify(help));
  await g.key('Escape');
  help = await g.evalP(`document.querySelector('#help').hidden`);
  check('Escape closes the help card without leaving the guide', help === true && !!(await h.guideTarget()));

  // ---- 3c. SCAN asks before waking a sleeping tab, and reports progress
  await g.evalP(`document.querySelector('#scan').click(); new Promise(r => setTimeout(r, 500))`);
  const ask = await g.evalP(`document.querySelector('#toast').textContent`);
  check('SCAN warns that a sleeping tab would wake up', /1 SLEEPING WOULD WAKE UP/.test(ask), ask);
  const tabsBeforeScan = await h.tabs();
  check('nothing scanned yet', tabsBeforeScan.some((t) => t.discarded));
  await g.key('s', { wait: 100 });
  await sleep(3500);
  const afterSkip = await g.evalP(`({ toast: document.querySelector('#toast').textContent, status: document.querySelector('#status').textContent })`);
  check('S scans while skipping the sleeping tab', /SCANNED 2 TABS · 1 SKIPPED/.test(afterSkip.toast), JSON.stringify(afterSkip));
  check('the sleeping tab is still asleep', (await h.tabs()).some((t) => t.discarded));
  check('guide is back in front after the scan', (await h.tabs()).find((t) => t.active && t.windowId === winA).url.includes('/overview.html'));

  // ---- 4. find and channel keys in the real extension
  await g.type('page 2');
  st = await h.guideState(g);
  check('typing filters the grid', st.cards === 1 && st.titles[0] === 'Test page 2' && /1 OF 3/.test(st.count), JSON.stringify(st));
  await g.key('Escape');
  st = await h.guideState(g);
  check('Escape clears the filter instead of leaving', st.cards === 3, `cards=${st.cards}`);
  const chanOf1 = await g.evalP(`[...document.querySelectorAll('.card')].find(c => c.querySelector('.title').textContent === 'Test page 1').querySelector('.ch').textContent`);
  const digit = chanOf1.replace('CH ', '').replace(/^0/, '');
  await g.key(digit, { wait: 1000 });
  st = await h.guideState(g);
  check('typing a channel number jumps the cursor', st.selected === 'Test page 1', `${chanOf1} -> ${st.selected}`);

  // ---- 5. recent ordering
  await g.evalP(`document.querySelector('#order').click()`);
  await sleep(200);
  st = await h.guideState(g);
  const orderBtn = await g.evalP(`document.querySelector('#order').textContent`);
  check('ORDER: RECENT puts the tab you came from first', orderBtn === 'ORDER: RECENT' && st.titles[0] === 'Test page 1', JSON.stringify(st.titles));
  await g.evalP(`document.querySelector('#order').click()`);
  await sleep(200);
  st = await h.guideState(g);
  check('ORDER: SITE groups by host then channel', (await g.evalP(`document.querySelector('#order').textContent`)) === 'ORDER: SITE' && st.titles.join() === 'Test page 2,Test page 1,Test page 4', JSON.stringify(st.titles));
  await g.evalP(`document.querySelector('#order').click()`);
  await sleep(200);
  st = await h.guideState(g);
  check('ORDER: TABS restores strip order', st.titles.join() === 'Test page 2,Test page 1,Test page 4', JSON.stringify(st.titles));
  const ageTitle = await g.evalP(`document.querySelector('.frame > img').parentElement.title`);
  check('hovering a picture says when it was taken', /^Picture taken (just now|\d+ min ago)$/.test(ageTitle), ageTitle);

  // ---- 6. chrome:// page: no capture, no error, sensible host label
  await g.key('Escape', { wait: 800 });
  check('Escape leaves the guide before the chrome:// test', !(await h.guideTarget()));
  const cv = await evalSW(`chrome.tabs.create({ url: 'chrome://version/' })`);
  await sleep(1500);
  th = await h.thumbs();
  check('chrome:// pages are not photographed', !th[cv.id]);
  g = await h.openGuide(winA);
  const cvHost = await g.evalP(`[...document.querySelectorAll('.card')].find(c => c.querySelector('.host').textContent.startsWith('chrome://'))?.querySelector('.host').textContent`);
  check('chrome:// tab shows its scheme as the host label', cvHost === 'chrome://version', String(cvHost));
  check('guide opened fine from a chrome:// page', (await h.guideState(g)).cards === 4);
  await g.key('Escape', { wait: 800 });
  const backOn = (await h.tabs()).find((t) => t.active && t.windowId === winA);
  check('Escape returns to the chrome:// page', /^chrome:\/\/version/.test(backOn.url), backOn.url);
  await evalSW(`chrome.tabs.remove(${cv.id})`);
  await sleep(300);

  // ---- 7. second window: grouped, and Enter focuses the other window
  const winB = await evalSW(`chrome.windows.create({ url: '${h.url('/p10.html')}', focused: true })`);
  await sleep(1500);
  const p11 = await h.openTab('/p11.html', { windowId: winB.id });
  await evalSW(`chrome.windows.update(${winA}, { focused: true })`);
  await h.activate(p1.id, 800);
  g = await h.openGuide(winA);
  st = await h.guideState(g);
  check('guide groups tabs by window with this window first', st.groups[0] === 'THIS WINDOW' && st.groups[1] === 'WINDOW 2' && st.cards === 5, JSON.stringify(st.groups) + ' cards=' + st.cards);
  const bImgs = await g.evalP(`[...document.querySelectorAll('.group')][1].querySelectorAll('.frame > img').length`);
  check('tabs in the other window have pictures too', bImgs === 2, `imgs=${bImgs}`);
  await g.key('Tab');
  st = await h.guideState(g);
  check('Tab jumps to the first card of the next window', st.selected === 'Test page 10', st.selected);
  const hint = await g.evalP(`getComputedStyle(document.querySelector('.only-other')).display`);
  check('BRING HERE hint appears for a card from another window', hint !== 'none', hint);
  const a11y = await g.evalP(`({ role: document.querySelector('.grid').getAttribute('role'), sel: document.querySelectorAll('[aria-selected="true"]').length, label: document.querySelector('.card.selected').getAttribute('aria-label'), active: document.querySelector('#screen').getAttribute('aria-activedescendant') })`);
  check('listbox roles and one aria-selected card', a11y.role === 'listbox' && a11y.sel === 1 && /other window/.test(a11y.label) && a11y.active.startsWith('card-'), JSON.stringify(a11y));
  await g.key('Tab', { modifiers: 8 });
  st = await h.guideState(g);
  check('Shift+Tab jumps back to the first card of the previous section (the pinned tab)', st.selected === 'Test page 2', st.selected);
  await g.key('End');
  st = await h.guideState(g);
  check('End key reaches the last card in the other window', st.selected === 'Test page 11', st.selected);
  await g.key('Enter', { wait: 1200 });
  const focusedWin = await evalSW('chrome.windows.getLastFocused()');
  const activeB = (await h.tabs()).find((t) => t.active && t.windowId === winB.id);
  check('Enter on a card in another window focuses that window', focusedWin.id === winB.id && /p11\.html$/.test(activeB.url), `focused=${focusedWin.id} winB=${winB.id}`);
  check('guide closed after cross-window switch', !(await h.guideTarget()));

  // Shift+Enter pulls a tab from the other window into this one
  await evalSW(`chrome.windows.update(${winA}, { focused: true })`);
  await h.activate(p1.id, 600);
  g = await h.openGuide(winA);
  await g.key('End');
  await g.key('Enter', { modifiers: 8, wait: 1200 });
  const moved = (await h.tabs()).find((t) => /p11\.html$/.test(t.url));
  check('Shift+Enter brings the tab into this window and switches to it', moved && moved.windowId === winA && moved.active, `window=${moved && moved.windowId} winA=${winA}`);
  check('guide closed after bringing a tab here', !(await h.guideTarget()));
  await evalSW(`chrome.tabs.move(${moved.id}, { windowId: ${winB.id}, index: -1 })`);
  await sleep(400);

  // ---- 8. Escape when the tab you came from is already gone
  await evalSW(`chrome.windows.update(${winA}, { focused: true })`);
  const pTmp = await h.openTab('/p12.html', { windowId: winA });
  g = await h.openGuide(winA);
  await evalSW(`chrome.tabs.remove(${pTmp.id})`);
  await sleep(600);
  await g.key('Escape', { wait: 900 });
  check('Escape still closes the guide when the origin tab is gone', !(await h.guideTarget()));

  // ---- 9. stress: 40 tabs in one window
  await evalSW(`chrome.windows.remove(${winB.id})`);
  const t0 = Date.now();
  await evalSW(`Promise.all(${JSON.stringify(Array.from({ length: 40 }, (_, i) => h.url(`/p${i + 5}.html`)))}.map(url => chrome.tabs.create({ url, active: false, windowId: ${winA} })))`);
  await sleep(2500);
  const total = (await h.tabs()).filter((t) => t.windowId === winA).length;
  const t1 = Date.now();
  g = await h.openGuide(winA);
  const t2 = Date.now();
  st = await h.guideState(g);
  check('guide lists every tab of a crowded window', st.cards === total && total >= 43, `cards=${st.cards} tabs=${total}`);
  check('guide opens quickly with many tabs', t2 - t1 < 4000, `${t2 - t1} ms (incl. 1.9 s of fixed waits)`);
  await g.key('PageDown');
  await g.key('PageDown');
  st = await h.guideState(g);
  check('PageDown moves down the crowded grid', st.selected !== 'Test page 1', st.selected);
  await g.type('page 4');
  st = await h.guideState(g);
  await g.shot('crowded-find.png');
  check('find narrows a crowded window to the matches', st.cards === 6 && st.titles.every((x) => /page 4/.test(x)), `cards=${st.cards}`);
  const hintShown = await g.evalP(`getComputedStyle(document.querySelector('.only-filter')).display`);
  check('CLOSE ALL SHOWN hint appears while searching', hintShown !== 'none');
  const beforeCloseAll = (await h.tabs()).length;
  await g.key('Delete', { modifiers: 8 });
  check('first Shift+Delete only asks', (await h.tabs()).length === beforeCloseAll && /PRESS SHIFT\+DEL AGAIN/.test(await g.evalP(`document.querySelector('#toast').textContent`)));
  await g.key('Delete', { modifiers: 8, wait: 900 });
  const afterCloseAll = (await h.tabs()).length;
  st = await h.guideState(g);
  check('second Shift+Delete closes all six and clears the search', afterCloseAll === beforeCloseAll - 6 && st.cards === total - 6, `${beforeCloseAll} -> ${afterCloseAll}, cards=${st.cards}`);
  await g.key('z', { modifiers: 4, wait: 1200 });
  check('Cmd+Z brings one of them back', (await h.tabs()).length === afterCloseAll + 1);
  await g.shot('crowded.png');
  const swErrors = await evalSW('typeof self.__errors === "undefined" ? 0 : self.__errors');
  check('service worker still healthy', swErrors === 0);
  log(`setup ${t1 - t0} ms, guide open ${t2 - t1} ms`);
} catch (e) {
  check('no harness exception', false, e.stack || String(e));
  if (process.env.DEBUG) log('events:\n' + h.b.events.filter((x) => !/consoleAPICalled|executionContext|Runtime\.|Page\.(lifecycle|frameStartedLoading|frameStoppedLoading|domContent|load)/.test(x.method)).map((x) => x.method + ' ' + JSON.stringify(x.params).slice(0, 200)).join('\n'));
}
process.exit(h.finish() ? 1 : 0);
