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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
