/*
 * Lumen — CSS analysis.
 *
 * Classifies declarations by role, finds color tokens inside arbitrary values
 * (gradients, shadows, `color-mix()`, shorthands) and rewrites them.
 */

var Lumen = (typeof Lumen === 'object' && Lumen) || {};

Lumen.css = (function () {
  'use strict';

  var C = Lumen.color;

  // --- property roles ------------------------------------------------------

  var FG = new Set([
    'color', '-webkit-text-fill-color', '-webkit-text-stroke-color',
    'caret-color', 'text-decoration-color', 'text-emphasis-color',
    'column-rule-color', 'fill', 'stroke', 'stop-color', 'flood-color',
    'lighting-color'
  ]);

  var BG = new Set([
    'background', 'background-color', 'background-image',
    'box-shadow', '-webkit-box-shadow', 'text-shadow', 'mask-image'
  ]);

  var BORDER = new Set([
    'border-color', 'border-top-color', 'border-right-color',
    'border-bottom-color', 'border-left-color',
    'border-block-start-color', 'border-block-end-color',
    'border-inline-start-color', 'border-inline-end-color',
    'outline-color'
  ]);

  // Names that tell us how a custom property is meant to be used. Checked before
  // falling back to symmetric inversion.
  var VAR_BORDER = /(^|-)(border|line|divider|rule|separator|outline|edge|stroke|hairline)(-|$)/;
  var VAR_BG = /(^|-)(bg|background|backdrop|surface|panel|canvas|paper|card|sheet|overlay|shadow|elevation|scrim)(-|$)/;
  var VAR_FG = /(^|-)(fg|foreground|text|txt|ink|label|heading|title|caption|link|icon|content)(-|$)/;

  /** Returns 'fg' | 'bg' | 'border' | 'var' | null for a property name. */
  function roleOf(prop) {
    if (prop.charCodeAt(0) === 45 && prop.charCodeAt(1) === 45) {
      // Border first: `--card-border` is a border, not a card surface.
      if (VAR_BORDER.test(prop)) return 'border';
      if (VAR_BG.test(prop)) return 'bg';
      if (VAR_FG.test(prop)) return 'fg';
      return 'var';
    }
    if (FG.has(prop)) return 'fg';
    if (BG.has(prop)) return 'bg';
    if (BORDER.has(prop)) return 'border';
    return null;
  }

  // --- value scanning ------------------------------------------------------

  // Functions whose entire text is one color and must be consumed atomically.
  var COLOR_FNS = new Set([
    'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch',
    'color', 'color-mix', 'device-cmyk'
  ]);

  // Values that parse as colors but must never be rewritten.
  var KEEP = new Set([
    'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert',
    'revert-layer', 'none', 'auto'
  ]);

  function isIdentStart(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '-' || c === '_';
  }
  function isIdentChar(c) {
    return isIdentStart(c) || (c >= '0' && c <= '9');
  }
  function isHexChar(c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
  }

  /** Index just past the `)` matching the `(` at `open`. */
  function matchParen(v, open) {
    var depth = 0;
    for (var i = open; i < v.length; i++) {
      var c = v[i];
      if (c === '"' || c === "'") {
        i = skipString(v, i);
      } else if (c === '(') {
        depth++;
      } else if (c === ')') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return v.length;
  }

  function skipString(v, i) {
    var quote = v[i];
    for (var j = i + 1; j < v.length; j++) {
      if (v[j] === '\\') { j++; continue; }
      if (v[j] === quote) return j;
    }
    return v.length;
  }

  /**
   * Walk a declaration value and call `cb(start, end, token)` for every token
   * that could be a color. Nested non-color functions (gradients, `filter`
   * chains) are descended into; `url()` and quoted strings are skipped whole,
   * so a `#fragment` or a base64 payload never gets mistaken for a hex color.
   */
  function eachToken(value, cb) {
    var len = value.length;
    var i = 0;
    while (i < len) {
      var c = value[i];

      if (c === '"' || c === "'") {
        i = skipString(value, i) + 1;
        continue;
      }

      if (c === '#') {
        var j = i + 1;
        while (j < len && isHexChar(value[j])) j++;
        var n = j - i - 1;
        if (n === 3 || n === 4 || n === 6 || n === 8) cb(i, j, value.slice(i, j));
        i = j;
        continue;
      }

      if (isIdentStart(c)) {
        var k = i;
        while (k < len && isIdentChar(value[k])) k++;
        var name = value.slice(i, k).toLowerCase();

        if (value[k] === '(') {
          if (COLOR_FNS.has(name)) {
            var end = matchParen(value, k);
            cb(i, end, value.slice(i, end));
            i = end;
          } else if (name === 'url' || name === 'var' || name === 'attr') {
            // Opaque: never rewrite inside these.
            i = matchParen(value, k);
          } else {
            // Gradient, filter, calc… descend so inner colors are still found.
            i = k + 1;
          }
          continue;
        }

        if (!KEEP.has(name)) cb(i, k, value.slice(i, k));
        i = k;
        continue;
      }

      i++;
    }
  }

  /**
   * Rewrite every color in `value` for the given role. Returns null when nothing
   * changed, so callers can skip emitting a redundant declaration.
   */
  function modifyValue(value, role, cfg) {
    if (!value || value.length > 6000) return null;

    var edits = null;
    eachToken(value, function (start, end, token) {
      var rgb = C.parse(token);
      if (!rgb) return;
      var out = C.modify(rgb, role, cfg);
      if (!out) return;
      // Compare the colour, not its spelling: `rgb(40, 44, 52)` and `#282c34`
      // are the same colour, and a preserved dark value should emit nothing
      // whichever notation the page happened to use.
      if (Math.round(out.r) === Math.round(rgb.r) &&
          Math.round(out.g) === Math.round(rgb.g) &&
          Math.round(out.b) === Math.round(rgb.b) &&
          out.a === rgb.a) return;
      (edits || (edits = [])).push([start, end, C.toCss(out)]);
    });

    if (!edits) return null;

    var result = value;
    for (var i = edits.length - 1; i >= 0; i--) {
      result = result.slice(0, edits[i][0]) + edits[i][2] + result.slice(edits[i][1]);
    }
    return result === value ? null : result;
  }

  // --- declaration blocks --------------------------------------------------

  /**
   * Build the override declarations for one CSSStyleDeclaration.
   *
   * CSSOM already expands shorthands into longhands for us, so `background: #fff
   * url(x)` arrives as separate `background-color` / `background-image` entries
   * and we never have to parse a shorthand by hand.
   *
   * `skipUrls` is set for stylesheets we fetched cross-origin: those are parsed
   * against the document's base URL, so any relative `url()` in them is already
   * wrong and re-emitting it would break the asset.
   */
  function declarations(style, cfg, skipUrls) {
    var out = '';
    for (var i = 0; i < style.length; i++) {
      var prop = style[i];
      var role = roleOf(prop);
      if (!role) continue;
      var value = style.getPropertyValue(prop);
      if (!value) continue;
      if (skipUrls && value.indexOf('url(') !== -1) continue;
      var next = modifyValue(value, role, cfg);
      if (next === null) continue;
      out += prop + ':' + next + ' !important;';
    }
    return out;
  }

  return {
    roleOf: roleOf,
    eachToken: eachToken,
    modifyValue: modifyValue,
    declarations: declarations
  };
})();
