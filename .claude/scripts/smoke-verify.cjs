'use strict';
// smoke-verify.cjs — browser-QA smoke verdict helper (ADR 0021). Built red/green.
// Pure core + thin seams: evaluateMarkers (pure predicate), findBrowser, renderDom,
// smokeVerify (compose), and a CLI that emits a `verdict` tic. Zero dependencies.

const child_process = require('child_process');
const path = require('path');

function evaluateMarkers(dom, expectedMarkers) {
  const present = expectedMarkers.filter(m => dom.includes(m));
  const missing = expectedMarkers.filter(m => !dom.includes(m));
  const verdict = missing.length === 0 ? 'pass' : present.length === 0 ? 'block' : 'concerns';
  return { present, missing, verdict };
}

function findBrowser(opts) {
  if (opts === undefined) opts = {};
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const onPath = opts.onPath || function(name) {
    try {
      const r = require('child_process').spawnSync(platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
      return !!r && r.status === 0;
    } catch (e) { return false; }
  };
  const exists = opts.exists || function(p) {
    try { return require('fs').existsSync(p); } catch (e) { return false; }
  };

  // Tier 1: explicit env override
  if (env && env.TT_BROWSER) return env.TT_BROWSER;

  // Tier 2: PATH candidates
  const pathNames = ['google-chrome', 'chromium', 'chromium-browser', 'chrome', 'google-chrome-stable', 'msedge'];
  for (const name of pathNames) {
    if (onPath(name)) return name;
  }

  // Tier 3: OS install paths
  const installPaths = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
    win32: [
      (env['ProgramFiles'] || 'C:\\Program Files') + '\\Google\\Chrome\\Application\\chrome.exe',
    ],
  };
  const paths = installPaths[platform] || [];
  for (const p of paths) {
    if (exists(p)) return p;
  }

  return null;
}
function spawnRender(browser, args, deadlineMs) { const r = child_process.spawnSync(browser, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: deadlineMs || 10000 }); const out = (r && r.stdout) || ''; if (out.trim()) { return out; } else if (r && (r.signal || (r.error && r.error.code === 'ETIMEDOUT'))) { return { timedOut: true }; } return ''; }

function isLoopback(u) {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\./.test(h);
  } catch (e) { return false; }
}

function renderDom(url, opts) {
  if (opts === undefined) opts = {};
  if (!opts.allowRemote && !isLoopback(url)) { return { dom: '', renderer: 'refused-nonloopback' }; }
  const find = opts.findBrowser || findBrowser;
  const spawn = opts.spawnRender || spawnRender;
  const browser = find();
  if (!browser) return { dom: '', renderer: 'none' };
  const budgetMs = opts.budgetMs || 2000;
  const isRoot = opts.isRoot || function() { try { return typeof process.getuid === 'function' && process.getuid() === 0; } catch (e) { return false; } };
  const mkProfile = opts.mkProfile || (function() { return require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'tt-smoke-')); });
  try {
    const profileDir = mkProfile();
    const args = ['--headless=new', '--disable-gpu', '--dump-dom', '--virtual-time-budget=' + budgetMs, '--user-data-dir=' + profileDir, '--disable-background-networking', '--no-first-run', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-default-browser-check', '--disable-extensions', '--mute-audio'];
    if (isRoot()) args.push('--no-sandbox');
    args.push(url);
    const out = spawn(browser, args);
    if (out && typeof out === 'object' && out.timedOut) { return { dom: '', renderer: 'timeout' }; }
    return { dom: out, renderer: 'browser' };
  } catch (e) { return { dom: '', renderer: 'render-error' }; }
}

function smokeVerify(url, markers, opts) {
  if (opts === undefined) opts = {};
  const render = opts.renderer || function(u) { return renderDom(u, opts); };
  const r = render(url);
  const e = evaluateMarkers(r.dom, markers);
  const UNOBSERVED = ['none', 'timeout', 'refused-nonloopback', 'render-error'];
  const verdict = UNOBSERVED.includes(r.renderer) ? 'concerns' : e.verdict;
  return { present: e.present, missing: e.missing, verdict, renderer: r.renderer };
}

module.exports = { evaluateMarkers, findBrowser, renderDom, smokeVerify, spawnRender };

function main(argv) {
  const url = argv[0];
  const markers = argv.slice(1);
  const renderer = process.env.TT_SMOKE_FAKE_DOM
    ? () => ({ dom: process.env.TT_SMOKE_FAKE_DOM, renderer: 'browser' })
    : undefined;
  const result = smokeVerify(url, markers, { renderer });
  const headline = `smoke verdict=${result.verdict} renderer=${result.renderer} markers=${result.present.length}/${markers.length}`;
  if (process.env.TT_QA_EMIT === '1') {
    const tic = path.join(process.cwd(), '.claude', 'hooks', 'tic.sh');
    child_process.spawnSync(tic, ['qa-verifier', '*', 'verdict', headline, 'app', result.verdict], { cwd: process.cwd(), encoding: 'utf8' });
  }
  console.log(headline);
}

if (require.main === module) { main(process.argv.slice(2)); }
