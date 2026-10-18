# Client state

Import factories from `#lib/state/index.ts` (or the individual `*.svelte.ts` modules).
Own one `createClientState()` in the client layout/context and call `dispose()` on teardown.
There is deliberately no module singleton: importing these modules never reads `window`, and
separate SSR requests cannot share mutable state. Locale remains exclusively in Paraglide.

All store properties are rune-backed getters. Do not destructure reactive properties outside a
reactive context. All stores expose `error: StorageFailure | null` and `dispose()`.

- `createCurveStore({storage?, now?})`: properties `current`, `dirty`, `unsaved`, `lastWritten`,
  `canUndo`, `canRedo`, `undoCount`, `redoCount`, `labels`; actions `set(CurveData)`, `update(Partial<CurveData>)`,
  `loadPreset(id)`, `undo()`, `redo()`, `markWritten(snapshot?)`, `setLabels(labels)`. `labels` (custom
  band names by slot) is client state only: never persisted, not undoable, cleared when a curve
  with a source other than `custom` is set.
- `createJournalStore({storage?})`: properties `entries`, `dropped`; action `append(entry)`.
- `createFlashStore({storage?, now?})`: property `state`; actions `canWriteNow(at?)`,
  `dailyNotice(at?)`, `recordWrite(at?)`.
- `createMeterRefStore({storage?})`: property `value`; action `set(-18 | -20 | -14)`.
- `createLibraryStore({storage?, now?, id?})`: properties `items`, `loading`; promise `ready`;
  actions `save(LibraryInput)`, `setFavorite(id, boolean)`, `remove(id)`, `list()`, `refresh()`.
- `createOutboxStore({storage?, now?, id?})`: properties `events`, `loading`; promise `ready`;
  actions `append({id?, type, payload, updatedAt?})`, `list()`, `remove(id)`, `refresh()`.

`createClientState(options?)` owns a shared adapter and all six stores, exposes them as
`storage`, `curve`, `journal`, `flash`, `meterRef`, `library`, `outbox`, and exposes a combined
`ready` promise. Pass `now` for an injected epoch-millisecond clock. Factories with an injected
adapter do not dispose that adapter themselves.

## Persistence and safety

- `oa.current` stores the exact schema-1 contract, with immutable core `snapshotBands` and
  `checkBand` validation. Invalid values load Neutro from the catalog. This is structural/codec
  validation, **not permission to send a curve to hardware**. Transport must still run its gate.
- Undo and redo keep at most 100 snapshots each. Edits/undo/redo persist with monotonic
  `updatedAt`; external newer curves invalidate local history. The backing value resolves a
  same-timestamp race. Removing the backing key resets the current curve to Neutro.
- `dirty` starts true because cable contents are unknown. `markWritten` is explicit and must
  receive the snapshot actually sent after a **real successful** write. It never runs on edit,
  preview, journal append, or simulated write. Metadata changes do not make DSP bytes dirty.
- The written snapshot persists in `oa.curve.written` (same schema-1 contract as `oa.current`,
  parsed defensively: invalid values are dropped and reported as `invalid`), so reloading after
  a real write stays clean. Other tabs pick it up through the storage event.
- `unsaved` is the boolean the chrome renders ("unsaved changes on the cable"). Decision
  (FX2.3/E1): `dirty` keeps its conservative meaning, but `unsaved` is true only when `dirty`
  **and** either a real write was ever recorded (`lastWritten !== null`) or the user changed the
  curve in this session (`set`/`update`/`loadPreset`/`undo`/`redo` that actually changed it). A
  fresh profile that never wrote shows no indicator on first load; the pre-write checklist still
  treats unknown cable contents as unknown. Use `dirty` for safety logic, `unsaved` for chrome.
- Journal parsing, validation, serialization and its 500-entry FIFO belong to the core.
  Cross-tab appends merge validated unique records in timestamp order.
- Flash parsing, counters, cooldown rebasing and the daily notice belong to the core. Session
  counters stay in sessionStorage; shared counters synchronize without importing another tab's
  session. `recordWrite` records completed writes, not attempts or simulations; callers honor
  `canWriteNow` before initiating transport. The notice is not a write cap.
- IndexedDB database `open-auri`, version 1, contains `audio` (out-of-line key `current`),
  `library` (keyPath `id`), and `outbox` (keyPath `id`). Audio content belongs to the audio
  engine, not these stores. Library items have exactly `id`, `name`, `source`, `preampDb`,
  `bands`, `s1`, `favorite`, `createdAt`, `updatedAt`. `s1` is generated/validated by the core.
- Library deduplication uses core `canonKey` inside a read/write transaction, including across
  tabs. Deduplication never sorts the actual wire-order bands. Explicit older `updatedAt`
  inputs cannot replace newer library/outbox records. BroadcastChannel `open-auri` invalidates
  readers after committed IndexedDB changes; readers reload authoritative transactional data.
- Outbox events contain `id`, `type`, JSON `payload`, `createdAt`, `updatedAt`. Events stay
  pending until explicitly removed; this module performs no network requests.

## Adapter

`createStorage({local?, session?, indexedDB?, listen?, channel?})` accepts injected backends;
`null` explicitly disables one. `listen` supplies normalized storage events; `channel` creates
a BroadcastChannel-compatible endpoint. Browser defaults are resolved only at construction.

`read`/`write` wrap string storage, `loadRecords`/`updateRecords` wrap library/outbox transactions,
and `onStorage`/`onDatabase`/`onError` return unsubscribe functions. The internal merge helpers
`readPersisted` and `acceptExternal` let timestamp-aware stores replace a failed-write overlay
only when accepting authoritative external data.

Quota and access failures never escape storage operations: edits remain in memory and a
reactive error (`quota`, `unavailable`, or `invalid`) is surfaced. Failed string writes can be
retried on the next edit. After an IndexedDB write failure, that store remains memory-backed
for this adapter's lifetime to avoid dropping pending changes on refresh. No persistence is
promised across reload after failure. Errors remain visible for the lifetime of the adapter.
