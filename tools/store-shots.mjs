// TabTV. Copyright 2026 Keith Adler. SPDX-License-Identifier: MIT
// Generate Chrome Web Store screenshots (1280x800) and a 440x280 promo tile from a real
// headless Chrome with the extension loaded. Output goes to store/.
import { launch, sleep, EXT } from './lib/harness.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.join(EXT, 'store');
mkdirSync(OUT, { recursive: true });

const site = (title, accent, bg, body) => `<!doctype html><title>${title}</title><link rel="icon" href="data:,">
<body style="margin:0;font-family:Helvetica,Arial,sans-serif;background:${bg};color:#222">
<div style="background:${accent};color:#fff;padding:18px 40px;font-size:26px;font-weight:700;display:flex;gap:30px;align-items:center">${title}<span style="font-size:15px;font-weight:400;opacity:.85">Home · Explore · About</span></div>
<div style="padding:40px;max-width:1100px">${body}</div></body>`;
const para = (n = 3, w = 100) => Array.from({ length: n }, (_, i) => `<div style="height:14px;background:#bbb;border-radius:7px;margin:12px 0;width:${w - (i * 17) % 40}%"></div>`).join('');
const hero = (c) => `<div style="height:220px;background:${c};border-radius:16px;margin-bottom:28px"></div>`;
// Fake hostnames resolve to the local test server via --host-resolver-rules.
const HOSTS = {
  '/news.html': 'morningledger.news', '/recipes.html': 'slowkitchen.co', '/docs.html': 'docs.widgetapi.io',
  '/shop.html': 'northwindoutfitters.com', '/mail.html': 'mail.example.com', '/video.html': 'streambox.tv',
  '/maps.html': 'trailfinder.net', '/wiki.html': 'encyclopedia.org',
};
const pages = {
  '/news.html': site('The Morning Ledger', '#1d3557', '#f7f5ef', `<h1 style="font-size:40px;margin:0 0 8px">City council approves new riverfront park</h1>${para(5)}${hero('#a8dadc')}${para(4, 90)}`),
  '/recipes.html': site('Slow Kitchen', '#b5651d', '#fff8f0', `${hero('#f4a261')}<h1 style="font-size:36px">Braised short ribs with polenta</h1>${para(6, 95)}`),
  '/docs.html': site('Widget API Docs', '#2a9d8f', '#f2fbf9', `<h1 style="font-size:32px">Getting started</h1>${para(3)}<pre style="background:#1e2a2a;color:#9fe;padding:22px;border-radius:12px;font-size:16px">const guide = new Guide({ channels: 43 });\nguide.on('select', switchTo);</pre>${para(4, 80)}`),
  '/shop.html': site('Northwind Outfitters', '#6a4c93', '#f9f6fd', `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px">${['#c9ada7', '#9a8c98', '#4a4e69', '#f2e9e4', '#22223b', '#c9ada7'].map((c) => `<div style="height:190px;background:${c};border-radius:14px"></div>`).join('')}</div>`),
  '/mail.html': site('Inbox', '#d62828', '#ffffff', Array.from({ length: 9 }, (_, i) => `<div style="display:flex;gap:20px;padding:14px 0;border-bottom:1px solid #eee"><div style="width:140px;height:14px;background:#888;border-radius:7px"></div><div style="flex:1;height:14px;background:#ccc;border-radius:7px;width:${60 + (i * 13) % 35}%"></div></div>`).join('')),
  '/video.html': site('StreamBox', '#111', '#181818', `<div style="height:420px;background:linear-gradient(135deg,#333,#000);border-radius:16px;display:flex;align-items:center;justify-content:center"><div style="width:0;height:0;border-left:70px solid #fff;border-top:40px solid transparent;border-bottom:40px solid transparent"></div></div>`),
  '/maps.html': site('Trail Finder', '#386641', '#e9f5db', `${hero('linear-gradient(135deg,#a7c957,#6a994e 60%,#386641)')}${para(3)}`),
  '/wiki.html': site('Encyclopedia', '#555', '#fff', `<h1 style="font-size:34px;border-bottom:1px solid #ccc">WebTV</h1>${para(8, 100)}`),
};

const PORT = 8781;
const at = (p) => `http://${HOSTS[p]}:${PORT}${p}`;
const h = await launch({ pages, port: PORT, name: 'store', extraArgs: [`--host-resolver-rules=MAP *.news 127.0.0.1, MAP *.co 127.0.0.1, MAP *.io 127.0.0.1, MAP *.com 127.0.0.1, MAP *.tv 127.0.0.1, MAP *.net 127.0.0.1, MAP *.org 127.0.0.1`], firstUrl: at('/news.html') });
try {
  const { evalSW } = h;
  const all0 = await h.tabs();
  const winA = all0[0].windowId;
  const ids = [all0[0].id];
  for (const p of Object.keys(pages).slice(1)) ids.push((await h.openTab(at(p))).id);
  // groups, a pin, a duplicate, for a lively guide
  await evalSW(`(async()=>{ const g = await chrome.tabs.group({ tabIds: [${ids[2]}, ${ids[3]}] }); await chrome.tabGroups.update(g, { title: 'Work', color: 'blue' }); })()`);
  await evalSW(`chrome.tabs.update(${ids[0]}, { pinned: true })`);
  await h.activate(ids[0]);

  const g = await h.openGuide(winA);
  const size = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
  await h.b.send('Emulation.setDeviceMetricsOverride', size, g.sessionId);
  await g.evalP(`localStorage.setItem('tabtv-zoom','1'); document.querySelector('#toast').hidden = true; placeCursor(); 1`);
  await g.key('ArrowRight');
  await g.key('ArrowRight');
  await sleep(600);
  const save = async (name, sess) => { const r = await h.b.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 } }, sess); writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')); h.log('wrote', name); };
  await save('shot-1-guide.png', g.sessionId);

  await g.type('kitchen');
  await sleep(400);
  await save('shot-2-find.png', g.sessionId);
  await g.key('Escape');

  // promo tile: crop of the guide at 440x280
  const tile = await h.b.send('Page.captureScreenshot', { format: 'png', clip: { x: 20, y: 90, width: 880, height: 560, scale: 0.5 } }, g.sessionId);
  writeFileSync(path.join(OUT, 'promo-440x280.png'), Buffer.from(tile.data, 'base64'));
  h.log('wrote promo-440x280.png');

  const { targetId } = await h.b.send('Target.createTarget', { url: `chrome-extension://${h.extId}/options.html` });
  const o = await h.attachPage(targetId);
  await h.b.send('Emulation.setDeviceMetricsOverride', size, o.sessionId);
  await o.evalP(`document.querySelector('#never').value = 'bank.com\\nmail.google.com\\nhealth.example.org'; 1`);
  await sleep(500);
  await save('shot-3-settings.png', o.sessionId);
} catch (e) {
  h.check('store shots', false, e.stack || String(e));
}
process.exit(h.finish() ? 1 : 0);
