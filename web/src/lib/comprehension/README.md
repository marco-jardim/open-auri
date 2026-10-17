# Comprehension integration (FUX.3)

## Page contract

Import `Tour`, `TourTrigger`, `Explainer` and `GlossaryLink` from
`#lib/components/comprehension/index.ts`. Mount one `<Tour page="curva" />`
alongside `<TourTrigger page="curva" />` in the page header (use the page ID below).
The default singleton coordinates both; tests or isolated hosts can inject the same
`controller={createTour(...)}` into both. No layout or page was edited by this task.

`Tour` auto-opens only on mount at a viewport width of at least 1024 CSS pixels and
only if that page has no saved status. Manual opening works on every viewport and
after dismissal/completion. Escape and Skip save `dispensado`; Finish saves `visto`.
Unmounting an unfinished tour also saves `dispensado`. The non-modal popover does
not trap focus, disable the background or scroll the page. A missing/offscreen
target puts the panel in the centre of the viewport instead.

Add these `data-tour` values to the actual controls/panels, in step order:

| Page ID      | `data-tour` values                                                                  |
| ------------ | ----------------------------------------------------------------------------------- |
| `curva`      | `curva-layers`, `curva-chart`, `curva-presets`, `curva-write`                       |
| `comunidade` | `comunidade-channels`, `comunidade-scope`, `comunidade-publish`, `comunidade-blind` |
| `cabo`       | `cabo-connect`, `cabo-bytes`, `cabo-checklist`, `cabo-tape`, `cabo-journal`         |
| `soe-como-x` | `soe-headphone`, `soe-target`, `soe-solver`, `soe-ab`, `soe-editor`                 |
| `comparar`   | `comparar-tracks`, `comparar-arm`, `comparar-level`                                 |
| `teste-cego` | `cego-prepare`, `cego-listen`, `cego-result`                                        |
| `biblioteca` | `biblioteca-shelf`, `biblioteca-card`, `biblioteca-share`                           |

Selectors are exactly `[data-tour="<value>"]`. Definitions and localized getters
are in `steps.ts`: 27 steps total. Curva wording is literal from spec section 4.2.

## Explainers, glossary and empty states

`<Explainer term="preamp" />` uses IDs from `explainers.ts`; `gate-a` through
`gate-g` link to the `gate` glossary term. `gateReasonContext()` provides the
localized whole-curve context when the gate has no section index. All official
section 4.3 bodies are retained verbatim. Bodies longer than three sentences have
a short preview plus a disclosure containing the complete official text.
The checklist explanation also displays the literal loudness warning. This does
not replace the mandatory, always-visible warning on the actual write screen.

The fixed manual popovers enter the browser top layer to escape overflow and
transformed ancestors. They close with Escape or the close button; explainers
also close on click outside, returning focus to their trigger.

`<GlossaryLink term="s6" />` displays natural language, never the technical ID.
Docs integration must supply all 17 IDs from `glossary.ts` as `g-<term>` anchors
(FUX.P7), then run the anchor-navigation e2e owned by that page task.

All new copy is in `messages/_staging/FUX.3.{pt-BR,en-US}.json`, including the
official empty states under `empty_`. Merge both staging files and regenerate
Paraglide **before** typechecking or executing components. Imports match the
repository's current `{ m } from '#lib/paraglide/messages.js'` convention.

Empty-state page tasks must add the three non-interactive EXAMPLE channels/tape
boxes, use `empty_example_unpublished` for example channels, keep the visitor
account invitation in a single card, and retain all ten neutral points and their
safe box on focus. No sample is a published curve or a measured signal.

## Local-only storage

`oa.tour.v1` contains `{ [page]: "visto" | "dispensado" }`, never network data.
`tour.svelte.ts` has lazy SSR-safe access, validated JSON, observable error status
and an in-memory fallback for blocked storage. API: `shouldAutoOpen(page)`,
`open(page)`, `markSeen(page)`, `dismiss(page)`, `reset(page?)`; `goTo(index)` is
used by the component. A full reset removes the storage key.

The existing Docs clear-local-data module already removes every `oa.*` key;
its contract comment and real IndexedDB deletion test now explicitly cover
`oa.tour.v1`. The orchestrator must also add this key to the storage contract in
the main plan, section 4.3 (outside this task's write set).

## T15 integration queue

`_qa/fux3-t15-overrides.json` contains **33 existing-key overrides per locale**
(66 values). Apply these in the catalog integration queue; no main message file
was edited, and no old key needs deletion. Both replacement sets have identical
keys. This removes codes from body copy as well as headings.

The only catalog exclusion is `docs_thresholds` in both locales: the technical
Docs section explicitly discusses the versioned gate and its exact thresholds.
No T/F plan-code values were found in the main catalogs.

Hard-coded visible strings for page owners to replace (comments excluded):

- `web/src/lib/components/pages/soe-como-x/Workstation.svelte:642`: `GATE v2 · Q27 / Q23`.
- `web/src/lib/components/pages/biblioteca/MeterBridge.svelte:77`: `S4 · RMS ...`.
- `web/src/lib/components/pages/biblioteca/Biblioteca.svelte:330`: `S9 / VOL. 01`.
- `web/src/lib/components/pages/curva/Cabinet.svelte:116`: `S{index + 1}`.
- `web/src/lib/components/pages/comunidade/TotalRecall.svelte:258`: `S{row.index + 1}`.

The last two are section-number labels rather than sharing-feature headings;
replace with localized “Section {index}” / “Seção {index}” to remove ambiguity.

## Central verification (not executed by this task)

Run from the repository root after merging staging and regenerating Paraglide:

```sh
npm run -w web check
npm run -w web test:unit -- tests/unit/comprehension tests/unit/pages/docs/clear-local-data.test.ts
```

The unit tests cover corrupt/unavailable storage, SSR, auto-open rules and reset;
component tests cover keyboard/focus/ARIA, background use, missing targets,
overflow clipping and both locales. Copy tests enforce all glossary terms, all
step translations, literal official copy, T15 coverage and no pt-BR em dash.

A1 visual comparison, A2 axe, A3 route budgets and A4 executed results remain for
central/page QA. A5 reduced-motion disables the highlight transition; A6 has copy
guards and no pre-existing literal was edited; A7 this layer never imports the
cable or audio engine; A8 all task edits stay in the dispatch's allowed paths.

## Loading (FUX.B budget pass)

Pages keep only light modules in their initial JS: `Tour.svelte` (host: auto-open, Escape,
dismiss on unmount), `TourTrigger.svelte`, `tour.svelte.ts`, `Explainer.svelte` (trigger) with
`explainer-titles.ts` (term + title per explainer, for the accessible name) and `glossary.ts`.
The prose is lazy: `TourPanel.svelte` (with `steps.ts`) loads when a tour opens or on hover/focus
of its trigger; `ExplainerPanel.svelte` (with the bodies in `explainers.ts`) loads on hover, focus
or press of an explainer trigger, and the explanation opens once it is there. One shared loader
each (`components/comprehension/panels.ts`); a failed import is retried on the next intent.
The page barrel no longer re-exports `tourSteps`, `explainers` or `gateReasonContext`: import
them from their modules (Docs prints every body, so it imports `explainers.ts` statically).
