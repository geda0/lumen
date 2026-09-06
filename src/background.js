/*
 * Lumen — service worker.
 *
 * Two jobs: fetch cross-origin stylesheets that the page's own CSSOM refuses to
 * expose, and keep the toolbar badge in sync with the per-site setting.
 */

const DEFAULTS = {
  enabled: true,
  defaultOn: true,
  skipDarkSites: true,
  darkness: 50,
  contrast: 50,
  saturation: 50,
  sites: {}
};

const MAX_CSS_BYTES = 4 * 1024 * 1024;
const cssCache = new Map();

// --- cross-origin CSS ------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== 'lumen-fetch-css') return false;

  const url = msg.url;
  if (cssCache.has(url)) {
    respond({ ok: true, text: cssCache.get(url) });
    return false;
  }

  fetch(url, { credentials: 'omit', cache: 'force-cache' })
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_CSS_BYTES) throw new Error('too large');
      return res.text();
    })
    .then((text) => {
      if (text.length > MAX_CSS_BYTES) throw new Error('too large');
      if (cssCache.size > 200) cssCache.clear();
      cssCache.set(url, text);
      respond({ ok: true, text });
    })
    .catch((err) => respond({ ok: false, error: String(err) }));

  return true; // keep the message channel open for the async response
});

// --- per-site toggle -------------------------------------------------------

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') {
      return null;
    }
    return u.hostname || 'local';
  } catch (e) {
    return null;
  }
}

async function isOn(host) {
  const s = await chrome.storage.local.get(DEFAULTS);
  if (!s.enabled) return false;
  const explicit = (s.sites || {})[host];
  return explicit === undefined ? s.defaultOn : explicit;
}

async function toggleSite(host) {
  const s = await chrome.storage.local.get(DEFAULTS);
  const sites = s.sites || {};
  const explicit = sites[host];
  const current = explicit === undefined ? s.defaultOn : explicit;
  sites[host] = !current;
  await chrome.storage.local.set({ sites });
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-site') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const host = hostOf(tab.url || '');
  if (host) await toggleSite(host);
});

// --- badge -----------------------------------------------------------------

async function refreshBadge(tabId, url) {
  const host = hostOf(url || '');
  const on = host ? await isOn(host) : false;
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? '' : 'off' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#4b5563' });
  } catch (e) {
    // Tab closed mid-update.
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading' || info.url) refreshBadge(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    refreshBadge(tabId, tab.url);
  } catch (e) { /* gone */ }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (!changes.sites && !changes.enabled && !changes.defaultOn) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) refreshBadge(tab.id, tab.url);
});
