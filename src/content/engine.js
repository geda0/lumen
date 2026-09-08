/*
 * Lumen — engine.
 *
 * Walks every stylesheet on the page, rebuilds each rule with inverted colors,
 * and appends the result as one override sheet at the end of the document. The
 * original CSS is never mutated, so turning the extension off is instant and
 * lossless.
 */

var Lumen = (typeof Lumen === 'object' && Lumen) || {};

(function () {
  'use strict';

  var C = Lumen.color;
  var CSS = Lumen.css;

  // Degrade to rule-level conversion alone if the repair module is unavailable,
  // rather than taking the whole engine down with it.
  var REPAIR = Lumen.repair || {
    scan: function () {},
    probe: function () { return false; },
    verify: function () { return 0; },
    pending: function () { return false; },
    abort: function () {},
    reset: function () {},
    clean: function () {},
    base: function () { return ''; },
    states: function () { return ''; }
  };

  var DEFAULTS = {
    enabled: true,
    defaultOn: true,
    skipDarkSites: true,
    darkness: 50,
    contrast: 50,
    saturation: 50,
    sites: {}
  };

  var host = location.hostname || 'local';
  var settings = null;
  var cfg = null;
  var cfgVersion = 0;
  var cfgKey = '';
  var active = false;
  var alreadyDark = false;
  var darkChecked = false;

  var earlyEl = null;
  var coreEl = null;
  var inlineEl = null;

  var sheetCache = new WeakMap();   // CSSStyleSheet -> { count, css, ver }
  var foreignCache = new Map();     // href -> css text | null (failed) | undefined (pending)
  var inlineIndex = new WeakMap();  // Element -> id
  var inlineCache = new WeakMap();  // Element -> { raw, ver, css }
  var inlineSerial = 0;
  var shadowRoots = new Set();

  var rebuildTimer = 0;
  var observer = null;

  var watchedLinks = new WeakSet();
  var lastSyncRebuild = 0;
  var SYNC_REBUILD_INTERVAL = 100;
  var repairEl = null;
  var repairStateEl = null;
  var repairQueue = new Set();
  var repairScheduled = false;
  var probeFrame = 0;
  var probePending = null;

  // How long the synchronous repair pass -- the one that runs when the palette
  // moves -- may spend measuring before handing the rest to idle slices. The
  // marker writes that follow are charged to the same task, so the budget is
  // deliberately well under the frame time it is trying to protect.
  var SYNC_REPAIR_MS = 50;

  // How often a scan still in progress may publish what it has so far.
  var REPAIR_PUBLISH_INTERVAL = 250;
  var lastRepairPublish = 0;

  // A full document walk looking for new shadow roots is too expensive to do on
  // every rebuild of a large page; newly added subtrees are walked as they
  // arrive, and this is the backstop for a root attached to an element that was
  // already there.
  var SHADOW_SWEEP_INTERVAL = 2000;
  var lastShadowSweep = 0;
  var linksDirty = true;

  // Beyond this many separately-added roots in one batch, scanning them one by
  // one costs more than one pass over the document.
  var ADDED_ROOT_LIMIT = 400;

  var restyleSet = new Set();
  var restyleTimer = 0;
  var stateHandlers = null;
  var repairSettled = false;

  // Stylesheets mutated through insertRule() (styled-components, emotion, and
  // most CSS-in-JS runtimes) produce no DOM mutation at all, so the observer
  // never fires. Poll the rule counts instead, backing off once they settle.
  var pollTimer = 0;
  var pollStable = 0;
  var lastSignature = '';

  // --- configuration -------------------------------------------------------

  function derive(s) {
    var bgMin = 0.14 - (s.darkness / 100) * 0.12;
    var bgMax = bgMin + 0.22;
    return {
      bgMin: bgMin,
      bgMax: bgMax,
      // Borders sit a fixed distance above the background floor, so they stay
      // visible at every darkness setting instead of collapsing into the page.
      borderMin: bgMin + 0.20,
      borderMax: bgMin + 0.42,
      fgMin: 0.44 + (s.contrast / 100) * 0.18,
      fgMax: 0.82 + (s.contrast / 100) * 0.18,
      sat: s.saturation / 50
    };
  }

  function siteEnabled(s) {
    if (!s.enabled) return false;
    var explicit = s.sites[host];
    return explicit === undefined ? s.defaultOn : explicit;
  }

  function baseColors() {
    return {
      bg: C.toCss(C.hslToRgb(0, 0, cfg.bgMin)),
      fg: C.toCss(C.hslToRgb(0, 0, cfg.fgMax)),
      // A field surface, lifted off the page so inputs stay distinguishable --
      // the same separation Chrome gives a control under `color-scheme: dark`.
      field: C.toCss(C.hslToRgb(0, 0, C.clamp(cfg.bgMin + 0.09, 0, 1))),
      // Selection. Chrome's own dark-mode highlight is a saturated blue, which
      // on a page whose surfaces we have deliberately kept near-neutral is the
      // loudest thing on screen. A grey one reads as a highlight without
      // recolouring the text under it.
      selection: C.toCss(C.hslToRgb(0, 0, C.clamp(cfg.bgMin + 0.26, 0, 1)))
    };
  }

  /**
   * Chrome paints an autofilled control itself, and that painting ignores
   * `background-color` entirely -- while the computed value still reports
   * whatever the page asked for, so nothing downstream can even tell the field
   * is rendering white. The documented way in is an inset shadow big enough to
   * cover the control, plus text-fill-color for the text on top.
   */
  function autofillCss(base) {
    var states = [':-webkit-autofill', ':-webkit-autofill:hover',
                  ':-webkit-autofill:focus', ':-webkit-autofill:active'];
    var selectors = [];
    for (var i = 0; i < states.length; i++) {
      selectors.push('input' + states[i], 'textarea' + states[i], 'select' + states[i]);
    }
    return selectors.join(',') + '{' +
      '-webkit-box-shadow:inset 0 0 0 1000px ' + base.field + ' !important;' +
      'box-shadow:inset 0 0 0 1000px ' + base.field + ' !important;' +
      '-webkit-text-fill-color:' + base.fg + ' !important;' +
      'caret-color:' + base.fg + ' !important;' +
      '}';
  }

  // --- style element plumbing ---------------------------------------------

  function makeStyle(id) {
    var el = document.createElement('style');
    el.id = id;
    el.setAttribute('data-lumen', '1');
    el.media = 'screen';
    return el;
  }

  function attach(el) {
    var root = document.documentElement;
    if (!root) return;
    if (el.parentNode !== root || root.lastElementChild !== el) {
      root.appendChild(el);
    }
  }

  /**
   * Keep our sheets at the end of the document, in cascade order, and move
   * nothing when they already are.
   *
   * Each of them used to re-append itself whenever it was written, and each in
   * turn wanted to be last, so a rebuild moved every one of them every time.
   * appendChild of a node that is already in place is still a mutation, and a
   * stylesheet moving invalidates style for the whole document: on a large page
   * that was several full restyles per rebuild to arrive at the order the
   * document was already in.
   */
  function attachOurs() {
    var root = document.documentElement;
    if (!root) return;
    var want = [];
    if (coreEl) want.push(coreEl);
    if (inlineEl) want.push(inlineEl);
    if (repairEl) want.push(repairEl);
    if (repairStateEl) want.push(repairStateEl);
    if (!want.length) return;

    var node = root.lastElementChild;
    for (var i = want.length - 1; i >= 0; i--) {
      if (node !== want[i]) {
        for (var j = 0; j < want.length; j++) root.appendChild(want[j]);
        return;
      }
      node = node.previousElementSibling;
    }
  }

  function isOurs(node) {
    return node && node.nodeType === 1 && node.hasAttribute &&
      node.hasAttribute('data-lumen');
  }

  /**
   * Painted at document_start, before any of the page's own CSS has loaded, so
   * the user never sees a white flash on a slow page. Replaced by the real
   * override sheet as soon as we have stylesheets to read.
   */
  function applyEarly() {
    if (earlyEl) return;
    earlyEl = makeStyle('lumen-early');
    // Neutral grey on purpose: this is the colour the page wears before any of
    // its own CSS has loaded, and a tinted one reads as a colour cast over
    // everything that follows. #141414 is exactly where the background curve
    // puts white at the default darkness, so nothing shifts when the real sheet
    // takes over.
    earlyEl.textContent =
      ':root{color-scheme:dark !important;}' +
      'html{background-color:#141414 !important;}' +
      'html,body{background-color:#141414 !important;color:#e8e8e8 !important;}';
    attach(earlyEl);
  }

  function removeAll() {
    [earlyEl, coreEl, inlineEl, repairEl, repairStateEl].forEach(function (el) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    earlyEl = coreEl = inlineEl = repairEl = repairStateEl = null;
    REPAIR.reset();
    if (REPAIR.clean) REPAIR.clean(document);
    repairQueue.clear();
    shadowRoots.forEach(function (root) {
      var el = root.querySelector('style[data-lumen]');
      if (el) el.remove();
    });
  }

  // --- rule serialization --------------------------------------------------

  function serializeRules(rules, out, skipUrls) {
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      var type = rule.constructor && rule.constructor.name;

      switch (type) {
        case 'CSSStyleRule': {
          var body = CSS.declarations(rule.style, cfg, skipUrls);
          var nested = '';
          // CSS nesting: a style rule can itself contain rules.
          if (rule.cssRules && rule.cssRules.length) {
            var buf = { css: '' };
            serializeRules(rule.cssRules, buf, skipUrls);
            nested = buf.css;
          }
          if (body || nested) {
            try {
              out.css += rule.selectorText + '{' + body + nested + '}';
            } catch (e) { /* selector we cannot read */ }
          }
          break;
        }

        case 'CSSNestedDeclarations': {
          out.css += CSS.declarations(rule.style, cfg, skipUrls);
          break;
        }

        case 'CSSMediaRule':
          wrap(rule, '@media ' + rule.conditionText, out, skipUrls);
          break;

        case 'CSSSupportsRule':
          wrap(rule, '@supports ' + rule.conditionText, out, skipUrls);
          break;

        case 'CSSContainerRule':
          wrap(rule, '@container ' + (rule.conditionText || ''), out, skipUrls);
          break;

        case 'CSSScopeRule':
          wrap(rule, '@scope ' + (rule.start ? '(' + rule.start + ')' : '') +
            (rule.end ? ' to (' + rule.end + ')' : ''), out, skipUrls);
          break;

        case 'CSSLayerBlockRule':
          // Deliberately *not* re-wrapped in @layer: for `!important`
          // declarations the cascade reverses layer order and unlayered wins,
          // so emitting these unlayered is what keeps our overrides on top.
          serializeRules(rule.cssRules, out, skipUrls);
          break;

        case 'CSSKeyframesRule': {
          var frames = '';
          for (var k = 0; k < rule.cssRules.length; k++) {
            var frame = rule.cssRules[k];
            // `!important` is ignored inside keyframes, so strip it here.
            var d = CSS.declarations(frame.style, cfg, skipUrls)
              .split(' !important;').join(';');
            if (d) frames += frame.keyText + '{' + d + '}';
          }
          if (frames) out.css += '@keyframes ' + rule.name + '{' + frames + '}';
          break;
        }

        case 'CSSImportRule':
          serializeSheet(rule.styleSheet, out, rule.href);
          break;

        default:
          if (rule.cssRules) serializeRules(rule.cssRules, out, skipUrls);
      }
    }
  }

  function wrap(rule, prelude, out, skipUrls) {
    var buf = { css: '' };
    serializeRules(rule.cssRules, buf, skipUrls);
    if (buf.css) out.css += prelude + '{' + buf.css + '}';
  }

  /**
   * Serialize one stylesheet, transparently recovering cross-origin sheets that
   * the CSSOM refuses to expose by re-fetching them through the service worker.
   */
  function serializeSheet(sheet, out, href) {
    if (!sheet) {
      if (href) requestForeign(href, out);
      return;
    }
    if (sheet.ownerNode && isOurs(sheet.ownerNode)) return;
    if (sheet.disabled) return;

    var rules = null;
    try {
      rules = sheet.cssRules;
    } catch (e) {
      rules = null;
    }

    if (!rules) {
      requestForeign(sheet.href || href, out);
      return;
    }

    var cached = sheetCache.get(sheet);
    if (cached && cached.count === rules.length && cached.ver === cfgVersion) {
      out.css += cached.css;
      return;
    }

    var buf = { css: '' };
    var foreign = isForeign(sheet.href);
    serializeRules(rules, buf, foreign);
    sheetCache.set(sheet, { count: rules.length, css: buf.css, ver: cfgVersion });
    out.css += buf.css;
  }

  function isForeign(href) {
    if (!href) return false;
    try {
      return new URL(href, location.href).origin !== location.origin;
    } catch (e) {
      return true;
    }
  }

  /**
   * Cross-origin stylesheets throw on `.cssRules`. We ask the background worker
   * to fetch the text, then re-parse it in a stylesheet whose media query can
   * never match — the CSSOM is populated either way, but nothing is rendered.
   */
  function requestForeign(href, out) {
    if (!href) return;
    var text = foreignCache.get(href);

    if (text === undefined) {
      foreignCache.set(href, null); // pending; avoids duplicate requests
      try {
        chrome.runtime.sendMessage({ type: 'lumen-fetch-css', url: href }, function (res) {
          if (chrome.runtime.lastError) return;
          if (res && res.ok) {
            foreignCache.set(href, res.text);
            scheduleRebuild();
          }
        });
      } catch (e) { /* extension context gone */ }
      return;
    }

    if (!text) return;

    var el = document.createElement('style');
    el.setAttribute('data-lumen', 'scratch');
    el.media = 'speech and (min-width: 99999px)';
    el.textContent = text;
    (document.head || document.documentElement).appendChild(el);
    try {
      if (el.sheet && el.sheet.cssRules) {
        serializeRules(el.sheet.cssRules, out, true);
      }
    } catch (e) { /* unparsable */ }
    el.remove();
  }

  // --- inline style attributes --------------------------------------------

  /**
   * Inline `style` attributes are overridden by tagging the element with an id
   * attribute and emitting `[data-lumen-i="n"] { … !important }`. We never write
   * to `element.style` itself — sites read their own inline styles back.
   *
   * The last result is reused when neither the attribute nor the palette has
   * moved.
   *
   * Rebuilds are frequent -- any stylesheet arriving anywhere on the page causes
   * one -- and a large page carries thousands of inline styles. Re-running the
   * value rewriter over all of them each time was pure repetition: the cache
   * turns every rebuild after the first into a string comparison per element.
   */
  function inlineFor(el) {
    var raw = el.getAttribute('style') || '';
    var hit = inlineCache.get(el);
    if (hit && hit.raw === raw && hit.ver === cfgVersion) return hit.css;

    var decls = CSS.declarations(el.style, cfg, false);
    var css = '';
    if (decls) {
      var id = inlineIndex.get(el);
      if (id === undefined) {
        id = ++inlineSerial;
        inlineIndex.set(el, id);
        el.setAttribute('data-lumen-i', id);
      }
      css = '[data-lumen-i="' + id + '"]{' + decls + '}';
    }
    inlineCache.set(el, { raw: raw, ver: cfgVersion, css: css });
    return css;
  }

  function buildInline() {
    var css = '';
    var nodes = document.querySelectorAll('[style]');
    for (var i = 0; i < nodes.length; i++) {
      if (isOurs(nodes[i])) continue;
      css += inlineFor(nodes[i]);
    }
    return css;
  }

  // --- shadow DOM ----------------------------------------------------------

  function collectShadowRoots(root) {
    // The root itself counts: this is called on newly added subtrees, and a
    // custom element arrives with its shadow root already attached to the very
    // node that was inserted.
    if (root.shadowRoot) shadowRoots.add(root.shadowRoot);
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.shadowRoot && !shadowRoots.has(node.shadowRoot)) {
        shadowRoots.add(node.shadowRoot);
      }
    }
  }

  /**
   * Document stylesheets do not cross the shadow boundary, so each open shadow
   * root gets its own override sheet built from its own styles.
   */
  function applyShadowRoots() {
    shadowRoots.forEach(function (root) {
      if (!root.host || !root.host.isConnected) {
        shadowRoots.delete(root);
        return;
      }
      var out = { css: '' };
      var adopted = root.adoptedStyleSheets || [];
      for (var i = 0; i < adopted.length; i++) serializeSheet(adopted[i], out);
      var styles = root.querySelectorAll('style,link[rel~="stylesheet" i]');
      for (var j = 0; j < styles.length; j++) {
        if (isOurs(styles[j])) continue;
        serializeSheet(styles[j].sheet, out, styles[j].href);
      }
      var inline = root.querySelectorAll('[style]');
      for (var k = 0; k < inline.length; k++) out.css += inlineFor(inline[k]);

      var el2 = root.querySelector('style[data-lumen]');
      if (!out.css) {
        if (el2) el2.remove();
        return;
      }
      if (!el2) {
        el2 = makeStyle('lumen-shadow');
        root.appendChild(el2);
      }
      if (el2.textContent !== out.css) el2.textContent = out.css;
      if (root.lastElementChild !== el2) root.appendChild(el2);
    });
  }

  // --- already-dark detection ---------------------------------------------

  /**
   * If the site already ships a dark theme, inverting it would just make it
   * light again. Read the page's own background with our sheets momentarily
   * disabled, and bail out when it is already comfortable.
   */
  function detectAlreadyDark() {
    var ours = [earlyEl, coreEl, inlineEl, repairEl, repairStateEl].filter(Boolean);
    ours.forEach(function (el) { if (el.sheet) el.sheet.disabled = true; });

    var candidates = [];
    if (document.body) candidates.push(getComputedStyle(document.body).backgroundColor);
    candidates.push(getComputedStyle(document.documentElement).backgroundColor);

    ours.forEach(function (el) { if (el.sheet) el.sheet.disabled = false; });

    for (var i = 0; i < candidates.length; i++) {
      var rgb = C.parse(candidates[i]);
      if (rgb && rgb.a > 0.5) {
        return C.rgbToHsl(rgb.r, rgb.g, rgb.b).l < 0.35;
      }
    }
    return false; // fully transparent: the canvas underneath is white
  }

  // --- build ---------------------------------------------------------------

  function rebuild(sync) {
    rebuildTimer = 0;
    if (!active) return;

    var out = { css: '' };
    var base = baseColors();
    out.css =
      ':root{color-scheme:dark !important;}' +
      'html{background-color:' + base.bg + ' !important;color:' + base.fg + ' !important;}' +
      // No `!important`, on purpose: a page that styles its own selection has
      // had that rule converted like any other, and the converted one -- which
      // *is* important -- has to win over this default.
      '::selection{background-color:' + base.selection + ';color:' + base.fg + ';}' +
      autofillCss(base);

    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      serializeSheet(sheets[i], out);
    }
    var adopted = document.adoptedStyleSheets || [];
    for (var j = 0; j < adopted.length; j++) {
      serializeSheet(adopted[j], out);
    }

    if (!coreEl) coreEl = makeStyle('lumen-core');
    if (coreEl.textContent !== out.css) coreEl.textContent = out.css;

    var inlineCss = buildInline();
    if (!inlineEl) inlineEl = makeStyle('lumen-inline');
    if (inlineEl.textContent !== inlineCss) inlineEl.textContent = inlineCss;
    attachOurs();

    if (earlyEl && earlyEl.parentNode) {
      earlyEl.parentNode.removeChild(earlyEl);
      earlyEl = null;
    }

    if (linksDirty) {
      linksDirty = false;
      trackLinks(document);
    }
    // Walking every element looking for shadow roots costs as much as the rest
    // of the rebuild put together on a large page, and rebuilds are frequent.
    // Subtrees are walked as they arrive (see the observer); this is only the
    // backstop for a root attached to an element that was already in the DOM.
    var now = Date.now();
    if (now - lastShadowSweep >= SHADOW_SWEEP_INTERVAL) {
      lastShadowSweep = now;
      collectShadowRoots(document.documentElement);
    }
    applyShadowRoots();

    if (sync) runRepairNow();
    else queueRepair(document.documentElement);
  }

  /**
   * Re-apply everything after a palette change, entirely within this one task.
   *
   * The old repairs have to go first: they were measured against the previous
   * palette, and leaving them in place would have the new pass judging colours
   * against stale corrections. But the browser paints only when a task ends, so
   * doing the teardown and the rebuild together means the intermediate state --
   * the page showing its own light colours again -- is never put on screen.
   * Splitting these across an idle callback is exactly what made the view flash
   * white before inverting.
   */
  function reapply() {
    REPAIR.reset();
    if (repairEl) repairEl.textContent = '';
    if (repairStateEl) repairStateEl.textContent = '';
    rebuild(true);
  }

  /**
   * Publish whatever the repair module currently has.
   *
   * Two sheets rather than one, because they change on completely different
   * schedules: the resting rules are the big sheet and settle after the first
   * pass, while the state rules are small and are rewritten every time the
   * pointer reaches something new. Sharing one element meant every hover made
   * the browser re-parse the resting rules as well, which on a large page was
   * most of the cost of hovering at all.
   */
  function applyRepairSheets() {
    lastRepairPublish = performance.now();
    var css = REPAIR.base();
    if (!repairEl) repairEl = makeStyle('lumen-repair');
    if (repairEl.textContent !== css) repairEl.textContent = css;

    var stateCss = REPAIR.states();
    // Nothing has ever needed a state rule: don't put an empty sheet in the DOM.
    if (stateCss || repairStateEl) {
      if (!repairStateEl) repairStateEl = makeStyle('lumen-repair-state');
      if (repairStateEl.textContent !== stateCss) repairStateEl.textContent = stateCss;
    }
    attachOurs(); // repairs must stay the last sheets in the document
  }

  /**
   * Publish mid-scan, but not after every slice.
   *
   * Changing a stylesheet invalidates style for the whole document, and on a
   * large one that is tens of milliseconds -- more than the slice that produced
   * the change. Publishing every slice meant a scan spent most of its budget
   * paying for its own previous instalment, and the more finely it sliced the
   * worse it got. Progress still shows, just at a rate the page can afford.
   */
  function publishRepairProgress() {
    if (performance.now() - lastRepairPublish < REPAIR_PUBLISH_INTERVAL) return;
    applyRepairSheets();
  }

  /**
   * The repair pass for a palette change, run here and now rather than handed to
   * an idle callback -- the page is showing converted colours from the previous
   * palette and every element still holding one is visibly wrong until this
   * lands.
   *
   * Bounded all the same. Scanning a large document to completion took nearly
   * three seconds of frozen page on every step of the darkness slider; the
   * budget covers the top of the document, which is what is on screen, and the
   * rest follows in idle slices exactly as it does on first load.
   */
  function runRepairNow() {
    REPAIR.abort();
    repairQueue.clear();
    var start = performance.now();
    REPAIR.scan([document.documentElement], cfg, function () {
      return SYNC_REPAIR_MS - (performance.now() - start);
    });
    applyRepairSheets();

    if (REPAIR.pending()) {
      scheduleRepairSlice();
      return;
    }
    repairSettled = true;
    if (REPAIR.verify() > 0 && observer) observer.takeRecords();

    // Roots queued while that scan was in flight were held back; nothing else
    // will pick them up, so schedule the follow-up here.
    if (repairQueue.size && !repairScheduled) scheduleRepairSlice();
  }

  // --- repair --------------------------------------------------------------

  /**
   * Queue a subtree for the computed-style repair pass. A whole-document request
   * supersedes any pending partial ones.
   */
  function queueRepair(root) {
    if (!active || !root) return;
    if (root === document.documentElement) {
      repairQueue.clear();
      repairQueue.add(root);
    } else if (!repairQueue.has(document.documentElement)) {
      // A Set, not an array: a page that streams content in queues hundreds of
      // roots between slices, and the linear scan that used to dedupe them was
      // quadratic in exactly the case that produces them.
      repairQueue.add(root);
    }
    // Deliberately does not abort a scan already in progress: restarting it on
    // every rebuild is how a busy page starves the pass out of ever finishing.
    if (repairScheduled) return;
    scheduleRepairSlice();
  }

  /**
   * Idle time if the browser offers it: this pass reads computed styles for
   * every element and should never compete with the page's own first paint.
   */
  function scheduleRepairSlice() {
    repairScheduled = true;
    var run = function (idle) {
      repairScheduled = false;
      runRepair(idle);
    };
    // Continue a scan already in progress promptly; the page still has
    // unconverted surfaces on screen until it finishes.
    var resuming = REPAIR.pending();
    var timeout = resuming ? 150 : 700;
    if (!window.requestIdleCallback) {
      setTimeout(run, resuming ? 0 : 150);
      return;
    }
    if (!resuming) {
      requestIdleCallback(run, { timeout: timeout });
      return;
    }
    // An idle callback requested from inside an idle callback is served in the
    // same idle period, so seventeen well-behaved 50 ms slices ran back to back
    // as two 200 ms tasks and nothing in between could be handled. The timeout
    // is only there to end the task; the work still waits for idle inside it.
    setTimeout(function () {
      requestIdleCallback(run, { timeout: timeout });
    }, 0);
  }

  function runRepair(idle) {
    if (!active || !cfg) return;
    var resuming = REPAIR.pending();
    var roots = repairQueue.size
      ? Array.from(repairQueue)
      : [document.documentElement];
    if (!resuming) repairQueue.clear();
    // Without an idle deadline the slice still gets a wall-clock one: a
    // setTimeout fallback is not licence to hold the main thread for as long as
    // the document happens to be.
    var start = performance.now();
    var deadline = idle && idle.timeRemaining
      ? function () { return idle.timeRemaining(); }
      : function () { return SYNC_REPAIR_MS - (performance.now() - start); };
    REPAIR.scan(roots, cfg, deadline);

    if (REPAIR.pending()) {
      // Ran out of idle time with elements left; pick up where we stopped.
      publishRepairProgress();
      scheduleRepairSlice();
      return;
    }
    applyRepairSheets();
    repairSettled = true;

    // Read back what the sheet actually achieved. Where an author rule outranks
    // it, verify() escalates to an inline !important. Those writes are ours, so
    // discard the mutation records they generate instead of letting them kick
    // off another rebuild.
    if (REPAIR.verify() > 0 && observer) observer.takeRecords();

    // Roots queued while that scan was in flight were held back; nothing else
    // will pick them up, so schedule the follow-up here.
    if (repairQueue.size && !repairScheduled) scheduleRepairSlice();
  }

  // --- interaction states --------------------------------------------------
  //
  // A repair rule is `!important` and deliberately specific, which means it also
  // wins against the page's own `:hover`, `:focus` and `.selected` rules -- so an
  // element we corrected at rest stopped responding to the pointer altogether.
  // And where the CSS behind a state was unreadable in the first place, the
  // state was never converted at all and paints light the moment it applies.
  //
  // Both are handled by measuring the state while the element is actually in it.

  /**
   * Unmasking of last resort: run `read` with our repair sheets switched off.
   *
   * Disabling a sheet invalidates style for the whole document, so this is only
   * for what the repair pass will not touch attribute-by-attribute -- a field
   * the user types into. Everything happens inside one task and the browser
   * paints only when a task ends, so the unmasked state is never on screen.
   */
  function unmask(read) {
    var sheets = [];
    if (repairEl && repairEl.sheet) sheets.push(repairEl.sheet);
    if (repairStateEl && repairStateEl.sheet) sheets.push(repairStateEl.sheet);
    if (!sheets.length) return read();
    for (var i = 0; i < sheets.length; i++) sheets[i].disabled = true;
    try {
      return read();
    } finally {
      for (var j = 0; j < sheets.length; j++) sheets[j].disabled = false;
    }
  }

  function applyProbe(target, state) {
    if (!active || !cfg || !REPAIR.probe) return;
    // Only ever an adjustment on top of the resting pass. Probing before that
    // pass has been over the document would file its ordinary corrections under
    // whatever state happened to be active -- the pointer sits somewhere from
    // the first frame, so `body` is in `:hover` before the page has even
    // finished loading -- and the resting page would then be left uncorrected.
    if (!repairSettled || REPAIR.pending()) return;
    if (!REPAIR.probe(target, state, cfg, unmask)) return;   // nothing moved
    applyRepairSheets();
  }

  /**
   * Hover probes are coalesced to one per frame.
   *
   * `mouseover` fires for every element the pointer crosses, and on a deeply
   * nested page a single gesture crosses a great many -- each one asking for a
   * probe that disables our sheets and so invalidates style for the whole
   * document. Only the element the pointer ended the frame on is worth
   * measuring; it is also the only one still in `:hover` by the time we look.
   */
  function queueProbe(el, state) {
    probePending = { el: el, state: state };
    if (probeFrame) return;
    probeFrame = requestAnimationFrame(function () {
      probeFrame = 0;
      var next = probePending;
      probePending = null;
      if (next && next.el.isConnected) applyProbe(next.el, next.state);
    });
  }

  function onHover(e) {
    var el = e.target;
    if (el && el.nodeType === 1) queueProbe(el, ':hover');
  }

  function onFocus(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    // `:focus-visible` where the browser is showing a focus ring, so a rule for
    // keyboard focus is not applied to a mouse click as well.
    var state = ':focus';
    try {
      if (el.matches(':focus-visible')) state = ':focus-visible';
    } catch (err) { /* older engine: plain :focus */ }
    applyProbe(el, state);
  }

  function onPress(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    // `:active` belongs to the same gesture but is not guaranteed to be applied
    // before this listener runs, so measure on the next frame; probe() checks
    // the element is still in the state before reading anything.
    requestAnimationFrame(function () { applyProbe(el, ':active'); });
  }

  /**
   * A class or ARIA attribute changed -- `.selected` on a row, `aria-current` on
   * a tab -- so the element's resting colours are not what we measured. Unlike
   * new content this needs the unmasked path: our own rule is sitting on top of
   * whatever the page just changed.
   *
   * Batched and rate-limited, because a busy page rewrites class attributes
   * constantly and each probe costs a style recalculation.
   */
  function queueRestyle(els) {
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.nodeType !== 1 || isOurs(el) || !el.isConnected) continue;
      if (restyleSet.size >= 300) break;
      restyleSet.add(el);
    }
    if (restyleTimer || !restyleSet.size) return;
    restyleTimer = setTimeout(runRestyle, 120);
  }

  function runRestyle() {
    restyleTimer = 0;
    if (!active) { restyleSet.clear(); return; }
    var batch = [];
    restyleSet.forEach(function (el) {
      if (batch.length < 20) { batch.push(el); restyleSet.delete(el); }
    });
    if (batch.length) applyProbe(batch, '');
    if (restyleSet.size) restyleTimer = setTimeout(runRestyle, 120);
  }

  // Attributes that routinely mean "this element now looks different": a
  // selected row, a current tab, an open disclosure, a disabled control.
  var STATE_ATTRS = ['class', 'aria-selected', 'aria-current', 'aria-checked',
                     'aria-expanded', 'aria-pressed', 'checked', 'selected',
                     'open', 'disabled'];

  function watchStates() {
    if (stateHandlers) return;
    stateHandlers = [
      ['mouseover', onHover],
      ['focusin', onFocus],
      ['pointerdown', onPress]
    ];
    for (var i = 0; i < stateHandlers.length; i++) {
      document.addEventListener(stateHandlers[i][0], stateHandlers[i][1], true);
    }
  }

  function unwatchStates() {
    if (!stateHandlers) return;
    for (var i = 0; i < stateHandlers.length; i++) {
      document.removeEventListener(stateHandlers[i][0], stateHandlers[i][1], true);
    }
    stateHandlers = null;
    if (restyleTimer) { clearTimeout(restyleTimer); restyleTimer = 0; }
    if (probeFrame) { cancelAnimationFrame(probeFrame); probeFrame = 0; }
    probePending = null;
    restyleSet.clear();
  }

  // --- CSS-in-JS polling ---------------------------------------------------

  function signature() {
    var sig = '';
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var sheet = sheets[i];
      if (sheet.ownerNode && isOurs(sheet.ownerNode)) continue;
      try {
        sig += (sheet.cssRules ? sheet.cssRules.length : 0) + ',';
      } catch (e) {
        sig += 'x,';
      }
    }
    // Constructed sheets are not in document.styleSheets, have no owner node to
    // mutate and fire no load event -- so leaving them out of the signature left
    // the poll unable to notice the one thing it exists for.
    var adopted = document.adoptedStyleSheets || [];
    sig += '|' + adopted.length + ':';
    for (var j = 0; j < adopted.length; j++) {
      try {
        sig += (adopted[j].cssRules ? adopted[j].cssRules.length : 0) + ',';
      } catch (e) {
        sig += 'x,';
      }
    }
    return sig;
  }

  function poll() {
    pollTimer = 0;
    if (!active) return;
    var sig = signature();
    if (sig !== lastSignature) {
      lastSignature = sig;
      pollStable = 0;
      scheduleRebuild();
    } else {
      pollStable++;
    }
    // Fast while the page is still settling, then a slow heartbeat that never
    // stops. A rule added with insertRule() produces no DOM mutation and no
    // load event, so this poll is the only thing that can ever notice it;
    // giving up after a few quiet seconds left anything injected later light
    // for good. No visibility gate: the browser already throttles timers in a
    // hidden tab, and gating here means a backgrounded tab never catches up.
    pollTimer = setTimeout(poll, pollStable < 8 ? 700 : 2500);
  }

  function armPoll() {
    pollStable = 0;
    if (!pollTimer && active) pollTimer = setTimeout(poll, 700);
  }

  function scheduleRebuild() {
    if (!active || rebuildTimer) return;
    rebuildTimer = setTimeout(function () { rebuild(); }, 40);
  }

  /**
   * Convert now, not on the debounce.
   *
   * A MutationObserver callback is delivered as a microtask, which runs before
   * the browser paints. Rebuilding there means CSS that arrives late is already
   * converted in the very same frame it first applies. Going through the 40ms
   * timer instead is what made late-loaded blocks -- syntax highlighting themes,
   * lazily injected component styles -- show up white and then invert.
   */
  function rebuildNow() {
    if (!active) return;
    if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = 0; }
    rebuild();
  }

  /**
   * An added <link> has no stylesheet yet, and when it finishes loading the
   * CSSOM changes with no DOM mutation to announce it. Waiting for the poller
   * to spot that is a visible flash, so listen for the load itself.
   */
  function trackLinks(root) {
    var links = (root || document).querySelectorAll('link[rel~="stylesheet" i]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      if (isOurs(link) || watchedLinks.has(link)) continue;
      watchedLinks.add(link);
      link.addEventListener('load', rebuildNow);
    }
  }

  // --- observation ---------------------------------------------------------

  function watch() {
    if (observer) return;
    observer = new MutationObserver(function (records) {
      if (!active) return;
      var needs = false;
      var sheets = false;
      var added = null;
      var fresh = null;      // genuinely inserted subtrees, not attribute targets
      var restyled = null;
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'attributes') {
          if (isOurs(r.target)) continue;
          if (r.attributeName === 'style') {
            // An inline style has to be re-serialised into the inline sheet.
            needs = true;
            (added || (added = [])).push(r.target);
          } else {
            // A state attribute changes no CSS, only which of the page's rules
            // apply -- so re-measure that element rather than rebuild the page.
            (restyled || (restyled = [])).push(r.target);
          }
          continue;
        }
        for (var j = 0; j < r.addedNodes.length; j++) {
          var node = r.addedNodes[j];
          if (node.nodeType !== 1 || isOurs(node)) continue;
          (added || (added = [])).push(node);
          (fresh || (fresh = [])).push(node);
        }
        if (!needs) needs = relevant(r.addedNodes) || relevant(r.removedNodes);
        if (!sheets) sheets = touchesSheets(r.addedNodes) || touchesSheets(r.removedNodes);
      }
      if (sheets) {
        // Converting synchronously is what keeps late CSS from painting light
        // for a frame -- but a CSS-in-JS runtime can insert a stylesheet per
        // component, and each rebuild walks the document. Doing that hundreds
        // of times in a row pegs the main thread, the idle repair pass never
        // gets a slice, and elements that depend on it stay white. So take the
        // synchronous path for an occasional stylesheet and let a storm
        // collapse into one debounced rebuild instead.
        var now = Date.now();
        linksDirty = true;
        if (now - lastSyncRebuild >= SYNC_REBUILD_INTERVAL) {
          lastSyncRebuild = now;
          rebuildNow();
        } else {
          scheduleRebuild();
        }
      } else if (needs) {
        scheduleRebuild();
      }
      if (added) {
        // New content still needs checking even when no stylesheet changed:
        // it may be rendered by rules that were already missed once.
        //
        // Only past a large batch is one document pass the cheaper answer. The
        // threshold used to be 40, which a single fragment of rows clears --
        // and rescanning a 30,000-element document because 60 rows arrived is
        // how an infinite scroll turned into a permanent full-page scan. The
        // queue is a Set, so the roots themselves cost nothing to hold.
        if (added.length > ADDED_ROOT_LIMIT) {
          queueRepair(document.documentElement);
        } else {
          for (var k = 0; k < added.length; k++) queueRepair(added[k]);
        }
        armPoll();
      }
      // Shadow roots inside new content, found while we are already holding the
      // subtree, rather than by walking the whole document. Only what was
      // actually inserted: an element whose `style` attribute changed is in
      // `added` too, and walking its subtree on every animation frame is the
      // cost this is here to avoid.
      if (fresh && fresh.length <= ADDED_ROOT_LIMIT) {
        for (var f = 0; f < fresh.length; f++) collectShadowRoots(fresh[f]);
      }
      if (restyled) queueRestyle(restyled);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'].concat(STATE_ATTRS)
    });

    // Polling pauses while hidden; pick it back up on return, since anything
    // could have been injected in the meantime.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'hidden' && active) {
        armPoll();
        scheduleRebuild();
      }
    });
  }

  /** Did this batch add or remove an actual stylesheet? */
  function touchesSheets(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType !== 1 || isOurs(n)) continue;
      if (n.tagName === 'STYLE' || n.tagName === 'LINK') return true;
      if (n.querySelector && n.querySelector('style,link')) return true;
    }
    return false;
  }

  function relevant(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType !== 1) continue;
      if (isOurs(n)) continue;
      var tag = n.tagName;
      if (tag === 'STYLE' || tag === 'LINK' || n.shadowRoot) return true;
      if (n.querySelector && n.querySelector('style,link,[style]')) return true;
      if (n.hasAttribute && n.hasAttribute('style')) return true;
    }
    return false;
  }

  // --- lifecycle -----------------------------------------------------------

  function enable() {
    if (active) return;
    active = true;
    applyEarly();
    watch();
    watchStates();
    rebuild();
    armPoll();
  }

  function disable() {
    active = false;
    repairSettled = false;
    unwatchStates();
    if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = 0; }
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; }
    lastSignature = '';
    removeAll();
  }

  function evaluate(paletteMoved) {
    var want = siteEnabled(settings);

    if (want && settings.skipDarkSites && settings.sites[host] === undefined) {
      // Probe once per page. Re-running it on every settings change costs a
      // forced style recalc and cannot tell us anything new.
      if (!darkChecked && document.readyState !== 'loading') {
        darkChecked = true;
        alreadyDark = detectAlreadyDark();
      }
      if (alreadyDark) want = false;
    } else {
      alreadyDark = false;
    }

    if (want) {
      if (active) {
        if (paletteMoved) reapply();
        else rebuild();
      } else {
        enable();
      }
    } else if (active || earlyEl) {
      disable();
    }
  }

  /**
   * Adopt new settings. Returns true only when the palette itself moved, which
   * is the one case that invalidates already-converted CSS -- toggling a site or
   * flipping `skipDarkSites` leaves every colour exactly where it was.
   */
  function load(stored) {
    settings = Object.assign({}, DEFAULTS, stored || {});
    settings.sites = settings.sites || {};
    var key = settings.darkness + '|' + settings.contrast + '|' + settings.saturation;
    var moved = key !== cfgKey;
    cfgKey = key;
    cfg = derive(settings);
    if (moved) cfgVersion++;
    return moved;
  }

  // Paint the fallback immediately; storage is async and we want zero flash.
  // If the site turns out to be excluded it is removed a few milliseconds later.
  applyEarly();

  /**
   * Small control surface, handy from the devtools console of any page and used
   * by tools/browser-test.js to drive the engine outside of an extension.
   */
  Lumen.engine = {
    applySettings: function (s) { evaluate(load(s)); },
    rebuild: rebuild,
    disable: disable,
    defaults: DEFAULTS,
    get active() { return active; }
  };

  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.runtime) {
    // Loaded directly rather than as an extension: stay dormant until a caller
    // invokes Lumen.engine.applySettings().
    disable();
    return;
  }

  try {
    chrome.storage.local.get(DEFAULTS, function (stored) {
      if (chrome.runtime.lastError) return;
      load(stored);
      evaluate(false);
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          evaluate(false);
        }, { once: true });
      }
      window.addEventListener('load', function () {
        evaluate(false);
        setTimeout(scheduleRebuild, 400);
      });
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !settings) return;
      var next = Object.assign({}, settings);
      Object.keys(changes).forEach(function (key) {
        next[key] = changes[key].newValue;
      });
      evaluate(load(next));
    });

    chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
      if (msg && msg.type === 'lumen-status') {
        respond({ active: active, alreadyDark: alreadyDark, host: host });
      }
      return false;
    });
  } catch (e) {
    // Extension context invalidated (e.g. reloaded while a tab was open).
    disable();
  }
})();
