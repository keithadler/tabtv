// TabTV. Copyright 2026 Keith Adler. SPDX-License-Identifier: MIT
// "Search what was on screen": opt-in, reads the words in the viewport at capture time,
// searchable from the guide with a SEEN snippet, skipped for never-listed sites, wiped when turned off.
import { launch, sleep, testPage } from './lib/harness.mjs';

const wordy = `<!doctype html><title>Plain title</title><link rel="icon" href="data:,">
<body style="margin:0;font:bold 28px Helvetica;padding:30px;background:#fff;color:#111">
<h1>Quarterly report</h1>
<p>The quokka population on Rottnest Island rose by twelve percent.</p>
<p style="position:absolute;top:5000px">Offscreen sentence about a marmalade cat.</p>
<input value="secret-field-text"><textarea>secret-area-text</textarea>
<p style="visibility:hidden">hidden-words</p>
<script>document.title = 'Plain title';</script>
</body>`;
const pages = { '/p1.html': testPage(1), '/report.html': wordy };
const h = await launch({ pages, port: 8793, name: 'text' });
const { check, evalSW } = h;
try {
  const all0 = await h.tabs();
  const winA = all0[0].windowId;
  const p1 = all0[0];

  // off by default: nothing read
  const rep = await h.openTab('/report.html');
  await sleep(800);
  let txt = await evalSW(`chrome.storage.local.get('text:${rep.id}').then(o => o['text:${rep.id}'] || null)`);
  check('off by default: no text stored', txt === null);
  check('but the picture was taken', !!(await h.thumbs())[rep.id]);

  // on: the next picture carries the words on screen
  await evalSW(`chrome.storage.local.set({ settings: { readText: true } })`);
  await h.activate(p1.id, 500);
  await h.activate(rep.id, 1500);
  txt = await evalSW(`chrome.storage.local.get('text:${rep.id}').then(o => o['text:${rep.id}'] || null)`);
  check('on: text stored with the picture', txt && /quokka population/.test(txt.text), JSON.stringify(txt).slice(0, 200));
  check('offscreen text is not included', txt && !/marmalade/.test(txt.text));
  check('form fields and hidden text are not included', txt && !/secret-/.test(txt.text) && !/hidden-words/.test(txt.text));

  // search finds it by what was on screen, with a SEEN snippet
  await h.activate(p1.id, 500);
  const g = await h.openGuide(winA);
  await g.type('quokka');
  const st = await h.guideState(g);
  const seen = await g.evalP(`document.querySelector('.card .seen')?.textContent || ''`);
  check('typing a word that was only on screen finds the tab', st.cards === 1 && st.titles[0] === 'Plain title', JSON.stringify(st.titles));
  check('the card shows a SEEN snippet around the match', /^SEEN .*quokka/.test(seen), seen);
  await g.key('Escape');
  await g.type('plain');
  const seen2 = await g.evalP(`document.querySelector('.card .seen')`);
  check('a title match shows no SEEN line', seen2 === null);
  await g.key('Escape');
  await g.key('Escape', { wait: 800 });

  // never-list wins over the switch
  await evalSW(`chrome.storage.local.set({ settings: { readText: true, never: ['localhost'] } })`);
  await evalSW(`chrome.storage.local.remove(['thumb:${rep.id}', 'meta:${rep.id}', 'text:${rep.id}'])`);
  await h.activate(rep.id, 1500);
  txt = await evalSW(`chrome.storage.local.get('text:${rep.id}').then(o => o['text:${rep.id}'] || null)`);
  check('never-listed sites get no text (and no picture)', txt === null && !(await h.thumbs())[rep.id]);

  // turning it off forgets everything
  await evalSW(`chrome.storage.local.set({ settings: { readText: true, never: [] } })`);
  await h.activate(p1.id, 500);
  await h.activate(rep.id, 1500);
  check('text back once allowed', !!(await evalSW(`chrome.storage.local.get('text:${rep.id}').then(o => o['text:${rep.id}'])`)));
  await evalSW(`new Promise(r => chrome.runtime.onMessage.dispatch ? r() : r())`);
  await evalSW(`(async () => { await chrome.storage.local.set({ settings: { readText: false } }); const meta = await allMeta(); await chrome.storage.local.remove(Object.keys(meta).map(id => 'text:' + id)); })()`);
  const left = await evalSW(`chrome.storage.local.getKeys ? chrome.storage.local.getKeys().then(k => k.filter(x => x.startsWith('text:')).length) : chrome.storage.local.get(null).then(o => Object.keys(o).filter(x => x.startsWith('text:')).length)`);
  check('turning the switch off wipes stored text', left === 0, `left=${left}`);
} catch (e) {
  check('no harness exception', false, e.stack || String(e));
}
process.exit(h.finish() ? 1 : 0);
