/*
 * Drives tools/fixture/states.html in a real browser.
 *
 * Interaction states cannot be judged from the CSSOM: the only honest question
 * is what the pixel is while the pointer is actually on the element, so this
 * hovers, focuses and presses each surface for real and reads the computed
 * colour in that state.
 *
 *   node tools/states-spec.js            (needs tools/fixture/serve.py running)
 */
'use strict';
const { chromium } = require(process.env.PW || '/opt/node22/lib/node_modules/playwright');

const URL = 'http://localhost:8123/tools/fixture/states.html?lumen=1';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction('window.__lumenReady === true');
  await page.waitForTimeout(1200);   // let the idle repair pass finish

  const samples = [];

  const rest = (id) => page.evaluate((i) => window.__bg(i), id);
  const restFg = (id) => page.evaluate((i) => window.__fg(i), id);

  // --- hover ---------------------------------------------------------------
  for (const [name, id, mustMove] of [
    ['A1 unreachable row, hover background', 'u-row', true],
    ['A2 unreachable button, hover background', 'u-btn', true],
    ['B1 readable row, hover background', 'r-row', true],
    ['B2 readable button, hover background', 'r-btn', true]
  ]) {
    const before = await rest(id);
    await page.hover('#' + id);
    await page.waitForTimeout(60);
    const after = await rest(id);
    samples.push({ name, rest: before, state: after, mustMove });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(60);
  }

  // Text colour under hover, on a row whose hover colour we never saw.
  {
    const before = await restFg('u-row');
    await page.hover('#u-row');
    await page.waitForTimeout(60);
    samples.push({ name: 'A3 unreachable row, hover text', rest: before,
                   state: await restFg('u-row'), mustMove: true, kind: 'fg' });
    await page.mouse.move(0, 0);
  }

  // A descendant restyled by an ancestor's hover (`.state-list:hover .cell`).
  {
    const before = await rest('u-cell');
    await page.hover('#u-list');
    await page.waitForTimeout(60);
    samples.push({ name: 'A4 cell under an ancestor hover', rest: before,
                   state: await rest('u-cell'), mustMove: true });
    await page.mouse.move(0, 0);
  }

  // --- focus ---------------------------------------------------------------
  {
    const before = await rest('u-field');
    await page.focus('#u-field');
    await page.waitForTimeout(60);
    samples.push({ name: 'A5 unreachable field, focus background', rest: before,
                   state: await rest('u-field'), mustMove: false });
    await page.evaluate(() => document.activeElement.blur());
  }

  // --- active --------------------------------------------------------------
  {
    const before = await rest('u-btn');
    const box = await page.locator('#u-btn').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(120);
    samples.push({ name: 'A6 unreachable button, pressed background', rest: before,
                   state: await rest('u-btn'), mustMove: true });
    await page.mouse.up();
    await page.mouse.move(0, 0);
  }

  // --- class-driven selection ---------------------------------------------
  for (const [name, id] of [['A7 unreachable row, .selected', 'u-row'],
                            ['B3 readable row, .selected', 'r-row']]) {
    const before = await rest(id);
    await page.evaluate((i) => window.toggleSelected(i), id);
    await page.waitForTimeout(400);   // the restyle queue is batched
    samples.push({ name, rest: before, state: await rest(id), mustMove: true });
    await page.evaluate((i) => window.toggleSelected(i), id);
    await page.waitForTimeout(300);
  }

  const report = await page.evaluate((s) => window.judge(s), samples);
  const selection = await page.evaluate(
    () => /::selection/.test((document.getElementById('lumen-core') || {}).textContent || ''));

  for (const s of samples) console.log('  ' + s.name + ': ' + s.rest + ' -> ' + s.state);
  console.log('');
  for (const f of report.failures) console.log('  FAIL ' + f.name + '  -> ' + f.got);
  console.log(`\n${report.passed}/${report.total} state assertions passed` +
              (selection ? ', ::selection rule present' : ', ::SELECTION RULE MISSING'));

  await browser.close();
  process.exit(report.failed || !selection ? 1 : 0);
})();
