/*
 * Drives tools/fixture/tailwind.html in a real browser.
 *
 * The question is not "does the page end up dark" -- it always did, eventually.
 * It is "what does the FIRST paint look like", because a surface that only the
 * asynchronous repair pass can fix is light on screen until that pass lands, and
 * on a page that re-renders (a client-side route change, a re-mounting component)
 * it goes light again every time. That is what reads as a flicker.
 *
 * So each surface is read twice: once in the very task that switched the extension
 * on -- before any idle callback can have run -- and once after everything has
 * settled. The first read is the one that was failing.
 *
 *   node tools/flicker-spec.js        (needs tools/fixture/serve.py running)
 */
'use strict';
const { chromium } = require('./pw');

const URL = 'http://localhost:8123/tools/fixture/tailwind.html?lumen=1';

// A converted surface sits at the bottom of the lightness range; converted text
// sits near the top. Anything the other side of these is the unconverted page.
const DARK = 0.30;
const LIGHT = 0.55;

const IDS = ['card', 'title', 'muted', 'legacy', 'wash', 'unknown', 'brand'];

(async () => {
  const browser = await chromium.launch();
  const results = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction('window.__lumenReady === true');

    const readAll = (ids) => page.evaluate((list) => {
      const out = {};
      for (const id of list) {
        const cs = getComputedStyle(document.getElementById(id));
        out[id] = { bg: cs.backgroundColor, fg: cs.color, border: cs.borderTopColor };
      }
      return out;
    }, ids);

    // Switch on and read back inside ONE evaluate: no await between them, so the
    // browser has had no opportunity to run an idle callback. Whatever is dark here
    // was converted by the synchronous rule walker, not by the repair pass.
    const firstPaint = await page.evaluate((list) => {
      window.__lumenApply();
      const out = {};
      for (const id of list) {
        const cs = getComputedStyle(document.getElementById(id));
        out[id] = { bg: cs.backgroundColor, fg: cs.color, border: cs.borderTopColor };
      }
      return out;
    }, IDS);

    await page.waitForTimeout(2500);
    const settled = await readAll(IDS);

    const lum = (c) => page.evaluate((x) => window.__lum(x), c);
    const check = async (name, colour, test) => {
      const l = await lum(colour);
      results.push({
        name, ok: l !== null && test(l),
        got: colour + ' (l=' + (l === null ? '?' : l.toFixed(2)) + ')',
      });
    };

    // --- the flicker itself -------------------------------------------------
    await check('card surface is dark on the FIRST paint', firstPaint.card.bg, (l) => l < DARK);
    await check('legacy-syntax surface is dark on the FIRST paint', firstPaint.legacy.bg, (l) => l < DARK);
    await check('heading is light on the FIRST paint', firstPaint.title.fg, (l) => l > LIGHT);
    await check('muted text is light on the FIRST paint', firstPaint.muted.fg, (l) => l > LIGHT);

    // `border-color` carrying a var() is a shorthand CSSOM will not expand, so the
    // longhands the walker reads come back empty -- it has to ask for the shorthand
    // by name. A border sits in its own band: clearly lifted off the surface it
    // borders, well short of the text on it. Note the bounds are the border band,
    // not the surface one: a border landing at the surface threshold is correct.
    await check('the card border is converted on the FIRST paint too',
      firstPaint.card.border, (l) => l > 0.20 && l < 0.60);
    await check('and the border is still in its band once settled',
      settled.card.border, (l) => l > 0.20 && l < 0.60);

    // --- and it stays that way ----------------------------------------------
    await check('card surface is still dark once settled', settled.card.bg, (l) => l < DARK);
    await check('heading is still light once settled', settled.title.fg, (l) => l > LIGHT);

    // --- a translucent wash is a separator, not a surface --------------------
    // Converting a 10% white divider as though it were opaque makes it vanish.
    // Bounded on BOTH sides: a one-sided `l > DARK` would also be satisfied by the
    // wash never being converted at all and simply staying white.
    await check('a 10% white wash keeps enough lightness to still read',
      settled.wash.bg, (l) => l > DARK && l < LIGHT);

    // --- an unknowable alpha is still handled, just later --------------------
    // The walker declines it, so this one is the repair pass's job; what matters
    // is that it is dark by the time the page has settled, not that it was early.
    await check('an unreadable alpha still ends up dark, via the repair pass',
      settled.unknown.bg, (l) => l < DARK);

    // --- without flattening the page's own colour ---------------------------
    const brand = (settled.brand.fg.match(/[\d.]+/g) || []).map(Number);
    results.push({
      name: 'the brand colour is still blue, not greyed out',
      ok: brand.length >= 3 && brand[2] > brand[0] + 20,
      got: settled.brand.fg,
    });
  } finally {
    await browser.close();
  }

  for (const r of results) {
    console.log('  ' + (r.ok ? 'ok  ' : 'FAIL') + ' ' + r.name + '  -> ' + r.got);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length +
              ' first-paint assertions passed');
  process.exit(failed ? 1 : 0);
})();
