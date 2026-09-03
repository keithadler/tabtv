// TabTV. Copyright 2026 Keith Adler. SPDX-License-Identifier: MIT
// Settings page. Talks to the background worker for anything that touches pictures so the
// storage layout lives in one place.

'use strict';
const $ = (s) => document.querySelector(s);

/** Fill the form from storage and show the unpacked-only section when relevant. */
async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  $('#never').value = ((settings && settings.never) || []).join('\n');
  const unpacked = !chrome.runtime.getManifest().update_url;
  $('#dev').hidden = !unpacked;
  $('#autoreload').checked = !(settings && settings.autoReload === false);
  $('#readtext').checked = !!(settings && settings.readText);
}
$('#readtext').addEventListener('change', async (e) => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...(settings || {}), readText: e.target.checked } });
  if (!e.target.checked) await chrome.runtime.sendMessage({ type: 'clear-text' });
});
$('#autoreload').addEventListener('change', async (e) => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...(settings || {}), autoReload: e.target.checked } });
});
/**
 * Save the never-list and delete pictures already taken of those sites.
 */
async function saveSettings() {
  const never = $('#never').value.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...(settings || {}), never } });
  // drop pictures already taken of sites that are now excluded
  const { dropped = 0 } = await chrome.runtime.sendMessage({ type: 'drop-pictures-matching', never });
  flash('#saved', dropped ? `SAVED · ${dropped} PICTURE${dropped === 1 ? '' : 'S'} REMOVED` : 'SAVED');
  stats();
}
/** Picture count and size in the top bar, from the background's records. */
async function stats() {
  const { n = 0, bytes = 0 } = await chrome.runtime.sendMessage({ type: 'picture-stats' });
  $('#stats').textContent = `${n} PICTURE${n === 1 ? '' : 'S'} · ${(bytes * 0.75 / 1048576).toFixed(1)} MB`;
}
/** Show a confirmation next to a button for a moment. */
function flash(sel, text) {
  const e = $(sel);
  e.textContent = text;
  clearTimeout(e._t);
  e._t = setTimeout(() => { e.textContent = ''; }, 2500);
}

$('#save').addEventListener('click', saveSettings);
$('#clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clear-pictures' });
  flash('#cleared', 'CLEARED');
  stats();
});
$('#shortcuts').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-shortcuts' }));
$('#never').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveSettings(); } });

/** Describe the real keyboard shortcut, or say none is set. */
async function shortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    const s = (cmds.find((c) => c.name === 'open-overview') || {}).shortcut;
    $('#shortcut-text').textContent = s ? `The guide opens with ${s}. Change it on Chrome's shortcuts page.` : 'No keyboard shortcut is assigned right now. Set one on Chrome\'s shortcuts page, or use the toolbar icon.';
  } catch {}
}
loadSettings();
stats();
shortcut();
