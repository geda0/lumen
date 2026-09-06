'use strict';

const DEFAULTS = {
  enabled: true,
  defaultOn: true,
  skipDarkSites: true,
  darkness: 50,
  contrast: 50,
  saturation: 50,
  sites: {}
};

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };
let host = null;

function hostOf(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:', 'file:'].includes(u.protocol)) return null;
    return u.hostname || 'local';
  } catch (e) {
    return null;
  }
}

function siteOn() {
  if (!settings.enabled || !host) return false;
  const explicit = settings.sites[host];
  return explicit === undefined ? settings.defaultOn : explicit;
}

function setSwitch(el, on) {
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}

// Each storage write makes every tab re-apply its palette in one synchronous
// pass, which is what keeps the change from flickering -- but it is not free.
// Dragging a slider fires `input` continuously, so the page follows the drag at
// a few frames a second and lands exactly on release, while the popup's own
// preview updates on every event.
const DRAG_INTERVAL = 250;
let pendingWrite = {};
let writeTimer = 0;

function flushWrite() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = 0; }
  const batch = pendingWrite;
  pendingWrite = {};
  if (Object.keys(batch).length) chrome.storage.local.set(batch);
}

function queueWrite(patch) {
  Object.assign(pendingWrite, patch);
  if (!writeTimer) writeTimer = setTimeout(flushWrite, DRAG_INTERVAL);
}

// The popup can be dismissed mid-drag; do not lose the last value.
window.addEventListener('pagehide', flushWrite);

async function save(patch) {
  Object.assign(settings, patch);
  await chrome.storage.local.set(patch);
  render();
}

// Mirrors the curves in src/content/color.js so the preview is honest.
function derive(s) {
  const bgMin = 0.14 - (s.darkness / 100) * 0.12;
  return {
    bgMin,
    bgMax: bgMin + 0.22,
    fgMin: 0.44 + (s.contrast / 100) * 0.18,
    fgMax: 0.82 + (s.contrast / 100) * 0.18,
    sat: s.saturation / 50
  };
}

function hsl(h, s, l) {
  return `hsl(${h} ${Math.round(Math.min(1, s) * 100)}% ${Math.round(l * 100)}%)`;
}

function renderPreview() {
  const c = derive(settings);
  const page = document.querySelector('.preview-page');
  const title = document.querySelector('.preview-title');
  const lines = document.querySelectorAll('.preview-line');
  // A white page background (l = 1) folds down to bgMin; near-black body text
  // (l = 0.13) lifts to just under fgMax.
  page.style.background = hsl(0, 0, c.bgMin);
  title.style.background = hsl(0, 0, c.fgMax);
  lines.forEach((el) => {
    el.style.background = hsl(0, 0, c.fgMax - 0.26 * (c.fgMax - c.fgMin));
  });
  const code = document.querySelector('.preview-code');
  code.style.color = hsl(122, 0.38 * c.sat, 0.72);
}

function render() {
  $('site').textContent = host || 'not available on this page';
  const on = siteOn();

  setSwitch($('site-toggle'), on);
  setSwitch($('skip-dark'), settings.skipDarkSites);
  setSwitch($('default-on'), settings.defaultOn);

  $('site-toggle').disabled = !host;
  $('sliders').dataset.disabled = String(!settings.enabled);

  for (const key of ['darkness', 'contrast', 'saturation']) {
    $(key).value = settings[key];
    $(key + '-out').textContent = settings[key] + '%';
  }

  $('master').textContent = settings.enabled ? 'Turn off everywhere' : 'Turn on everywhere';
  renderPreview();
}

function showNotice(text) {
  const el = $('notice');
  if (!text) {
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.hidden = false;
}

async function init() {
  settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  settings.sites = settings.sites || {};

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  host = tab ? hostOf(tab.url || '') : null;
  render();

  if (!host) {
    showNotice('Chrome blocks extensions on this page.');
  } else if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: 'lumen-status' }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      if (res.alreadyDark) {
        showNotice('This site already uses a dark theme, so Lumen left it alone. Toggle above to override.');
      }
    });
  }

  $('site-toggle').addEventListener('click', () => {
    if (!host) return;
    const sites = { ...settings.sites, [host]: !siteOn() };
    showNotice('');
    save({ sites, enabled: true });
  });

  $('skip-dark').addEventListener('click', () => save({ skipDarkSites: !settings.skipDarkSites }));
  $('default-on').addEventListener('click', () => save({ defaultOn: !settings.defaultOn }));

  for (const key of ['darkness', 'contrast', 'saturation']) {
    $(key).addEventListener('input', (e) => {
      const value = Number(e.target.value);
      settings[key] = value;
      $(key + '-out').textContent = value + '%';
      renderPreview();
      queueWrite({ [key]: value });
    });
    // Releasing the slider applies the final value straight away.
    $(key).addEventListener('change', flushWrite);
  }

  $('reset').addEventListener('click', () =>
    save({ darkness: 50, contrast: 50, saturation: 50 }));

  $('master').addEventListener('click', () => save({ enabled: !settings.enabled }));
}

init();
