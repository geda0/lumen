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
   * Split a colour function whose alpha is a `var()`.
   *
   * Tailwind writes its entire palette this way -- `rgb(255 255 255 / var(--tw-bg-opacity, 1))`
   * is `bg-white`, and every text-/border-/bg- utility used without an opacity
   * modifier has the same shape. The alpha is a variable we cannot resolve, but
   * the channels in front of it are an ordinary colour, and refusing the whole
   * declaration over the alpha handed a Tailwind site's every surface to the
   * repair pass. That pass is asynchronous, so the page painted light first and
   * corrected itself a few hundred milliseconds later -- the flash.
   *
   * The alpha still has to be *known*, even though it is not ours to resolve:
   * `C.modify` keeps a translucent white wash light enough to go on reading as a
   * separator, and it can only do that when it is told the alpha. So the var's
   * own fallback is read when it is a plain number -- which is the common case,
   * Tailwind writing `var(--tw-bg-opacity, 1)` -- and anything else is refused,
   * leaving the declaration to the repair pass, which sees the colour the browser
   * actually resolved. Guessing would be wrong for half the pages either way.
   *
   * Returns { rgb, alpha, legacy } or null when there is no colour to read: a
   * var among the CHANNELS (`rgb(var(--brand) / 0.5)`) is genuinely opaque to us.
   */
  function varAlpha(token) {
    var open = token.indexOf('(');
    if (open === -1 || token.charAt(token.length - 1) !== ')') return null;
    var name = token.slice(0, open).toLowerCase();
    if (name !== 'rgb' && name !== 'rgba' && name !== 'hsl' && name !== 'hsla') return null;

    var inner = token.slice(open + 1, token.length - 1);
    // The alpha separator, at the top level only: `/` in the modern syntax, the
    // last of three commas in the legacy one. A comma inside the var's own
    // fallback (`var(--x, 1)`) is nested, so depth keeps it out of the way.
    var depth = 0, slash = -1, commas = [];
    for (var i = 0; i < inner.length; i++) {
      var ch = inner.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && ch === '/') slash = i;
      else if (depth === 0 && ch === ',') commas.push(i);
    }
    var cut = slash !== -1 ? slash : (commas.length === 3 ? commas[2] : -1);
    if (cut === -1) return null;

    var alpha = inner.slice(cut + 1).trim();
    if (alpha.slice(0, 4).toLowerCase() !== 'var(') return null; // a plain alpha parses already
    var channels = inner.slice(0, cut).trim();
    if (channels.indexOf('var(') !== -1) return null;      // no colour to read

    var known = fallbackAlpha(alpha);
    if (known === null) return null;                       // unknowable: leave it to repair

    // Read the channels on their own. hsl() keeps its own name so the parser
    // reads the numbers in the right space; the result comes back as rgb.
    var base = (name === 'hsl' || name === 'hsla') ? 'hsl' : 'rgb';
    var rgb = C.parse(base + '(' + channels + ')');
    if (!rgb) return null;
    rgb.a = known;
    return { rgb: rgb, alpha: alpha, legacy: slash === -1 };
  }

  /**
   * The plain number a `var()` falls back to, or null when there is not one.
   * `var(--o, 0.1)` is 0.1; `var(--o)` and `var(--o, var(--p))` are unknowable.
   */
  function fallbackAlpha(text) {
    var comma = -1, depth = 0;
    for (var i = 4; i < text.length - 1; i++) {   // inside `var(` … `)`
      var ch = text.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && ch === ',') { comma = i; break; }
    }
    if (comma === -1) return null;
    var raw = text.slice(comma + 1, text.length - 1).trim();
    var pct = raw.charAt(raw.length - 1) === '%';
    if (pct) raw = raw.slice(0, -1);
    if (!/^[0-9]*\.?[0-9]+$/.test(raw)) return null;
    var n = parseFloat(raw);
    if (isNaN(n)) return null;
    return C.clamp(pct ? n / 100 : n, 0, 1);
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
      if (!rgb) {
        var split = varAlpha(token);
        if (!split) return;
        var shade = C.modify(split.rgb, role, cfg);
        if (!shade) return;
        if (Math.round(shade.r) === Math.round(split.rgb.r) &&
            Math.round(shade.g) === Math.round(split.rgb.g) &&
            Math.round(shade.b) === Math.round(split.rgb.b)) return;
        var r = Math.round(shade.r), g = Math.round(shade.g), b = Math.round(shade.b);
        // Emitted in whichever syntax the page used, so the declaration still
        // reads like the sheet around it -- and the var is handed back untouched.
        (edits || (edits = [])).push([start, end, split.legacy
          ? 'rgba(' + r + ', ' + g + ', ' + b + ', ' + split.alpha + ')'
          : 'rgb(' + r + ' ' + g + ' ' + b + ' / ' + split.alpha + ')']);
        return;
      }
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
  /**
   * Shorthands that carry a colour, with the longhand that proves whether they
   * expanded. A shorthand containing a `var()` does NOT expand: CSSOM still lists
   * its longhands, but reports every one of them empty, so the loop below reads
   * nothing at all. The shorthand's own text is readable, and it is the only route
   * to those colours -- `border-color: rgb(229 231 235 / var(--tw-border-opacity, 1))`
   * is how Tailwind writes every border on the page.
   */
  // The longhand that gives a shorthand away, and the shorthand to read instead.
  var UNEXPANDED = {
    'border-top-color': ['border-color', 'border'],
    'background-color': ['background', 'bg']
  };

  function declarations(style, cfg, skipUrls) {
    var out = '';
    var unexpanded = null;

    for (var i = 0; i < style.length; i++) {
      var prop = style[i];
      var role = roleOf(prop);
      if (!role) continue;
      var value = style.getPropertyValue(prop);
      if (!value) {
        // Listed but empty is the tell: the shorthand that owns this longhand
        // carries a var() and so did not expand. Noting it here costs nothing --
        // a block with no such shorthand never reaches the lookup below.
        if (UNEXPANDED[prop]) (unexpanded || (unexpanded = [])).push(UNEXPANDED[prop]);
        continue;
      }
      if (skipUrls && value.indexOf('url(') !== -1) continue;
      var next = modifyValue(value, role, cfg);
      if (next === null) continue;
      out += prop + ':' + next + ' !important;';
    }

    for (var j = 0; unexpanded && j < unexpanded.length; j++) {
      var name = unexpanded[j][0];
      var text = style.getPropertyValue(name);
      if (!text) continue;
      if (skipUrls && text.indexOf('url(') !== -1) continue;
      var shade = modifyValue(text, unexpanded[j][1], cfg);
      if (shade === null) continue;
      out += name + ':' + shade + ' !important;';
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
