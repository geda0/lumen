/*
 * Does `Lumen.color.parse` agree with the browser?
 *
 * Every colour this extension emits is derived from one it read, so a parser
 * that answers *wrongly* is worse than one that declines: declining falls
 * through to the canvas, or at worst to the repair pass, but a wrong answer is
 * confidently painted. `hsl(0.5turn 50% 50%)` is cyan; the fast path read the
 * hue with a bare parseFloat and called it 0.5deg, which is red.
 *
 * So each notation here is checked against what the browser actually paints,
 * and the contract is: agree, or return null. Only a real engine can referee
 * this, which is why it is a browser spec and not a unit test.
 *
 *   node tools/color-spec.js
 */
'use strict';
const { chromium } = require('./pw');
const fs = require('fs');
const path = require('path');

// How far a channel may drift from what the browser painted. Not zero: a
// translucent colour round-trips through a premultiplied backing store, so the
// channels quantise. Opaque colours are expected to be exact.
const SLACK = 2;
const SLACK_ALPHA = 6;

(async () => {
  const browser = await chromium.launch();
  let rows;
  try {
    const page = await browser.newPage();
    await page.setContent('<div>probe</div>');
    await page.addScriptTag({
      content: fs.readFileSync(path.join(__dirname, '../src/content/color.js'), 'utf8'),
    });

    rows = await page.evaluate(() => {
      const C = Lumen.color;
      // What the browser paints, which is the only authority here.
      const truth = (s) => {
        const ctx = new OffscreenCanvas(1, 1).getContext('2d');
        ctx.fillStyle = '#000000'; ctx.fillStyle = s; const a = ctx.fillStyle;
        ctx.fillStyle = '#ffffff'; ctx.fillStyle = s; const b = ctx.fillStyle;
        if (a !== b) return null;                 // not a colour at all
        ctx.globalCompositeOperation = 'copy';
        ctx.fillStyle = s;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      };

      const cases = [
        // the angle units, which the fast path used to read as bare degrees
        ['hsl, degrees', 'hsl(180deg 50% 50%)'],
        ['hsl, unitless', 'hsl(180 50% 50%)'],
        ['hsl, turns', 'hsl(0.5turn 50% 50%)'],
        ['hsl, radians', 'hsl(3.14159rad 50% 50%)'],
        ['hsl, gradians', 'hsl(200grad 50% 50%)'],
        // the modern spaces
        ['oklch', 'oklch(0.7 0.15 250)'],
        ['oklch, translucent', 'oklch(0.7 0.15 250 / 0.5)'],
        ['lab', 'lab(60% 20 -40)'],
        ['display-p3', 'color(display-p3 0.4 0.6 0.9)'],
        ['color-mix', 'color-mix(in oklab, oklch(1 0 0) 50%, oklch(0.4 0.1 250))'],
        ['relative colour', 'rgb(from #3366cc r g b)'],
        // the ordinary ones, which must not regress
        ['hex', '#3366cc'],
        ['rgb', 'rgb(51, 102, 204)'],
        ['rgba with alpha', 'rgba(51, 102, 204, 0.4)'],
        ['named', 'rebeccapurple'],
        ['hwb', 'hwb(220 20% 20%)'],
      ];

      const out = cases.map(([name, css]) => ({
        name, css, mine: C.parse(css), theirs: truth(css),
      }));

      // Things that are not colours must stay null however capable the parser
      // gets: these appear inside gradients and shadows, and resolving one to a
      // colour would corrupt the value it sits in.
      const notColours = ['solid', 'to right', 'inset', 'none', 'ease-in-out', '12px'];
      out.push(...notColours.map((css) => ({
        name: 'not a colour: ' + css, css, mine: C.parse(css), theirs: null,
      })));
      return out;
    });
  } finally {
    await browser.close();
  }

  let failed = 0;
  for (const r of rows) {
    let ok, detail;
    if (r.theirs === null) {
      ok = r.mine === null;
      detail = JSON.stringify(r.mine);
    } else if (r.mine === null) {
      // Declining is tolerated for a colour the browser understands: it falls
      // through to the repair pass rather than being painted wrong.
      ok = true;
      detail = 'declined (falls through)';
    } else {
      const near = (a, b, slack) => Math.abs(a - b) <= slack;
      ok = near(r.mine.r, r.theirs.r, SLACK) && near(r.mine.g, r.theirs.g, SLACK) &&
           near(r.mine.b, r.theirs.b, SLACK) &&
           near(r.mine.a * 255, r.theirs.a * 255, SLACK_ALPHA);
      detail = 'ours rgb(' + [r.mine.r, r.mine.g, r.mine.b].map(Math.round).join(',') +
               ') a=' + r.mine.a.toFixed(2) +
               '  browser rgb(' + [r.theirs.r, r.theirs.g, r.theirs.b].join(',') +
               ') a=' + r.theirs.a.toFixed(2);
    }
    if (!ok) failed++;
    console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + r.name.padEnd(22) + ' ' + detail);
  }

  console.log('\n' + (rows.length - failed) + '/' + rows.length +
              ' notations agree with the browser');
  process.exit(failed ? 1 : 0);
})();
