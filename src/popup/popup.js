'use strict';

const DEFAULTS = {
  enabled: true,
  defaultOn: true,
  skipDarkSites: true,
  darkness: 50,
  contrast: 50,
  saturation: 50,
  tintSurface: null,
  tintText: null,
  tintBorder: null,
  tintStrength: 45,
  sites: {}
};

// Mirrors src/content/engine.js. The picker names roles the way the page does:
// a surface, its text, and the lines between them.
const TINT_MAX = 0.09;
const TINT_SCALE = { tintSurface: 1, tintText: 0.45, tintBorder: 0.8 };
const TINT_ROLE = { tintSurface: 'bg', tintText: 'fg', tintBorder: 'border' };
const TINT_KEYS = ['tintSurface', 'tintText', 'tintBorder'];
const TINT_DEFAULT_HUE = 212;   // the hue a target picks up when first switched on

const C = Lumen.color;

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };
let host = null;

// The hue each target shows while it is switched off, so that turning one off
// and back on returns the colour that was there rather than a default.
const hueMemory = { tintSurface: TINT_DEFAULT_HUE, tintText: TINT_DEFAULT_HUE,
                    tintBorder: TINT_DEFAULT_HUE };

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

// Mirrors the curves in src/content/color.js so the preview is honest. The
// colour maths itself is not mirrored -- color.js is loaded into the popup, so
// the swatches and the preview run the same code the page does.
function derive(s) {
  const bgMin = 0.14 - (s.darkness / 100) * 0.12;
  const tintOf = (key) => (s[key] === null || s[key] === undefined || !s.tintStrength
    ? null
    : { h: Number(s[key]), amount: TINT_MAX * TINT_SCALE[key] * (s.tintStrength / 100) });
  return {
    bgMin,
    bgMax: bgMin + 0.22,
    fgMin: 0.44 + (s.contrast / 100) * 0.18,
    fgMax: 0.82 + (s.contrast / 100) * 0.18,
    sat: s.saturation / 50,
    tint: { bg: tintOf('tintSurface'), fg: tintOf('tintText'), border: tintOf('tintBorder') }
  };
}

/** The colour a role's tint actually produces, at that role's own lightness. */
function shadeFor(key, cfg) {
  const l = key === 'tintText' ? cfg.fgMax
    : key === 'tintBorder' ? cfg.bgMin + 0.20
    : cfg.bgMin;
  return C.toCss(C.shade(l, TINT_ROLE[key], cfg));
}

function renderPreview() {
  const c = derive(settings);
  const page = document.querySelector('.preview-page');
  const title = document.querySelector('.preview-title');
  const lines = document.querySelectorAll('.preview-line');
  // A white page background (l = 1) folds down to bgMin; near-black body text
  // (l = 0.13) lifts to just under fgMax.
  page.style.background = C.toCss(C.shade(c.bgMin, 'bg', c));
  title.style.background = C.toCss(C.shade(c.fgMax, 'fg', c));
  lines.forEach((el) => {
    el.style.background = C.toCss(C.shade(c.fgMax - 0.26 * (c.fgMax - c.fgMin), 'fg', c));
  });
  // Held at a real syntax colour, so the preview also shows what the tint does
  // *not* touch: a colour of its own keeps its own hue.
  const code = document.querySelector('.preview-code');
  code.style.color = `hsl(122 ${Math.round(Math.min(1, 0.38 * c.sat) * 100)}% 72%)`;
  code.style.borderColor = C.toCss(C.shade(c.bgMin + 0.20, 'border', c));

  for (const key of TINT_KEYS) {
    const on = settings[key] !== null && settings[key] !== undefined;
    const hue = on ? settings[key] : hueMemory[key];
    const swatch = $(key + '-swatch');
    swatch.setAttribute('aria-pressed', on ? 'true' : 'false');
    // Off shows the colour it *would* apply, so the swatch is a preview of what
    // switching it on does rather than a blank.
    // backgroundColor, not background: the shorthand would clear the diagonal
    // background-image the stylesheet uses to mark a target as switched off.
    swatch.style.backgroundColor = shadeFor(key, on ? c : derive({ ...settings, [key]: hue }));
    $(key).value = hue;
    $(key).closest('.tint-row').dataset.off = String(!on);
  }
}

function render() {
  $('site').textContent = host || 'not available on this page';
  const on = siteOn();

  setSwitch($('site-toggle'), on);
  setSwitch($('skip-dark'), settings.skipDarkSites);
  setSwitch($('default-on'), settings.defaultOn);

  $('site-toggle').disabled = !host;
  $('sliders').dataset.disabled = String(!settings.enabled);

  for (const key of ['darkness', 'contrast', 'saturation', 'tintStrength']) {
    $(key).value = settings[key];
    $(key + '-out').textContent = settings[key] + '%';
  }

  $('tints').dataset.disabled = String(!settings.enabled);

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
  for (const key of TINT_KEYS) {
    if (settings[key] !== null && settings[key] !== undefined) hueMemory[key] = settings[key];
  }

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

  for (const key of ['darkness', 'contrast', 'saturation', 'tintStrength']) {
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

  for (const key of TINT_KEYS) {
    // Dragging a hue turns its target on: picking a colour is the whole point
    // of touching the control, and a slider that does nothing until a separate
    // switch is found is a puzzle, not a picker.
    $(key).addEventListener('input', (e) => {
      settings[key] = hueMemory[key] = Number(e.target.value);
      renderPreview();
      queueWrite({ [key]: settings[key] });
    });
    $(key).addEventListener('change', flushWrite);

    $(key + '-swatch').addEventListener('click', () => {
      const on = settings[key] !== null && settings[key] !== undefined;
      save({ [key]: on ? null : hueMemory[key] });
    });
  }

  $('reset').addEventListener('click', () =>
    save({ darkness: 50, contrast: 50, saturation: 50,
           tintSurface: null, tintText: null, tintBorder: null, tintStrength: 45 }));

  $('master').addEventListener('click', () => save({ enabled: !settings.enabled }));
}

init();
