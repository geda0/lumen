/*
 * The whole suite, in one command.
 *
 *   node tools/run-suite.js             unit + browser
 *   node tools/run-suite.js --unit      the pure maths only (no browser needed)
 *   node tools/run-suite.js --browser   the specs that need a real engine
 *
 * The browser specs load the extension over http from the fixture server (one of the
 * fixtures deliberately serves a stylesheet cross-origin), so this starts the server,
 * waits for it to answer, and takes it down again whatever happens.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UNIT = ['tools/test.js'];
const BROWSER = ['tools/states-spec.js', 'tools/flicker-spec.js'];

const argv = process.argv.slice(2);
const only = argv.find((a) => a === '--unit' || a === '--browser');
const want = { unit: only !== '--browser', browser: only !== '--unit' };

function run(script) {
  process.stdout.write('\n=== ' + script + ' ===\n');
  const r = spawnSync(process.execPath, [script], { cwd: ROOT, stdio: 'inherit' });
  return r.status === 0;
}

/*
 * Wait for the fixture server -- and make sure it is OURS.
 *
 * serve.py binds a fixed port. If another checkout of this repo is already
 * serving on it, our spawn fails quietly, the poll below still gets an answer,
 * and the specs then run against someone else's working tree: a fixture added in
 * this one 404s and the failure looks like a bug in the extension. So the probe
 * asks for a file and checks the answer, rather than only that something replied.
 */
function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const probe = '/tools/fixture/tailwind.html';
  return new Promise((resolve, reject) => {
    (function poll() {
      http.get('http://127.0.0.1:8123' + probe, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        reject(new Error('port 8123 is served by a different checkout (' + probe +
          ' -> HTTP ' + res.statusCode + '). Stop that server and re-run.'));
      }).on('error', () => {
        if (Date.now() > deadline) return reject(new Error('fixture server did not start'));
        setTimeout(poll, 150);
      });
    })();
  });
}

(async () => {
  let ok = true;

  if (want.unit) {
    for (const s of UNIT) ok = run(s) && ok;
  }

  if (want.browser) {
    const server = spawn('python3', ['tools/fixture/serve.py'],
      { cwd: ROOT, stdio: 'ignore', detached: true });
    try {
      await waitForServer(15000);
      for (const s of BROWSER) ok = run(s) && ok;
    } catch (e) {
      process.stdout.write('\nFAIL  ' + e.message + '\n');
      ok = false;
    } finally {
      try { process.kill(-server.pid); } catch (e) { /* already gone */ }
    }
  }

  process.stdout.write('\n' + (ok ? 'SUITE GREEN' : 'SUITE RED') + '\n');
  process.exit(ok ? 0 : 1);
})();
