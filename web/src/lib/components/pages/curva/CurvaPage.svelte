<!--
	Curva page (homage: Robert Moog). Container for the three layers Ouvir ⊂ Ajustar ⊂ Engenharia.
	- The layer comes from the route (`?camada=`) as a prop; changes go back through `onlayer`.
	- Editor state is `app.state.curve` (undo/redo/dirty); every change is gate-approved first
	  (macros, drags, knobs, typed values, kinds, reorders, imports, links, parked points, the
	  manual preamp), in the editor's profile (Modo YOLO: the YOLO gate, preamp −25,5 to 0 dB).
	  During "Prévia sem limites" edits stay in a memory-only draft (`freeDraft`) and never reach
	  the store, `oa.current`, the undo history or another tab (C1).
	- Writing is only ever `app.requestWrite()` / `app.requestRescue()` (layout checklist).
	- Works without `app` (SSR, before mount): renders Neutro read-only, `aria-busy`, and every
	  action says it is still loading.
	- Rack (mock v2), each panel engraved with its name under the content. Ouvir: the scope runs
	  across the top beside the output; presets (Experimentos under them), fine adjust and rescue
	  sit under it. Ajustar and Engenharia (desktop): the filter bank hangs right under the scope
	  and the side column (output, presets as a list, Experimentos, fine adjust, rescue) rides along
	  it, sticky. Narrower screens stack the scope, the bank, then the side panels, in DOM
	  (keyboard) order.
	- Loading: the account panel (SocialActions) is a dynamic import, fetched when it comes into
	  view, on idle, or at once for a community link; the gate worker warms on idle after the first
	  paint; the audio engine warms on the preview lever's pointer or key down.
-->
<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { slide } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
	import type { ClientApp } from '#lib/app/index.ts';
	import { warmGateWorker } from '#lib/app/warm.ts';
	import { warmAudio } from '#lib/audio/warm.ts';
	import LazyArt from '#lib/components/art/LazyArt.svelte';
	import { Tour, TourTrigger } from '#lib/components/comprehension/index.ts';
	import Skeleton from '#lib/components/primitives/Skeleton.svelte';
	import Button from '#lib/components/primitives/Button.svelte';
	import { createGateWorker } from '#lib/workers/index.ts';
	import { curveSignature, type CurveData } from '#lib/state/model.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { whenIdle } from '#lib/app/runtime.ts';
	import Deferred from '#lib/components/pages/lazy/Deferred.svelte';
	import { cabinet, filterBank, importExport } from './lazy.ts';
	import LayerSelector from './LayerSelector.svelte';
	import MacroKnobs from './MacroKnobs.svelte';
	import OutputPanel, { snapPreamp } from './OutputPanel.svelte';
	import PresetTabs from './PresetTabs.svelte';
	import Experiments from './Experiments.svelte';
	import RescuePanel from './RescuePanel.svelte';
	import ScopePanel from './ScopePanel.svelte';
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
	import {
		bandOfKind,
		defaultOrder,
		defaultPermutation,
		editorPreampMaxDb,
		editorVerdict,
		maxPreamp,
		movePermutation,
		moveSection,
		permuteLabels,
		reorderSections
	} from './edit.ts';
	import { codecAccepts } from '#lib/workers/gate-handler.ts';
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
	import { parkedBand } from './parked.ts';
	import { CurvaPreview } from './preview.svelte.ts';
	import LivePanel from './LivePanel.svelte';
	import {
		browserFlat,
		liveActive as isLiveActive,
		livePlaying
	} from '#lib/components/cable/live.ts';
	import type { LiveOutcome } from '#lib/cable/types.ts';
	import type { ABSide } from '#lib/audio/engine.ts';
	import { provideBandLabelView } from './band-labels.svelte.ts';
	import YoloToggle from '#lib/components/yolo/YoloToggle.svelte';
	import YoloCurveNotice from '#lib/components/yolo/YoloCurveNotice.svelte';
	import { waivedLabels } from '#lib/components/yolo/yolo-curve.ts';
	import { withProfile } from './drag.ts';
	import {
		canBringBack,
		classOf,
		editorProfile,
		exitReason,
		standardCurve,
		yoloWriteBlock
	} from './yolo.ts';
	import { firstReasonText, type Reason } from './reasons.ts';

	type SocialComponent = typeof import('./SocialActions.svelte').default;

	// FUX.B: warm the layer panels once the first screen is quiet, so Ajustar and Engenharia
	// open on loaded chunks (the boxes in Deferred hold their size if a press comes first).
	onMount(() =>
		whenIdle(() => {
			filterBank.request();
			cabinet.request();
		})
	);

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
		/**
		 * Opens the guided tour on a first desktop visit. Defaults to on, except under automation
		 * (`navigator.webdriver`), where a popover would cover the controls under test.
		 */
		tourAutoOpen?: boolean;
	}
	let {
		app,
		layer,
		hash,
		pageUrl,
		onlayer,
		gateClient,
		clearLinkHash,
		tourAutoOpen = typeof navigator !== 'undefined' && navigator.webdriver !== true
	}: Props = $props();

	/** Drops `#p=…` from the address bar without a navigation (path, query and state are kept). */
	function clearAddressLink(): void {
		if (typeof window === 'undefined' || !window.location.hash.startsWith('#p=')) return;
		const { pathname, search } = window.location;
		window.history.replaceState(window.history.state, '', pathname + search);
	}

	const injected = untrack(() => gateClient);
	const owned = injected === undefined ? createGateWorker() : null;
	// Every drag and commit carries the editor profile of that moment (Modo YOLO: class 1 still
	// snaps; free preview: codec-only). Standard unless YOLO is on in this tab.
	const gate: GateClient = withProfile(injected ?? owned ?? createGateWorker(), () =>
		editorProfile(app?.yolo.enabled ?? false, app?.yolo.freePreview ?? false)
	);
	onDestroy(() => owned?.dispose());

	const locale = getLocale();
	const titleId = $props.id();
	const neutral: Curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };

	// --- Modo YOLO (this tab only, memory only; see lib/state/yolo.svelte.ts) -------------------
	const yoloOn = $derived(app?.yolo.enabled ?? false);
	const freePreview = $derived(app?.yolo.freePreview ?? false);
	/** Gate profile of a write from this editor, and of every discrete edit. */
	const writeProfile = $derived<'standard' | 'yolo'>(yoloOn ? 'yolo' : 'standard');
	/**
	 * What judges every discrete edit (kinds and the dial's preflight, parked points, reorders and
	 * the default order, the preamp, "Máximo sem clipping", macros): the write profile, except in
	 * "Prévia sem limites", where the codec accepts, the same check the drags use (`'codec'`).
	 * Those edits then go to the memory-only draft (`apply` → `applyFree`), never to the store.
	 */
	const editJudge = $derived(editorProfile(yoloOn, freePreview));

	const stored = $derived(app?.state.curve.current ?? null);
	const storedCurve = $derived<Curve>(stored ?? neutral);
	const storedSignature = $derived(curveSignature(storedCurve));
	/**
	 * "Prévia sem limites" (C1): every edit made while it is on lives here only, in this page's
	 * memory, over the stored curve it started from (`base`, its signature). It never reaches
	 * `curve.set`, `oa.current`, the undo history or another tab, and is never written. Leaving the
	 * free preview (or YOLO, or the page) discards it, and so does any change of the stored curve
	 * (a preset, Neutro, an experiment, another tab). Its own Desfazer/Refazer steps live with it.
	 *
	 * Filter labels follow the draft's reorders: `order` maps each draft slot to the stored slot
	 * its filter came from, and the draft shows the stored labels permuted by it
	 * (`draftLabels`, through `provideBandLabelView` to the bank and the scope). A rename during
	 * the draft is written to the stored curve (labels are presentation only, never the gate, C1)
	 * at the stored slot `order` names, so the name stays on the filter it was given to, in the
	 * draft and once the draft ends. Each step keeps its own order, so Desfazer/Refazer move the
	 * names back with their filters.
	 */
	interface DraftStep {
		readonly curve: Curve;
		/** Entry i: the stored curve's slot of the filter at draft slot i. */
		readonly order: readonly number[];
	}
	interface FreeDraft extends DraftStep {
		readonly base: string;
		readonly past: readonly DraftStep[];
		readonly future: readonly DraftStep[];
	}
	const FREE_DRAFT_STEPS = 100;
	let freeDraft = $state.raw<FreeDraft | null>(null);
	/** The live draft (free preview on, still over the stored curve), or null. */
	const liveDraft = $derived(
		freePreview && freeDraft !== null && freeDraft.base === storedSignature ? freeDraft : null
	);
	const curve = $derived<Curve>(liveDraft?.curve ?? storedCurve);
	/** The stored labels, in the live draft's slot order; null without a live draft or labels. */
	const draftLabels = $derived(
		liveDraft === null ? null : permuteLabels(stored?.labels ?? null, liveDraft.order)
	);
	/** The editor's labels by slot: the draft's while it is live, else the stored curve's. */
	const editorLabels = $derived(liveDraft === null ? (stored?.labels ?? null) : draftLabels);
	provideBandLabelView(() => {
		const live = liveDraft;
		if (live === null) return null;
		return {
			labels: draftLabels ?? [],
			storedSlot: (index: number) => live.order[index] ?? index
		};
	});
	const signature = $derived(curveSignature(curve));
	$effect(() => {
		const live = liveDraft;
		untrack(() => {
			if (live === null && freeDraft !== null) freeDraft = null;
		});
	});
	/**
	 * Bumped each time the free preview starts or ends (not reactive): a commit begun before a
	 * free-preview exit is stale even if the free preview is on again when the gate answers.
	 */
	let freePreviewEpoch = 0;
	let wasFreePreview = false;
	$effect(() => {
		const on = freePreview;
		if (on !== wasFreePreview) {
			wasFreePreview = on;
			freePreviewEpoch++;
		}
	});
	/** Why YOLO itself disables writing (the free preview), or null. */
	const yoloWriteReason = $derived(
		yoloWriteBlock(yoloOn, freePreview) ? m.yolo_reason_free_preview() : null
	);
	const verdict = $derived(verdictFor(curve, writeProfile));
	/**
	 * Whether the editor's own profile accepts the curve as the start of a drag: the gate's verdict,
	 * except in the free preview, where the codec alone decides (the worker's `accepted`).
	 */
	const startAccepted = $derived(
		freePreview ? codecAccepts(curve.bands, curve.preampDb) : verdict.ok
	);
	/**
	 * Why the editor curve may not leave as a file, a link or an account save/publication: only a
	 * rejected curve (class-based, `exitRefusal` in yolo.ts). A YOLO curve leaves, marked, whether
	 * or not YOLO is on.
	 */
	const exitGateReason = $derived(exitReason(curve, locale));
	/** The class of the editor curve (cached by signature). */
	const curveClass = $derived(classOf(curve));
	const curveYolo = $derived(curveClass.class === 'yolo');
	/**
	 * A YOLO curve in the editor while YOLO is off (a link, a file, the library, a fork, or
	 * `oa.current` after a reload): it is shown and may be previewed (the engine protects any curve
	 * the standard gate refuses), but the handles and discrete edits are locked until YOLO is on in
	 * Engenharia or the curve is brought back to the standard limits. The store keeps it: explicit
	 * loads go through `curve.set`, and only another tab's curve and undo/redo steps follow the
	 * adoption rules of state/curve.svelte.ts.
	 */
	const yoloLocked = $derived(curveYolo && !yoloOn);
	/** "Trazer para os limites padrão": the clamped, auto-preamp curve, when it passes. */
	const standardOffer = $derived(yoloLocked ? standardCurve(curve) : null);
	const noticeVariant = $derived(stored?.source === 'import' ? 'share' : 'editor');
	let yoloToggleSlot = $state<HTMLElement | undefined>();
	/** Says why an edit did nothing while a YOLO curve is locked; true when locked. */
	function lockedEdit(): boolean {
		if (!yoloLocked) return false;
		dragMessage = m.yolopub_editor_locked();
		dragTone = 'info';
		return true;
	}
	/** "Ativar Modo YOLO": in Engenharia (switching to it first), at the YOLO toggle. */
	function offerYolo() {
		if (layer !== 'engenharia') onlayer('engenharia');
		// Focusing the toggle scrolls it into view (its slot has no box of its own).
		requestAnimationFrame(() => {
			yoloToggleSlot?.querySelector<HTMLElement>('button, input')?.focus();
		});
	}
	/** "Trazer para os limites padrão": one undoable change to the standard curve. */
	function bringToStandard() {
		const next = standardOffer;
		if (!next || !app) return;
		if (apply(next, { name: curveName })) {
			drawKey++;
			notify(m.yolopub_bring_standard_done());
		}
	}
	// YOLO exists only in Engenharia: leaving the layer turns it off.
	$effect(() => {
		app?.yolo.syncLayer(layer);
	});
	/**
	 * The editor curve when YOLO was turned on, whole (name, source, labels, bands and preamp):
	 * restored, all of it, if YOLO ends on a curve the standard gate refuses, even when a YOLO-only
	 * experiment or import renamed it or gave it another source meanwhile.
	 */
	let beforeYolo: CurveData | null = null;
	let wasYolo = false;
	$effect(() => {
		const on = yoloOn;
		untrack(() => {
			if (on && !wasYolo && app) {
				const current = app.state.curve.current;
				beforeYolo = {
					name: current.name,
					source: current.source,
					preampDb: current.preampDb,
					bands: current.bands,
					labels: current.labels ?? null
				};
			} else if (!on && wasYolo && app && beforeYolo !== null) {
				// "Desligar" (or leaving Engenharia) on a YOLO-only curve: the editor goes back to
				// the curve it had before, metadata included; a curve the standard gate accepts
				// stays as it is.
				if (!canBringBack(app.state.curve.current) && app.state.curve.set(beforeYolo)) {
					notify(m.yolo_restored());
				}
				beforeYolo = null;
			}
			wasYolo = on;
		});
	});
	/** "Trazer para o modo normal": only when the standard gate accepts the curve. */
	function bringBack() {
		if (!app) return;
		if (canBringBack(app.state.curve.current)) {
			beforeYolo = null;
			app.yolo.disable();
			notify(m.yolo_bring_back_done());
		} else {
			notify(m.yolo_bring_back_refused(), 'error');
		}
	}
	/** Opens the write checklist with this editor's profile (YOLO while it is on). */
	function requestEditorWrite() {
		if (!app || yoloWriteReason !== null) return;
		app.requestWrite(undefined, { profile: writeProfile });
	}
	const experimental = $derived(hasExperimental(curve.bands));
	const crc = $derived(verdict.metrics.payload ? payloadCrc(verdict.metrics.payload) : '…');
	const activePreset = $derived(
		stored?.source.startsWith('preset:') ? stored.source.slice('preset:'.length) : null
	);
	const curveName = $derived(stored?.name ?? NEUTRO.label);
	const motionMs = $derived(prefersReducedMotion.current ? 0 : 280);
	/** Why every editor action is unavailable before the client mounts (T8). */
	const loadingReason = $derived(app ? null : m.curva_v2_loading_reason());

	let draft = $state.raw<Curve | null>(null);
	const display = $derived(draft ?? curve);
	let dragMessage = $state<string | null>(null);
	let dragTone = $state<'info' | 'danger'>('info');
	/** The gate's reason while the advisory says "outside" (scope chip). */
	let dragReason = $state<string | null>(null);
	let dragView = $state.raw<DragView | null>(null);
	let shake = $state<number | null>(null);
	let bankMessage = $state<string | null>(null);
	let cabMessage = $state<string | null>(null);
	let macroMessage = $state<string | null>(null);
	let macroStopped = $state<number | null>(null);
	let selected = $state(0);
	let refused = $state<number | null>(null);
	let announcement = $state('');
	/** Bumped when a preset loads: the scope traces the new curve once. */
	let drawKey = $state(0);

	// --- editor writes (never the cable) ------------------------------------------------------

	/**
	 * Edits keep the current filter labels (a kind change keeps the slot's label); reorders pass
	 * their permutation (`order`, entry i: the editor slot whose filter lands at i) and the labels
	 * follow it; an import brings its own (or none).
	 *
	 * During "Prévia sem limites" an edit goes to the memory-only draft instead (C1, `freeDraft`):
	 * nothing reaches the store, and a reorder permutes the draft's labels (its `order`). Loads
	 * that name their own source (an experiment, an import, a link) still replace the stored
	 * curve, like a preset, and so end the draft.
	 */
	function apply(
		next: Curve,
		meta: {
			name?: string;
			source?: 'custom' | 'import';
			labels?: readonly (string | null)[] | null;
			order?: readonly number[];
		} = {}
	): boolean {
		if (!app) return false;
		if (freePreview && meta.source === undefined) return applyFree(next, meta.order);
		const current = app.state.curve.current;
		const labels =
			meta.labels !== undefined
				? meta.labels
				: meta.source
					? null
					: meta.order
						? permuteLabels(current.labels, meta.order)
						: current.labels;
		return app.state.curve.set({
			name: meta.name ?? current.name,
			source: meta.source ?? 'custom',
			preampDb: next.preampDb,
			bands: next.bands,
			labels
		});
	}
	/** The editor curve as a draft step: the live draft's, or the stored curve in its own order. */
	function currentStep(): DraftStep {
		return (
			liveDraft ?? {
				curve: storedCurve,
				order: Array.from({ length: storedCurve.bands.length }, (_, index) => index)
			}
		);
	}
	/**
	 * One free-preview edit: a new draft step (memory only). A reorder (`permutation`, over the
	 * draft's slots) moves the draft's labels with their filters.
	 */
	function applyFree(next: Curve, permutation?: readonly number[]): boolean {
		const current = currentStep();
		const order = permutation
			? permutation.map((index) => current.order[index] ?? index)
			: current.order;
		const moved = order.some((slot, index) => slot !== current.order[index]);
		if (!moved && curveSignature(next) === curveSignature(current.curve)) return true;
		freeDraft = {
			base: storedSignature,
			curve: { bands: next.bands.slice(), preampDb: next.preampDb },
			order,
			past: [...(liveDraft?.past ?? []), { curve: current.curve, order: current.order }].slice(
				-FREE_DRAFT_STEPS
			),
			future: []
		};
		return true;
	}
	/** Desfazer: the draft's own steps first (free preview), then the editor history. */
	function onUndo() {
		const live = liveDraft;
		const previous = live?.past.at(-1);
		if (live && previous) {
			freeDraft = {
				...live,
				curve: previous.curve,
				order: previous.order,
				past: live.past.slice(0, -1),
				future: [...live.future, { curve: live.curve, order: live.order }]
			};
			return;
		}
		app?.state.curve.undo();
	}
	/** Refazer: within the draft while it is live; the editor history otherwise. */
	function onRedo() {
		const live = liveDraft;
		if (live) {
			const next = live.future.at(-1);
			if (next) {
				freeDraft = {
					...live,
					curve: next.curve,
					order: next.order,
					past: [...live.past, { curve: live.curve, order: live.order }],
					future: live.future.slice(0, -1)
				};
			}
			return;
		}
		app?.state.curve.redo();
	}
	// Ctrl/Cmd+Z (the layout's shortcut, a window bubble listener) steps the live draft first: this
	// capture listener runs before it and claims the event, with the layout's own conditions.
	$effect(() => {
		if (liveDraft === null) return;
		const onDraftKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey) return;
			if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
			const target = event.target;
			if (
				target instanceof Element &&
				target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
			) {
				return;
			}
			if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
			event.preventDefault();
			if (event.shiftKey) onRedo();
			else onUndo();
		};
		window.addEventListener('keydown', onDraftKey, true);
		return () => window.removeEventListener('keydown', onDraftKey, true);
	});
	const canUndo = $derived(
		(liveDraft !== null && liveDraft.past.length > 0) || (app?.state.curve.canUndo ?? false)
	);
	const canRedo = $derived(
		liveDraft !== null ? liveDraft.future.length > 0 : (app?.state.curve.canRedo ?? false)
	);
	function notify(message: string, tone: 'info' | 'error' = 'info') {
		announcement = message;
		app?.toasts.push(message, { tone });
	}
	/** A preset, Neutro or Padrão loaded into the editor: say so and draw the new trace. */
	function loaded(ok: boolean | undefined) {
		if (!ok) return;
		announcement = m.curva_loaded();
		drawKey++;
	}
	/**
	 * An experiment from the Experimentos panel, already judged by the editor's write gate in the
	 * profile of the moment (`decideExperiment`): one undoable editor change, like a preset, that
	 * also sets its filter labels. The panel announces the result; the scope traces the new curve.
	 */
	function onExperiment(next: Curve, meta: { name: string; labels: readonly (string | null)[] }) {
		if (!apply(next, { name: meta.name, source: 'custom', labels: meta.labels })) return false;
		drawKey++;
		return true;
	}

	// --- free drags with an advisory gate, gate-decided releases ----------------------------------
	//
	// Pointer moves never wait for the gate: the handle and the drawn curve follow the pointer on
	// every animation frame (`draft`, never written anywhere), while the worker judges the latest
	// position on the drag grid in the background (one request in flight, the newest position
	// queued). The verdict only colours the handle and explains itself. Release (and keys, wheel,
	// typed values, knobs) goes through `releaseBand`: full grid on the exact target, else the last
	// safe point, else back to the start, animated.

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
		dragReason = null;
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
		if (!app || lockedEdit()) return;
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
		// "Accepted" is the profile's: in the free preview the codec's (`accepted`), not the gate's.
		const verdictOf = startAccepted
			? dragBand(gate, start, index, target, experimental).then((result) => ({
					refused: result.stopped,
					reasons: result.reasons
				}))
			: gate
					.commit({ bands: candidate.bands.slice(), preampDb: candidate.preampDb, experimental })
					.then((result) => ({
						refused: !(result.accepted ?? result.verdict.ok),
						reasons: result.verdict.reasons
					}));
		verdictOf
			.then(
				(result) => {
					// A newer position is queued: this answer is already stale.
					if (generation !== advisoryGeneration || advisoryNext) return;
					const status = result.refused ? 'outside' : 'inside';
					// The same answer again leaves the view alone: the scope does not re-render for it.
					if (dragView?.index !== index || dragView.status !== status) {
						dragView = { index, status };
					}
					if (result.refused) {
						const reason = explain(result.reasons, candidate);
						dragReason = reason;
						dragMessage = m.curva_drag_outside({ reason });
						dragTone = 'danger';
					} else {
						dragReason = null;
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
		if (yoloLocked) {
			draft = null;
			dragView = null;
			report(m.yolopub_editor_locked(), 'info');
			return;
		}
		const token = ++dragToken;
		advisoryGeneration++;
		advisoryNext = null;
		cancelFrames();
		const start = curve;
		const released = draft;
		// What the answer is about: the stored curve under the edit, the gate profile it is judged
		// in, and where it lands (the free preview's memory-only draft, and which step of it). Any
		// of them may change while the gate answers (another tab, a preset, YOLO turned off and
		// the curve before it restored, the free preview turned off or on, a draft Desfazer,
		// Refazer, reorder or other edit): then the answer is stale and is dropped (C1, #38).
		const startStored = storedSignature;
		const startProfile = writeProfile;
		const startFree = freePreview;
		const startFreeEpoch = freePreviewEpoch;
		const startDraft = liveDraft;
		dragView = null;
		dragReason = null;
		try {
			const result = await releaseBand(gate, start, index, target, experimental, startAccepted);
			if (token !== dragToken) return;
			if (
				storedSignature !== startStored ||
				writeProfile !== startProfile ||
				freePreview !== startFree ||
				freePreviewEpoch !== startFreeEpoch ||
				liveDraft !== startDraft
			) {
				// C1: never applied over another curve or draft step, in a profile it was not
				// judged in, nor into the store once the free preview it began in has ended.
				draft = null;
				report(null, 'info');
				return;
			}
			if (result.previewOnly && !freePreview) {
				// C1: only the codec accepted it and the free preview ended while the gate was
				// answering. Such a curve is never stored: the editor keeps its curve.
				draft = null;
				report(null, 'info');
				return;
			}
			// In the free preview `apply` keeps it in the memory-only draft.
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

	// --- Neutro's parked points: grabbing one creates a PK filter there -----------------------

	function onPark(index: number, target: DragTarget) {
		if (!app || lockedEdit()) return;
		const bands = replaceBand(curve.bands, index, parkedBand(index));
		const check = editorVerdict({ bands, preampDb: curve.preampDb }, editJudge);
		if (!check.ok) {
			dragMessage = m.curva_v2_parked_refused({
				index: String(index + 1),
				reason: firstReasonText(check.reasons, { bands, locale })
			});
			dragTone = 'danger';
			return;
		}
		if (!apply({ bands, preampDb: curve.preampDb })) return;
		selected = index;
		// The flat filter exists; moving it where the point was dropped is a normal gated release.
		void onCommit(index, target);
	}

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
		if (yoloLocked) {
			macroMessage = m.yolopub_editor_locked();
			return;
		}
		const base = macrosLive && macroBase ? macroBase : curve;
		const values = macrosLive ? macroValues : ZERO_MACROS;
		const proposal = proposeMacro({
			base: base.bands,
			basePreampDb: base.preampDb,
			values,
			index,
			target: value,
			profile: editJudge
		});
		const macro = MACROS[index];
		if (proposal.ok && apply(proposal)) {
			const pick = (k: number): number => (k === index ? proposal.value : (values[k] ?? 0));
			macroBase = base;
			macroValues = [pick(0), pick(1), pick(2), pick(3)];
			// The editor curve now (the free-preview draft or the stored curve).
			macroSignature = curveSignature(curve);
		}
		macroStopped = proposal.stopped ? index : null;
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
		if (yoloLocked) {
			maxClip = { text: m.yolopub_editor_locked(), signature };
			announcement = maxClip.text;
			return;
		}
		const result = maxPreamp(curve, editJudge);
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
		maxClip = { text, signature: curveSignature(curve) };
		announcement = text;
	}

	// --- output: manual preamp (Ajustar, Engenharia) ------------------------------------------

	/** Why the manual preamp is unavailable (T8): loading, Ouvir (read-only), a write running. */
	const preampReason = $derived(
		loadingReason ??
			(!includesLayer(layer, 'ajustar')
				? m.curva_preamp_ouvir_reason()
				: app?.cableState.writing
					? m.curva_v2_writing_reason()
					: yoloLocked
						? m.yolopub_editor_locked()
						: null)
	);
	/** The last refusal, shown only while the curve is still the one it talks about. */
	let preampRefusal = $state.raw<{ text: string; signature: string } | null>(null);
	const preampMessage = $derived(
		preampRefusal?.signature === signature ? preampRefusal.text : null
	);
	/**
	 * A stepped or typed preamp. Same path as the other discrete edits (kinds, order, "Máximo sem
	 * clipping"): the full write gate of the editor's profile judges the bands with the new preamp
	 * and only an accepted curve goes to the editor (one undo step). In YOLO the range is −25,5 to
	 * 0 dB (`editorPreampMaxDb`, `editorVerdict`'s floor). A refusal keeps the curve and says why.
	 */
	function onPreamp(value: number) {
		if (!app || preampReason) return;
		const preampDb = snapPreamp(value);
		if (preampDb === null || preampDb === curve.preampDb) return;
		const bands = curve.bands;
		const check = editorVerdict({ bands, preampDb }, editJudge);
		if (!check.ok) {
			const text = m.curva_preamp_refused({
				value: formatSignedDb(preampDb, locale),
				reason: firstReasonText(check.reasons, { bands, locale })
			});
			preampRefusal = { text, signature };
			announcement = text;
			return;
		}
		if (apply({ bands, preampDb })) preampRefusal = null;
	}

	// --- bank and cabinet ---------------------------------------------------------------------

	/** Non-mutating discrete-edit preflight, shared by the dial and its commit handler. */
	function kindProposal(index: number, kind: BandKind) {
		if (!app || layer === 'ouvir') {
			return { ok: false as const, reason: loadingReason ?? m.curva_kinddial_readonly() };
		}
		if (yoloLocked) return { ok: false as const, reason: m.yolopub_editor_locked() };
		if (kind !== 'OFF' && isLockedKind(kind, layer)) {
			return { ok: false as const, reason: m.curva_exp_hint() };
		}
		const previous = curve.bands[index];
		if (!previous) return { ok: false as const, reason: m.curva_reason_unknown() };
		const bands = replaceBand(
			curve.bands,
			index,
			bandOfKind(previous, kind, { layer, yolo: yoloOn })
		);
		const result = editorVerdict({ bands, preampDb: curve.preampDb }, editJudge);
		return result.ok
			? { ok: true as const, bands }
			: {
					ok: false as const,
					reason: firstReasonText(result.reasons, { bands, locale })
				};
	}
	function onKind(index: number, kind: BandKind) {
		const result = kindProposal(index, kind);
		if (result.ok) {
			apply({ bands: result.bands, preampDb: curve.preampDb });
			bankMessage = null;
		} else {
			bankMessage = m.curva_kind_refused({
				reason: result.reason
			});
		}
	}
	function onDefaultOrder() {
		if (yoloLocked) {
			bankMessage = m.yolopub_editor_locked();
			return;
		}
		const bands = defaultOrder(curve.bands);
		const result = editorVerdict({ bands, preampDb: curve.preampDb }, editJudge);
		if (result.ok) {
			// The labels follow their filters (in the free preview: the draft's labels).
			apply({ bands, preampDb: curve.preampDb }, { order: defaultPermutation(curve.bands) });
			bankMessage = null;
		} else {
			bankMessage = m.curva_reorder_refused({
				reason: firstReasonText(result.reasons, { bands, locale })
			});
		}
	}
	/** Typed values and knob releases from the bank: gated like a handle, reported in the bank. */
	function onBankMove(index: number, target: DragTarget) {
		void onCommit(index, target, (message) => {
			bankMessage = message;
			dragMessage = null;
		});
	}
	let springTimer: ReturnType<typeof setTimeout> | undefined;
	function onReorder(from: number, to: number) {
		if (!app) return;
		if (yoloLocked) {
			cabMessage = m.yolopub_editor_locked();
			return;
		}
		const result = reorderSections(curve, from, to, editJudge);
		if (result.ok) {
			// The labels follow their filters (in the free preview: the draft's labels).
			const order = movePermutation(curve.bands.length, from, to);
			apply({ bands: result.bands, preampDb: curve.preampDb }, { order });
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
			!apply(
				{ bands, preampDb },
				{
					name: result.curve.name || fallbackName,
					source: 'import',
					labels: result.curve.labels ?? null
				}
			)
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
		if (result.yolo) notify(m.yolopub_loaded_yolo());
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
		// A community link: the account panel will verify its origin, so fetch it now.
		if (lineageId && versionId) loadSocial();
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
			if (result.yolo) notify(m.yolopub_loaded_yolo());
			clear();
		});
	});

	// --- account panel: loaded on demand (L5) ---------------------------------------------------

	let Social = $state.raw<SocialComponent | null>(null);
	let socialFailed = $state(false);
	let socialLoad: Promise<void> | null = null;
	let socialSlot = $state<HTMLElement | undefined>();
	function loadSocial() {
		socialLoad ??= import('./SocialActions.svelte').then(
			(module) => {
				Social = module.default;
			},
			(cause: unknown) => {
				console.error('Curva account panel failed to load', cause);
				socialFailed = true;
			}
		);
	}
	$effect(() => {
		if (originHint) untrack(loadSocial);
	});

	/** Runs `callback` when the browser is idle (or after `timeout` ms at the latest). */
	function idleTask(callback: () => void, timeout: number): () => void {
		if (typeof requestIdleCallback === 'function') {
			const handle = requestIdleCallback(callback, { timeout });
			return () => cancelIdleCallback(handle);
		}
		const handle = setTimeout(callback, Math.min(timeout, 300));
		return () => clearTimeout(handle);
	}

	onMount(() => {
		const cleanups: (() => void)[] = [];
		// After the first paint: warm the gate worker (W4) and fetch the account panel when idle.
		const frame = requestAnimationFrame(() => {
			cleanups.push(idleTask(() => void warmGateWorker(), 1500));
			cleanups.push(idleTask(loadSocial, 2500));
		});
		cleanups.push(() => cancelAnimationFrame(frame));
		const slot = socialSlot;
		if (slot && typeof IntersectionObserver === 'function') {
			const observer = new IntersectionObserver(
				(entries) => {
					if (entries.some((entry) => entry.isIntersecting)) {
						loadSocial();
						observer.disconnect();
					}
				},
				{ rootMargin: '400px 0px' }
			);
			observer.observe(slot);
			cleanups.push(() => observer.disconnect());
		}
		return () => {
			for (const cleanup of cleanups) cleanup();
		};
	});

	// --- preview and meters -------------------------------------------------------------------

	let preview = $state.raw<CurvaPreview | null>(null);
	$effect(() => {
		const client = app;
		if (!client) return;
		const meterRef = client.state.meterRef;
		const instance = new CurvaPreview(client.audio, {
			reference: () => meterRef.value,
			// Modo YOLO previews get the engine's protection (-1 dBFS peak, limiter); so does any
			// curve the standard gate refuses, YOLO or not (the free-preview draft, a YOLO curve
			// restored after a reload, a YOLO cable write as the reference).
			yolo: () => client.yolo.enabled
		});
		preview = instance;
		return () => {
			instance.dispose();
			if (preview === instance) preview = null;
		};
	});
	/** What the preview plays (the ♪ Áudio file or pink noise), for the lever's caption. */
	let audioSource = $state<'file' | 'noise'>('noise');
	$effect(() => {
		const client = app;
		if (!client) return;
		audioSource = client.audio.state().source;
		return client.audio.onChange((state) => {
			audioSource = state.source;
		});
	});
	const lastWritten = $derived(app?.state.curve.lastWritten ?? null);
	const reference = $derived<Curve>(
		lastWritten ?? { bands: PADRAO_AURI.bands, preampDb: PADRAO_AURI.preampDb }
	);
	const referenceName = $derived(lastWritten ? m.curva_ab_ref_written() : PADRAO_AURI.label);

	// --- "Ouvir no cabo": live (no-flash) preview on the cable (issue #69) ----------------------
	//
	// While the cable plays a curve other than the saved one (a session that applied a curve, a
	// curve kept after the session, an orphan preview), the cable applies the EQ: the browser
	// preview must not add it again. Both A/B chains then play the flat Neutro curve
	// (`heardReference`/`heardEditor`), so the browser keeps its session, Transport, meters and
	// protection, but sounds raw (EQ off). Not before the cable is known to play the live curve:
	// while starting (or after a failed first apply) it still plays the saved curve, and the EQ'd
	// chains keep the level (`browserFlat`). The engine's 'raw' mode would take the session away
	// from CurvaPreview (it treats raw playback as someone else's) and lose the A/B chains it
	// resumes with when the session ends.
	// The A/B lever then switches the cable: A = the saved curve, B = the editor; every editor
	// change is queued to the cable (`queueLive`; the service debounces and coalesces), except
	// while the free preview is on (edits there are not the curve to hear on the cable).
	const liveSession = $derived(app?.cableState.live ?? null);
	const liveOn = $derived(isLiveActive(liveSession));
	/** CRC-16 an accepted revert left on the cable (the service's saved curve); reset on a save. */
	let liveSavedCrc = $state<number | null>(null);
	$effect(() => {
		void lastWritten;
		untrack(() => (liveSavedCrc = null));
	});
	/**
	 * The saved curve of the session's cable (the service's: shared journal, this page's saves),
	 * while there is a session (also an ended one). A save to another cable is not it.
	 */
	const sessionSaved = $derived.by<Curve | null>(() => {
		const client = app;
		// Read again on every cable state change and every save.
		const session = client?.cableState.live ?? null;
		void lastWritten;
		if (!client || session === null) return null;
		const saved = untrack(() => client.cable.liveSavedCurve());
		return saved === null ? null : { bands: saved.bands, preampDb: saved.preampDb };
	});
	/** What the live preview calls the saved curve (A): the session cable's own, else the last written. */
	const liveSaved = $derived(liveSession === null ? lastWritten : sessionSaved);
	const liveFlat = $derived(browserFlat(app?.cableState ?? null, liveSaved, liveSavedCrc));
	/** The side the page last sent to the cable while a session runs (the browser's is `preview.side`). */
	let liveSide = $state<ABSide>('B');
	/** Signature of the last curve sent to the session (the start curve included). */
	let liveQueued: string | null = null;
	/** The lever shows what the cable actually plays (A: saved, B: editor), else the side sent. */
	const livePlays = $derived(
		liveOn
			? livePlaying(liveSession, liveSaved, curve, {
					savedCrc: liveSavedCrc,
					prefer: liveSide === 'A' ? 'saved' : 'editor'
				})
			: null
	);
	const liveShownSide = $derived<ABSide>(
		livePlays === 'saved' ? 'A' : livePlays === 'editor' ? 'B' : liveSide
	);
	/** No known saved curve: A would send the Padrão Auri reference, not what the cable saved. */
	const liveAReason = $derived(liveOn && liveSaved === null ? m.cable_live_a_no_saved() : null);
	/** The curve A sends while live: the session cable's saved curve (else the reference). */
	const liveReference = $derived<Curve>(liveSaved ?? reference);
	/** The A label: while live, it names the session cable's saved curve. */
	const abReferenceName = $derived(
		liveOn ? (liveSaved ? m.curva_ab_ref_written() : PADRAO_AURI.label) : referenceName
	);
	const heardReference = $derived(liveFlat ? neutral : reference);
	const heardEditor = $derived(liveFlat ? neutral : curve);
	/** Sends `side`'s curve to the session unless it is what was sent last. */
	function sendLive(client: NonNullable<typeof app>, side: ABSide) {
		const target = side === 'A' ? liveReference : curve;
		const signatureNow = curveSignature(target);
		if (signatureNow === liveQueued) return;
		liveQueued = signatureNow;
		client.cable.queueLive({ bands: target.bands, preampDb: target.preampDb });
	}
	$effect(() => {
		const client = app;
		if (!client || !liveOn) {
			liveQueued = null;
			liveSide = 'B';
			return;
		}
		// The free preview pauses following; turning it off sends the current curve.
		if (freePreview) return;
		const side = liveSide;
		// Tracked: the target curve of that side.
		void (side === 'A' ? liveReference : curve);
		untrack(() => sendLive(client, side));
	});
	/** The A/B lever: the cable's curve while live, the browser chains otherwise. */
	function onSide(side: ABSide) {
		if (!liveOn) {
			preview?.select(side);
			return;
		}
		const client = app;
		// The cable does not play that side (a revert, a failed apply): send it again.
		if (side !== liveShownSide) liveQueued = null;
		liveSide = side;
		if (client && !freePreview) sendLive(client, side);
	}
	/** A revert ended: accepted, the cable plays the saved curve (A); failed, A is held or lost. */
	function onLiveRevert(outcome: LiveOutcome) {
		liveSide = 'A';
		liveQueued = curveSignature(liveReference);
		if (outcome.status === 'accepted') liveSavedCrc = outcome.live?.applied?.crc ?? null;
	}
	// Leaving the page stops following edits: the cable keeps the live curve until it is
	// unplugged (the top bar's chip still says so); nothing is reverted without a gesture.
	onDestroy(() => {
		if (app && isLiveActive(app.cable.getState().live)) void app.cable.stopLive({ revert: false });
	});

	$effect(() => {
		const ref = heardReference;
		const editor = heardEditor;
		// Turning YOLO on or off rebuilds the A/B with or without the preview protection.
		void yoloOn;
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
	const previewCaption = $derived(
		m.curva_v2_preview_state({
			state: preview?.starting
				? m.curva_v2_preview_starting()
				: preview?.playing
					? m.curva_v2_preview_on()
					: m.curva_v2_preview_off(),
			source: audioSource === 'file' ? m.curva_v2_source_file() : m.curva_v2_source_noise()
		})
	);
	const idleStages = Array.from({ length: 10 }, () => ({ mode: 'data' as const, frame: null }));

	function onPreview() {
		const instance = preview;
		if (!instance) return;
		// A second press while the engine is still starting cancels, like a stop.
		if (instance.playing || instance.starting) instance.stop();
		else void instance.start(heardReference, heardEditor);
	}
	/** Pointer or key down on the lever: create/resume the AudioContext before the click (W3). */
	function onPreviewWarm() {
		void warmAudio(app?.audio ?? null);
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
	<LazyArt load={() => import('#lib/components/art/CurvaArt.svelte')} />
	<section class="nameplate">
		<div class="np-title">
			<p class="np-eyebrow"><b>01 /</b> {m.curva_eyebrow()}</p>
			<h1 id={titleId}>{m.curva_title()}</h1>
			<p class="np-lede">{m.curva_lede()}</p>
		</div>
		<div class="np-preset" aria-live="polite">
			<span class="np-k">{m.curva_in_editor()}</span>
			<span class="np-name">{curveName}</span>
			<span class="np-state" data-testid="editor-state">
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
		<LayerSelector {layer} {onlayer}>
			<!-- Modo YOLO sits with the layer choice: unavailable (with its reason) off Engenharia. -->
			{#if app}
				<span class="yolo-toggle-slot" bind:this={yoloToggleSlot}>
					<YoloToggle
						yolo={app.yolo}
						{layer}
						onbringback={bringBack}
						writeReason={yoloWriteReason}
					/>
				</span>
			{/if}
		</LayerSelector>
		<div class="np-help"><TourTrigger page="curva" /></div>
	</section>

	{#if curveYolo}
		<!-- A YOLO curve: marked wherever it is; with YOLO off, shown and previewed, not edited. -->
		<section class="yolo-curve" data-yolo-locked={yoloLocked ? 'editor' : undefined}>
			<YoloCurveNotice variant={noticeVariant} waived={waivedLabels(curveClass.waived)} />
			{#if yoloLocked}
				<p class="yolo-curve-why" role="status">{m.yolopub_editor_locked()}</p>
				<div class="yolo-curve-actions">
					<Button size="sm" caps disabledReason={loadingReason} onclick={offerYolo}
						>{m.yolopub_enable_yolo()}</Button
					>
					{#if standardOffer}
						<Button size="sm" caps disabledReason={loadingReason} onclick={bringToStandard}
							>{m.yolopub_bring_standard()}</Button
						>
					{/if}
				</div>
			{/if}
		</section>
	{/if}

	<LivePanel
		{app}
		{curve}
		{experimental}
		profile={writeProfile}
		saved={liveSaved}
		savedCrc={liveSavedCrc}
		heldCurve={liveSide === 'A' ? 'saved' : 'editor'}
		followPaused={liveOn && freePreview}
		blockedReason={loadingReason ?? yoloWriteReason}
		{locale}
		onbeforestart={(sent) => {
			liveQueued = curveSignature(sent);
			liveSide = 'B';
		}}
		onrevert={onLiveRevert}
	/>

	<div class="instrument" aria-busy={app === null ? 'true' : 'false'}>
		<div class="cheek" aria-hidden="true"></div>
		<div class="rack">
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
				{drawKey}
				message={dragMessage}
				messageTone={dragTone}
				chipReason={dragReason}
				spectrumMode={preview?.vu.mode ?? 'data'}
				analyser={preview?.analyser ?? null}
				playing={preview?.playing ?? false}
				paused={preview?.paused ?? false}
				side={liveOn ? liveShownSide : (preview?.side ?? 'B')}
				abLive={liveOn}
				aReason={liveAReason}
				referenceName={abReferenceName}
				{previewError}
				previewDisabled={!preview}
				previewReason={m.curva_v2_preview_unavailable()}
				{previewCaption}
				approximate={preview ? !preview.exact : false}
				rate={preview?.rate ?? null}
				ondrag={onDrag}
				oncommit={(index, target) => void onCommit(index, target)}
				onpark={onPark}
				{onlayer}
				onpreview={onPreview}
				onpreviewwarm={onPreviewWarm}
				onside={onSide}
			/>
			<!-- Ajustar and Engenharia: the bank hangs right under the scope, inside the rack. -->
			{#if includesLayer(layer, 'ajustar')}
				<div class="layer-block bank-slot" transition:slide={{ duration: motionMs }}>
					<Deferred module={filterBank} height="560px">
						{#snippet children(FilterBank)}
							<FilterBank
								{curve}
								{verdict}
								{layer}
								{locale}
								{selected}
								stages={preview?.stages ?? idleStages}
								message={bankMessage}
								ondrag={onDrag}
								onmove={onBankMove}
								onkind={onKind}
								canApplyKind={kindProposal}
								kindContext={writeProfile}
								kindDisabledReason={loadingReason}
								onorder={onDefaultOrder}
							/>
						{/snippet}
					</Deferred>
				</div>
			{/if}
			<!-- Output, presets, fine adjust and rescue: one sticky column beside the bank (desktop),
			     rack cells everywhere else (see `.side`). -->
			<div class="side">
				<OutputPanel
					{curve}
					{verdict}
					{locale}
					mode={preview?.playing ? preview.vu.mode : 'data'}
					frame={preview?.playing ? preview.vu.frame : null}
					side={liveOn ? liveShownSide : (preview?.side ?? 'B')}
					onmaxclip={onMaxClip}
					{maxClipMessage}
					disabled={!app}
					disabledReason={loadingReason}
					onpreamp={onPreamp}
					{preampReason}
					{preampMessage}
					preampMaxDb={editorPreampMaxDb(writeProfile)}
				/>
				<PresetTabs
					activeId={activePreset}
					{locale}
					onload={(id) => loaded(app?.state.curve.loadPreset(id))}
				/>
				<Experiments
					{layer}
					{locale}
					yolo={app?.yolo ?? null}
					{signature}
					disabledReason={loadingReason}
					onapply={onExperiment}
					{onlayer}
				/>
				<MacroKnobs
					values={shownMacros}
					scopes={macroScopes}
					{locale}
					disabled={!app}
					message={macroMessage}
					stopped={macroStopped}
					onchange={onMacro}
				/>
				<RescuePanel
					unsaved={app?.state.curve.unsaved ?? false}
					{canUndo}
					{canRedo}
					journalCount={app?.state.journal.entries.length ?? 0}
					disabled={!app}
					disabledReason={loadingReason}
					writeDisabled={(app?.cableState.writing ?? true) || yoloWriteReason !== null}
					neutralActive={activePreset === NEUTRO.id}
					defaultActive={activePreset === PADRAO_AURI.id}
					onneutral={() => loaded(app?.loadNeutral())}
					ondefault={() => loaded(app?.loadAuriDefault())}
					onrescue={() => app?.requestRescue()}
					onundo={onUndo}
					onredo={onRedo}
					onwrite={requestEditorWrite}
				/>
			</div>
		</div>
		<div class="cheek r" aria-hidden="true"></div>
	</div>
	{#if !app}
		<p class="visually-hidden" role="status">{m.curva_v2_loading()}</p>
	{/if}

	{#if layer === 'engenharia'}
		<div class="layer-block" transition:slide={{ duration: motionMs }}>
			<Deferred module={cabinet} height="420px">
				{#snippet children(Cabinet)}
					<Cabinet
						{curve}
						{locale}
						{selected}
						{refused}
						message={cabMessage}
						onselect={(index) => (selected = index)}
						onreorder={onReorder}
					/>
				{/snippet}
			</Deferred>
			<div class="below">
				{#await import('./Inspector.svelte') then { default: Inspector }}
					<Inspector {curve} {verdict} {selected} {locale} />
				{:catch}
					<p role="alert">{m.layout_error_generic()}</p>
				{/await}
				{#await import('./Sequencer.svelte') then { default: Sequencer }}
					{@const sequencerReason =
						loadingReason ??
						(app?.cableState.writing ? m.curva_v2_writing_reason() : yoloWriteReason)}
					<fieldset
						class="min-w-0 border-0 p-0"
						disabled={!app || (app?.cableState.writing ?? true) || yoloWriteReason !== null}
						aria-describedby={sequencerReason ? `${titleId}-sequencer-why` : undefined}
					>
						<legend class="visually-hidden">{m.curva_seq_heading()}</legend>
						<Sequencer
							{curve}
							disabled={!app || (app?.cableState.writing ?? true) || yoloWriteReason !== null}
							onsend={requestEditorWrite}
						/>
						{#if sequencerReason}
							<p id={`${titleId}-sequencer-why`} role="status">{sequencerReason}</p>
						{/if}
					</fieldset>
				{:catch}
					<p role="alert">{m.layout_error_generic()}</p>
				{/await}
			</div>
		</div>
	{/if}

	<div class="lower">
		<div class="social-slot" bind:this={socialSlot}>
			{#if Social}
				<Social
					{app}
					{curve}
					name={curveName}
					{locale}
					{pageUrl}
					{preview}
					{originHint}
					blockedReason={exitGateReason}
				/>
			{:else if socialFailed}
				<p role="alert">{m.layout_error_generic()}</p>
			{:else}
				<Skeleton height="148px" radius="var(--rad-lg)" label={m.curva_v2_social_loading()} />
			{/if}
		</div>
		<Deferred module={importExport} height="180px">
			{#snippet children(ImportExport)}
				<ImportExport
					{curve}
					name={curveName}
					source={stored?.source ?? `preset:${NEUTRO.id}`}
					labels={editorLabels}
					{layer}
					{locale}
					{pageUrl}
					disabled={!app}
					disabledReason={loadingReason}
					exportReason={exitGateReason}
					onimport={(result) => onImport(result)}
					{notify}
				/>
			{/snippet}
		</Deferred>
	</div>

	<p class="visually-hidden" role="status" aria-live="polite">{announcement}</p>
	<Tour page="curva" autoOpen={tourAutoOpen} />
</main>

<style>
	.yolo-curve {
		display: grid;
		gap: var(--space-2, 8px);
	}
	.yolo-curve-why {
		margin: 0;
		color: var(--text-2);
		font-size: var(--fs-small, 13px);
	}
	.yolo-curve-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2, 8px);
	}
	.yolo-toggle-slot {
		display: contents;
	}
	.curva {
		/* Panel legends read the design-system text tokens (silk on the satin panel). */
		--curva-silk: var(--text);
		--curva-silk-2: var(--text-2);
		--curva-satin:
			linear-gradient(180deg, rgb(255 255 255 / 0.05), transparent 30%),
			linear-gradient(#2e2d2b, #1f1e1c);
		--curva-wood: linear-gradient(90deg, #26140a, #5b351c 30%, #4b2b16 62%, #22120a);
		/* Width of the side column beside the filter bank (desktop): two fine-adjust knobs across. */
		--curva-side: clamp(264px, 20vw, 304px);
		/* FUX.ART: the art layer (first child) sits under the content inside this context. */
		position: relative;
		isolation: isolate;
		display: grid;
		/* minmax(0, …): wide content (cabinet rack, bank strips) scrolls inside its box instead of
		   widening the page and pushing the nameplate controls off-screen. */
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-5);
		max-width: var(--frame-max, 1440px);
		margin: 0 auto;
		padding: var(--space-5) var(--gutter, 24px) var(--space-6);
		background: var(--ink);
		color: var(--text);
	}
	.nameplate {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto auto;
		gap: var(--space-4) var(--space-6);
		align-items: end;
	}
	.np-eyebrow {
		margin: 0;
		color: var(--accent-text);
		font: 400 var(--fs-eyebrow) / var(--lh-caps) var(--face-data);
		letter-spacing: var(--tracking-eyebrow);
		text-transform: uppercase;
	}
	.np-eyebrow b {
		font-weight: 500;
	}
	h1 {
		margin: var(--space-1) 0;
		font: 400 var(--fs-display-xl) / var(--lh-display) var(--face-display);
		font-style: italic;
		letter-spacing: var(--tracking-display);
	}
	.np-lede {
		max-width: 52ch;
		margin: 0;
		color: var(--text-2);
		font: 400 var(--fs-body) / var(--lh-body) var(--face-body);
	}
	.np-preset {
		display: grid;
		gap: 2px;
		padding-left: var(--space-4);
		border-left: 1px solid var(--rule);
	}
	.np-k,
	.np-state {
		color: var(--text-2);
		font: 400 var(--label-min) / var(--lh-caps) var(--face-data);
		letter-spacing: 0.08em;
	}
	.np-k {
		letter-spacing: var(--tracking-eyebrow);
		text-transform: uppercase;
	}
	.np-name {
		font: 400 var(--fs-display-m) / var(--lh-display-m) var(--face-display);
		overflow-wrap: anywhere;
	}
	.np-dirty {
		color: var(--accent-text);
		font: 500 var(--label-min) / var(--lh-caps) var(--face-data);
	}
	.np-help {
		align-self: start;
	}
	.instrument {
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr) 24px;
		border-radius: var(--rad-lg);
		box-shadow: var(--elev-3);
	}
	.cheek {
		border-radius: var(--rad-lg) 0 0 var(--rad-lg);
		background: var(--curva-wood);
		box-shadow: inset -2px 0 4px rgb(0 0 0 / 0.5);
	}
	.cheek.r {
		border-radius: 0 var(--rad-lg) var(--rad-lg) 0;
		box-shadow: inset 2px 0 4px rgb(0 0 0 / 0.5);
	}
	/* The rack (mock v2). Without the bank (Ouvir): the scope runs almost the full width beside the
	   output; presets (a wide strip), fine adjust and rescue sit under it. With the bank, see the
	   media blocks below. */
	.rack {
		display: grid;
		grid-template-columns: minmax(280px, 1.15fr) minmax(0, 1fr) minmax(0, 0.95fr) 204px;
		grid-template-areas:
			'scope scope scope out'
			'pre pre mac res'
			'xp xp mac res';
		gap: var(--space-5) 0;
		padding: var(--space-5) var(--space-2) var(--space-4);
		border-top: 1px solid rgb(255 255 255 / 0.07);
		border-bottom: 2px solid #050505;
		background: var(--curva-satin);
	}
	.rack :global(.psec) {
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding: 0 var(--space-4);
	}
	.rack :global(.ps-scope) {
		grid-area: scope;
	}
	.rack :global(.ps-out) {
		grid-area: out;
		box-shadow: inset 1px 0 0 rgb(236 231 221 / 0.1);
	}
	.rack :global(.ps-pre) {
		grid-area: pre;
	}
	/* Experimentos: right under the presets, in every layout (DOM order on a phone). */
	.rack :global(.ps-xp) {
		grid-area: xp;
	}
	.rack :global(.ps-mac) {
		grid-area: mac;
		box-shadow: inset 1px 0 0 rgb(236 231 221 / 0.1);
	}
	.rack :global(.ps-res) {
		grid-area: res;
		box-shadow: inset 1px 0 0 rgb(236 231 221 / 0.1);
	}
	/* The side panels' wrapper lends them to the rack grid; only beside the bank on desktop is it
	   a box of its own. A plain div with no role, so `display: contents` hides nothing. */
	.side {
		display: contents;
	}
	/* The filter bank, under the scope inside the rack; its edges line up with the scope bezel.
	   The layouts below place it in their `bank` area; a full row is only the safe fallback. */
	/* The bank is a size container of its own: its head and its strips follow the slot's width
	   (never the viewport's), so it needs no layout rule from here. `min-width: 0` keeps the
	   grid cell from growing with the bank's content. */
	.bank-slot {
		grid-column: 1 / -1;
		align-self: start;
		min-width: 0;
		padding: 0 var(--space-4);
	}
	/* Desktop with the bank (Ajustar, Engenharia): the scope and the bank fill the main column and
	   the side panels ride along them in one column, sticky under the bar, so presets and the fine
	   knobs stay at hand while the bank is in use. Taller than the viewport, the column scrolls
	   inside (popovers and tooltips sit in the top layer, so nothing is clipped). */
	@media (min-width: 1101px) {
		.rack:has(> .bank-slot) {
			grid-template-columns: minmax(0, 1fr) var(--curva-side);
			grid-template-rows: auto 1fr;
			grid-template-areas:
				'scope side'
				'bank side';
		}
		.bank-slot {
			grid-area: bank;
		}
		.rack:has(> .bank-slot) > .side {
			grid-area: side;
			position: sticky;
			top: calc(var(--bar-h) + var(--space-4));
			align-self: start;
			display: flex;
			flex-direction: column;
			gap: var(--space-5);
			max-height: calc(100dvh - var(--bar-h) - 2 * var(--space-4));
			/* Room for the focus rings and the tour outline inside the scroll box. */
			padding: var(--space-2);
			overflow-y: auto;
			scrollbar-gutter: stable;
			scrollbar-width: thin;
			scrollbar-color: var(--rule-control) transparent;
			box-shadow: inset 1px 0 0 rgb(236 231 221 / 0.1);
		}
		.rack:has(> .bank-slot) > .side > :global(.psec) {
			flex: none;
			padding: 0 var(--space-3);
			box-shadow: none;
		}
	}
	/* Engraved section names: centred under the content, on a rule (mock .legend-bar). The rule
	   sits a fixed distance below the content; `margin-top: auto` aligns the names of a row. */
	.curva :global(.legend-bar) {
		position: relative;
		order: 99;
		margin: auto 0 0;
		padding-top: calc(var(--space-4) + 7px);
		color: var(--text);
		font: 600 var(--fs-caption) / 1 var(--face-engrave);
		letter-spacing: 0.3em;
		text-align: center;
		text-transform: uppercase;
	}
	.curva :global(.legend-bar::before) {
		content: '';
		position: absolute;
		top: var(--space-4);
		right: 0;
		left: 0;
		border-top: 1.5px solid currentColor;
	}
	/* Panel buttons kept by the Engenharia modules (mock .btn-pl): machined plate, condensed caps. */
	.curva :global(.btn-pl) {
		display: inline-flex;
		gap: 6px;
		align-items: center;
		justify-content: center;
		min-height: 32px;
		padding: 7px 11px;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-sm);
		background: linear-gradient(#262725, #141514);
		box-shadow:
			var(--bevel),
			0 2px 3px rgb(0 0 0 / 0.6);
		color: var(--text);
		font: 600 var(--fs-caption) / 1 var(--face-engrave);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		cursor: pointer;
		transition:
			border-color var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out),
			transform var(--dur-instant) var(--ease-mech);
	}
	.curva :global(.btn-pl:hover:not(:disabled):not([aria-disabled='true'])) {
		border-color: color-mix(in srgb, var(--text) 62%, transparent);
	}
	.curva :global(.btn-pl:active:not(:disabled):not([aria-disabled='true'])) {
		transform: translateY(1px);
		box-shadow: var(--well);
	}
	.curva :global(.btn-pl[aria-pressed='true']) {
		border-color: color-mix(in srgb, var(--accent) 55%, transparent);
		color: var(--accent-text);
		box-shadow: var(--well);
	}
	.curva :global(.btn-pl.acc) {
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--accent-text);
	}
	.curva :global(.btn-pl:disabled),
	.curva :global(.btn-pl[aria-disabled='true']) {
		background: var(--lamp-off);
		color: var(--muted-hi);
		cursor: not-allowed;
	}
	.curva :global(.btn-pl:focus-visible),
	.curva :global(.soon-ctl:focus-visible) {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	@media (prefers-reduced-motion: reduce) {
		.curva :global(.btn-pl) {
			transition: none;
		}
	}
	.layer-block,
	.lower {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-5);
		min-width: 0;
	}
	.lower {
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		align-items: start;
	}
	.social-slot {
		min-width: 0;
	}
	.below {
		content-visibility: auto;
		contain-intrinsic-size: auto 650px;
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: var(--space-5);
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@media (max-width: 1280px) {
		.nameplate {
			grid-template-columns: minmax(0, 1fr) auto auto;
		}
		.nameplate :global(.mode) {
			grid-column: 1 / 3;
		}
	}
	/* Tablet: the scope, the bank (Ajustar, Engenharia), then output beside the presets and the fine
	   knobs beside rescue. Rows read left to right in DOM (keyboard) order. The phone block below
	   overrides this one (no width gap between the two). */
	@media (max-width: 1100px) {
		.rack {
			grid-template-columns: 204px minmax(0, 1fr) 204px;
			grid-template-areas:
				'scope scope scope'
				'out pre pre'
				'out xp xp'
				'mac mac res';
		}
		.rack:has(> .bank-slot) {
			grid-template-areas:
				'scope scope scope'
				'bank bank bank'
				'out pre pre'
				'out xp xp'
				'mac mac res';
		}
		.bank-slot {
			grid-area: bank;
		}
		.rack :global(.ps-out),
		.rack :global(.ps-mac) {
			box-shadow: none;
		}
		.rack :global(.ps-pre),
		.rack :global(.ps-xp) {
			box-shadow: inset 1px 0 0 rgb(236 231 221 / 0.1);
		}
		.below,
		.lower {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	@media (max-width: 720px) {
		.curva {
			padding: var(--space-4) 14px var(--space-5);
		}
		/* One column: beside an `auto` column, the "No editor" block (its state line is one long
		   max-content run) took the whole width and squeezed the title's 1fr track to 0 px, so
		   the h1 had no box on a phone. */
		.nameplate {
			grid-template-columns: minmax(0, 1fr);
		}
		.nameplate :global(.mode) {
			grid-column: 1 / -1;
		}
		.np-preset {
			padding-left: 0;
			border-left: 0;
		}
		.instrument {
			grid-template-columns: 10px minmax(0, 1fr) 10px;
		}
		/* Phone: one column in DOM order (scope, bank, output, presets, fine adjust, rescue). */
		.rack,
		.rack:has(> .bank-slot) {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas: none;
		}
		.rack {
			padding: var(--space-3) 0;
		}
		.rack :global(.psec) {
			grid-area: auto;
			padding: 0 var(--space-3);
		}
		/* The bank card spans the rack (its own padding lines its content up with the panels'). */
		.bank-slot {
			grid-area: auto;
			padding: 0;
		}
		.rack :global(.psec + .psec),
		.side > :global(.psec:first-child) {
			padding-top: var(--space-3);
			border-top: 1px solid var(--rule);
			box-shadow: none;
		}
	}
</style>
