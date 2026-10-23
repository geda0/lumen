# Progress

## Slice: the light flash on Tailwind pages (`flicker-varalpha` / `flicker-firstpaint`)

**Symptom.** On experts.afterquery.com the card painted white, with near-black
unreadable text, then corrected itself a few hundred milliseconds later — and did it
again on every client-side route change.

**Cause.** Tailwind compiles its whole palette to `rgb(255 255 255 / var(--tw-bg-opacity, 1))`.
`CSS.modifyValue` returned `null` for that shape (the canvas parser cannot read a
`var()`), so the synchronous rule walker converted none of it and every surface fell
through to the asynchronous repair pass. The page therefore painted in its own light
colours first. Not a regression — this shape was never handled.

**Fix.** `varAlpha()` in `src/content/css.js` splits a colour function whose alpha is a
`var()`, converts the channels, and re-emits with the var handed back untouched. A var
among the *channels* is still refused: there is no colour to read.

### Cycles

| # | layer | red | green |
|---|---|---|---|
| 1 | unit | 3 failing checks in `tools/test.js` (`modifyValue` → null) | 89 passed, 0 failed |
| 2 | browser | `flicker-spec` 3/7 — card `rgb(255,255,255)` l=1.00 on first paint | 7/7 |

The browser red was proven by backing the fix out of `src/content/css.js` and re-running,
so the spec is known to have teeth rather than assumed to.

### Evidence

- Settled rendering vs base `36d546a`: **30,332 elements across 6 fixtures, 0 differ** —
  the fix changes *when* a colour lands, not *what* it is.
- 27,570-element Tailwind-shaped page: first paint white → dark; repair sheet
  **154 KB → 0 KB**; hover median 22 → 17 ms; hover long tasks 1 → 0; enable 58 → 88 ms
  (the rule walker now does work the repair pass used to).

### Harness added for this slice

`tools/pw.js` (resolve Playwright + pin the container's Chromium — the specs hard-coded
one path), `tools/run-suite.js` (both layers, starts/stops the fixture server),
`tools/fixture/tailwind.html`, `tools/flicker-spec.js`.

### Open

- `color-mix(... rgb(255 255 255 / var(--x)) ...)` is still not converted. Pre-existing,
  out of this slice's scope.
