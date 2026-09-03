// TabTV. Copyright 2026 Keith Adler. SPDX-License-Identifier: MIT
// Picture-in-Picture from the guide, with several tabs playing video at once. Chrome permits one
// PiP window per browser, so pressing PIP on another tab must swap the floating window over.
import { launch, sleep, testPage } from './lib/harness.mjs';

// a page with a playing, muted, canvas-fed video (no media files needed)
const videoPage = (n) => `<!doctype html><title>Show ${n}</title><link rel="icon" href="data:,">
<body style="margin:0;background:#111;color:#fff;font:bold 40px Helvetica">
<h1 style="margin:20px">SHOW ${n}</h1>
<canvas id="c" width="640" height="360" hidden></canvas>
<video id="v" muted autoplay playsinline style="width:640px;height:360px;background:#000"></video>
<script>
const c = document.getElementById('c'), g = c.getContext('2d');
let f = 0; (function draw(){ g.fillStyle = 'hsl(' + ((f++ * 3 + ${n} * 90) % 360) + ' 70% 45%)'; g.fillRect(0,0,640,360); g.fillStyle='#fff'; g.font='bold 80px Helvetica'; g.fillText('SHOW ${n}', 140, 200); requestAnimationFrame(draw); })();
const v = document.getElementById('v'); v.srcObject = c.captureStream(30); v.play().catch(() => {});
</script></body>`;

const pages = { '/p1.html': testPage(1), '/show1.html': videoPage(1), '/show2.html': videoPage(2), '/show3.html': videoPage(3) };
const h = await launch({ pages, port: 8792, name: 'pip', extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
const { check, log, evalSW } = h;
try {
  const all0 = await h.tabs();
  const winA = all0[0].windowId;
  const p1 = all0[0];
  const shows = [];
  for (const i of [1, 2, 3]) { const tab = await h.openTab(`/show${i}.html`); shows.push({ id: tab.id, path: `/show${i}.html` }); }
  await h.activate(p1.id);
  const pipState = async () => {
    const out = {};
    for (const s of shows) {
      const t = (await h.b.send('Target.getTargets')).targetInfos.find((x) => x.type === 'page' && x.url.endsWith(s.path));
      const p = await h.attachPage(t.targetId);
      out[s.path] = await p.evalP(`({ pip: !!document.pictureInPictureElement, playing: !document.querySelector('video').paused, ready: document.querySelector('video').readyState })`);
    }
    return out;
  };
  const before = await pipState();
  check('three tabs are playing video', Object.values(before).every((s) => s.playing && s.ready >= 1), JSON.stringify(before));

  const g = await h.openGuide(winA);
  // audible is false for muted video, so the PIP button is hidden; Shift+P works on any card
  await g.key('ArrowRight');
  let st = await h.guideState(g);
  check('cursor on the first show', st.selected === 'Show 1', st.selected);
  await g.key('P', { modifiers: 8, wait: 1500 });
  let s = await pipState();
  const supported = !Object.values(s).every((x) => !x.pip);
  const toast = await g.evalP(`document.querySelector('#toast').textContent`).catch(() => '(guide closed)');
  if (!supported) {
    log('note: Picture-in-Picture did not open in headless Chrome; toast was:', toast);
  }
  check('Shift+P puts show 1 into Picture-in-Picture', s['/show1.html'].pip, JSON.stringify(s) + ' toast=' + toast);
  check('guide closed and returned to the origin tab after PiP', !(await h.guideTarget()) && /p1\.html$/.test((await h.tabs()).find((t) => t.active && t.windowId === winA).url));

  // second show: the floating window swaps over, show 1 is released
  const g2 = await h.openGuide(winA);
  await g2.key('ArrowRight');
  await g2.key('ArrowRight');
  st = await h.guideState(g2);
  check('cursor on the second show', st.selected === 'Show 2', st.selected);
  await g2.key('P', { modifiers: 8, wait: 1500 });
  s = await pipState();
  check('PiP swapped to show 2 and show 1 was released', s['/show2.html'].pip && !s['/show1.html'].pip, JSON.stringify(s));

  // pressing again on the same tab toggles it off and keeps the guide open
  const g3 = await h.openGuide(winA);
  await g3.key('ArrowRight');
  await g3.key('ArrowRight');
  await g3.key('P', { modifiers: 8, wait: 1200 });
  s = await pipState();
  const offToast = await g3.evalP(`document.querySelector('#toast').textContent`).catch(() => '(guide closed)');
  check('Shift+P on the same tab turns PiP off', !s['/show2.html'].pip && /OFF/.test(offToast), JSON.stringify(s) + ' toast=' + offToast);
  check('guide stays open when turning PiP off', !!(await h.guideTarget()));

  // a tab without video says so
  await g3.key('Home');
  await g3.key('P', { modifiers: 8, wait: 800 });
  const noVideo = await g3.evalP(`document.querySelector('#toast').textContent`);
  check('a tab with no video gets a clear message', /NO VIDEO/.test(noVideo), noVideo);
} catch (e) {
  check('no harness exception', false, e.stack || String(e));
}
process.exit(h.finish() ? 1 : 0);
