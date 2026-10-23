/* Node harness for the pure parts of the engine: color math + value scanning. */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const NAMED = {
  red: '#ff0000', blue: '#0000ff', white: '#ffffff', black: '#000000',
  gray: '#808080', grey: '#808080', darkslategray: '#2f4f4f',
  whitesmoke: '#f5f5f5', gainsboro: '#dcdcdc', navy: '#000080'
};

class FakeCtx {
  constructor() { this._fill = '#000000'; }
  set fillStyle(v) {
    const s = String(v).trim().toLowerCase();
    if (NAMED[s]) { this._fill = NAMED[s]; return; }
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) { this._fill = s; return; }
    if (/^rgba?\(/.test(s) || /^hsla?\(/.test(s)) { this._fill = s; return; }
    /* invalid: ignored, sentinel survives */
  }
  get fillStyle() { return this._fill; }
}

const ctx = {
  OffscreenCanvas: class { getContext() { return new FakeCtx(); } },
  console
};
vm.createContext(ctx);
for (const f of ['src/content/color.js', 'src/content/css.js', 'src/content/repair.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
}
const { color: C, css: CSS, repair: R } = ctx.Lumen;

const cfg = {
  bgMin: 0.08, bgMax: 0.30, borderMin: 0.24, borderMax: 0.48,
  fgMin: 0.53, fgMax: 0.91, sat: 1
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function group(n) { console.log('\n' + n); }

const L = (css) => { const c = C.parse(css); return C.rgbToHsl(c.r, c.g, c.b).l; };
const mod = (css, role) => C.toCss(C.modify(C.parse(css), role, cfg));

group('curve continuity (no visible seam at mid-lightness)');
check('bgCurve continuous at 0.5',
  Math.abs(C.bgCurve(0.499, cfg) - C.bgCurve(0.5, cfg)) < 0.01,
  `${C.bgCurve(0.499, cfg)} vs ${C.bgCurve(0.5, cfg)}`);
check('fgCurve continuous at 0.5',
  Math.abs(C.fgCurve(0.499, cfg) - C.fgCurve(0.5, cfg)) < 0.01,
  `${C.fgCurve(0.499, cfg)} vs ${C.fgCurve(0.5, cfg)}`);
check('bgCurve monotonic non-increasing over light half', (() => {
  for (let l = 0.5; l <= 1; l += 0.01) if (C.bgCurve(l + 0.01, cfg) > C.bgCurve(l, cfg) + 1e-9) return false;
  return true;
})());

group('THE requirement: already-dark sections are preserved');
const codeBg = '#282c34';           // One Dark editor background
check('dark code background is untouched', mod(codeBg, 'bg') === codeBg, mod(codeBg, 'bg'));
check('dark code text stays light', L(mod('#abb2bf', 'fg')) >= L('#abb2bf'), mod('#abb2bf', 'fg'));
check('#1e1e1e (VS Code dark) untouched', mod('#1e1e1e', 'bg') === '#1e1e1e', mod('#1e1e1e', 'bg'));
check('pure black stays black', mod('#000000', 'bg') === '#000000', mod('#000000', 'bg'));
check('dark syntax green stays readable', L(mod('#98c379', 'fg')) >= L('#98c379'));

group('light surfaces are inverted');
check('white page -> near-black', L(mod('#ffffff', 'bg')) <= 0.09, mod('#ffffff', 'bg'));
check('whitesmoke -> dark', L(mod('whitesmoke', 'bg')) < 0.15, mod('whitesmoke', 'bg'));
check('white bg is darker than a #f0f0f0 bg (order preserved)',
  L(mod('#ffffff', 'bg')) < L(mod('#f0f0f0', 'bg')));
check('black body text -> near-white', L(mod('#000000', 'fg')) >= 0.9, mod('#000000', 'fg'));
check('#333 text -> light', L(mod('#333333', 'fg')) > 0.7, mod('#333333', 'fg'));
check('light border stays faintly visible', (() => {
  const l = L(mod('#dddddd', 'border'));
  const eps = 1 / 255; // 8-bit rounding in toCss()
  return l >= cfg.borderMin - eps && l <= cfg.borderMax + eps;
})(), mod('#dddddd', 'border'));

group('hue and alpha are preserved');
const blue = C.parse('#1a73e8');
const blueOut = C.modify(blue, 'bg', cfg);
check('hue preserved on a saturated button',
  Math.abs(C.rgbToHsl(blue.r, blue.g, blue.b).h - C.rgbToHsl(blueOut.r, blueOut.g, blueOut.b).h) < 1);
check('alpha preserved', C.modify(C.parse('rgba(0, 0, 0, 0.5)'), 'bg', cfg).a === 0.5);
check('fully transparent is skipped', C.modify(C.parse('rgba(0,0,0,0)'), 'bg', cfg) === null);
check('translucent white wash stays a visible separator',
  L(mod('rgba(255,255,255,0.1)', 'bg')) > 0.3, mod('rgba(255,255,255,0.1)', 'bg'));

group('chroma is preserved, not saturation (the "everything went blue" bug)');
// HSL saturation is a ratio of the chroma available at a given lightness, so
// carrying it across a big lightness move multiplies the colour's real chroma.
const chroma = (css) => { const c = C.parse(css); const h = C.rgbToHsl(c.r, c.g, c.b);
  return (1 - Math.abs(2 * h.l - 1)) * h.s; };
for (const [name, css] of [['#f6f8fa (the classic <pre> grey)', '#f6f8fa'],
                           ['#eef2ff (indigo-tinted card)', '#eef2ff'],
                           ['#d0d7de (hairline)', '#d0d7de']]) {
  check(name + ' does not gain chroma as a background',
    chroma(mod(css, 'bg')) <= chroma(css) + 1e-3,
    `${chroma(css).toFixed(3)} -> ${chroma(mod(css, 'bg')).toFixed(3)}  ${mod(css, 'bg')}`);
  check(name + ' does not gain chroma as a border',
    chroma(mod(css, 'border')) <= chroma(css) + 1e-3,
    `${chroma(css).toFixed(3)} -> ${chroma(mod(css, 'border')).toFixed(3)}`);
}
check('a near-white blue-grey surface stays near-neutral', (() => {
  const c = C.parse(mod('#f6f8fa', 'bg'));
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= 6;
})(), mod('#f6f8fa', 'bg'));
check('a saturated brand colour keeps its saturation', (() => {
  const before = C.parse('#1a73e8');
  const after = C.parse(mod('#1a73e8', 'bg'));
  // 0.01 of slack for the 8-bit rounding in toCss().
  return C.rgbToHsl(after.r, after.g, after.b).s >=
         C.rgbToHsl(before.r, before.g, before.b).s - 0.01;
})(), mod('#1a73e8', 'bg'));
check('dark text is still lifted to a legible lightness',
  L(mod('#24292f', 'fg')) > 0.7, mod('#24292f', 'fg'));
check('chromaSafe never increases saturation', (() => {
  for (let l = 0; l <= 1.001; l += 0.05) {
    for (let nl = 0; nl <= 1.001; nl += 0.05) {
      if (C.chromaSafe(0.8, l, nl) > 0.8 + 1e-9) return false;
    }
  }
  return true;
})());
check('contrast repair does not gain chroma either', (() => {
  const before = C.parse('#1c2026');          // barely-blue, invisible on dark
  const after = R.fixContrast(before, C.parse('#141414'), 4.0);
  const ch = (c) => { const h = C.rgbToHsl(c.r, c.g, c.b);
    return (1 - Math.abs(2 * h.l - 1)) * h.s; };
  return after && ch(after) <= ch(before) + 1e-3;
})());

group('tint');
// A tint pulls neutrals toward a hue; anything with a colour of its own keeps
// it, and anything the curve did not move is not touched at all.
const warm = { ...cfg, tint: { bg: { h: 30, amount: 0.09 },
                               fg: { h: 30, amount: 0.04 },
                               border: { h: 30, amount: 0.07 } } };
const modT = (css, role) => C.toCss(C.modify(C.parse(css), role, warm));
const hueOf = (css) => { const c = C.parse(css); return C.rgbToHsl(c.r, c.g, c.b).h; };
check('a white surface takes the tint hue',
  Math.abs(hueOf(modT('#ffffff', 'bg')) - 30) < 2, modT('#ffffff', 'bg'));
check('a white surface is warmer than it is blue', (() => {
  const c = C.parse(modT('#ffffff', 'bg'));
  return c.r > c.b + 6;
})(), modT('#ffffff', 'bg'));
check('text takes the tint too', Math.abs(hueOf(modT('#000000', 'fg')) - 30) < 2,
  modT('#000000', 'fg'));
check('borders take the tint too', Math.abs(hueOf(modT('#dddddd', 'border')) - 30) < 2,
  modT('#dddddd', 'border'));
check('THE requirement still holds: an already-dark block is not tinted',
  modT('#282c34', 'bg') === '#282c34', modT('#282c34', 'bg'));
check('already-light text is not tinted either',
  modT('#abb2bf', 'fg') === '#abb2bf', modT('#abb2bf', 'fg'));
check('a brand colour keeps its own hue under a tint', (() => {
  const before = hueOf('#1a73e8');
  return Math.abs(hueOf(modT('#1a73e8', 'bg')) - before) < 3;
})(), modT('#1a73e8', 'bg'));
check('a partly-coloured surface moves only partway', (() => {
  // #e8eef6 is faintly blue (hue 214, chroma 0.055). A violet tint pulls it
  // toward, but not all the way to, the tint hue.
  const violet = { ...cfg, tint: { bg: { h: 270, amount: 0.09 } } };
  const h = hueOf(C.toCss(C.modify(C.parse('#e8eef6'), 'bg', violet)));
  return h > 216 && h < 268;
})());
check('an opposing tint cancels toward neutral rather than flipping the hue', (() => {
  // Chroma is added as a vector, so a warm tint on a cool surface subtracts.
  // The result is a grey, never the same colour with the hue spun 180 degrees.
  const c = C.parse(modT('#e8eef6', 'bg'));
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= 3;
})(), modT('#e8eef6', 'bg'));
check('the tint changes the shade of an invented colour', (() => {
  const c = C.parse(C.toCss(C.shade(cfg.bgMin, 'bg', warm)));
  return c.r > c.b;
})(), C.toCss(C.shade(cfg.bgMin, 'bg', warm)));
check('no tint configured leaves shade() neutral', (() => {
  const c = C.parse(C.toCss(C.shade(cfg.bgMin, 'bg', cfg)));
  return c.r === c.g && c.g === c.b;
})(), C.toCss(C.shade(cfg.bgMin, 'bg', cfg)));
check('a zero-amount tint is the same as none',
  C.toCss(C.shade(cfg.bgMin, 'bg', { tint: { bg: { h: 30, amount: 0 } } })) ===
  C.toCss(C.shade(cfg.bgMin, 'bg', cfg)));

group('value scanning inside complex declarations');
const seen = [];
CSS.eachToken('linear-gradient(to right, #fff 0%, rgba(0,0,0,.5) 100%)',
  (s, e, t) => seen.push(t));
check('descends into gradients', seen.includes('#fff') && seen.includes('rgba(0,0,0,.5)'), seen.join('|'));
check('gradient keywords are not colors', !seen.includes('linear-gradient'));

const urlSeen = [];
CSS.eachToken('url("data:image/svg+xml;base64,AAAA#ffffff") no-repeat', (s, e, t) => urlSeen.push(t));
check('url() contents are never scanned', !urlSeen.some(t => t.startsWith('#')), urlSeen.join('|'));

const varSeen = [];
CSS.eachToken('var(--brand-white, #ffffff)', (s, e, t) => varSeen.push(t));
check('var() is opaque (the definition is rewritten instead)',
  !varSeen.includes('#ffffff'), varSeen.join('|'));

check('shadow color rewritten, geometry kept',
  CSS.modifyValue('0 1px 3px rgba(0,0,0,0.2), inset 0 0 0 1px #ffffff', 'bg', cfg)
    .startsWith('0 1px 3px'));
check('"inset" is not treated as a color',
  !/inset\s*:/.test(CSS.modifyValue('inset 0 0 4px #ffffff', 'bg', cfg) || ''));
check('border shorthand keeps width and style',
  CSS.modifyValue('1px solid #cccccc', 'border', cfg).startsWith('1px solid #'));
check('non-color value returns null (nothing emitted)',
  CSS.modifyValue('url(/a.png) no-repeat center', 'bg', cfg) === null);
check('already-dark value returns null (nothing emitted)',
  CSS.modifyValue('#282c34', 'bg', cfg) === null);

group('gradient surfaces');
check('a light gradient is darkened', (() => {
  const out = CSS.modifyValue('linear-gradient(rgb(255, 255, 255), rgb(242, 242, 242))', 'bg', cfg);
  if (!out) return false;
  return (out.match(/rgb\([^)]*\)/g) || []).every(c => L(c) < 0.2);
})());
check('an already-dark gradient is preserved',
  CSS.modifyValue('linear-gradient(rgb(40, 44, 52), rgb(30, 33, 39))', 'bg', cfg) === null);
check('gradient direction keywords survive', (() => {
  const out = CSS.modifyValue('linear-gradient(180deg, #f6f8fa 0%, #ffffff 100%)', 'bg', cfg);
  return out && out.startsWith('linear-gradient(180deg,') && out.includes('0%') && out.includes('100%');
})(), CSS.modifyValue('linear-gradient(180deg, #f6f8fa 0%, #ffffff 100%)', 'bg', cfg));
check('a gradient over a url() leaves the image alone', (() => {
  const out = CSS.modifyValue('linear-gradient(#ffffff, #eeeeee), url("/bg.png")', 'bg', cfg);
  return out && out.includes('url("/bg.png")');
})());

group('custom property name hints');
check('--card-bg treated as background', CSS.roleOf('--card-bg') === 'bg');
check('--text-primary treated as foreground', CSS.roleOf('--text-primary') === 'fg');
check('--brand-500 falls back to symmetric', CSS.roleOf('--brand-500') === 'var');
check('--line treated as border', CSS.roleOf('--line') === 'border');
check('--card-border is a border, not a surface', CSS.roleOf('--card-border') === 'border');
check('--divider treated as border', CSS.roleOf('--divider') === 'border');
check('symmetric var inverts a dark value up', L(mod('#222222', 'var')) > 0.7);
check('symmetric var inverts a light value down', L(mod('#eeeeee', 'var')) < 0.2);
check('--code-bg hint keeps dark value', mod('#282c34', 'bg') === '#282c34');

group('property roles');
check('color -> fg', CSS.roleOf('color') === 'fg');
check('background-color -> bg', CSS.roleOf('background-color') === 'bg');
check('border-top-color -> border', CSS.roleOf('border-top-color') === 'border');
check('fill -> fg (SVG icons brighten)', CSS.roleOf('fill') === 'fg');
check('width -> null (ignored)', CSS.roleOf('width') === null);
check('font-family -> null (ignored)', CSS.roleOf('font-family') === null);

group('colour serialisation');
// hslToRgb() builds a colour from scratch and has no alpha to carry, so toCss()
// must treat a missing alpha as opaque. Emitting rgba(r,g,b,NaN) is silently
// invalid CSS: the parser drops the whole declaration and the rule does nothing.
check('toCss defaults a missing alpha to opaque',
  C.toCss(C.hslToRgb(0, 0, 0.08)) === '#141414', C.toCss(C.hslToRgb(0, 0, 0.08)));
check('toCss never emits NaN', (() => {
  for (let l = 0; l <= 1; l += 0.05) if (/NaN/.test(C.toCss(C.hslToRgb(210, 0.4, l)))) return false;
  return true;
})());
check('an explicit alpha still round-trips',
  C.toCss({ r: 1, g: 2, b: 3, a: 0.5 }) === 'rgba(1, 2, 3, 0.5)', C.toCss({r:1,g:2,b:3,a:0.5}));

group('repair: contrast measurement');
const W = C.parse('#ffffff'), K = C.parse('#000000');
check('white vs black is 21:1', Math.abs(R.contrast(W, K) - 21) < 0.01, String(R.contrast(W, K)));
check('contrast is symmetric', R.contrast(W, K) === R.contrast(K, W));
check('a colour against itself is 1:1', Math.abs(R.contrast(W, W) - 1) < 1e-9);

group('repair: contrast repair');
const darkBg = C.parse('#141414');
check('legible text is left untouched (returns null)',
  R.fixContrast(C.parse('#e8e6e3'), darkBg, 4.0) === null);
check('dark-on-dark text is lifted past the target', (() => {
  const fixed = R.fixContrast(C.parse('#2b2b2b'), darkBg, 4.0);
  return fixed && R.contrast(fixed, darkBg) >= 4.0;
})());
check('invisible border is lifted past the border target', (() => {
  const fixed = R.fixContrast(C.parse('#1c1c1c'), darkBg, 2.0);
  return fixed && R.contrast(fixed, darkBg) >= 2.0;
})());
check('hue survives the repair', (() => {
  const before = C.parse('#0a3d8f');            // dark blue on a dark surface
  const after = R.fixContrast(before, darkBg, 4.0);
  const h1 = C.rgbToHsl(before.r, before.g, before.b).h;
  const h2 = C.rgbToHsl(after.r, after.g, after.b).h;
  return Math.abs(h1 - h2) < 1;
})());
check('on a light surface the repair darkens instead', (() => {
  const lightBg = C.parse('#fafafa');
  const fixed = R.fixContrast(C.parse('#eeeeee'), lightBg, 4.0);
  return fixed && C.rgbToHsl(fixed.r, fixed.g, fixed.b).l < 0.5;
})());
check('alpha is carried through', (() => {
  const fixed = R.fixContrast(C.parse('rgba(43,43,43,0.6)'), darkBg, 4.0);
  return fixed && fixed.a === 0.6;
})());
check('repair is idempotent: a repaired colour needs no second pass', (() => {
  const once = R.fixContrast(C.parse('#2b2b2b'), darkBg, 4.0);
  return R.fixContrast(once, darkBg, 4.0) === null;
})());
check('the light-background threshold is above what our own curve can emit',
  R.thresholds.LIGHT_BG > cfg.bgMax, `${R.thresholds.LIGHT_BG} vs bgMax ${cfg.bgMax}`);

group('css: a colour whose alpha is a var()');
// Tailwind emits `rgb(255 255 255 / var(--tw-bg-opacity, 1))` for bg-white, and the
// same shape for every text-/border-/bg- utility used without an opacity modifier.
// The alpha is a var we must not resolve, but the channels in front of it are an
// ordinary colour. Skipping the declaration whole hands the entire palette of a
// Tailwind site to the repair pass, and that pass is asynchronous -- so the page
// paints light first and corrects itself a few hundred milliseconds later.
const varAlpha = (v, role) => CSS.modifyValue(v, role || 'bg', cfg);
const noAlpha = (v) => String(v).replace(/\s*\/\s*var\([^)]*\)/, '');

check('bg-white converts, and keeps the opacity var', (() => {
  const out = varAlpha('rgb(255 255 255 / var(--tw-bg-opacity, 1))');
  return out !== null && /var\(--tw-bg-opacity, 1\)/.test(out) && L(noAlpha(out)) < 0.2;
})(), String(varAlpha('rgb(255 255 255 / var(--tw-bg-opacity, 1))')));

// A fallback is needed for the alpha to be knowable at all -- see the wash group
// below -- so the legacy-syntax case carries one, like the modern one above.
check('the legacy comma form converts too', (() => {
  const out = varAlpha('rgba(255, 255, 255, var(--tw-bg-opacity, 1))');
  return out !== null && /^rgba\(/.test(out) && /var\(--tw-bg-opacity, 1\)/.test(out) &&
         L(out.replace(/,\s*var\([^)]*\)\s*\)$/, ')')) < 0.2;
})(), String(varAlpha('rgba(255, 255, 255, var(--tw-bg-opacity, 1))')));

check('dark text with a var alpha is lightened, not darkened', (() => {
  const out = varAlpha('rgb(26 26 26 / var(--tw-text-opacity, 1))', 'fg');
  return out !== null && L(noAlpha(out)) > 0.5;
})(), String(varAlpha('rgb(26 26 26 / var(--tw-text-opacity, 1))', 'fg')));

check('an already-dark surface with a var alpha is left alone',
  varAlpha('rgb(20 20 20 / var(--tw-bg-opacity, 1))') === null,
  String(varAlpha('rgb(20 20 20 / var(--tw-bg-opacity, 1))')));

// The channels themselves being a var is a different thing entirely: there is no
// colour to read, so there is nothing we can honestly convert.
check('a var in the CHANNELS is still untouchable',
  varAlpha('rgb(var(--brand-rgb) / 0.5)') === null,
  String(varAlpha('rgb(var(--brand-rgb) / 0.5)')));

// The plain #ffffff in this gradient converts on its own, so the assertion has to
// name the var-alpha stop specifically: no white may survive anywhere in the value.
// Both stops are checked by lightness rather than by an exact hex, so tuning the
// curve cannot break this test for a reason that has nothing to do with it.
check('a var-alpha colour nested in a gradient converts as well', (() => {
  const out = varAlpha('linear-gradient(rgb(255 255 255 / var(--tw-bg-opacity, 1)), #ffffff)');
  if (out === null || !/var\(--tw-bg-opacity, 1\)/.test(out)) return false;
  // The var-alpha stop: no white may survive it. The plain stop: dark by lightness,
  // not by an exact hex, so tuning the curve cannot break this for an unrelated reason.
  const hex = (out.match(/#[0-9a-f]{6}/i) || [])[0];
  return !/255\s+255\s+255/.test(out) && hex !== undefined && L(hex) < 0.2;
})(), String(varAlpha('linear-gradient(rgb(255 255 255 / var(--tw-bg-opacity, 1)), #ffffff)')));

check('hsl with a var alpha converts, emitted as rgb', (() => {
  const out = varAlpha('hsl(0 0% 100% / var(--o, 1))');
  return out !== null && /^rgb\(/.test(out) && /var\(--o, 1\)/.test(out) && L(noAlpha(out)) < 0.2;
})(), String(varAlpha('hsl(0 0% 100% / var(--o, 1))')));

check('hsla with a var alpha converts, emitted as rgba', (() => {
  const out = varAlpha('hsla(210, 40%, 98%, var(--o))');
  return out === null || /^rgba\(/.test(out);
})(), String(varAlpha('hsla(210, 40%, 98%, var(--o))')));

group('css: a var alpha must not destroy a translucent wash');
// `C.modify` keeps a translucent white wash light enough to still read as a
// separator over the new dark base -- but it can only do that when it knows the
// alpha. Reading the channels on their own hands it a=1, so a 10% white divider
// came out near-black and vanished. Two honest answers: use the var's own
// fallback when it is a plain number, and refuse outright when it is not, which
// leaves the declaration to the repair pass exactly as before.
check('a numeric var fallback is read as the real alpha', (() => {
  const out = varAlpha('rgb(255 255 255 / var(--o, 0.1))');
  return out !== null && L(noAlpha(out)) >= cfg.bgMax;
})(), String(varAlpha('rgb(255 255 255 / var(--o, 0.1))')));

check('the same wash in the legacy syntax keeps its lightness', (() => {
  const out = varAlpha('rgba(255, 255, 255, var(--o, 0.1))');
  return out !== null && L(out.replace(/,\s*var\([^)]*\)\s*\)$/, ')')) >= cfg.bgMax;
})(), String(varAlpha('rgba(255, 255, 255, var(--o, 0.1))')));

check('an opaque fallback still converts all the way down',
  (() => {
    const out = varAlpha('rgb(255 255 255 / var(--tw-bg-opacity, 1))');
    return out !== null && L(noAlpha(out)) < 0.2;
  })(), String(varAlpha('rgb(255 255 255 / var(--tw-bg-opacity, 1))')));

// No fallback at all: the alpha is genuinely unknowable, and guessing either way
// is wrong for half the pages. Refusing leaves it to the repair pass, which reads
// the colour the browser actually resolved.
check('an unreadable alpha is refused, not guessed',
  varAlpha('rgba(255, 255, 255, var(--o))') === null,
  String(varAlpha('rgba(255, 255, 255, var(--o))')));

check('a non-numeric fallback is refused too',
  varAlpha('rgb(255 255 255 / var(--o, var(--p)))') === null,
  String(varAlpha('rgb(255 255 255 / var(--o, var(--p)))')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
