/*
 * Lumen — computed-style repair.
 *
 * Rewriting stylesheets catches most of a page, but never all of it. A colour
 * can reach the screen by routes the rule walker cannot follow:
 *
 *   - a shorthand containing var() — `border: 1px solid var(--line)` — which
 *     CSSOM refuses to expand into longhands, so the border role never sees it;
 *   - a declaration in a cross-origin sheet that also carries a url(), which we
 *     skip because its relative path would resolve against the wrong base;
 *   - a generically named custom property (`--gray-900`) whose real role we
 *     guessed wrong;
 *   - rules injected with insertRule() by a CSS-in-JS runtime.
 *
 * So after the override sheet is in place we look at what actually rendered and
 * repair anything still wrong: backgrounds that stayed light, text that lost its
 * contrast, and borders that faded into their surface. Because this pass reads
 * final computed values it is a backstop for every route at once, and it is
 * idempotent — the colours it writes are already correct on the next pass.
 */

var Lumen = (typeof Lumen === 'object' && Lumen) || {};

Lumen.repair = (function () {
  'use strict';

  var C = Lumen.color;
  var CSS = Lumen.css;

  // A computed background lighter than this cannot have come from our own
  // conversion (the background curve tops out at bgMax = bgMin + 0.22), so it is
  // proof that something bypassed the rule walker.
  var LIGHT_BG = 0.42;

  // WCAG contrast ratios. Text is deliberately below AA so that legitimately
  // muted body text is left alone; this is a repair for unreadable text, not a
  // restyling of the page.
  var TEXT_CONTRAST = 4.0;
  var BORDER_CONTRAST = 2.0;


  // Always visit at least this many elements before yielding, whatever the idle
  // budget says.
  //
  // Two failure modes sit on either side of this number. Too low and a big page
  // needs many slices; idle callbacks are scarce on a busy page and throttled
  // hard in a background tab, so the scan crawls and surfaces stay light for
  // seconds. Too high and one slice blocks the main thread. Since separating
  // reads from writes the scan costs about 0.003 ms per element, so this is
  // roughly a 60 ms ceiling per slice, and every ordinary page -- and most large
  // ones -- finishes in a single pass. Only genuinely huge documents slice.
  var MIN_PER_SLICE = 20000;

  var SELF_TEXT = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'OPTION', 'SUMMARY']);
  var SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'BR', 'NOSCRIPT']);

  var ids = new WeakMap();
  var rules = new Map();        // id -> [[prop, value], ...]
  var touched = [];             // elements given a rule by the last scan
  var committed = 0;            // how far through `touched` commit() has got
  var escalated = [];           // inline overrides, with what to put back
  var serial = 0;

  /**
   * Put back every inline property we escalated, exactly as we found it. Done
   * before re-measuring too, so a fresh pass judges the page's real colours
   * rather than our own previous corrections.
   */
  function restore() {
    for (var i = escalated.length - 1; i >= 0; i--) {
      var e = escalated[i];
      if (e.prev) e.el.style.setProperty(e.prop, e.prev, e.prio);
      else e.el.style.removeProperty(e.prop);
    }
    escalated = [];
  }

  function reset() {
    restore();
    pendingState = null;
    lastCss = '';
    ids = new WeakMap();
    rules.clear();
    touched = [];
    committed = 0;
    // `serial` is deliberately NOT reset. Elements keep their data-lumen-r
    // attribute across a reset, so restarting the counter would hand a fresh
    // element an id that a stale attribute elsewhere still carries, and one
    // rule would then style two unrelated elements.
  }

  /** Strip the marker attributes; used on teardown so the DOM is left clean. */
  function clean(root) {
    restore();
    var marked = (root || document).querySelectorAll('[data-lumen-r]');
    for (var i = 0; i < marked.length; i++) marked[i].removeAttribute('data-lumen-r');
  }

  // --- contrast ------------------------------------------------------------

  function channel(c) {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function relLum(rgb) {
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  function contrast(a, b) {
    var la = relLum(a);
    var lb = relLum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function blend(top, under) {
    var a = top.a;
    return {
      r: top.r * a + under.r * (1 - a),
      g: top.g * a + under.g * (1 - a),
      b: top.b * a + under.b * (1 - a),
      a: 1
    };
  }

  /**
   * Walk `rgb` away from `bg` in HSL lightness until it clears `target`. Hue and
   * saturation are held, so a blue link stays a blue link — it just becomes a
   * legible one.
   */
  function fixContrast(rgb, bg, target) {
    var flat = rgb.a >= 0.999 ? rgb : blend(rgb, bg);
    if (contrast(flat, bg) >= target) return null;

    var hsl = C.rgbToHsl(rgb.r, rgb.g, rgb.b);
    var up = relLum(bg) < 0.2;
    var step = up ? 0.02 : -0.02;
    var l = hsl.l;

    for (var i = 0; i < 60; i++) {
      l += step;
      if (l > 1 || l < 0) break;
      var cand = C.hslToRgb(hsl.h, hsl.s, l);
      cand.a = rgb.a;
      if (contrast(rgb.a >= 0.999 ? cand : blend(cand, bg), bg) >= target) return cand;
    }

    var edge = C.hslToRgb(hsl.h, hsl.s, up ? 1 : 0);
    edge.a = rgb.a;
    return edge;
  }

  // --- effective background ------------------------------------------------

  /**
   * The colour a child is actually sitting on. `memo` holds each element's
   * post-repair background, so a descendant is judged against the corrected
   * surface rather than the light one still in the computed styles.
   */
  function inherited(el, memo) {
    for (var p = el; p; p = p.parentElement) {
      var hit = memo.get(p);
      if (hit) return hit;
    }
    return null;
  }

  /** Mean of the colour stops in a resolved gradient, or null. */
  function gradientAverage(value) {
    var stops = value.match(/rgba?\([^)]*\)/g);
    if (!stops || !stops.length) return null;
    var r = 0, g = 0, b = 0, n = 0;
    for (var i = 0; i < stops.length; i++) {
      var c = C.parse(stops[i]);
      if (!c || c.a < 0.02) continue;
      r += c.r; g += c.g; b += c.b; n++;
    }
    return n ? { r: r / n, g: g / n, b: b / n, a: 1 } : null;
  }

  /** True when any stop in a resolved gradient is a light surface colour. */
  function gradientIsLight(value) {
    var stops = value.match(/rgba?\([^)]*\)/g);
    if (!stops) return false;
    for (var i = 0; i < stops.length; i++) {
      var c = C.parse(stops[i]);
      if (c && c.a > 0.02 && C.rgbToHsl(c.r, c.g, c.b).l > LIGHT_BG) return true;
    }
    return false;
  }

  function hasOwnText(el) {
    if (SELF_TEXT.has(el.tagName)) return true;
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue && /\S/.test(n.nodeValue)) return true;
    }
    return false;
  }

  // --- the pass ------------------------------------------------------------

  function inspect(el, cfg, memo, pageBg) {
    var cs = getComputedStyle(el);
    var parent = el.parentElement ? inherited(el.parentElement, memo) : null;
    var under = parent ? parent.bg : pageBg;

    // A background lighter than LIGHT_BG cannot have come from our own
    // conversion, so this element was missed wholesale. Everything on it was
    // authored for a light surface and needs the ordinary treatment, not just a
    // contrast nudge -- otherwise its pale border survives as a glare, and its
    // text is dragged only just past the contrast floor into a muddy grey.
    //
    // The flag is inherited, because the text inside a missed table lives on
    // the cells, not on the table that gave itself away.
    var missed = parent ? parent.missed : false;
    var missedHere = false;   // this element's own background gave it away
    var decls = [];
    var own = C.parse(cs.backgroundColor);
    var eff = under;

    if (own && own.a > 0.02) {
      if (C.rgbToHsl(own.r, own.g, own.b).l > LIGHT_BG) {
        missed = true;
        missedHere = true;
        own = C.modify(own, 'bg', cfg) || own;
        decls.push(['background-color', C.toCss(own)]);
      } else if (own.a >= 0.999) {
        // Its own properly dark surface: descendants start clean again.
        missed = false;
      }
      eff = own.a >= 0.999 ? own : blend(own, under);
    }

    // A surface can be painted entirely by a gradient, leaving background-color
    // transparent. Looking only at background-color misses those completely --
    // input fields with a subtle vertical sheen, striped code blocks -- so they
    // stayed white. The computed value has its stops already resolved to rgb(),
    // so the ordinary value rewriter handles it.
    var img = cs.backgroundImage;
    if (img && img !== 'none' && img.indexOf('gradient') !== -1 && gradientIsLight(img)) {
      var next = CSS.modifyValue(img, 'bg', cfg);
      if (next) {
        decls.push(['background-image', next]);
        missed = true;
        eff = gradientAverage(next) || eff;
      }
    }

    memo.set(el, { bg: eff, missed: missed });

    // Elements that hold no text of their own are skipped, otherwise every
    // wrapper div on the page would collect a pointless rule. The exception is
    // an element we just caught out by its own background: its colour is still
    // the one authored for a light surface, and anything inheriting it -- a
    // generated ::before, a cell we never reach -- would inherit that.
    if (hasOwnText(el) || missedHere) {
      var fg = C.parse(cs.color);
      if (fg && fg.a > 0.05) {
        var text = convert(fg, 'fg', eff, TEXT_CONTRAST, cfg, missed);
        if (text) decls.push(['color', C.toCss(text)]);
      }
    }

    // Cheap gate: the overwhelming majority of elements have no border at all.
    // The shorthand collapses to exactly '0px' only when all four sides are
    // zero, so one read replaces four and halves the cost of this check.
    if (cs.borderWidth !== '0px') {
      repairBorders(cs, eff, cfg, missed, decls);
    }

    if (!decls.length) return;

    // Deliberately does not write to the DOM. Setting the marker attribute here
    // would invalidate style, so the next element's getComputedStyle would force
    // a fresh recalculation of the whole document -- one per repaired element.
    // On a page with a few hundred repairs that turned a 40 ms pass into 2 s.
    // The writes are batched in commit() once all the reading is done.
    touched.push({ el: el, decls: decls });
  }

  /**
   * Assign ids and marker attributes for everything found since the last call.
   * Cheap enough to run at the end of every slice, which is what lets a long
   * scan publish its results progressively instead of holding them all back.
   */
  function commit() {
    for (var i = committed; i < touched.length; i++) {
      var el = touched[i].el;
      var id = ids.get(el);
      if (id === undefined) {
        id = ++serial;
        ids.set(el, id);
        el.setAttribute('data-lumen-r', id);
      }
      rules.set(id, touched[i].decls);
    }
    committed = touched.length;
  }

  /**
   * Produce one declaration for `rgb`. On a missed element the colour first goes
   * through the ordinary role conversion; either way the result must then clear
   * `target` against the surface it sits on.
   */
  function convert(rgb, role, eff, target, cfg, missed) {
    var base = rgb;
    if (missed) {
      var converted = C.modify(rgb, role, cfg);
      if (converted) base = converted;
    }
    var fixed = fixContrast(base, eff, target);
    if (!fixed) fixed = base === rgb ? null : base;
    return fixed;
  }

  var SIDES = ['top', 'right', 'bottom', 'left'];

  function repairBorders(cs, eff, cfg, missed, decls) {
    for (var i = 0; i < SIDES.length; i++) {
      var side = SIDES[i];
      if (cs.getPropertyValue('border-' + side + '-width') === '0px') continue;
      var style = cs.getPropertyValue('border-' + side + '-style');
      if (style === 'none' || style === 'hidden') continue;
      var bc = C.parse(cs.getPropertyValue('border-' + side + '-color'));
      if (!bc || bc.a < 0.05) continue;
      var fixed = convert(bc, 'border', eff, BORDER_CONTRAST, cfg, missed);
      if (fixed) decls.push(['border-' + side + '-color', C.toCss(fixed)]);
    }
  }

  /**
   * Scan `roots` (document order, so parents are memoised before their
   * children) and return the full repair stylesheet.
   */
  var pendingState = null;
  var lastCss = '';

  /** True when a scan ran out of time and still has elements to visit. */
  function pending() {
    return pendingState !== null;
  }

  /** Abandon a partial scan, e.g. because a fresh full pass supersedes it. */
  function abort() {
    pendingState = null;
  }

  /**
   * Scan `roots` in document order, so a parent is always memoised before its
   * children need its background.
   *
   * `deadline` is optional and returns the milliseconds left in the current idle
   * slice. When it runs out the scan saves its place and returns what it has so
   * far; `pending()` then reports that there is more to do. Splitting the work
   * this way keeps a 20,000-element page from blocking the main thread for a
   * quarter of a second in one go.
   */
  function scan(roots, cfg, deadline) {
    var st = pendingState;
    if (!st) {
      var pageBg = C.hslToRgb(0, 0, cfg.bgMin);
      pageBg.a = 1;
      touched = [];
      committed = 0;
      st = {
        roots: roots, rootIndex: -1, list: null, index: 0,
        memo: new Map(), pageBg: pageBg
      };
    }

    var since = 0;
    var visited = 0;

    // No total element cap. There used to be one, and when it ran out mid-list
    // the loop fell through to `st.list = null`, lost its place, and then set
    // pendingState = null -- reporting the scan as COMPLETE. Everything past
    // that point was silently never repaired, so on a long page identical
    // elements came out converted near the top and white further down. The
    // per-slice deadline already bounds how long we hold the main thread; the
    // document itself is finite and all of it has to be looked at.
    for (;;) {
      if (st.list === null) {
        st.rootIndex++;
        if (st.rootIndex >= st.roots.length) break;
        var root = st.roots[st.rootIndex];
        if (!root || !root.isConnected) continue;
        if (root.nodeType === 1 && !SKIP.has(root.tagName)) {
          inspect(root, cfg, st.memo, st.pageBg);
        }
        st.list = root.querySelectorAll('*');
        st.index = 0;
      }

      while (st.index < st.list.length) {
        var el = st.list[st.index++];
        if (SKIP.has(el.tagName) || el.hasAttribute('data-lumen')) continue;
        visited++;
        inspect(el, cfg, st.memo, st.pageBg);
        // Checking the clock is itself not free, so only every so often.
        if (++since >= 150 && visited >= MIN_PER_SLICE) {
          since = 0;
          if (deadline && deadline() <= 1) {
            // Returns with st.index intact, so the next slice resumes exactly
            // where this one stopped.
            pendingState = st;
            // Publish what this slice found rather than holding everything back
            // until the whole document is done. On a long page that wait is
            // seconds, and every surface needing repair stays white for all of
            // it. commit() only walks the new entries, so this stays cheap.
            commit();
            lastCss = serialize();
            return lastCss;
          }
        }
      }
      st.list = null;
    }

    pendingState = null;
    commit();
    lastCss = serialize();
    return lastCss;
  }

  /**
   * Confirm the repair sheet actually took effect, and escalate where it did
   * not.
   *
   * The sheet is deliberately the gentle option: it overrides nothing the page
   * owns and disappears cleanly. But `!important` ties are settled by
   * specificity, and a rule like `#main table.data { background: #fff
   * !important }` scores (1,1,1) against the repair selector's (0,3,0). No
   * amount of selector repetition wins that -- an id always outranks attribute
   * selectors -- so for those few elements the only thing left that beats an
   * author `!important` is an inline `!important`.
   *
   * Every escalation records the inline value it displaced, so teardown puts
   * the element back exactly as it was. Call this only after the sheet has been
   * applied, since it reads back computed styles.
   */
  function verify() {
    var failures = [];

    for (var i = 0; i < touched.length; i++) {
      var el = touched[i].el;
      if (!el.isConnected) continue;
      var want = rules.get(ids.get(el));
      if (!want) continue;
      var cs = getComputedStyle(el);
      for (var j = 0; j < want.length; j++) {
        if (matches(cs.getPropertyValue(want[j][0]), want[j][1])) continue;
        failures.push({ el: el, prop: want[j][0], value: want[j][1] });
      }
    }

    // Applied only once the reading is finished, for the same reason commit()
    // batches its writes.
    for (var k = 0; k < failures.length; k++) {
      var f = failures[k];
      escalated.push({
        el: f.el,
        prop: f.prop,
        prev: f.el.style.getPropertyValue(f.prop),
        prio: f.el.style.getPropertyPriority(f.prop)
      });
      f.el.style.setProperty(f.prop, f.value, 'important');
    }
    return failures.length;
  }

  /** Computed values come back in a different notation, so compare channels. */
  function matches(actual, wanted) {
    var a = C.parse(actual);
    var b = C.parse(wanted);
    if (!a || !b) return actual === wanted;
    return Math.abs(a.r - b.r) < 3 && Math.abs(a.g - b.g) < 3 &&
           Math.abs(a.b - b.b) < 3 && Math.abs(a.a - b.a) < 0.02;
  }

  function serialize() {
    var css = '';
    rules.forEach(function (decls, id) {
      // Repeated three times on purpose. Among `!important` declarations the
      // cascade settles ties by specificity before source order, so (0,3,0)
      // beats the ordinary class-based rule that caused the miss. Anything that
      // still outranks it is handled by verify() instead.
      var sel = '[data-lumen-r="' + id + '"]';
      var body = '';
      for (var i = 0; i < decls.length; i++) {
        body += decls[i][0] + ':' + decls[i][1] + ' !important;';
      }
      css += sel + sel + sel + '{' + body + '}';
    });
    return css;
  }

  return {
    scan: scan,
    verify: verify,
    pending: pending,
    abort: abort,
    reset: reset,
    clean: clean,
    serialize: serialize,
    contrast: contrast,
    relLum: relLum,
    fixContrast: fixContrast,
    thresholds: { LIGHT_BG: LIGHT_BG, TEXT_CONTRAST: TEXT_CONTRAST, BORDER_CONTRAST: BORDER_CONTRAST }
  };
})();
