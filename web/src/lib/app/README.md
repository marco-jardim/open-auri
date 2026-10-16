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
- Real `cable:written` events feed back `levelDb`, mark the actual snapshot written and retain the
  journal/flash updates; simulated writes do not mark a real cable or clear editor dirtiness.
- `app.toasts.push(message, options)` uses the layout's per-app toast region.

Metadata deliberately leaves auth/account/profile/admin homages unset until F3/F4. Footer currently
requires an honoree, so the layout renders the default site homage (Robert Moog, Curva) for those
neutral-accent routes. No chrome component is modified. Andy Hildebrand and Toole/Olive have empty
`years`, because their canonical mock footers omit dates; no biographical data is invented.

The integration queue must merge the T2.9 staging messages and regenerate Paraglide before checking
the web application. Unit metadata tests accept staging or the merged catalogs after staging removal.
