# Page integration (W2.4)

```svelte
<script lang="ts">
	import { getAppContext } from '#lib/app/index.ts';

	// Run during component initialization. Do not destructure .client before mount.
	const context = getAppContext();
	const app = $derived(context.client); // null in SSR and before browser mount
	const curve = $derived(app?.state.curve.current);
</script>
```

- The root layout alone owns browser initialization, restore and disposal. No page should call
  `createClientState`, `createCableService`, `createClientApp` or `context.mount`.
- `client` is `null` in SSR and until the runtime chunk has loaded (see "Loading" below). A page
  must render with `client === null` (skeleton with the final geometry, never an error) and react
  when it appears; `context.status` is `idle | loading | ready | error`.
- `app.state` provides `curve`, `journal`, `flash`, `meterRef`, `library`, `outbox`, `storage`, `ready`.
  Change the editor with `app.state.curve.set/update/loadPreset`; use its undo/redo and dirty getters.
- `app.audio` is `getAudioEngine()` shared with the chrome AudioLoader. Build/dispose page preview
  chains on this engine, not a second engine. Start playback only in a user gesture. Do not dispose
  the shared engine when a page unmounts; dispose only that page's chains/subscriptions.
- `app.cableState` is reactive; `app.cable` exposes the service's status, subscription, events,
  connect/disconnect and device selection APIs. Call `connect()` directly from a click.
- **Never call `write`, `writeQueue` or `createGesture` from pages.** Use `app.requestWrite()` for
  the current editor, or `app.requestWrite(currentCurveSnapshot)` for a different curve. The layout
  freezes that selection, opens PreWriteChecklist and lets only its confirmation handler mint the
  gesture and call the service. `requestRescue()` selects NEUTRAL_CURVE without changing the editor.
- `app.loadNeutral()` and `app.loadAuriDefault()` are editor-only actions and never write.
- Real `cable:written` events mark the actual snapshot written; simulated writes do not mark a real
  cable or clear editor dirtiness. The last written level (loudness "jump" warning) is derived from
  the newest `ok` journal entry (`journal.lastOk`), so it survives reloads and other tabs.
- Writes are exclusive across tabs: the service holds the Web Lock `oa-cable-write` from the
  in-lock checklist through settle and refuses `busy` otherwise. Before any I/O it persists the
  `localStorage` marker `oa.cable.inflight` and records the flash attempt (counters + lastWriteAt);
  when the sequence ends it only moves `lastWriteAt` to that time (`flash.touchWrite`), so the 2 s
  spacing runs from the end of the write. A marker left by a tab closed mid-write becomes an
  `interrupted` journal entry and the rescue notice on the next start, or at once in any open tab
  that saw the marker appear (it waits for the writer's lock and then only records). A write that
  finds such a marker is refused with `interrupted-elsewhere`. An X9 queue journals (and emits
  `cable:written` for) each cable as it commits; between cables the marker is flagged `between`.
- **Old-build tabs (accepted risk, #18):** During the PWA service worker update flow, a tab
  still running the previous build ignores `between` and may record an already-written cable
  as `interrupted`, showing a false rescue warning. This fails on the safe side, so #18 accepts
  documentation rather than a compatibility change. The risk is limited to the mixed-build
  update window, and the shared `oa-cable-write` lock still allows only one writer across tabs.
  Revisit marker versioning if its format changes again.
- A restored cable is never chosen silently: with several cables the target stays unset until the
  user selects one (CableStatus or the checklist); the checklist always shows the target label.
  Unplugging the target never makes another cable the target, and the checklist asks for its
  confirmations again whenever the target changes.
- `requestWrite(curve)` copies with `$state.snapshot`, so a page may pass a deep `$state` value.
  `closeChecklist()` asked during a write closes the checklist when that write ends; the checklist
  dialog itself cannot be dismissed mid-write (it reopens if the browser forces it closed).
- While a write sends bytes, `isWriteInProgress()` (`#lib/cable/index.ts`, mirrors
  `window.__oaWriteInProgress`) is true; anything that reloads the page (PWA update, language
  toggle) must refuse then.
- Cabo/rack flash counters come from `app.cable.counters()`, the same source as the checklist.
- `app.toasts.push(message, options)` uses the layout's per-app toast region. The layout creates
  that store before the runtime loads and injects it (`ClientAppOptions.toasts`).

## Loading (FUX.2, spec `docs/plans/fux-spec.md` §5.3 and §5.4)

- The runtime (`client.svelte.ts`: catalog, safety, policy, audio engine, cable service, state)
  is a dynamic chunk loaded by `loadAppRuntime()` (`runtime.ts`). `context.mount(options,
{ prepare })` is async: it imports the chunk, creates the app, awaits `prepare(app)` and only
  then publishes `client`. The layout's `prepare` attaches the social outbox bridge, so no real
  `cable:written` event can happen before the bridge listens.
- When the layout imports it:
  - at once, during hydration, on instrument routes (`INSTRUMENT_ROUTES`: `/`, `/comparar`,
    `/soe-como-x`, `/cabo`, `/teste-cego`, `/biblioteca`, `/comunidade`, `/c/[id]`,
    `/u/[apelido]`) and whenever `localStorage['oa.cable.inflight']` holds a marker (read
    synchronously, `hasInflightMarker()`), so the rescue notice never waits;
  - otherwise on idle (`whenIdle`, `requestIdleCallback` with a 1500 ms timeout), or on the first
    pointer, press or focus on the bar's tools or status, whichever comes first.
- Import path: `#lib/app/index.ts` re-exports the `createClientApp` value, which keeps the
  runtime in the static closure of whatever imports the barrel (fine for instrument pages: no
  load cascade). Chrome and any module on a static route (Docs, auth, legal, offline) imports
  `getAppContext` from `#lib/app/context.svelte.ts` and types from `#lib/app/client.svelte.ts`.
- Chrome islands are lazy (`LazyModule`, `lazy.svelte.ts`): PreWriteChecklist (with a pending
  write), CableStatus (first open of the status popover), RescueNotice (marker or rescue state),
  the AudioLoader panel (first hover, focus or press of its trigger), HelpOverlay (when opened),
  UpdatePrompt (idle) and PolicyBanner (only with an unseen version). A checklist chunk that
  cannot load closes the pending write and shows an error toast; nothing is ever written.
- `data-runtime` on `.app-root` mirrors `context.status` (e2e `loading.spec.ts`).

### Warm-up helpers (stable API for page tasks)

| Helper                                                              | Module                | Use                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warmAudio(engine?: AudioEngine \| null): Promise<boolean>`         | `#lib/audio/warm.ts`  | On `pointerdown`/`keydown` of a play control: creates or resumes the AudioContext (bounded wait) and adds the meter worklet. Never plays, never rejects; `true` when the context runs with the worklet loaded. |
| `warmAudioOnPress(engine?: () => AudioEngine \| null \| undefined)` | `#lib/audio/warm.ts`  | Svelte attachment for the same: `<button {@attach warmAudioOnPress(() => app?.audio)} onclick={play}>`. Primary button or Enter/Space only.                                                                    |
| `prefetchMeterWorklet(): Promise<string \| null>`                   | `#lib/audio/warm.ts`  | Idle prefetch of the worklet module on meter pages (`<link rel="prefetch">`).                                                                                                                                  |
| `warmGateWorker(): Promise<string \| null>`                         | `#lib/app/warm.ts`    | Idle after the first paint on Curva, Soe como X and Comparar: prefetches the gate worker bundle; creates no worker.                                                                                            |
| `warmSolverWorker(): Promise<string \| null>`                       | `#lib/app/warm.ts`    | When the Soe como X search gets focus: prefetches the solver worker bundle.                                                                                                                                    |
| `whenIdle(callback, timeout = 1500): () => void`                    | `#lib/app/runtime.ts` | Idle scheduling with a fallback timer; returns a cancel function.                                                                                                                                              |

Example: `onMount(() => whenIdle(() => void warmGateWorker()))`.

Metadata deliberately leaves auth/account/profile/admin homages unset until F3/F4. Footer currently
requires an honoree, so the layout renders the default site homage (Robert Moog, Curva) for those
neutral-accent routes. No chrome component is modified. Andy Hildebrand and Toole/Olive have empty
`years`, because their canonical mock footers omit dates; no biographical data is invented.

The integration queue must merge the T2.9 staging messages and regenerate Paraglide before checking
the web application. Unit metadata tests accept staging or the merged catalogs after staging removal.
