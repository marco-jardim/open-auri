# Decorative art layers (FUX.ART)

Rules: `docs/plans/fux-art-brief.md`. One component per page, `<Page>Art.svelte`, placed by the page as the first child of its root (which has `position: relative; isolation: isolate`).

Contract for every art component:

- Root element: `<div class="art-layer" aria-hidden="true" {@attach artVisibility}>`, `position: absolute; inset: 0; z-index: -1; pointer-events: none; overflow: hidden`.
- Heavy shapes are static files in `web/static/art/<page>/*.svg`, used as CSS `background-image` or `<img src alt="" aria-hidden="true" loading="lazy" decoding="async">`.
- Inline SVG only for strokes that draw in (`stroke-dasharray`) or parts that move.
- Animations: only `transform`, `opacity`, `stroke-dashoffset`, light `filter`.
- `:global([data-art='paused']) *` pauses animations; `[data-art-seen]` starts one-shot reveals.
- `@media (prefers-reduced-motion: reduce)` disables every animation and shows the final frame.
- Nothing may look like a live meter (plan §0.12.7).
- Text over the art keeps WCAG AA: low opacity, masks, vignettes.
