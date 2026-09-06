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
  // seconds. Too high and the deadline is not consulted until the slice has
  // already overrun it -- at ~0.006 ms per element a floor of 20,000 was 120 ms
  // of frozen page per slice, twice the whole idle budget it was meant to
  // respect. This floor guarantees progress; the deadline decides the rest.
  var MIN_PER_SLICE = 2000;

  var SELF_TEXT = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'OPTION', 'SUMMARY']);
  var SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'BR', 'NOSCRIPT']);

  // How much of a hovered element's subtree is looked at. A rule like
  // `.row:hover .cell` restyles descendants that the pointer is not itself over,
  // and those are exactly the cells whose text has to stay readable.
  var STATE_SUBTREE = 60;

  // --- markers -------------------------------------------------------------
  //
  // How an element is tagged for its rules decides what the whole extension
  // costs, because it decides how the browser matches those rules.
  //
  // Every rule used to be `[data-lumen-r="17"]`, one per repaired element, all
  // sharing the attribute *name*. Chromium buckets rules by the name, so a
  // shared name is one bucket holding every rule we emit, and every element
  // carrying the attribute is matched against all of them: 19,000 rules on
  // 27,000 elements is quadratic, and a style recalculation that should take
  // 80 ms took 2.6 seconds. Every hover paid it twice.
  //
  // Two things fix it, and both matter:
  //
  //   - the id goes in the attribute *name* (`[data-lumen-g17]`), so each rule
  //     lands in its own bucket and matching is linear again;
  //   - elements needing the same declarations share one rule, which is the
  //     overwhelming majority of them -- a page has thousands of repaired
  //     elements but only dozens of distinct corrections. The sheet stops
  //     growing with the document.
  //
  // Specificity is unchanged: `[data-lumen-g17]` repeated three times is (0,3,0)
  // exactly as the old selector was, so every cascade decision behaves the same.
  var ATTR_GROUP = 'data-lumen-g';
  var ATTR_UNIQUE = 'data-lumen-u';

  var baseDecls = new WeakMap();  // element -> [[prop, value], ...]
  var groupOf = new WeakMap();    // element -> group id currently marked on it
  var groupIds = new Map();       // declaration body -> group id
  var groupSerial = 0;

  // Unique ids are handed out lazily, only to elements that actually take part
  // in a state rule -- a few hundred on a page where every element has a group.
  var ids = new WeakMap();      // element -> unique id
  var stateRules = new Map();   // "id|state|scope" -> { sel, decls }
  var stateIndex = new Map();   // unique id -> Set of keys mentioning it
  var marks = new WeakMap();    // element -> { ':hover': true, ... } already probed
  var verified = new WeakMap(); // element -> decls last confirmed to have applied
  var touched = [];             // elements given a rule by the last scan
  var committed = 0;            // how far through `touched` commit() has got
  var escalated = [];           // inline overrides, with what to put back
  var serial = 0;

  // Cached sheet text. The base sheet only changes when a correction the page
  // has never needed before turns up, so after the first pass it is handed back
  // untouched and a hover never re-parses it.
  var baseCss = '';
  var stateCss = '';
  var stateDirty = true;

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
    baseDecls = new WeakMap();
    groupIds.clear();
    ids = new WeakMap();
    stateRules.clear();
    stateIndex.clear();
    marks = new WeakMap();
    verified = new WeakMap();
    touched = [];
    committed = 0;
    baseCss = '';
    stateCss = '';
    stateDirty = true;
    // `groupSerial` and `serial` are deliberately NOT reset, and `groupOf` is
    // deliberately kept. Elements keep their marker attributes across a reset,
    // so restarting a counter would hand a fresh element an id that a stale
    // attribute elsewhere still carries, and one rule would then style two
    // unrelated elements. Keeping `groupOf` is what lets the next pass strip
    // each element's stale attribute as it re-marks it, instead of leaving one
    // behind per palette change.
  }

  /**
   * Strip the marker attributes; used on teardown so the DOM is left clean.
   *
   * The ids live in attribute names rather than values, so there is no single
   * selector that finds them and this walks the document instead. It runs once,
   * when the extension is switched off.
   */
  function clean(root) {
    restore();
    var all = (root || document).querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var attrs = all[i].attributes;
      var doomed = null;
      for (var j = 0; j < attrs.length; j++) {
        var name = attrs[j].name;
        if (name.lastIndexOf(ATTR_GROUP, 0) === 0 || name.lastIndexOf(ATTR_UNIQUE, 0) === 0) {
          (doomed || (doomed = [])).push(name);
        }
      }
      if (doomed) {
        for (var k = 0; k < doomed.length; k++) all[i].removeAttribute(doomed[k]);
      }
    }
    groupOf = new WeakMap();
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
   * Walk `rgb` away from `bg` in HSL lightness until it clears `target`. Hue is
   * held, so a blue link stays a blue link — it just becomes a legible one.
   *
   * Saturation follows the same chroma rule as the main curves: holding `s`
   * while lightness climbs inflates the colour's real chroma, which is how a
   * barely-tinted grey comes out of a contrast repair as a distinctly blue one.
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
      var cand = C.hslToRgb(hsl.h, C.chromaSafe(hsl.s, hsl.l, l), l);
      cand.a = rgb.a;
      if (contrast(rgb.a >= 0.999 ? cand : blend(cand, bg), bg) >= target) return cand;
    }

    var edgeL = up ? 1 : 0;
    var edge = C.hslToRgb(hsl.h, C.chromaSafe(hsl.s, hsl.l, edgeL), edgeL);
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

  /**
   * Work out what needs correcting on one element, given the already-measured
   * backgrounds of its ancestors. Returns the declarations to apply, which is
   * empty for the overwhelming majority of elements.
   *
   * Reading is deliberately separated from writing: this function touches
   * neither the DOM nor the rule table, which is what lets the same measurement
   * serve the full document scan, a re-measure after the page restyles an
   * element, and a probe of a live `:hover` state.
   */
  function measure(el, cs, cfg, memo, pageBg) {
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

    return decls;
  }

  /**
   * The scan's use of measure(). Deliberately does not write to the DOM: setting
   * the marker attribute here would invalidate style, so the next element's
   * getComputedStyle would force a fresh recalculation of the whole document --
   * one per repaired element. On a page with a few hundred repairs that turned a
   * 40 ms pass into 2 s. The writes are batched in commit() once all the reading
   * is done.
   */
  function inspect(el, cfg, memo, pageBg) {
    var decls = measure(el, getComputedStyle(el), cfg, memo, pageBg);
    if (decls.length) touched.push({ el: el, decls: decls });
  }

  /**
   * Assign ids and marker attributes for everything found since the last call.
   * Cheap enough to run at the end of every slice, which is what lets a long
   * scan publish its results progressively instead of holding them all back.
   */
  function commit() {
    for (var i = committed; i < touched.length; i++) {
      var el = touched[i].el;
      // A base rule that moved invalidates everything measured against it, so
      // the element's state rules go and it becomes probeable again.
      if (sameDecls(baseDecls.get(el), touched[i].decls)) continue;
      baseDecls.set(el, touched[i].decls);
      group(el, touched[i].decls);
      dropStatesFor(el);
      marks.delete(el);
      verified.delete(el);
    }
    committed = touched.length;
  }

  function body(decls) {
    var out = '';
    for (var i = 0; i < decls.length; i++) {
      out += decls[i][0] + ':' + decls[i][1] + ' !important;';
    }
    return out;
  }

  /**
   * Put `el` in the group for these declarations, creating the group -- and the
   * one rule that serves every element in it -- the first time this particular
   * correction is needed anywhere on the page.
   */
  function group(el, decls) {
    var text = body(decls);
    var gid = groupIds.get(text);
    if (gid === undefined) {
      gid = ++groupSerial;
      groupIds.set(text, gid);
      // Append rather than rebuild: the base sheet is the big one, and after the
      // first pass over a page this is the only thing that ever touches it.
      baseCss += selector(ATTR_GROUP + gid, 3) + '{' + text + '}';
    }
    var old = groupOf.get(el);
    if (old === gid) return;
    if (old !== undefined) el.removeAttribute(ATTR_GROUP + old);
    el.setAttribute(ATTR_GROUP + gid, '');
    groupOf.set(el, gid);
  }

  /**
   * Selector for one marker attribute, repeated `times` for the specificity.
   *
   * Three is enough to beat the ordinary class-based rule that caused a miss.
   * A rule scoped to an ancestor's state spends six, and an element's own state
   * rule therefore has to spend seven: both apply when the pointer is on the
   * child, and it is the one measured with the child itself in the state that
   * is right.
   */
  function selector(attr, times) {
    var sel = '[' + attr + ']';
    var out = '';
    for (var i = 0; i < (times || 3); i++) out += sel;
    return out;
  }

  /** Selector for one element's own state rules, by its unique id. */
  function rep(id, times) {
    return selector(ATTR_UNIQUE + id, times);
  }

  /**
   * Assign the unique marker a state rule is keyed by. Only elements that take
   * part in one ever get it, so this stays a small population.
   */
  function idFor(el) {
    var id = ids.get(el);
    if (id === undefined) {
      id = ++serial;
      ids.set(el, id);
      el.setAttribute(ATTR_UNIQUE + id, '');
    }
    return id;
  }

  /**
   * Forget every state rule that mentions `id`, either as its subject or as the
   * ancestor it is scoped to. The index exists so this costs the number of rules
   * actually affected rather than a walk of all of them -- a scan that moves a
   * few thousand base rules used to pay that walk once per element.
   */
  function dropStates(id) {
    var keys = stateIndex.get(id);
    if (!keys) return;
    // A copy: unindex() deletes from this very set as it goes.
    Array.from(keys).forEach(function (key) {
      if (stateRules.delete(key)) stateDirty = true;
      unindex(key);
    });
  }

  function dropStatesFor(el) {
    var id = ids.get(el);
    if (id !== undefined) dropStates(id);
  }

  function index(key, own, scope) {
    var add = function (id) {
      var set = stateIndex.get(id);
      if (!set) stateIndex.set(id, (set = new Set()));
      set.add(key);
    };
    add(own);
    if (scope) add(scope);
  }

  function unindex(key) {
    var parts = key.split('|');
    var drop = function (id) {
      var set = stateIndex.get(Number(id));
      if (!set) return;
      set.delete(key);
      if (!set.size) stateIndex.delete(Number(id));
    };
    drop(parts[0]);
    if (parts[2] && parts[2] !== '0') drop(parts[2]);
  }

  /** Same properties, same colours — whatever notation each is written in. */
  function sameDecls(a, b) {
    if (!a || !b) return !a && !b;
    if (a.length !== b.length) return false;
    var map = Object.create(null);
    for (var i = 0; i < a.length; i++) map[a[i][0]] = a[i][1];
    for (var j = 0; j < b.length; j++) {
      var v = map[b[j][0]];
      if (v === undefined || !matches(v, b[j][1])) return false;
    }
    return true;
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
   * children); the resulting rules are read back with base() and states().
   */
  var pendingState = null;

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
   * `deadline` returns the milliseconds left in the current slice. When it runs
   * out the scan saves its place and returns with what it has committed so far;
   * `pending()` then reports that there is more to do. Splitting the work this
   * way keeps a large page from blocking the main thread in one go -- so it is
   * passed even on the synchronous path, where it is a plain wall-clock budget
   * rather than the browser's idle estimate.
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
            return;
          }
        }
      }
      st.list = null;
    }

    pendingState = null;
    commit();
  }

  // --- interaction states --------------------------------------------------
  //
  // Everything above measures the page at rest. A page is not at rest: rows
  // highlight under the pointer, buttons darken while pressed, a tab gets
  // `aria-selected` and changes surface. Two separate things went wrong there.
  //
  // The first is that our own corrections *froze* those states. A repair rule is
  // `!important` at (0,3,0), so it outranks the page's own `.row:hover` rule --
  // which we did convert correctly, and which then never got to apply. The
  // element simply stopped responding to the pointer.
  //
  // The second is that a state can carry colours the resting page never showed
  // us at all: if `.row` came from a stylesheet we could not read, so did
  // `.row:hover`, and the first thing the pointer does is paint it white.
  //
  // Both are answered by measuring the state itself, while the element is in it.
  // The one trick needed is unmasking: our own corrections are lifted for the
  // duration of the read, so what comes back is the page's real colour for this
  // state rather than our correction of the resting one. It all happens inside
  // the event handler, and the browser paints only when a task ends, so nothing
  // intermediate is ever on screen and the fix lands in the same frame the state
  // does.

  function matchesState(el, state) {
    try {
      return el.matches(state);
    } catch (e) {
      return false;
    }
  }

  /**
   * The elements a probe of `root` has to look at: `root` and its ancestors —
   * which are in the same `:hover` as it is — plus a slice of its subtree, for
   * the `.row:hover .cell` shape. Ancestors come first so a parent's background
   * is always measured before the children judged against it.
   */
  function collectProbe(root, state, list, seen) {
    if (!root || root.nodeType !== 1 || !root.isConnected) return;
    if (state) {
      if (!matchesState(root, state)) return;
      var mark = marks.get(root);
      if (!mark) marks.set(root, (mark = {}));
      // Already measured in this state, and nothing has invalidated it since.
      if (mark[state]) return;
      mark[state] = true;
    }

    var add = function (el, scope) {
      if (SKIP.has(el.tagName) || el.hasAttribute('data-lumen')) return;
      if (seen.has(el)) return;
      seen.add(el);
      list.push({ el: el, scope: scope });
    };

    var chain = [];
    for (var p = root; p && p.nodeType === 1; p = p.parentElement) chain.push(p);
    for (var i = chain.length - 1; i >= 0; i--) add(chain[i], null);

    // A TreeWalker rather than querySelectorAll('*'): only STATE_SUBTREE of the
    // descendants are ever looked at, and materialising a list of all of them
    // first is the whole cost of a hover on a large container.
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (var j = 0, node; j < STATE_SUBTREE && (node = walker.nextNode()); j++) {
      add(node, root);
    }
  }

  /**
   * What a state rule has to say, given what the ordinary rules already say.
   *
   * `decls` is the ordinary correction for how the element looks in this state.
   * On top of that, every property the base rules pin has to be restated at its
   * real value here — otherwise the correction made for the resting state leaks
   * into this one and the element never changes colour.
   *
   * Returns null when the state wants exactly what the base rules already do,
   * which is the common case and emits nothing.
   */
  function stateDecls(decls, base, cs) {
    var want = decls.slice();
    if (base) {
      var have = Object.create(null);
      for (var i = 0; i < want.length; i++) have[want[i][0]] = true;
      for (var j = 0; j < base.length; j++) {
        var prop = base[j][0];
        if (have[prop]) continue;
        var raw = cs.getPropertyValue(prop);
        // A computed background-image can carry a base64 payload; restating one
        // is not worth the sheet it would take, so that state keeps the resting
        // correction instead.
        if (raw && raw.length < 2000) want.push([prop, raw]);
      }
    }
    if (!want.length) return null;
    return sameDecls(base, want) ? null : want;
  }

  /**
   * Run `read` with our corrections lifted from the elements it is about to
   * measure -- by taking their marker attributes off, so the rules stop matching
   * them, and putting them back afterwards.
   *
   * Disabling the whole sheet would do the same thing and used to, but a
   * disabled sheet invalidates style for every element in the document: on a
   * large page that was two full style recalculations, ~55 ms, for a read of
   * seventy elements. Removing an attribute invalidates only the element that
   * carried it. Every ancestor a measurement depends on is in the list, so the
   * elements unmasked are exactly the ones being judged.
   */
  function unmasked(list, read) {
    var stripped = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i].el;
      var gid = groupOf.get(el);
      if (gid !== undefined) stripped.push(el, ATTR_GROUP + gid);
      var uid = ids.get(el);
      if (uid !== undefined) stripped.push(el, ATTR_UNIQUE + uid);
    }
    if (!stripped.length) return read();
    for (var j = 0; j < stripped.length; j += 2) stripped[j].removeAttribute(stripped[j + 1]);
    try {
      return read();
    } finally {
      for (var k = 0; k < stripped.length; k += 2) stripped[k].setAttribute(stripped[k + 1], '');
    }
  }

  function measureProbe(list, state, cfg) {
    var pageBg = C.hslToRgb(0, 0, cfg.bgMin);
    pageBg.a = 1;
    var memo = new Map();
    var found = [];

    // Read everything first. idFor() sets an attribute, which invalidates style
    // and would make the next getComputedStyle in this loop recalculate the
    // whole document -- the same trap commit() exists to avoid.
    for (var i = 0; i < list.length; i++) {
      var el = list[i].el;
      if (!el.isConnected) continue;
      var cs = getComputedStyle(el);
      var decls = measure(el, cs, cfg, memo, pageBg);
      var base = baseDecls.get(el) || null;
      found.push({
        el: el,
        scope: list[i].scope,
        decls: state ? stateDecls(decls, base, cs) : decls,
        base: base
      });
    }

    var changed = false;
    for (var j = 0; j < found.length; j++) {
      var hit = found[j];

      if (!state) {
        // The page restyled the element; whatever we corrected it to was
        // measured against colours it no longer has.
        if (!hit.decls.length) {
          if (hit.base) {
            baseDecls.delete(hit.el);
            ungroup(hit.el);
            dropStatesFor(hit.el);
            marks.delete(hit.el);
            verified.delete(hit.el);
            changed = true;
          }
        } else if (!sameDecls(hit.base, hit.decls)) {
          baseDecls.set(hit.el, hit.decls);
          group(hit.el, hit.decls);
          dropStatesFor(hit.el);
          marks.delete(hit.el);
          verified.delete(hit.el);
          changed = true;
        }
        continue;
      }

      var known = ids.get(hit.el);

      if (hit.decls) {
        known = idFor(hit.el);
        var root = hit.scope ? idFor(hit.scope) : 0;
        var key = known + '|' + state + '|' + root;
        var prev = stateRules.get(key);
        if (!prev || !sameDecls(prev.decls, hit.decls)) {
          stateRules.set(key, {
            sel: root
              ? rep(root) + state + ' ' + rep(known)
              : rep(known, 7) + state,
            decls: hit.decls
          });
          index(key, known, root);
          changed = true;
          stateDirty = true;
        }
      } else if (known !== undefined) {
        // The state wants nothing beyond the resting rules, so drop any rule a
        // previous probe left. A scope with no id of its own has never had a
        // rule keyed to it, and must not be defaulted to 0 -- that is the key of
        // the element's *own* state rule, which is a different measurement.
        var root2 = hit.scope ? ids.get(hit.scope) : 0;
        if (root2 !== undefined) {
          var gone = known + '|' + state + '|' + root2;
          if (stateRules.delete(gone)) {
            unindex(gone);
            changed = true;
            stateDirty = true;
          }
        }
      }
    }

    return changed;
  }

  /** Take an element out of its declaration group; it needs no rule any more. */
  function ungroup(el) {
    var gid = groupOf.get(el);
    if (gid === undefined) return;
    el.removeAttribute(ATTR_GROUP + gid);
    groupOf.delete(el);
  }

  /**
   * Re-measure live elements and update their rules. Returns true when something
   * moved; false when nothing did and the caller can leave the sheets alone.
   *
   * `state` is '' to refresh the ordinary rules — the page restyled the element,
   * so whatever we corrected it to is now measured against the wrong thing — or
   * a pseudo-class the element is matching *right now*, in which case that is
   * what gets measured and the rules are emitted scoped to it.
   *
   * The measurement runs unmasked -- see unmasked() -- so a state is judged by
   * the page's own colour for it rather than by the correction we already made
   * for the resting one.
   */
  function probe(target, state, cfg) {
    if (!cfg) return false;
    // One entry per element per state, so this only grows with how much of the
    // page has actually been interacted with. Start over rather than let a very
    // long session on a very long list accumulate without bound; the next hover
    // measures what it needs again.
    if (stateRules.size > 4000) {
      stateRules.clear();
      stateIndex.clear();
      stateDirty = true;
      marks = new WeakMap();
    }
    var roots = target && target.nodeType === undefined ? target : [target];
    var list = [];
    var seen = new Set();
    for (var i = 0; i < roots.length; i++) {
      collectProbe(roots[i], state, list, seen);
    }
    if (!list.length) return false;

    return unmasked(list, function () {
      return measureProbe(list, state, cfg);
    }) || false;
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
      var want = baseDecls.get(el);
      if (!want) continue;
      // Already confirmed to have landed, and asking for the same thing since.
      // A page that mutates constantly re-scans constantly, and reading back
      // every element every time is a second pass as expensive as the first.
      if (sameDecls(verified.get(el), want)) continue;
      var cs = getComputedStyle(el);
      var ok = true;
      for (var j = 0; j < want.length; j++) {
        if (matches(cs.getPropertyValue(want[j][0]), want[j][1])) continue;
        ok = false;
        failures.push({ el: el, prop: want[j][0], value: want[j][1] });
      }
      if (ok) verified.set(el, want);
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

  /**
   * The resting rules, one per distinct correction.
   *
   * Built by append in group(), never rebuilt: a hover, a restyle or another
   * scan slice hands back the very same string, so the browser is not asked to
   * re-parse the largest sheet on the page for a change that is not in it.
   */
  function base() {
    return baseCss;
  }

  /**
   * The state rules, in their own sheet.
   *
   * They change on every hover of something new, and they are a few hundred
   * rules against the base sheet's thousands -- keeping them separate is what
   * makes a hover cost the parse of a small sheet instead of a large one.
   */
  function states() {
    if (!stateDirty) return stateCss;
    var css = '';
    stateRules.forEach(function (rule) {
      css += rule.sel + '{' + body(rule.decls) + '}';
    });
    stateCss = css;
    stateDirty = false;
    return stateCss;
  }

  /** Both sheets as one string. Not used to render; handy for tests. */
  function serialize() {
    return base() + states();
  }

  return {
    scan: scan,
    probe: probe,
    verify: verify,
    pending: pending,
    abort: abort,
    reset: reset,
    clean: clean,
    base: base,
    states: states,
    serialize: serialize,
    contrast: contrast,
    relLum: relLum,
    fixContrast: fixContrast,
    thresholds: { LIGHT_BG: LIGHT_BG, TEXT_CONTRAST: TEXT_CONTRAST, BORDER_CONTRAST: BORDER_CONTRAST }
  };
})();
