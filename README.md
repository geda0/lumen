# Lumen — luminance dark mode for Chrome

Inverts the *luminance* of light websites, and leaves already-dark regions alone.
A dark code block, a dark navbar or a dark hero panel stays exactly as the site
authored it — byte-for-byte.

## Why not `filter: invert(1)`

The one-line approach every dark-mode tutorial reaches for is:

```css
html { filter: invert(1) hue-rotate(180deg); }
```

It fails on exactly the case in the brief. It is a *global* transform, so it has
no idea what it is inverting: a `#282c34` code block becomes a glaring `#d7d3cb`,
and every photo, video and logo has to be inverted a second time to undo it —
which is both fragile and visibly wrong on transparent PNGs and CSS gradients.

Lumen never applies a filter. It reads every stylesheet, converts each colour to
HSL, and reruns it through an **asymmetric curve** based on what the colour is
*for*. Because nothing is transformed globally, images are untouched by
construction — there is no re-inversion pass to get wrong.

## The curves

`l` is HSL lightness, 0–1. Both curves are continuous at `l = 0.5`, so a page
whose colours sit mid-range shows no seam.

**Backgrounds** — light surfaces fold down into the dark range; anything already
at or below mid-lightness is kept as-is:

```
l ≥ 0.5 → bgMin + (1 − l)·2·(bgMax − bgMin)     white #fff → #141414
l < 0.5 → min(l, bgMax)                          #282c34   → #282c34  (untouched)
```

**Foregrounds** — dark text is lifted; text that is already light stays light,
because it is sitting on one of those preserved dark sections:

```
l ≤ 0.5 → fgMax − l·2·(fgMax − fgMin)            #1a1d21 → near-white
l > 0.5 → max(l, fgMin)                          #abb2bf → #abb2bf  (untouched)
```

Hue and alpha are always preserved, so brand colours stay recognisable and
translucent overlays keep compositing correctly. A translucent *white* wash is
special-cased to stay light enough to still read as a separator.

**Saturation is not preserved — chroma is.** HSL saturation is a *ratio* of the
chroma available at a given lightness, and that available chroma collapses to
zero at both ends of the scale. So carrying `s` across a large lightness move
silently multiplies the colour a surface actually carries. `#f6f8fa` — the
blue-grey a great many sites use for `pre`, cards and table stripes — is
`s = 0.29` at `l = 0.97`, which is a chroma of 0.016: white with a hint of cool
in it. Dropped to `l = 0.08` at the same `s` it arrives at a chroma of 0.046,
three times the tint it started with, and now at a lightness where the eye reads
hue easily. Do that to every surface, border and shadow on a page and the result
is the uniform navy wash dark modes are notorious for.

```
s' = s · min(1, capacity(l) / capacity(l'))      capacity(l) = 1 − |2l − 1|
```

Saturated colours are untouched by this — a brand blue moving toward
mid-lightness only gains room, so it keeps every bit of its saturation — while
near-neutral greys stay near-neutral, which is what they were. The same rule
governs the contrast repair, which walks a colour's lightness and would
otherwise turn a barely-blue grey into a definitely-blue one on the way.

Borders get the background curve clamped into a band that sits a fixed distance
above the background floor, so a `#ddd` hairline keeps the same visibility at
every darkness setting instead of collapsing into the page.

## How it is applied

1. **Parse.** Every rule in `document.styleSheets`, `adoptedStyleSheets` and each
   open shadow root is walked. CSSOM has already expanded shorthands into
   longhands, so `background: #fff url(x)` arrives pre-split and no shorthand is
   ever hand-parsed.
2. **Rewrite.** Colour tokens are found inside arbitrary values — gradients,
   `box-shadow`, `color-mix()`. `url()`, `var()` and quoted strings are skipped
   whole, so a `#fragment` or a base64 payload is never mistaken for a hex colour.
   Token validity is decided by the canvas colour parser, which gets named
   colours, `oklch()`, `lab()` etc. for free and reliably rejects non-colours like
   `solid` or `to right`.
3. **Emit.** The result is one override stylesheet appended at the end of the
   document, with the original `@media` / `@supports` / `@container` / `@keyframes`
   context reconstructed around it. `@layer` blocks are deliberately re-emitted
   *unlayered*: for `!important` declarations the cascade reverses layer order, so
   unlayered is what keeps the overrides on top.

4. **Repair.** Rewriting rules cannot reach every colour (see below), so a final
   pass reads the *computed* styles of the rendered page and fixes what is still
   wrong: backgrounds that stayed light, text that lost its contrast, and borders
   that faded into their surface.

The page's own CSS is never mutated — inline `style` attributes are overridden via
a generated `[data-lumen-i]` rule rather than by writing to `element.style`, since
sites read their own inline styles back. Turning Lumen off restores the page
exactly.

### The repair pass

Rule rewriting alone leaves gaps, because a colour can reach the screen by routes
the walker cannot follow:

- a shorthand containing `var()` — `border: 1px solid var(--line)` — which CSSOM
  never expands into longhands, so the border role never sees it;
- a declaration in a cross-origin sheet that also carries a `url()`;
- a sheet that is neither readable nor fetchable (CSP, or an auth-gated CDN);
- a generically named custom property such as `--gray-900`, whose role cannot be
  guessed from its name — and which, used as a surface, would otherwise be
  *brightened* into a light box.

Rather than chase each route separately, the repair pass looks at what actually
rendered. Any element whose computed background is lighter than 0.42 cannot have
come from our own conversion — the background curve tops out at `bgMin + 0.22` —
so that element was missed wholesale, and all of its colours get the ordinary
role conversion. Text and borders are then checked for contrast against the
surface they sit on (4.0 and 2.0 respectively) and walked along HSL lightness,
hue held, until they clear it.

The text threshold is deliberately below WCAG AA: this repairs unreadable text,
it does not restyle legitimately muted body copy. The pass is idempotent — the
colours it writes already pass on the next run — and it costs roughly 0.003 ms
per element (about 20 ms for 6,000 elements), run inside `requestIdleCallback` so
it never competes with first paint.

That figure depends on one rule: **the scan never writes to the DOM.** Setting an
element's marker attribute mid-loop invalidates style, so the next element's
`getComputedStyle` forces a fresh recalculation of the whole document — one per
repaired element. Marker attributes are therefore batched into a commit step
after all the reading is done, and `verify()` likewise collects its failures
before applying any of them. Interleaving the two turned a 40 ms pass into 2.2
seconds.

The "missed" flag is inherited by descendants, because the text inside a missed
table lives on the cells, not on the table that gave itself away. Without that,
cell text gets dragged only just past the contrast floor into a muddy grey
instead of being converted properly.

Because the pass only ever acts on surfaces that are *too light* or contrast that
is *too low*, it cannot touch a dark code block: the block's background is
already dark and its text already legible.

### When the repair sheet loses the cascade

The repair sheet is the gentle option — it overrides nothing the page owns and
disappears cleanly on teardown. But `!important` ties are settled by specificity
before source order, and a rule like

```css
#main table.data { background: #fff !important; }
```

scores (1,1,1) against the repair selector's (0,3,0). An id always outranks
attribute selectors, so no amount of selector repetition wins that one. If such a
rule lives in a stylesheet we cannot rewrite, the element stays white.

So after applying the sheet, the pass reads the computed styles back and checks
that its own fixes actually took. For the few elements where they did not, it
escalates to an inline `!important`, which is the only thing left that beats an
author `!important`. Each escalation records the inline value it displaced, so
teardown puts the element back byte-for-byte. On a typical page this escalates
nothing; on the stress fixture it escalates exactly three elements while 21 other
fixes stay in the sheet.

### Interaction states

A page is not a still image. Rows highlight under the pointer, buttons darken
while pressed, a tab gets `aria-selected` and changes surface. Two separate
things went wrong there, and both are invisible in a screenshot.

The first is that our own corrections *froze* those states. A repair rule is
`!important` at (0,3,0), so it also outranks the page's own `.row:hover` rule —
which we did convert correctly, and which then never got to apply. The element
simply stopped responding to the pointer. The second is that a state can carry
colours the resting page never showed us at all: if `.row` came from a
stylesheet we could not read, so did `.row:hover`, and the first thing the
pointer does is paint it white.

Neither can be answered from the CSSOM, because the rules that produce them are
exactly the ones we cannot see. So the state is measured while the element is in
it — on `mouseover`, `focusin` and `pointerdown` — and the result is emitted
scoped to that pseudo-class:

```css
[data-lumen-r="7"]…:hover { background-color: #12181f !important; }
```

The one trick needed is that the repair sheet is switched **off** for the
duration of the read. Otherwise what comes back is our own correction of the
resting state, and the hover looks fine to us while being frozen on screen. A
sheet toggle plus the read plus the new rule all happen inside the event
handler, and the browser paints only when a task ends, so nothing intermediate
is ever shown and the fix lands in the same frame the state does. It costs about
0.18 ms per element on a 6,000-element page, once per element per state.

Three details are load-bearing:

- **Only ever an adjustment on top of the resting pass.** The pointer is
  somewhere from the first frame, so `body` is in `:hover` before the page has
  finished loading; probing then would file the page's *ordinary* corrections
  under `:hover` and leave the resting page uncorrected. Probes are ignored
  until a full repair pass has been over the document.
- **A rule scoped to an ancestor's state must lose to the element's own.**
  `.row:hover .cell` restyles descendants the pointer is not on, so a hovered
  element's subtree is measured too and emitted as `[row]:hover [cell]`. Both
  rules apply when the pointer is on the cell itself, and it is the one measured
  with the cell in the state that is right — so a self-state rule spends seven
  copies of the attribute selector against the scoped rule's six.
- **A class is not a pseudo-class.** `.selected`, `aria-current`, `open` and
  friends change which of the page's rules apply, with no CSS change to notice
  and no pseudo-class to scope a rule to. Those come through the
  `MutationObserver` — which now watches them, having previously watched only
  `style` — and re-measure the element's *resting* rules through the same
  unmasked path, because our own stale correction is sitting on top of whatever
  the page just changed. That path is batched and rate-limited: a busy page
  rewrites class attributes constantly, and each probe costs a style
  recalculation.

Selection gets an explicit `::selection` rule in the base sheet, without
`!important` so that a page which styles its own selection still wins. Chrome's
dark-mode default is a saturated blue, which on a page whose surfaces we have
deliberately kept near-neutral is the loudest thing on screen.

### Every element, in one pass where possible

The scan covers the whole document. There is no total element cap, and the way
that cap failed is worth recording: when it ran out mid-list the loop fell
through, lost its place in the list, and then marked the scan **complete**.
Everything past that point was silently never repaired — so on a long page,
identical elements came out converted near the top and left white further down,
with nothing in the CSS to explain the difference.

The scan is still resumable, and yields when the idle budget is spent, but only
after visiting at least 20,000 elements. That floor is bounded on both sides.
Too low and a big page needs many slices; idle callbacks are scarce on a busy
page and throttled hard in a background tab, so the scan crawls and surfaces stay
light for seconds. Too high and a single slice blocks the main thread. Since
separating reads from writes the scan costs about 0.003 ms per element, so the
floor is roughly a 60 ms ceiling per slice, and every ordinary page — and most
large ones — finishes in a single pass.

When a scan does have to slice, each slice publishes what it found rather than
holding everything back until the end. Waiting for completion means every surface
needing repair stays white for the whole scan.

### Late-arriving CSS

Stylesheets do not all arrive with the document. A syntax-highlighting theme, a
lazily injected component style, a deferred `<link>` — each lands after the first
pass has already run, and each restyles content that was converted correctly a
moment earlier.

Handling that on the ordinary 40 ms rebuild debounce means the new CSS paints
once *before* it is converted: the block shows up white and then inverts. So a
stylesheet mutation rebuilds **synchronously instead**. A `MutationObserver`
callback is delivered as a microtask, which runs before the browser paints, so
converting there lands the change in the very same frame it first applies. With a
warm sheet cache that rebuild is a millisecond or two, because only the new sheet
needs serialising.

That synchronous path is rate-limited to once per 100 ms. A CSS-in-JS runtime can
insert a stylesheet per component, and each rebuild walks the document; doing
that hundreds of times in a row pegs the main thread, the idle repair pass never
gets a slice, and elements that depend on it stay white. An occasional stylesheet
takes the synchronous path; a storm collapses into one debounced rebuild.

An added `<link>` needs one more thing: it has no stylesheet yet when it is
inserted, and when it finishes loading the CSSOM changes with no DOM mutation to
announce it. Every stylesheet link therefore gets a one-time `load` listener that
triggers the same synchronous rebuild, rather than waiting for the poll to notice.

### Changing a setting without flicker

Moving a slider invalidates every colour on the page. The repairs have to be torn
down first — they were measured against the old palette, and leaving them up
would have the new pass judging colours against stale corrections — but tearing
them down exposes the page's own light colours underneath.

The browser paints only when a task ends, so the whole re-application happens
inside a single task: drop the old repairs, rebuild the override sheet, run a
full repair pass with no idle deadline, escalate what needs escalating. Nothing
in between is ever put on screen. Splitting that work across an idle callback is
precisely what made the view flash white and then invert.

Two things keep that affordable. A settings change is only treated as a palette
change when the darkness, contrast or saturation values actually moved — toggling
a site or flipping *skip dark sites* leaves every colour where it was, and takes
a 0.7 ms path instead of a 50 ms one. And the popup coalesces slider writes: the
preview in the popup updates on every event, while the page follows at a few
frames a second and lands exactly on release.

### Details worth knowing

- **Custom properties.** `--card-bg: #fff` is rewritten at its definition, so
  everything using `var(--card-bg)` follows. The role is inferred from the name
  (`--*-border` → border, `--*-bg` → background, `--text-*` → foreground). With no
  usable hint the inversion is symmetric, because a variable holding a dark value
  is more often text than background, and invisible text is worse than a
  lightened panel.
- **Cross-origin stylesheets** throw on `.cssRules`. The service worker re-fetches
  them and they are re-parsed in a stylesheet whose media query can never match —
  the CSSOM is populated, nothing renders. Relative `url()`s in those sheets
  resolve against the wrong base, so declarations containing them are skipped.
- **CSS-in-JS.** Rules added with `insertRule()` (styled-components, emotion, and
  most CSS-in-JS runtimes) change no DOM node and fire no load event, so a
  `MutationObserver` never sees them and the poll is the only thing that ever
  can — which means the poll has to look at `adoptedStyleSheets` too, since a
  constructed sheet is in neither `document.styleSheets` nor the DOM, and one
  left out of the signature is one nothing can ever notice. It runs fast while
  the page is settling and then keeps a slow heartbeat indefinitely — stopping once things go quiet left anything injected later
  light for good. There is no visibility gate on it: the browser already
  throttles timers in a background tab, and gating meant a hidden tab never
  caught up.
- **Frames.** The content script is injected into frames whose origin is
  inherited rather than real — `about:blank`, `srcdoc`, `blob:` and `data:` —
  via `match_about_blank` and `match_origin_as_fallback`. Without those, an
  embedded widget renders entirely unconverted: white background, black text.
- **Gradient surfaces.** A surface can be painted entirely by `background-image`,
  leaving `background-color` transparent — input fields with a vertical sheen,
  striped code blocks. The repair pass reads the computed `background-image` too,
  whose stops are already resolved to `rgb()`, and runs them through the same
  value rewriter. Looking only at `background-color` left those white.
- **Autofill.** Chrome paints an autofilled control itself, and that painting
  ignores `background-color` — while the computed value still reports whatever
  the page asked for, so nothing downstream can tell the field is rendering
  white. The base sheet carries an explicit `:-webkit-autofill` rule using an
  inset shadow large enough to cover the control, plus `-webkit-text-fill-color`
  for the text on top.
- **No white flash.** A minimal dark base is painted at `document_start`, before
  the page's own CSS loads, and is swapped for the real override sheet as soon as
  there are stylesheets to read.
- **Already-dark sites are skipped.** If the page's own background is already
  dark, inverting it would just make it light. Detection reads the site's real
  background with the override sheets momentarily disabled. Toggle the site
  manually to override.

## Install

```bash
open -a "Google Chrome" --args --new-window "chrome://extensions"
```

Enable **Developer mode**, choose **Load unpacked**, and select this folder.
`tools/` is not referenced by the manifest and is ignored at runtime.

## Use

- Click the toolbar icon for per-site control and the appearance sliders.
- `Alt+Shift+D` toggles the current site.
- *Skip sites that are already dark* is on by default.
- Sliders: **Darkness** (how deep the background floor goes), **Text contrast**
  (how far text is lifted), **Color intensity** (saturation multiplier).

## Tests

Unit tests for the colour maths and the value scanner — no browser needed:

```bash
node tools/test.js
```

End-to-end against a fixture page that deliberately mixes light chrome, a dark
code block, a dark navbar, CSS variables, a media query, inline styles, a
cross-origin stylesheet, a stylesheet that is neither readable nor fetchable, a
CSS-in-JS sheet injected after load, shadow DOM and an image:

```bash
python3 tools/fixture/serve.py
```

`loading.html?lumen=1`, `order.html?lumen=1` and `whites.html?lumen=1` carry
their own assertions: call `window.runSpec()` in the
console and they return pass/fail per surface, so "is anything still white" and
"did it flash before inverting" are objective signals rather than judgement
calls. `loading.html` covers a late `<style>`, a late stylesheet on a textarea, a
large batch of nodes, and a rule injected by `insertRule()` after the poller has
settled. `order.html` puts identical elements at the top and bottom of a
24,000-element document, so anything that quietly gives up partway through shows
as one passing and the other failing.

Interaction states cannot be judged from the CSSOM — the only honest question is
what the pixel is while the pointer is actually on the element — so those have a
driver that hovers, focuses and presses each surface for real:

```bash
node tools/states-spec.js          # needs the fixture server above, and Playwright
```

It covers a hover, a press, a focus and a `.selected` toggle, for states defined
both in readable CSS and in the unreachable sheet, and asserts of each that it is
converted *and* that it actually moved off the resting colour.

Then open `http://localhost:8123/tools/fixture/index.html?lumen=1`, and
`stress.html?lumen=1` for the harder cases: nested tables and code styled by an
unreachable sheet, high-specificity `!important` rules that outrank the repair
selector, a stylesheet linked long after load, content hidden at scan time and
revealed later, and a large DOM. `window.report()` prints the measurements. The `?lumen=1`
harness loads the real engine into the page and drives it directly. Without the
query string you get the untouched light page, for before/after comparison.

`Lumen.engine` (`applySettings`, `rebuild`, `disable`, `active`) is also exposed
on any page the extension runs on, which is useful from the devtools console.

## Known limits

- Logos and icons shipped as dark-on-transparent images stay dark on the new dark
  background. Detecting these reliably needs per-pixel analysis and is defeated by
  cross-origin canvas restrictions.
- Colours set from JavaScript on a canvas, or baked into raster images, are out of
  reach — nothing short of a global filter can touch those, and a global filter is
  the approach this extension exists to avoid.
- Closed shadow roots are unreachable by design.
- The repair pass walks the light DOM only. Content inside open shadow roots is
  converted from that root's own stylesheets, but does not get the computed-style
  backstop.
- A page that rewrites an element's inline style after we escalate will win until
  the next pass notices and escalates again.
- An element that needed an inline escalation keeps its resting colours in every
  state: an inline `!important` is the last thing in the cascade and cannot be
  scoped to `:hover`. On a typical page this is nothing; on the stress fixture it
  is three elements.
- Interaction states inside open shadow roots are not probed, for the same reason
  the repair pass does not walk them — and because a pointer event is retargeted
  to the host before we see it.
