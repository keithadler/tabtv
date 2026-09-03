// TabTV. Copyright 2026 Keith Adler. SPDX-License-Identifier: MIT
// Shared test harness: headless Google Chrome + the extension over the DevTools pipe. No deps.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function testPage(i, extra = '') {
  return `<!doctype html><title>Test page ${i}</title><link rel="icon" href="data:,">
<body style="margin:0;font:bold 48px Helvetica;background:hsl(${(i * 80) % 360} 60% 45%);color:#fff;padding:40px">
<h1>PAGE ${i}</h1><p>Big colorful test page number ${i} so the thumbnail is obvious.</p>${extra}</body>`;
}

class Conn {
  constructor(proc) {
    this.out = proc.stdio[3]; this.inp = proc.stdio[4]; this.id = 0; this.waits = new Map(); this.events = [];
    let buf = '';
    this.inp.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (m.id && this.waits.has(m.id)) { const { res, rej } = this.waits.get(m.id); this.waits.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
        else this.events.push(m);
      }
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    const id = ++this.id;
    this.out.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error(`CDP timeout: ${method} ${JSON.stringify(params).slice(0, 120)}`)); } }, timeoutMs);
      this.waits.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    });
  }
}

const KEYS = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Enter: 13, Escape: 27, Delete: 46, Backspace: 8, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 };

export async function launch({ pages = {}, port = 8777, name = 'e2e', extraArgs = [], firstUrl: firstUrlOverride, extPath = EXT } = {}) {
  const S = mkdtempSync(path.join(os.tmpdir(), `tabtv-${name}-`));
  mkdirSync(path.join(S, 'shots'));
  const server = http.createServer((req, res) => {
    const body = pages[req.url];
    if (!body) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body);
  }).listen(port);
  const firstUrl = firstUrlOverride || (Object.keys(pages)[0] ? `http://localhost:${port}${Object.keys(pages)[0]}` : 'about:blank');
  // Linux CI runners: no sandbox user namespaces, tiny /dev/shm, no GPU.
  const linuxFlags = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : [];
  const chrome = spawn(CHROME, [
    ...linuxFlags,
    '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${S}/profile`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', ...extraArgs, firstUrl,
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const b = new Conn(chrome);
  // wait for the browser to answer before loading the extension, instead of a fixed pause
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { try { await b.send('Browser.getVersion'); ready = true; } catch { await sleep(250); } }
  if (!ready) throw new Error('Chrome did not answer over the debugging pipe');
  await sleep(300);
  const { id: extId } = await b.send('Extensions.loadUnpacked', { path: extPath });

  const results = [];
  const log = (...a) => console.log(`[${name}]`, ...a);
  const check = (label, ok, extra = '') => { results.push([label, !!ok]); log(ok ? 'PASS' : 'FAIL', label, extra); return !!ok; };

  let swSess;
  const attachSW = async (notTargetId) => {
    let sw;
    for (let i = 0; i < 60 && !sw; i++) { const { targetInfos } = await b.send('Target.getTargets'); sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('background.js') && t.targetId !== notTargetId); if (!sw) await sleep(250); }
    if (!sw) throw new Error('service worker never started');
    ({ sessionId: swSess } = await b.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true }));
    return sw.targetId;
  };
  let swTargetId = await attachSW();
  const reattachSW = async () => { swTargetId = await attachSW(swTargetId); await sleep(500); };
  const evalSW = async (expr, retry = true) => {
    let r;
    try { r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, swSess); }
    catch (e) {
      // the worker may have been terminated and restarted (MV3 idle timeout, runtime.reload)
      if (!retry || !/timeout|Session with given id/.test(e.message)) throw e;
      await reattachSW();
      return evalSW(expr, false);
    }
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };

  const url = (p) => `http://localhost:${port}${p}`;
  const tabs = () => evalSW('chrome.tabs.query({})');
  const openTab = async (p, { windowId, activate = true } = {}) => {
    const t = await evalSW(`chrome.tabs.create(${JSON.stringify({ url: /^https?:/.test(p) ? p : url(p), active: activate, ...(windowId != null ? { windowId } : {}) })})`);
    if (activate) await sleep(1200);
    return t;
  };
  const activate = async (tabId, wait = 1200) => { await evalSW(`chrome.tabs.update(${tabId}, { active: true })`); await sleep(wait); };
  const thumbs = () => evalSW('chrome.storage.local.get(null).then(o => Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith("thumb:")).map(([k,v]) => [k.slice(6), { url: v.url, bytes: v.data.length }])))');

  const attachPage = async (targetId) => {
    const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
    await b.send('Runtime.enable', {}, sessionId);
    await b.send('Page.enable', {}, sessionId);
    const evalP = async (expr) => { const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const key = async (k, { modifiers = 0, wait = 150 } = {}) => {
      const code = KEYS[k] != null ? KEYS[k] : k.toUpperCase().charCodeAt(0);
      const base = { key: k, code: KEYS[k] != null ? k : 'Key' + k.toUpperCase(), windowsVirtualKeyCode: code, modifiers };
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, sessionId);
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId).catch(() => {}); // page may have closed itself on keydown
      await sleep(wait);
    };
    const type = async (s) => { for (const ch of s) await key(ch, { wait: 60 }); await sleep(150); };
    const shot = async (file) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }, sessionId); writeFileSync(path.join(S, 'shots', file), Buffer.from(r.data, 'base64')); };
    return { sessionId, evalP, key, type, shot, targetId };
  };

  const guideTarget = async () => (await b.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${extId}/overview.html`));
  // Open the guide exactly as the toolbar click / shortcut does, then attach to it.
  const openGuide = async (windowId) => {
    await evalSW(`openOverview(${windowId == null ? 'undefined' : windowId})`);
    await sleep(1300);
    const t = await guideTarget();
    if (!t) throw new Error('guide did not open');
    await b.send('Target.activateTarget', { targetId: t.targetId });
    const p = await attachPage(t.targetId);
    await sleep(600);
    return p;
  };
  const guideState = (p) => p.evalP(`({ cards: document.querySelectorAll('.card').length, imgs: document.querySelectorAll('.frame > img').length, nosignal: document.querySelectorAll('.nosignal').length, count: document.querySelector('#count').textContent, selected: document.querySelector('.card.selected .title')?.textContent || null, groups: [...document.querySelectorAll('.group h2')].map(h => h.textContent), titles: [...document.querySelectorAll('.card .title')].map(e => e.textContent) })`);

  const finish = () => {
    const failed = results.filter(([, ok]) => !ok).length;
    log(`${results.length - failed}/${results.length} checks passed`);
    log(`screenshots in ${S}/shots`);
    chrome.kill('SIGKILL');
    server.close();
    rmSync(path.join(S, 'profile'), { recursive: true, force: true });
    return failed;
  };

  return { b, S, extId, port, url, evalSW, reattachSW, tabs, openTab, activate, thumbs, attachPage, guideTarget, openGuide, guideState, check, log, results, finish };
}
