<!--
	Curva page (homage: Robert Moog). Container for the three layers Ouvir ⊂ Ajustar ⊂ Engenharia.
	- The layer comes from the route (`?camada=`) as a prop; changes go back through `onlayer`.
	- Editor state is `app.state.curve` (undo/redo/dirty); every change is gate-approved first
	  (macros, drags, typed values, kinds, reorders, imports, links).
	- Writing is only ever `app.requestWrite()` / `app.requestRescue()` (layout checklist).
	- Works without `app` (SSR, before mount): renders Neutro read-only.
-->
<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { slide } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
	import type { ClientApp } from '#lib/app/index.ts';
	import { createGateWorker } from '#lib/workers/index.ts';
	import { curveSignature } from '#lib/state/model.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import Cabinet from './Cabinet.svelte';
	import FilterBank from './FilterBank.svelte';
	import ImportExport from './ImportExport.svelte';
	import LayerSelector from './LayerSelector.svelte';
	import MacroKnobs from './MacroKnobs.svelte';
	import OutputPanel from './OutputPanel.svelte';
	import PresetTabs from './PresetTabs.svelte';
	import RescuePanel from './RescuePanel.svelte';
	import ScopePanel from './ScopePanel.svelte';
	import SocialActions from './SocialActions.svelte';
	import { currentS1 } from './social.ts';
	import {
		dragBand,
		isAbortError,
		releaseBand,
		withTarget,
		type DragTarget,
		type DragView,
		type GateClient
	} from './drag.ts';
	import { changeKind, defaultOrder, maxPreamp, moveSection, reorderSections } from './edit.ts';
	import { formatSignedDb, payloadCrc } from './format.ts';
	import { readLinkHash, type ImportResult } from './io.ts';
	import { ioFailureText } from './io-text.ts';
	import {
		includesLayer,
		isLayerKeyEvent,
		isLockedKind,
		layerFromKey,
		type Layer,
		type UrlLike
	} from './layers.ts';
	import {
		MACROS,
		macroScope,
		proposeMacro,
		ZERO_MACROS,
		type MacroId,
		type MacroValues
	} from './macros.ts';
	import {
		activeCount,
		hasExperimental,
		hasGain,
		replaceBand,
		verdictFor,
		type Band,
		type BandKind,
		type Curve
	} from './model.ts';
	import { CurvaPreview } from './preview.svelte.ts';
	import { firstReasonText, type Reason } from './reasons.ts';

	interface Props {
		app: ClientApp | null;
		layer: Layer;
		/** `page.url.hash` (each new `#p=` link is consumed once). */
		hash: string;
		/** `page.url` (only its `href` is read, on user actions). */
		pageUrl: UrlLike;
		onlayer: (layer: Layer) => void;
		/** Test injection; defaults to the gate Web Worker client. */
		gateClient?: GateClient;
		/**
		 * Removes the consumed `#p=` link from the address bar, so a reload does not apply it again.
		 * Defaults to `history.replaceState`, keeping the router's history state.
		 */
		clearLinkHash?: () => void;
	}
	let { app, layer, hash, pageUrl, onlayer, gateClient, clearLinkHash }: Props = $props();

	/** Drops `#p=…` from the address bar without a navigation (path, query and state are kept). */
	function clearAddressLink(): void {
		if (typeof window === 'undefined' || !window.location.hash.startsWith('#p=')) return;
		const { pathname, search } = window.location;
		window.history.replaceState(window.history.state, '', pathname + search);
	}

	const injected = untrack(() => gateClient);
	const owned = injected === undefined ? createGateWorker() : null;
	const gate: GateClient = injected ?? owned ?? createGateWorker();
	onDestroy(() => owned?.dispose());

	const locale = getLocale();
	const titleId = $props.id();
	const neutral: Curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };

	const stored = $derived(app?.state.curve.current ?? null);
	const curve = $derived<Curve>(stored ?? neutral);
	const signature = $derived(curveSignature(curve));
	const verdict = $derived(verdictFor(curve));
	const experimental = $derived(hasExperimental(curve.bands));
	const crc = $derived(verdict.metrics.payload ? payloadCrc(verdict.metrics.payload) : '…');
	const activePreset = $derived(
		stored?.source.startsWith('preset:') ? stored.source.slice('preset:'.length) : null
	);
	const curveName = $derived(stored?.name ?? NEUTRO.label);
	const motionMs = $derived(prefersReducedMotion.current ? 0 : 280);

	let draft = $state.raw<Curve | null>(null);
	const display = $derived(draft ?? curve);
	let dragMessage = $state<string | null>(null);
	let dragTone = $state<'info' | 'danger'>('info');
	let dragView = $state.raw<DragView | null>(null);
	let shake = $state<number | null>(null);
	let bankMessage = $state<string | null>(null);
	let cabMessage = $state<string | null>(null);
	let macroMessage = $state<string | null>(null);
	let selected = $state(0);
	let refused = $state<number | null>(null);
	let announcement = $state('');

	// --- editor writes (never the cable) ------------------------------------------------------

	function apply(next: Curve, meta: { name?: string; source?: 'custom' | 'import' } = {}): boolean {
		if (!app) return false;
		return app.state.curve.set({
			name: meta.name ?? app.state.curve.current.name,
			source: meta.source ?? 'custom',
			preampDb: next.preampDb,
			bands: next.bands
		});
	}
	function notify(message: string, tone: 'info' | 'error' = 'info') {
		announcement = message;
		app?.toasts.push(message, { tone });
	}

	// --- free drags with an advisory gate, gate-decided releases ----------------------------------
	//
	// Pointer moves never wait for the gate: the handle and the drawn curve follow the pointer on
	// every animation frame (`draft`, never written anywhere), while the worker judges the latest
	// position on the drag grid in the background (one request in flight, the newest position
	// queued). The verdict only colours the handle and explains itself. Release (and keys, wheel,
	// typed values) goes through `releaseBand`: full grid on the exact target, else the last safe
	// point, else back to the start, animated.

	// Pointer, key and wheel handlers only run in the browser, where animation frames exist.
	const schedule = (callback: FrameRequestCallback) => requestAnimationFrame(callback);
	const unschedule = (handle: number) => cancelAnimationFrame(handle);

	let dragToken = 0;
	let advisoryGeneration = 0;
	let advisoryBusy = false;
	let advisoryNext: { index: number; target: DragTarget } | null = null;
	let pendingDraft: { index: number; target: DragTarget } | null = null;
	let draftFrame: number | null = null;
	let settleFrame: number | null = null;
	let shakeTimer: ReturnType<typeof setTimeout> | undefined;

	function gateFailed(cause: unknown) {
		console.error('Gate worker failed', cause);
		dragMessage = m.curva_gate_error();
		dragTone = 'danger';
	}

	/** The curve with one band moved to `target` (drawing only; never committed as such). */
	function moved(start: Curve, index: number, target: DragTarget): Curve {
		const band = start.bands[index];
		if (!band) return start;
		return {
			bands: replaceBand(start.bands, index, withTarget(band, target)),
			preampDb: start.preampDb
		};
	}

	function cancelFrames() {
		if (draftFrame !== null) unschedule(draftFrame);
		if (settleFrame !== null) unschedule(settleFrame);
		draftFrame = null;
		settleFrame = null;
		pendingDraft = null;
	}

	function onDrag(index: number, target: DragTarget) {
		if (!app) return;
		if (settleFrame !== null) {
			unschedule(settleFrame);
			settleFrame = null;
		}
		if (dragView?.index !== index) dragView = { index, status: 'checking' };
		pendingDraft = { index, target };
		draftFrame ??= schedule(() => {
			draftFrame = null;
			const next = pendingDraft;
			pendingDraft = null;
			if (next) draft = moved(curve, next.index, next.target);
		});
		advise(index, target);
	}

	/** Advisory verdict for the newest position; never blocks and never moves the handle. */
	function advise(index: number, target: DragTarget) {
		if (advisoryBusy) {
			advisoryNext = { index, target };
			return;
		}
		advisoryBusy = true;
		const generation = advisoryGeneration;
		const start = curve;
		const candidate = moved(start, index, target);
		// The worker's bisection needs an accepted start; otherwise judge the candidate directly.
		const verdictOf = verdict.ok
			? dragBand(gate, start, index, target, experimental).then((result) => ({
					refused: result.stopped,
					reasons: result.reasons
				}))
			: gate
					.commit({ bands: candidate.bands.slice(), preampDb: candidate.preampDb, experimental })
					.then((result) => ({ refused: !result.verdict.ok, reasons: result.verdict.reasons }));
		verdictOf
			.then(
				(result) => {
					// A newer position is queued: this answer is already stale.
					if (generation !== advisoryGeneration || advisoryNext) return;
					dragView = { index, status: result.refused ? 'outside' : 'inside' };
					if (result.refused) {
						dragMessage = m.curva_drag_outside({ reason: explain(result.reasons, candidate) });
						dragTone = 'danger';
					} else {
						dragMessage = null;
					}
				},
				(cause: unknown) => {
					if (generation === advisoryGeneration && !isAbortError(cause)) gateFailed(cause);
				}
			)
			.finally(() => {
				advisoryBusy = false;
				const next = advisoryNext;
				advisoryNext = null;
				if (next && generation === advisoryGeneration) advise(next.index, next.target);
			});
	}

	function explain(reasons: readonly Reason[], judged: Curve): string {
		return firstReasonText(reasons, { bands: judged.bands, locale });
	}

	/** Eases the drawn band from where it was released to where it ended (refused releases). */
	function settle(from: Curve | null, to: Curve, index: number) {
		const a = from?.bands[index];
		const b = to.bands[index];
		if (!a || !b || a.kind === 'OFF' || b.kind === 'OFF' || a.kind !== b.kind || motionMs === 0) {
			draft = null;
			return;
		}
		const started = performance.now();
		const duration = 300;
		const ratio = (x: number, y: number, t: number) => x * Math.pow(y / x, t);
		const frame = (now: number) => {
			const t = Math.min(1, (now - started) / duration);
			if (t >= 1) {
				settleFrame = null;
				draft = null;
				return;
			}
			const e = 1 - Math.pow(1 - t, 3);
			const tween: DragTarget = {
				freqHz: ratio(a.freqHz, b.freqHz, e),
				qFactor: ratio(a.qFactor, b.qFactor, e)
			};
			if (hasGain(a) && hasGain(b)) tween.gainDb = a.gainDb + (b.gainDb - a.gainDb) * e;
			const band: Band = withTarget(b, tween);
			draft = { bands: replaceBand(to.bands, index, band), preampDb: to.preampDb };
			settleFrame = schedule(frame);
		};
		settleFrame = schedule(frame);
	}

	/** Refused release: the handle shakes once (CSS, off under reduced motion). */
	function shakeHandle(index: number) {
		clearTimeout(shakeTimer);
		shake = index;
		shakeTimer = setTimeout(() => (shake = null), 450);
	}

	async function onCommit(
		index: number,
		target: DragTarget,
		report: (message: string | null, tone: 'info' | 'danger') => void = (message, tone) => {
			dragMessage = message;
			dragTone = tone;
		}
	) {
		if (!app) return;
		const token = ++dragToken;
		advisoryGeneration++;
		advisoryNext = null;
		cancelFrames();
		const start = curve;
		const released = draft;
		dragView = null;
		try {
			const result = await releaseBand(gate, start, index, target, experimental, verdict.ok);
			if (token !== dragToken) return;
			if (result.committed) apply(result);
			if (result.outcome === 'exact') {
				draft = null;
				report(null, 'info');
				return;
			}
			const reason = explain(result.reasons, moved(start, index, target));
			const band = String(index + 1);
			report(
				result.outcome === 'snapped'
					? m.curva_drag_snapped({ index: band, reason })
					: m.curva_drag_reverted({ index: band, reason }),
				'danger'
			);
			shakeHandle(index);
			settle(released, result.committed ? result : start, index);
		} catch (cause) {
			if (token === dragToken) draft = null;
			if (!isAbortError(cause)) gateFailed(cause);
		}
	}
	onDestroy(() => {
		advisoryGeneration++;
		cancelFrames();
		clearTimeout(shakeTimer);
	});

	// --- macros (Ouvir) ------------------------------------------------------------------------

	let macroBase = $state.raw<Curve | null>(null);
	let macroValues = $state.raw<MacroValues>(ZERO_MACROS);
	let macroSignature = $state<string | null>(null);
	const macrosLive = $derived(macroBase !== null && macroSignature === signature);
	const shownMacros = $derived(macrosLive ? macroValues : ZERO_MACROS);
	const macroScopes = $derived(
		MACROS.map((_, index) => macroScope((macrosLive && macroBase ? macroBase : curve).bands, index))
	);
	const macroNames: Record<MacroId, () => string> = {
		bass: () => m.curva_macro_bass(),
		body: () => m.curva_macro_body(),
		presence: () => m.curva_macro_presence(),
		air: () => m.curva_macro_air()
	};

	function onMacro(index: number, value: number) {
		if (!app) return;
		const base = macrosLive && macroBase ? macroBase : curve;
		const values = macrosLive ? macroValues : ZERO_MACROS;
		const proposal = proposeMacro({
			base: base.bands,
			basePreampDb: base.preampDb,
			values,
			index,
			target: value
		});
		const macro = MACROS[index];
		if (proposal.ok && apply(proposal)) {
			const pick = (k: number): number => (k === index ? proposal.value : (values[k] ?? 0));
			macroBase = base;
			macroValues = [pick(0), pick(1), pick(2), pick(3)];
			macroSignature = curveSignature(app.state.curve.current);
		}
		macroMessage =
			proposal.stopped && macro
				? m.curva_macro_stopped({
						name: macroNames[macro.id](),
						value: formatSignedDb(proposal.value, locale),
						reason: firstReasonText(proposal.reasons, { bands: base.bands, locale })
					})
				: null;
	}

	// --- output: "Máximo sem clipping" --------------------------------------------------------

	/** Shown only while the curve is still the one it talks about. */
	let maxClip = $state.raw<{ text: string; signature: string } | null>(null);
	const maxClipMessage = $derived(maxClip?.signature === signature ? maxClip.text : null);
	function onMaxClip() {
		if (!app) return;
		const result = maxPreamp(curve);
		let text: string;
		if (!result.ok) {
			text = m.curva_maxclip_none({
				reason: firstReasonText(result.reasons, { bands: curve.bands, locale })
			});
		} else if (!result.changed) {
			text = m.curva_maxclip_same({ value: formatSignedDb(result.preampDb, locale) });
		} else if (apply({ bands: curve.bands, preampDb: result.preampDb })) {
			text = m.curva_maxclip_done({ value: formatSignedDb(result.preampDb, locale) });
		} else {
			return;
		}
		maxClip = { text, signature: curveSignature(app.state.curve.current) };
		announcement = text;
	}

	// --- bank and cabinet ---------------------------------------------------------------------

	function onKind(index: number, kind: BandKind) {
		if (kind !== 'OFF' && isLockedKind(kind, layer)) {
			bankMessage = m.curva_exp_hint();
			return;
		}
		const result = changeKind(curve, index, kind);
		if (result.ok) {
			apply({ bands: result.bands, preampDb: curve.preampDb });
			bankMessage = null;
		} else {
			bankMessage = m.curva_kind_refused({
				reason: firstReasonText(result.reasons, { bands: curve.bands, locale })
			});
		}
	}
	function onDefaultOrder() {
		const bands = defaultOrder(curve.bands);
		const result = verdictFor({ bands, preampDb: curve.preampDb });
		if (result.ok) {
			apply({ bands, preampDb: curve.preampDb });
			bankMessage = null;
		} else {
			bankMessage = m.curva_reorder_refused({
				reason: firstReasonText(result.reasons, { bands, locale })
			});
		}
	}
	let springTimer: ReturnType<typeof setTimeout> | undefined;
	function onReorder(from: number, to: number) {
		if (!app) return;
		const result = reorderSections(curve, from, to);
		if (result.ok) {
			apply({ bands: result.bands, preampDb: curve.preampDb });
			selected = to;
			refused = null;
			cabMessage = m.curva_reorder_ok();
			return;
		}
		refused = from;
		cabMessage = m.curva_reorder_refused({
			reason: firstReasonText(result.reasons, {
				bands: moveSection(curve.bands, from, to),
				locale
			})
		});
		notify(cabMessage, 'error');
		clearTimeout(springTimer);
		springTimer = setTimeout(() => (refused = null), 450);
	}
	onDestroy(() => clearTimeout(springTimer));

	// --- import, links ------------------------------------------------------------------------

	function onImport(result: ImportResult, fallbackName = m.curva_name_imported()) {
		if (!app) return;
		if (!result.ok) {
			notify(m.curva_import_refused({ reason: ioFailureText(result) }), 'error');
			return;
		}
		const { bands, preampDb } = result.curve;
		if (
			!apply({ bands, preampDb }, { name: result.curve.name || fallbackName, source: 'import' })
		) {
			notify(m.curva_import_refused({ reason: m.curva_io_error_format() }), 'error');
			return;
		}
		notify(
			m.curva_import_ok({
				count: String(activeCount(bands)),
				preamp: formatSignedDb(preampDb, locale)
			})
		);
	}

	let handledLinkHash: string | null = null;
	let originHint = $state.raw<{ s1: string; lineageId: string; versionId: string } | null>(null);
	$effect(() => {
		const client = app;
		const linkHashValue = hash;
		if (!client || !linkHashValue.startsWith('#p=') || linkHashValue === handledLinkHash) return;
		const params = new URL(pageUrl.href).searchParams;
		const lineageId = params.get('l');
		const versionId = params.get('v');
		handledLinkHash = linkHashValue;
		void client.state.ready.then(() => {
			const result = readLinkHash(
				linkHashValue,
				untrack(() => layer)
			);
			if (result === null) return;
			// Consumed either way: applied, or refused and reported. A reload must not repeat it.
			const clear = untrack(() => clearLinkHash) ?? clearAddressLink;
			if (!result.ok) {
				notify(m.curva_link_refused({ reason: ioFailureText(result) }), 'error');
				clear();
				return;
			}
			if (!apply(result.curve, { name: m.curva_name_link(), source: 'import' })) {
				clear();
				return;
			}
			const code = currentS1(result.curve);
			originHint = code && lineageId && versionId ? { s1: code, lineageId, versionId } : null;
			notify(m.curva_link_loaded());
			clear();
		});
	});

	// --- preview and meters -------------------------------------------------------------------

	let preview = $state.raw<CurvaPreview | null>(null);
	$effect(() => {
		const client = app;
		if (!client) return;
		const meterRef = client.state.meterRef;
		const instance = new CurvaPreview(client.audio, { reference: () => meterRef.value });
		preview = instance;
		return () => {
			instance.dispose();
			if (preview === instance) preview = null;
		};
	});
	const lastWritten = $derived(app?.state.curve.lastWritten ?? null);
	const reference = $derived<Curve>(
		lastWritten ?? { bands: PADRAO_AURI.bands, preampDb: PADRAO_AURI.preampDb }
	);
	const referenceName = $derived(lastWritten ? m.curva_ab_ref_written() : PADRAO_AURI.label);
	$effect(() => {
		const ref = reference;
		const editor = curve;
		untrack(() => preview?.update(ref, editor));
	});
	const previewError = $derived.by(() => {
		switch (preview?.error) {
			case 'gesture':
				return m.curva_preview_error_gesture();
			case 'suspended':
				return m.curva_preview_error_suspended();
			case 'unsupported':
				return m.curva_preview_error_unsupported();
			case 'failed':
				return m.curva_preview_error_failed();
			default:
				return null;
		}
	});
	const idleStages = Array.from({ length: 10 }, () => ({ mode: 'data' as const, frame: null }));

	function onPreview() {
		const instance = preview;
		if (!instance) return;
		// A second press while the engine is still starting cancels, like a stop.
		if (instance.playing || instance.starting) instance.stop();
		else void instance.start(reference, curve);
	}

	// --- keyboard -----------------------------------------------------------------------------

	function onKeydown(event: KeyboardEvent) {
		if (!isLayerKeyEvent(event)) return;
		if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
		const next = layerFromKey(event.key);
		if (!next) return;
		event.preventDefault();
		onlayer(next);
	}
</script>

<svelte:head>
	<title>{m.curva_title()} · open-auri</title>
	<meta name="description" content={m.curva_lede()} />
</svelte:head>

<svelte:window onkeydown={onKeydown} />

<main class="curva" data-layer={layer} aria-labelledby={titleId}>
	<section class="nameplate">
		<div>
			<p class="np-eyebrow"><b>01 /</b> {m.curva_eyebrow()}</p>
			<h1 id={titleId}>{m.curva_title()}</h1>
			<p class="np-lede">{m.curva_lede()}</p>
		</div>
		<div class="np-preset" aria-live="polite">
			<span class="np-k">{m.curva_in_editor()}</span>
			<span class="np-name">{curveName}</span>
			<span class="np-state">
				{m.curva_np_state({
					preamp: formatSignedDb(curve.preampDb, locale),
					crc,
					count: String(activeCount(curve.bands))
				})}
			</span>
			{#if app?.state.curve.unsaved}
				<span class="np-dirty">{m.curva_unsaved()}</span>
			{/if}
		</div>
		<LayerSelector {layer} {onlayer} />
	</section>

	<div class="instrument">
		<div class="cheek" aria-hidden="true"></div>
		<div class="panel">
			<PresetTabs
				activeId={activePreset}
				{locale}
				onload={(id) => {
					if (app?.state.curve.loadPreset(id)) announcement = m.curva_loaded();
				}}
			/>
			<MacroKnobs
				values={shownMacros}
				scopes={macroScopes}
				{locale}
				disabled={!app}
				message={macroMessage}
				onchange={onMacro}
			/>
			<ScopePanel
				curve={display}
				committed={curve}
				{verdict}
				{reference}
				drag={dragView}
				{shake}
				bind:selected
				{layer}
				{locale}
				message={dragMessage}
				messageTone={dragTone}
				spectrumMode={preview?.vu.mode ?? 'data'}
				analyser={preview?.analyser ?? null}
				playing={preview?.playing ?? false}
				side={preview?.side ?? 'B'}
				{referenceName}
				{previewError}
				previewDisabled={!preview}
				approximate={preview ? !preview.exact : false}
				ondrag={onDrag}
				oncommit={(index, target) => void onCommit(index, target)}
				onpreview={onPreview}
				onside={(side) => preview?.select(side)}
			/>
			<OutputPanel
				{curve}
				{verdict}
				{locale}
				mode={preview?.playing ? preview.vu.mode : 'data'}
				frame={preview?.playing ? preview.vu.frame : null}
				side={preview?.side ?? 'B'}
				onmaxclip={onMaxClip}
				{maxClipMessage}
				disabled={!app}
			/>
			<RescuePanel
				unsaved={app?.state.curve.unsaved ?? false}
				canUndo={app?.state.curve.canUndo ?? false}
				canRedo={app?.state.curve.canRedo ?? false}
				journalCount={app?.state.journal.entries.length ?? 0}
				disabled={!app}
				writeDisabled={app?.cableState.writing ?? true}
				onneutral={() => app?.loadNeutral() && (announcement = m.curva_loaded())}
				ondefault={() => app?.loadAuriDefault() && (announcement = m.curva_loaded())}
				onrescue={() => app?.requestRescue()}
				onundo={() => app?.state.curve.undo()}
				onredo={() => app?.state.curve.redo()}
				onwrite={() => app?.requestWrite()}
			/>
		</div>
		<div class="cheek r" aria-hidden="true"></div>
	</div>

	{#if includesLayer(layer, 'ajustar')}
		<div class="layer-block" transition:slide={{ duration: motionMs }}>
			<FilterBank
				{curve}
				{verdict}
				{layer}
				{locale}
				stages={preview?.stages ?? idleStages}
				message={bankMessage}
				onmove={(index, target) =>
					void onCommit(index, target, (message) => (bankMessage = message))}
				onkind={onKind}
				onorder={onDefaultOrder}
			/>
		</div>
	{/if}

	{#if layer === 'engenharia'}
		<div class="layer-block" transition:slide={{ duration: motionMs }}>
			<Cabinet
				{curve}
				{locale}
				{selected}
				{refused}
				message={cabMessage}
				onselect={(index) => (selected = index)}
				onreorder={onReorder}
			/>
			<div class="below">
				{#await import('./Inspector.svelte') then { default: Inspector }}
					<Inspector {curve} {verdict} {selected} {locale} />
				{:catch}
					<p role="alert">{m.layout_error_generic()}</p>
				{/await}
				{#await import('./Sequencer.svelte') then { default: Sequencer }}
					<Sequencer
						{curve}
						disabled={!app || (app?.cableState.writing ?? true)}
						onsend={() => app?.requestWrite()}
					/>
				{:catch}
					<p role="alert">{m.layout_error_generic()}</p>
				{/await}
			</div>
		</div>
	{/if}

	<div class="layer-block">
		<SocialActions {app} {curve} name={curveName} {locale} {pageUrl} {preview} {originHint} />
		<ImportExport
			{curve}
			name={curveName}
			source={stored?.source ?? `preset:${NEUTRO.id}`}
			{layer}
			{locale}
			{pageUrl}
			disabled={!app}
			onimport={(result) => onImport(result)}
			{notify}
		/>
	</div>

	<p class="visually-hidden" role="status" aria-live="polite">{announcement}</p>
</main>

<style>
	.curva {
		--curva-silk: #e9e3d4;
		--curva-silk-2: #c9c1ae;
		display: grid;
		/* minmax(0, …): wide content (cabinet rack, tape) scrolls inside its box instead of
		   widening the page and pushing the nameplate controls off-screen. */
		grid-template-columns: minmax(0, 1fr);
		gap: 18px;
		max-width: var(--frame-max, 1440px);
		margin: 0 auto;
		padding: 24px var(--gutter, 24px) 32px;
		background: var(--ink, #0f0f0e);
		color: var(--text, #ece7dd);
	}
	.nameplate {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		gap: 18px 28px;
		align-items: end;
	}
	.np-eyebrow {
		margin: 0;
		font: 11px/1.3 var(--font-mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--accent, #ff7a2f);
	}
	h1 {
		margin: 4px 0;
		font: 400 clamp(40px, 6vw, 72px) / 1 var(--font-display, 'Instrument Serif', serif);
	}
	.np-lede {
		max-width: 60ch;
		margin: 0;
		color: var(--curva-silk-2);
	}
	.np-preset {
		display: grid;
		gap: 2px;
		padding-left: 18px;
		border-left: 1px solid rgb(238 233 222 / 0.2);
	}
	.np-k,
	.np-state {
		font: 11px/1.3 var(--font-mono, 'JetBrains Mono', monospace);
		color: var(--curva-silk-2);
	}
	.np-name {
		font: 400 26px/1.1 var(--font-display, 'Instrument Serif', serif);
		overflow-wrap: anywhere;
	}
	.np-dirty {
		font: 600 11px/1.3 var(--font-mono, 'JetBrains Mono', monospace);
		color: var(--accent, #ff7a2f);
	}
	.instrument {
		display: grid;
		grid-template-columns: 22px minmax(0, 1fr) 22px;
	}
	.cheek {
		border-radius: 6px 0 0 6px;
		background: linear-gradient(90deg, #26140a, #5b351c 30%, #4b2b16 62%, #22120a);
	}
	.cheek.r {
		border-radius: 0 6px 6px 0;
	}
	.panel {
		display: grid;
		grid-template-columns: 290px minmax(0, 1fr) 200px;
		grid-template-areas:
			'pre scope out'
			'mac scope res';
		gap: 18px;
		padding: 18px;
		background:
			linear-gradient(180deg, rgb(255 255 255 / 0.05), transparent 30%),
			linear-gradient(#2e2d2b, #1f1e1c);
		box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.08);
	}
	.curva:not([data-layer='ouvir']) .panel {
		grid-template-areas:
			'scope scope out'
			'pre mac res';
	}
	.panel :global(.ps-pre) {
		grid-area: pre;
	}
	.panel :global(.ps-mac) {
		grid-area: mac;
	}
	.panel :global(.ps-scope) {
		grid-area: scope;
		min-width: 0;
	}
	.panel :global(.ps-out) {
		grid-area: out;
	}
	.panel :global(.ps-res) {
		grid-area: res;
	}
	.curva :global(.psec) {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.curva :global(.legend-bar) {
		order: 99;
		margin: 12px 0 0;
		padding: 3px 8px;
		border-top: 1px solid rgb(238 233 222 / 0.25);
		font: 600 10px/1.3 var(--font-mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--curva-silk);
	}
	/* Panel buttons (mock .btn-pl): machined plate, condensed caps, hover brightens the edge,
	   press sinks 1 px. */
	.curva :global(.btn-pl) {
		display: inline-flex;
		gap: 6px;
		align-items: center;
		justify-content: center;
		min-height: 32px;
		padding: 7px 11px;
		border: 1px solid #2c2c2a;
		border-radius: 3px;
		background: linear-gradient(#262725, #141514);
		box-shadow:
			inset 0 1px 0 rgb(255 255 255 / 0.07),
			0 2px 3px rgb(0 0 0 / 0.6);
		color: var(--curva-silk);
		font: 600 12px/1 var(--font-cond, 'Barlow Condensed', 'Arial Narrow', sans-serif);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			border-color 0.15s,
			color 0.15s,
			transform 0.08s;
	}
	.curva :global(.btn-pl:hover:not(:disabled):not([aria-disabled='true'])) {
		border-color: #4a4a46;
		color: #fff7ec;
	}
	.curva :global(.btn-pl:active:not(:disabled):not([aria-disabled='true'])) {
		transform: translateY(1px);
		box-shadow: inset 0 2px 4px rgb(0 0 0 / 0.7);
	}
	.curva :global(.btn-pl[aria-pressed='true']) {
		border-color: rgb(255 122 47 / 0.55);
		color: var(--accent, #ff7a2f);
		box-shadow: inset 0 2px 4px rgb(0 0 0 / 0.7);
	}
	.curva :global(.btn-pl.acc) {
		border-color: rgb(255 122 47 / 0.45);
		color: var(--accent, #ff7a2f);
	}
	.curva :global(.btn-pl.acc:hover:not(:disabled)) {
		border-color: var(--accent, #ff7a2f);
	}
	.curva :global(.btn-pl:disabled),
	.curva :global(.btn-pl[aria-disabled='true']),
	.curva :global(.guard:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.curva :global(.btn-pl:focus-visible),
	.curva :global(.guard:focus-visible),
	.curva :global(.soon-ctl:focus-visible) {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 3px;
	}
	@media (prefers-reduced-motion: reduce) {
		.curva :global(.btn-pl) {
			transition: none;
		}
	}
	.layer-block {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 18px;
		min-width: 0;
	}
	.below {
		content-visibility: auto;
		contain-intrinsic-size: auto 650px;
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: 18px;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@media (max-width: 1100px) {
		.nameplate {
			grid-template-columns: minmax(0, 1fr) auto;
		}
		.below {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	@media (max-width: 720px) {
		.curva {
			padding: 18px 14px 24px;
		}
		.nameplate {
			grid-template-columns: minmax(0, 1fr);
		}
		.np-preset {
			padding-left: 0;
			border-left: 0;
		}
		.instrument {
			grid-template-columns: 10px minmax(0, 1fr) 10px;
		}
		.panel,
		.curva:not([data-layer='ouvir']) .panel {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas: 'scope' 'pre' 'mac' 'out' 'res';
			padding: 12px;
		}
	}
</style>
