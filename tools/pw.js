/*
 * Resolve Playwright, wherever this machine keeps it, and pin the browser.
 *
 * The browser specs need a real engine; how one is installed differs per machine
 * (a global playwright, a local playwright-core, a CI image with its own browsers).
 * Each spec used to hard-code one path, so a spec that ran for one person threw
 * MODULE_NOT_FOUND for the next. This looks in the usual places, in order, and says
 * plainly what to install when it finds nothing.
 *
 *   PW                  — an explicit module path, checked first.
 *   PW_CHROMIUM         — an explicit browser executable.
 */
'use strict';
const fs = require('fs');

const CANDIDATES = [
  process.env.PW,
  'playwright',
  'playwright-core',
  '/opt/node22/lib/node_modules/playwright',
].filter(Boolean);

// Playwright finds its own browsers when it downloaded them. Where the image ships
// one instead (PLAYWRIGHT_BROWSERS_PATH with a revision this build does not expect),
// the launch has to be told the path.
function chromium() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  var root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root) return null;
  var hit = null;
  try {
    fs.readdirSync(root)
      .filter(function (d) { return d.indexOf('chromium-') === 0; })
      .sort()
      .forEach(function (d) {
        var exe = root + '/' + d + '/chrome-linux/chrome';
        if (fs.existsSync(exe)) hit = exe;
      });
  } catch (e) { /* no such directory: let playwright decide */ }
  return hit;
}

function load() {
  var tried = [];
  for (var i = 0; i < CANDIDATES.length; i++) {
    try {
      return require(CANDIDATES[i]);
    } catch (e) {
      tried.push(CANDIDATES[i]);
    }
  }
  throw new Error(
    'Playwright not found (tried: ' + tried.join(', ') + ').\n' +
    'Install one, or point PW at it:\n' +
    '  npm i playwright-core && PW=playwright-core node <spec>');
}

var pw = load();
var exe = chromium();
if (exe) {
  var launch = pw.chromium.launch.bind(pw.chromium);
  pw.chromium.launch = function (opts) {
    opts = opts || {};
    // The caller's own args are added to, never replaced: a spec that passes any
    // args of its own would otherwise silently drop --no-sandbox and fail to
    // launch at all in a container.
    var args = ['--no-sandbox'].concat(opts.args || []);
    return launch(Object.assign({ executablePath: exe }, opts, { args: args }));
  };
}

module.exports = pw;
