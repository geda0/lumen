/*
 * Lumen — color parsing and luminance inversion.
 *
 * The whole point of this extension lives in this file. A naive dark mode does
 * `filter: invert(1)` on the page, which flips *everything* — including sections
 * that were already dark (code blocks, dark hero banners, dark navbars) and every
 * image. We instead convert each individual color to HSL and run it through an
 * asymmetric curve: light colors are pushed down into the dark range, colors that
 * are already dark are left where they are.
 */

var Lumen = (typeof Lumen === 'object' && Lumen) || {};

Lumen.color = (function () {
  'use strict';

  // --- parsing -------------------------------------------------------------

  var HEX = /^#([0-9a-f]{3,8})$/i;
  var FN = /^(rgba?|hsla?)\(([^)]*)\)$/i;

  var cache = new Map();
  var ctx = null;

  /**
   * Normalize any CSS color string via the canvas 2D parser. This gets us named
   * colors, `hwb()`, `lab()`, `oklch()`, `color(display-p3 ...)` etc. for free,
   * and — critically — tells us when a token is *not* a color at all, which is
   * how we skip things like `solid`, `inset` or `to right` inside a gradient.
   *
   * Returns a normalized string, or null when the token is not a valid color.
   */
  function normalize(str) {
    if (ctx === null) {
      try {
        ctx = new OffscreenCanvas(1, 1).getContext('2d');
      } catch (e) {
        ctx = false;
      }
    }
    if (!ctx) return null;
    // Set two different sentinels first. An invalid assignment is ignored by the
    // canvas, so the sentinel survives and the two reads disagree.
    ctx.fillStyle = '#000000';
    ctx.fillStyle = str;
    var a = ctx.fillStyle;
    ctx.fillStyle = '#ffffff';
    ctx.fillStyle = str;
    var b = ctx.fillStyle;
    return a === b ? a : null;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function parseHex(hex) {
    var n = hex.length;
    var r, g, b, a = 1;
    if (n === 3 || n === 4) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
      if (n === 4) a = parseInt(hex[3] + hex[3], 16) / 255;
    } else if (n === 6 || n === 8) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      if (n === 8) a = parseInt(hex.slice(6, 8), 16) / 255;
    } else {
      return null;
    }
    return { r: r, g: g, b: b, a: a };
  }

  /** Parse a CSS color token into {r,g,b,a}, or null if it isn't a color. */
  function parse(str) {
    if (typeof str !== 'string') return null;
    var key = str;
    if (cache.has(key)) return cache.get(key);

    var out = null;
    var s = str.trim();
    var m;

    if ((m = HEX.exec(s))) {
      out = parseHex(m[1]);
    } else if ((m = FN.exec(s))) {
      out = parseFn(m[1].toLowerCase(), m[2]);
    }

    if (!out) {
      // Slow path: let the browser tell us. Also filters out non-colors.
      var norm = normalize(s);
      if (norm) {
        if ((m = HEX.exec(norm))) out = parseHex(m[1]);
        else if ((m = FN.exec(norm))) out = parseFn(m[1].toLowerCase(), m[2]);
      }
    }

    if (cache.size > 8000) cache.clear();
    cache.set(key, out);
    return out;
  }

  function parseFn(name, body) {
    var parts = body.split(/[\s,\/]+/).filter(function (p) { return p !== ''; });
    if (parts.length < 3) return null;
    var a = parts.length > 3 ? alphaOf(parts[3]) : 1;
    if (a === null) return null;

    if (name === 'rgb' || name === 'rgba') {
      var c = parts.slice(0, 3).map(function (p) {
        return p.endsWith('%')
          ? clamp(parseFloat(p) * 2.55, 0, 255)
          : clamp(parseFloat(p), 0, 255);
      });
      if (c.some(isNaN)) return null;
      return { r: c[0], g: c[1], b: c[2], a: a };
    }

    var h = parseFloat(parts[0]);
    var sat = parseFloat(parts[1]) / 100;
    var lig = parseFloat(parts[2]) / 100;
    if (isNaN(h) || isNaN(sat) || isNaN(lig)) return null;
    var rgb = hslToRgb(h, clamp(sat, 0, 1), clamp(lig, 0, 1));
    rgb.a = a;
    return rgb;
  }

  function alphaOf(p) {
    if (p === undefined) return 1;
    var v = p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p);
    return isNaN(v) ? null : clamp(v, 0, 1);
  }

  // --- HSL conversion ------------------------------------------------------

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var h = 0;
    var s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var rgb;
    if (h < 60) rgb = [c, x, 0];
    else if (h < 120) rgb = [x, c, 0];
    else if (h < 180) rgb = [0, c, x];
    else if (h < 240) rgb = [0, x, c];
    else if (h < 300) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    return {
      r: Math.round((rgb[0] + m) * 255),
      g: Math.round((rgb[1] + m) * 255),
      b: Math.round((rgb[2] + m) * 255)
    };
  }

  function toCss(rgb) {
    var r = Math.round(clamp(rgb.r, 0, 255));
    var g = Math.round(clamp(rgb.g, 0, 255));
    var b = Math.round(clamp(rgb.b, 0, 255));
    // hslToRgb() builds a colour with no alpha to carry, so treat a missing one
    // as opaque. Without this the rgba() branch below serialises NaN, which is
    // invalid CSS -- the parser drops the declaration and the rule silently
    // does nothing.
    var a = (rgb.a === undefined || rgb.a === null || rgb.a !== rgb.a) ? 1 : rgb.a;
    if (a >= 1) {
      return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + Math.round(a * 1000) / 1000 + ')';
  }

  // --- the inversion curves ------------------------------------------------
  //
  // `l` is HSL lightness in 0..1. Both curves are continuous at l = 0.5, so
  // there is no visible seam where a page's colors happen to sit mid-range.

  /**
   * Backgrounds. Light backgrounds are folded down into [bgMin, bgMax]; anything
   * already at or below mid-lightness is *kept as-is* (only capped at bgMax).
   * This is what preserves a dark code block, a dark navbar or a dark hero image
   * overlay — they were already comfortable to look at, so we don't touch them.
   */
  function bgCurve(l, cfg) {
    if (l >= 0.5) return cfg.bgMin + (1 - l) * 2 * (cfg.bgMax - cfg.bgMin);
    return Math.min(l, cfg.bgMax);
  }

  /**
   * Foregrounds. Dark text is lifted into [fgMin, fgMax]; text that is already
   * light stays light (it was presumably sitting on one of those dark sections
   * we just preserved, and flipping it would destroy the contrast).
   */
  function fgCurve(l, cfg) {
    if (l <= 0.5) return cfg.fgMax - l * 2 * (cfg.fgMax - cfg.fgMin);
    return Math.max(l, cfg.fgMin);
  }

  /**
   * Convert one color for a given role.
   *   'fg'     text, icons, SVG fill/stroke
   *   'bg'     backgrounds, gradients, shadows
   *   'border' borders and outlines (clamped so they stay faintly visible)
   *   'var'    custom property with no usable name hint — symmetric inversion,
   *            because a variable holding a dark value is more often text than
   *            background, and invisible text is worse than a lightened panel.
   */
  function modify(rgb, kind, cfg) {
    if (!rgb || rgb.a === 0) return null;
    var hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    var l = hsl.l;
    var nl;

    if (kind === 'fg') {
      nl = fgCurve(l, cfg);
    } else if (kind === 'border') {
      nl = clamp(bgCurve(l, cfg), cfg.borderMin, cfg.borderMax);
    } else if (kind === 'var') {
      nl = l >= 0.5 ? bgCurve(l, cfg) : fgCurve(l, cfg);
    } else {
      nl = bgCurve(l, cfg);
      // A translucent white wash is a separator, not a surface. Keep enough
      // lightness that it still reads as a separator over the new dark base.
      if (rgb.a < 0.5 && l >= 0.5) nl = Math.max(nl, cfg.bgMax + 0.05);
    }

    var ns = clamp(hsl.s * cfg.sat, 0, 1);
    var out = hslToRgb(hsl.h, ns, clamp(nl, 0, 1));
    out.a = rgb.a;
    return out;
  }

  return {
    parse: parse,
    toCss: toCss,
    rgbToHsl: rgbToHsl,
    hslToRgb: hslToRgb,
    modify: modify,
    bgCurve: bgCurve,
    fgCurve: fgCurve,
    clamp: clamp
  };
})();
