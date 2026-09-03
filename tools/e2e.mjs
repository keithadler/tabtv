// End-to-end test of TabTV in a real Chrome via the DevTools protocol. No deps.
// Usage: node tools/e2e.mjs   (needs Google Chrome; runs headless with a throwaway profile)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, writeSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = mkdtempSync(path.join(os.tmpdir(), 'tabtv-e2e-'));
mkdirSync(path.join(S, 'shots'));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGES = {};
for (const i of [1, 2, 3, 4]) PAGES[`/p${i}.html`] = `<!doctype html><title>Test page ${i}</title><link rel="icon" href="data:,">
<body style="margin:0;font:bold 48px Helvetica;background:hsl(${i * 80} 60% 45%);color:#fff;padding:40px">
<h1>PAGE ${i}</h1><p>Big colorful test page number ${i} so the thumbnail is obvious.</p></body>`;
const PORT = 8777;
const CDP = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tiny static server for the test pages
const server = http.createServer((req, res) => {
  const body = PAGES[req.url];
  if (!body) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', 'text/html');
  res.end(body);
}).listen(PORT);

// Linux CI runners: no sandbox user namespaces, tiny /dev/shm, no GPU.
const linuxFlags = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : [];
const chrome = spawn(CHROME, [
  ...linuxFlags,
  '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  `--user-data-dir=${S}/profile`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,800',
  `http://localhost:${PORT}/p1.html`,
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); if (chromeErr.length > 8000) chromeErr = chromeErr.slice(-8000); });
chrome.on('exit', (code, sig) => { if (code) chromeErr += `\n[chrome exited code=${code} signal=${sig}]`; });

// CDP over the debugging pipe: fd 3 is Chrome's stdin for commands, fd 4 its stdout, NUL-separated JSON
class Conn {
  constructor(proc) {
    this.out = proc.stdio[3]; this.inp = proc.stdio[4]; this.id = 0; this.waits = new Map(); this.events = [];
    let buf = '';
    this.inp.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        const msg = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = JSON.parse(msg);
        if (m.id && this.waits.has(m.id)) { const { res, rej } = this.waits.get(m.id); this.waits.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
        else this.events.push(m);
      }
    });
    this.ready = Promise.resolve();
  }
  // Every call is bounded: a browser that never answers must fail the suite, not hang it.
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    const id = ++this.id;
    this.out.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      const timer = setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error(`CDP timeout: ${method} ${JSON.stringify(params).slice(0, 120)}`)); } }, timeoutMs);
      timer.unref?.();
    });
  }
}
const b = new Conn(chrome);
// Synchronous writes: they survive a kill, unlike buffered stdout on a pipe.
const log = (...a) => { try { writeSync(2, '[e2e] ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); } catch { console.log('[e2e]', ...a); } };
let ready = false;
let lastErr = '';
for (let i = 0; i < 20 && !ready; i++) {
  try { await b.send('Browser.getVersion', {}, undefined, 2000); ready = true; }
  catch (e) { lastErr = e.message; await sleep(500); }
}
if (!ready) { log(`Chrome did not answer over the debugging pipe (${lastErr}). Chrome said:\n${chromeErr || '(nothing on stderr)'}`); chrome.kill('SIGKILL'); server.close(); process.exit(1); }
const loaded = await b.send('Extensions.loadUnpacked', { path: EXT });
log('loaded extension', loaded.id);
const results = [];
let lastCheck = '(startup)';
const check = (name, ok, extra = '') => { results.push([name, ok]); lastCheck = name; log(ok ? 'PASS' : 'FAIL', name, extra); };
const beat = setInterval(() => log('...', lastCheck), 30000);
beat.unref?.();
const watchdog = setTimeout(() => { log(`WATCHDOG: no progress for 240s. Last check: ${lastCheck}`); try { chrome.kill('SIGKILL'); server.close(); } catch {} process.exit(1); }, 240000);

// find the extension's service worker
let sw;
for (let i = 0; i < 40 && !sw; i++) { const { targetInfos } = await b.send('Target.getTargets'); sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('background.js')); if (!sw) await sleep(250); }
check('service worker running', !!sw, sw ? sw.url : '');
const extId = new URL(sw.url).host;
const { sessionId: swSess } = await b.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
const evalSW = async (expr) => { const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, swSess); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception)); return r.result.value; };

// open pages 2..4, activating each one so captures happen
const pageIds = [];
for (const i of [2, 3, 4]) {
  const { targetId } = await b.send('Target.createTarget', { url: `http://localhost:${PORT}/p${i}.html` });
  pageIds.push(targetId);
  await b.send('Target.activateTarget', { targetId });
  await sleep(1200);
}
// Chrome throttles captureVisibleTab; give the debounce time
await sleep(1500);
const stored = await evalSW('chrome.storage.local.get(null).then(o => Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith("thumb:")).map(([k,v]) => [k, {url: v.url, bytes: v.data.length, isJpeg: v.data.startsWith("data:image/jpeg")}])))');
log('stored thumbs:', JSON.stringify(stored, null, 1));
const tabs = await evalSW('chrome.tabs.query({})');
const captured = Object.keys(stored).length;
check('thumbnails captured for visited tabs', captured >= 3, `${captured} thumbs for ${tabs.length} tabs`);
check('thumbnails are jpeg data urls', Object.values(stored).every((v) => v.isJpeg && v.bytes > 2000));

// put pages 2 and 3 in a named tab group
const grp = await evalSW(`(async()=>{ const ts = await chrome.tabs.query({}); const ids = ts.filter(t => /p[23]\\.html$/.test(t.url)).map(t => t.id); const gid = await chrome.tabs.group({ tabIds: ids }); await chrome.tabGroups.update(gid, { title: 'Research', color: 'green' }); return gid; })()`);
check('tab group created', typeof grp === 'number', String(grp));

// open the guide the way the background does it
const active = tabs.find((t) => t.active);
const winId = active.windowId;
const before = (await evalSW('chrome.tabs.query({})')).length;
await evalSW(`chrome.action.onClicked.hasListeners()`);
// simulate the toolbar click handler directly
await evalSW(`(async()=>{ const [t]=await chrome.tabs.query({active:true,windowId:${winId}}); await chrome.tabs.create({windowId:${winId}, url: chrome.runtime.getURL('overview.html')+'?from='+t.id+'&win='+${winId}, index:t.index+1}); })()`);
await sleep(1500);
const { targetInfos } = await b.send('Target.getTargets');
const ov = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${extId}/overview.html`));
check('guide page opened', !!ov, ov ? ov.url : '');
const { sessionId: pSess } = await b.send('Target.attachToTarget', { targetId: ov.targetId, flatten: true });
await b.send('Target.activateTarget', { targetId: ov.targetId });
await b.send('Page.enable', {}, pSess);
await b.send('Runtime.enable', {}, pSess);
await sleep(1000);
const evalP = async (expr) => { const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, pSess); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
const state = await evalP(`({ cards: document.querySelectorAll('.card').length, imgs: document.querySelectorAll('.frame > img').length, nosignal: document.querySelectorAll('.nosignal').length, count: document.querySelector('#count').textContent, selected: document.querySelector('.card.selected .title')?.textContent, now: document.querySelector('.badge.now') ? 1 : 0, demo: document.querySelector('#toast')?.textContent })`);
log('guide state:', JSON.stringify(state));
check('guide lists the four test tabs (not itself)', state.cards === 4, `cards=${state.cards}`);
check('guide shows real screenshots', state.imgs >= 3, `imgs=${state.imgs} nosignal=${state.nosignal}`);
check('cursor starts on the tab we came from (NOW badge)', state.now === 1 && /Test page 4/.test(state.selected || ''), `selected=${state.selected}`);
check('not in demo mode', state.demo !== 'DEMO MODE');
const hiddenBits = await evalP(`['#update', '#help', '#search', '#toast'].map(s => getComputedStyle(document.querySelector(s)).display)`);
check('update bar, help, search, and toast are all hidden on a fresh guide', hiddenBits.every((d) => d === 'none'), JSON.stringify(hiddenBits));
const bigFav = await evalP(`document.querySelector('.nosignal img.fav')?.src || ''`);
check('NO PREVIEW card uses the big cached favicon', bigFav.includes('/_favicon/?pageUrl='), bigFav.slice(0, 80));
const badge = await evalSW(`chrome.action.getBadgeText({})`);
check('toolbar badge shows the tab count', badge === '4', `badge=${badge}`);
const tags = await evalP(`[...document.querySelectorAll('.gtag')].map(e => e.textContent + ':' + e.dataset.color)`);
check('group tags shown on grouped cards', tags.length === 2 && tags.every((x) => x === 'Research:green'), JSON.stringify(tags));
const shot = await b.send('Page.captureScreenshot', { format: 'png' }, pSess);
writeFileSync(`${S}/shots/guide.png`, Buffer.from(shot.data, 'base64'));

// move left twice, press Enter: should land on page 2 and close the guide
for (const k of ['ArrowLeft', 'ArrowLeft']) {
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'ArrowLeft' ? 37 : 39 }, pSess);
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k }, pSess);
  await sleep(150);
}
const selTitle = await evalP(`document.querySelector('.card.selected .title').textContent`);
check('arrow keys move the cursor', /Test page 2/.test(selTitle), selTitle);
const shot2 = await b.send('Page.captureScreenshot', { format: 'png' }, pSess);
writeFileSync(`${S}/shots/guide-moved.png`, Buffer.from(shot2.data, 'base64'));
await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, pSess);
await sleep(1200);
const after = await evalSW('chrome.tabs.query({})');
const act = after.find((t) => t.active && t.windowId === winId);
check('Enter switches to the chosen tab', /p2\.html$/.test(act?.url || ''), act?.url);
check('guide tab closed itself', !after.some((t) => t.url.startsWith(`chrome-extension://${extId}/overview.html`)), `tabs now ${after.length}, before ${before}`);

// close a tab: its picture is kept for restore, and expires once stale
const victim = after.find((t) => /p3\.html$/.test(t.url));
await evalSW(`chrome.tabs.remove(${victim.id})`);
await sleep(600);
const kept = await evalSW(`chrome.storage.local.get('thumb:${victim.id}').then(o => !!o['thumb:${victim.id}'])`);
check('closed tab keeps its picture for undo and restore', kept);
await evalSW(`(async()=>{ const k='meta:${victim.id}'; const o=await chrome.storage.local.get(k); o[k].at = Date.now() - 8*864e5; await chrome.storage.local.set(o); await reconcile(); })()`);
const metaGone = await evalSW(`chrome.storage.local.get('meta:${victim.id}').then(o => Object.keys(o).length === 0)`);
check('its bookkeeping record goes with it', metaGone);
const expired = await evalSW(`chrome.storage.local.get('thumb:${victim.id}').then(o => !!o['thumb:${victim.id}'])`);
check('stale pictures of closed tabs expire on reconcile', !expired);

// SCAN: reopen the guide, ask the background to walk the window, and expect p1 (never captured) to get a picture
await evalSW(`(async()=>{ const [t]=await chrome.tabs.query({active:true,windowId:${winId}}); await chrome.tabs.create({windowId:${winId}, url: chrome.runtime.getURL('overview.html')+'?from='+t.id+'&win='+${winId}}); })()`);
await sleep(1200);
const ti2 = (await b.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url.includes('/overview.html'));
const { sessionId: p2 } = await b.send('Target.attachToTarget', { targetId: ti2.targetId, flatten: true });
await b.send('Runtime.enable', {}, p2);
const evalP2 = async (expr) => { const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, p2); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
const beforeScan = await evalP2(`document.querySelectorAll('.nosignal').length`);
await evalP2(`document.querySelector('#scan').click(); new Promise(r => setTimeout(r, 4500))`);
const afterScan = await evalP2(`({ nosignal: document.querySelectorAll('.nosignal').length, imgs: document.querySelectorAll('.frame > img').length, status: document.querySelector('#status').textContent })`);
const activeNow = (await evalSW('chrome.tabs.query({active:true})')).map((t) => t.url);
check('SCAN fills in the missing picture', beforeScan === 1 && afterScan.nosignal === 0 && afterScan.imgs === 3, JSON.stringify({ beforeScan, afterScan }));
check('SCAN returns to the guide', activeNow.some((u) => u.includes('/overview.html')), activeNow.join(','));
const shot3 = await b.send('Page.captureScreenshot', { format: 'png' }, p2);
writeFileSync(`${S}/shots/guide-after-scan.png`, Buffer.from(shot3.data, 'base64'));
// Escape goes back to the tab we came from (p2) and closes the guide
await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, p2);
await sleep(1000);
const afterEsc = await evalSW('chrome.tabs.query({})');
check('Escape returns to the origin tab', /p2\.html$/.test(afterEsc.find((t) => t.active && t.windowId === winId)?.url || ''));
check('guide closed after Escape', !afterEsc.some((t) => t.url.includes('/overview.html')));

// Undo: open the guide, close a tab with Delete, restore it with Cmd+Z, guide stays up
await evalSW(`(async()=>{ const [t]=await chrome.tabs.query({active:true,windowId:${winId}}); await chrome.tabs.create({windowId:${winId}, url: chrome.runtime.getURL('overview.html')+'?from='+t.id+'&win='+${winId}}); })()`);
await sleep(1200);
const ti3 = (await b.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url.includes('/overview.html'));
const { sessionId: p3 } = await b.send('Target.attachToTarget', { targetId: ti3.targetId, flatten: true });
await b.send('Runtime.enable', {}, p3);
const evalP3 = async (expr) => { const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, p3); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
const nBefore = (await evalSW('chrome.tabs.query({})')).length;
const victimTitle = await evalP3(`document.querySelector('.card.selected .title').textContent`);
await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }, p3);
await sleep(700);
const nAfterDel = (await evalSW('chrome.tabs.query({})')).length;
check('Delete closes the highlighted tab', nAfterDel === nBefore - 1, `${nBefore} -> ${nAfterDel} (${victimTitle})`);
await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 4 }, p3);
await sleep(1500);
const afterUndo = await evalSW('chrome.tabs.query({})');
check('Cmd+Z restores the closed tab', afterUndo.length === nBefore, `${afterUndo.length}`);
check('guide is still open and in front after undo', afterUndo.some((t) => t.active && t.url.includes('/overview.html')));
const cardsAfterUndo = await evalP3(`document.querySelectorAll('.card').length`);
check('restored tab is back in the grid', cardsAfterUndo === nBefore - 1, `cards=${cardsAfterUndo}`);
const restoredHasPic = await evalP3(`[...document.querySelectorAll('.card')].filter(c => c.querySelector('.title').textContent === ${JSON.stringify(victimTitle)}).map(c => !!c.querySelector('.frame > img'))[0]`);
check('restored tab adopted its old picture by URL', restoredHasPic === true, String(restoredHasPic));

// (exclusions tested below)


// Auto-close: switching to another tab by hand makes the guide go away
const other = afterUndo.find((t) => /p4\.html$/.test(t.url));
await evalSW(`chrome.tabs.update(${other.id}, { active: true })`);
await sleep(800);
const afterSwitch = await evalSW('chrome.tabs.query({})');
check('guide closes itself when you click another tab', !afterSwitch.some((t) => t.url.includes('/overview.html')));

// Exclusions: a site on the never list is not photographed is not photographed, even by SCAN
await evalSW(`chrome.storage.local.set({ settings: { never: ['localhost'] } })`);
const p1 = afterUndo.find((t) => /p1\.html$/.test(t.url));
await evalSW(`(async()=>{ const all = await chrome.storage.local.get(null); await chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith('thumb:'))); })()`);
await evalSW(`chrome.tabs.update(${p1.id}, { active: true })`);
await sleep(1500);
const excludedCount = await evalSW(`chrome.storage.local.get(null).then(o => Object.keys(o).filter(k => k.startsWith('thumb:')).length)`);
check('never-list sites are not photographed', excludedCount === 0, `thumbs=${excludedCount}`);
// pre-0.6 picture without a record gets one on reconcile; stats count it
await evalSW(`chrome.storage.local.set({ 'thumb:424242': { data: 'data:image/jpeg;base64,AAAA', url: 'http://old.example/', title: 'old', at: Date.now() } })`);
await evalSW('reconcile()');
const legacyMeta = await evalSW(`chrome.storage.local.get('meta:424242').then(o => o['meta:424242'])`);
check('a picture without a record gets one (upgrade path)', legacyMeta && legacyMeta.url === 'http://old.example/' && legacyMeta.bytes === 27, JSON.stringify(legacyMeta));
const statsMsg = await evalSW(`new Promise(r => chrome.runtime.onMessage.hasListeners() && allMeta().then(m => r(Object.keys(m).length)))`);
check('stats see it', statsMsg >= 1, String(statsMsg));
await evalSW(`chrome.storage.local.remove(['thumb:424242', 'meta:424242'])`);
const gx = await (async () => { await evalSW(`(async()=>{ const [t]=await chrome.tabs.query({active:true,windowId:${winId}}); await chrome.tabs.create({windowId:${winId}, url: chrome.runtime.getURL('overview.html')+'?from='+t.id+'&win='+${winId}}); })()`); await sleep(1200); const ti = (await b.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url.includes('/overview.html')); const { sessionId } = await b.send('Target.attachToTarget', { targetId: ti.targetId, flatten: true }); await b.send('Runtime.enable', {}, sessionId); return { sessionId, evalP: async (expr) => (await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)).result.value }; })();
const labels = await gx.evalP(`[...document.querySelectorAll('.nosignal span')].map(e => e.textContent)`);
check('never-list tabs say NOT PHOTOGRAPHED in the guide', labels.length >= 1 && labels.every((x) => x === 'NOT PHOTOGRAPHED'), JSON.stringify(labels));
await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, gx.sessionId);
await sleep(800);
await evalSW(`chrome.storage.local.set({ settings: { never: [] } })`);
await evalSW(`chrome.tabs.update(${other.id}, { active: true })`).catch(() => {});
await sleep(1200);
const allowedCount = await evalSW(`chrome.storage.local.get(null).then(o => Object.keys(o).filter(k => k.startsWith('thumb:')).length)`);
check('captures resume once the list is cleared', allowedCount >= 1, `thumbs=${allowedCount}`);

// Options page renders and reports stats
const { targetId: optId } = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
const { sessionId: oSess } = await b.send('Target.attachToTarget', { targetId: optId, flatten: true });
await b.send('Runtime.enable', {}, oSess);
await sleep(800);
const optStats = (await b.send('Runtime.evaluate', { expression: `document.querySelector('#stats').textContent`, returnByValue: true }, oSess)).result.value;
check('options page shows picture stats', /PICTURE/.test(optStats), optStats);
const optShot = await b.send('Page.captureScreenshot', { format: 'png' }, oSess);
writeFileSync(`${S}/shots/options.png`, Buffer.from(optShot.data, 'base64'));

const failed = results.filter(([, ok]) => !ok).length;
log(`${results.length - failed}/${results.length} checks passed`);
log(`screenshots in ${S}/shots`);
clearTimeout(watchdog);
clearInterval(beat);
chrome.kill('SIGKILL');
server.close();
// best-effort: Chrome may still be writing to the profile as it dies
try { rmSync(path.join(S, 'profile'), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
process.exit(failed ? 1 : 0);
