<!--
	Oscilloscope (v2 mock): phosphor EQ sum, output with preamp, the reference curve (dashed), one
	thin trace per section and draggable handles (Ajustar and Engenharia), plus the live spectrum
	strip and the preview levers (Ouvir prévia, A/B) with the compact Transport (SEEK.2: seek, back
	to start, play/pause of the `curva` session; its play with nothing paused is the lever's start).
	- Every trace is core data (`scope.ts`: core responses summed per section). The output limit
	  line is the gate threshold; red/amber regions show where the drawn curve is over or near the
	  output limit, or where it would clip inside the chain. They are a preview: the gate decides.
	- Selected section: its safe box (core SOFT_RANGES) and the hatched zones it can never reach
	  (ABS_RANGES gain cap, D7: no PK boost above 16 kHz). The box lights while a point is grabbed.
	- Handles follow the pointer freely (the page draws a draft every frame and asks the worker for
	  an advisory verdict without blocking). When that verdict first says "outside", the handle hits
	  a 120 ms detent and the chip shows the gate's reason. Release, keys and the wheel (Q) commit
	  through the page, which judges the full grid and animates back when refused.
	- Neutro (every section OFF): ten points parked at 0 dB with the empty-state hint. Grabbing one
	  (pointer or arrow keys) asks the page to create a filter there (`onpark`, gate-checked).
	- HS/LP/HP handles are locked outside Engenharia, with a hint.
	- Motion: the trace draws in once when a preset loads (`drawKey`), the after-commit ghost, the
	  detent and refused shake and a faint CRT sweep (decorative, aria-hidden, never a reading); all
	  off under prefers-reduced-motion.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	// Direct imports (FUX.B): the meters barrel would bring every meter component into the page.
	import MeterModeLabel from '#lib/components/meters/MeterModeLabel.svelte';
	import SpectrumOverlay from '#lib/components/meters/SpectrumOverlay.svelte';
	import type { MeterMode } from '#lib/audio/meters.ts';
	import type { ABSide, AudioEngine } from '#lib/audio/engine.ts';
	import { getAppContext, type AppContext } from '#lib/app/context.svelte.ts';
	import { Transport } from '#lib/components/audio/index.ts';
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import { CURVA_SESSION } from './preview.svelte.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { formatHz, formatQ, formatSignedDb } from './format.ts';
	import { isLockedKind, type Layer } from './layers.ts';
	import { hasGain, type Band, type Curve } from './model.ts';
	import type { DragTarget, DragView } from './drag.ts';
	import { isEmptyCurve, PARKED_HZ, parkedBand } from './parked.ts';
	import type { GateVerdict } from './reasons.ts';
	import {
		DB_MAX,
		DB_MIN,
		DRAG_GRID,
		INTERNAL_LIMIT_DB,
		MAJOR_FREQS,
		MINOR_FREQS,
		NEAR_MARGIN_DB,
		OUTPUT_LIMIT_DB,
		PLOT,
		SCOPE_GRID,
		VIEW_HEIGHT,
		VIEW_WIDTH,
		clamp,
		handleGain,
		hardZones,
		keyTarget,
		pathOf,
		pointerTarget,
		responsePath,
		segmentPath,
		softBox,
		spansAbove,
		stepQ,
		traces,
		xOf,
		yOf
	} from './scope.ts';

	interface Props {
		/** The curve drawn now (the page's draft while a handle moves, else the editor curve). */
		curve: Curve;
		layer: Layer;
		locale: string;
		/** Plain-language state of the last edit (advisory, snapped back, reverted). */
		message?: string | null;
		/** `danger` while the moving handle is outside the envelope or after a refusal. */
		messageTone?: 'info' | 'danger';
		/** The gate's reason for the advisory "outside", shown in the chip while dragging. */
		chipReason?: string | null;
		/** The editor curve (committed); a change fades the previous one out as a ghost. */
		committed?: Curve | null;
		/** Full-grid verdict of `committed` (peak marker and envelope chip). */
		verdict?: GateVerdict | null;
		/** The A/B reference curve, drawn dashed. */
		reference?: Curve | null;
		/** Advisory state of the handle being moved. */
		drag?: DragView | null;
		/** Handle index to shake (a refused release). */
		shake?: number | null;
		/** Selected section (safe box and highlighted trace). */
		selected?: number;
		/** Bumped by the page when a preset loads: the traces draw in once. */
		drawKey?: number;
		spectrumMode: MeterMode;
		analyser: AnalyserNode | null;
		playing: boolean;
		/**
		 * This page's preview is paused (resumable, `CurvaPreview.paused`): its chains are kept, so
		 * A/B still switches and the lever continues it.
		 */
		paused?: boolean;
		side: ABSide;
		referenceName: string;
		previewError?: string | null;
		previewDisabled?: boolean;
		/** Why the preview is unavailable while `previewDisabled`. */
		previewReason?: string | null;
		/** State caption under the preview lever ("desligada · ruído rosa"). */
		previewCaption?: string;
		/** The preview runs at a rate other than 96 kHz (recomputed coefficients). */
		approximate?: boolean;
		/** Engine of the preview Transport (SEEK.2); defaults to the app context's `audio`. */
		engine?: AudioEngine | null;
		/** Overrides the `prefers-reduced-motion` media query. */
		reducedMotion?: boolean;
		ondrag: (index: number, target: DragTarget) => void;
		oncommit: (index: number, target: DragTarget) => void;
		/** A parked Neutro point was moved: create a filter there (page, gate-checked). */
		onpark?: (index: number, target: DragTarget) => void;
		onpreview: () => void;
		/** Pointer down or key down on the preview lever: warm the audio engine before the click. */
		onpreviewwarm?: () => void;
		onside: (side: ABSide) => void;
	}
	let {
		curve,
		layer,
		locale,
		message = null,
		messageTone = 'info',
		chipReason = null,
		committed = null,
		verdict = null,
		reference = null,
		drag = null,
		shake = null,
		selected = $bindable(0),
		drawKey = 0,
		spectrumMode,
		analyser,
		playing,
		paused = false,
		side,
		referenceName,
		previewError = null,
		previewDisabled = false,
		previewReason = null,
		previewCaption = '',
		approximate = false,
		engine = null,
		reducedMotion,
		ondrag,
		oncommit,
		onpark,
		onpreview,
		onpreviewwarm,
		onside
	}: Props = $props();

	const DETENT_MS = 120;
	const editable = $derived(layer !== 'ouvir');
	const reduced = $derived(reducedMotion ?? prefersReducedMotion.current);
	const legendId = $props.id();
	// Readouts redrawn on every drag frame (handle label, bubble, peak) name their locale: without
	// it each message asks Paraglide's getLocale(), which reads document.cookie (cookie strategy)
	// on every call. A language switch reloads the page, so the locale at mount stays current.
	const messages = { locale: getLocale() };
	let overlay: SVGSVGElement | undefined = $state();
	let screenWidth = $state(0);
	interface ActiveDrag {
		index: number;
		pointer: number;
		start: Band;
	}
	// Set on press and cleared on release only: a pointer move writes no reactive state here (the
	// page draws the draft once per frame), so a move alone re-renders nothing in this panel.
	let active = $state.raw<ActiveDrag | null>(null);
	/** Newest target of the active pointer drag; read only on release, so not reactive. */
	let activeTarget: DragTarget = {};
	let wheelState = $state<{ index: number; q: number } | null>(null);
	let parkedActive = $state<{
		index: number;
		pointer: number;
		target: DragTarget;
		x: number;
		y: number;
	} | null>(null);

	const moving = $derived(drag !== null || active !== null || wheelState !== null);
	/**
	 * A point is moving (pointer, wheel, advisory drag or a parked point): the scope repaints on
	 * every frame, so it draws the cheap way until release (CSS `[data-dragging]`: no blurred
	 * effects, no glass, the live traces on their own layer; traces on DRAG_GRID). At rest the
	 * scope is drawn exactly as before.
	 */
	const dragging = $derived(moving || parkedActive !== null);
	/** Full resolution at rest; half the points while a point moves (the resting state is exact). */
	const grid = $derived(dragging ? DRAG_GRID : SCOPE_GRID);

	// Labels and handles keep a legible, touch-friendly size whatever the scope width.
	const unit = $derived(screenWidth > 0 ? VIEW_WIDTH / screenWidth : 1);
	const labelSize = $derived(Math.max(11, 11 * unit));
	const hitR = $derived(Math.max(20, 17.5 * unit));
	const ringR = $derived(Math.max(10, 8.5 * unit));
	const handleFont = $derived(Math.max(10, 9 * unit));

	// --- traces (core responses) ------------------------------------------------------------------

	const live = $derived(traces(curve, grid));
	const eqPath = $derived(pathOf(live.eq, grid));
	const outPath = $derived(pathOf(live.output, grid));
	// Section responses are cached per exact band (scope.ts): while one handle moves, only its own
	// thin trace is rebuilt; the others reuse their remembered path.
	const bandPaths = $derived(
		live.bands.map((response) => (response ? responsePath(response, grid) : ''))
	);
	const refPath = $derived(reference ? pathOf(traces(reference).output) : '');
	const overOutput = $derived(spansAbove(live.output, OUTPUT_LIMIT_DB, grid));
	const nearOutput = $derived(
		overOutput.length > 0 ? [] : spansAbove(live.output, OUTPUT_LIMIT_DB - NEAR_MARGIN_DB, grid)
	);
	const overInternal = $derived(spansAbove(live.internal, INTERNAL_LIMIT_DB, grid));
	const widest = <T extends { fromHz: number; toHz: number }>(spans: readonly T[]): T | null =>
		spans.reduce<T | null>(
			(best, s) => (!best || s.toHz / s.fromHz > best.toHz / best.fromHz ? s : best),
			null
		);
	const hotLabel = $derived(widest(overOutput));
	const internalLabel = $derived(overOutput.length > 0 ? null : widest(overInternal));

	/** Gate metrics when the drawn curve is the committed one; else the drawn preview's maximum. */
	const peak = $derived.by(() => {
		const audible = verdict?.metrics.outputAudible;
		if (!moving && audible && curve === committed) {
			return { db: audible.db, hz: audible.frequencyHz ?? SCOPE_GRID[0] ?? 20 };
		}
		const points = grid;
		let db = -Infinity;
		let hz = points[0] ?? 20;
		live.output.forEach((value, i) => {
			if (value > db) {
				db = value;
				hz = points[i] ?? hz;
			}
		});
		return Number.isFinite(db) ? { db, hz } : null;
	});

	// Ghost of the previous committed EQ, fading for 1.5 s after each commit (mock .tr-after).
	const committedEq = $derived(committed ? pathOf(traces(committed).eq) : '');
	let ghost = $state<{ path: string; key: number } | null>(null);
	let previousEq = '';
	$effect(() => {
		const next = committedEq;
		untrack(() => {
			if (previousEq && next && previousEq !== next && !reduced) {
				ghost = { path: previousEq, key: (ghost?.key ?? 0) + 1 };
			}
			previousEq = next;
		});
	});

	// --- Neutro: parked points ----------------------------------------------------------------------

	const parked = $derived(isEmptyCurve(curve.bands));
	let parkedFocus = $state<number | null>(null);

	// --- selection: safe box and hard zones -------------------------------------------------------

	const selectedBand = $derived.by(() => {
		if (!editable) return null;
		if (parked) {
			const index = parkedActive?.index ?? parkedFocus;
			return index === null ? null : parkedBand(index);
		}
		const band = curve.bands[selected];
		if (!band || band.kind === 'OFF' || isLockedKind(band.kind, layer)) return null;
		return band;
	});
	const box = $derived(selectedBand ? softBox(selectedBand) : null);
	const zones = $derived(selectedBand ? hardZones(selectedBand) : []);
	const boxRect = $derived(
		box
			? {
					x: xOf(box.fMin),
					y: yOf(Math.min(box.gMax, DB_MAX)),
					width: xOf(box.fMax) - xOf(box.fMin),
					height: yOf(Math.max(box.gMin, DB_MIN)) - yOf(Math.min(box.gMax, DB_MAX))
				}
			: null
	);
	const insideBox = $derived(
		box && selectedBand && selectedBand.kind !== 'OFF'
			? selectedBand.freqHz >= box.fMin &&
					selectedBand.freqHz <= box.fMax &&
					handleGain(selectedBand) >= box.gMin &&
					handleGain(selectedBand) <= box.gMax
			: true
	);
	/** A point of the selected section is in the hand: its safe box lights up. */
	const grabbed = $derived(
		parkedActive !== null ||
			active?.index === selected ||
			wheelState?.index === selected ||
			drag?.index === selected
	);

	const chip = $derived(
		drag ? drag.status : verdict ? (verdict.ok ? ('inside' as const) : ('outside' as const)) : null
	);
	const chipText = $derived(
		chip === 'checking'
			? m.curva_chip_checking()
			: chip === 'outside'
				? m.curva_chip_outside()
				: m.curva_chip_inside()
	);
	const chipWhy = $derived(drag?.status === 'outside' && chipReason ? chipReason : null);

	// --- the 120 ms detent when the advisory verdict first says "outside" -------------------------

	let detent = $state<number | null>(null);
	let detentTimer: ReturnType<typeof setTimeout> | undefined;
	let lastOutside: number | null = null;
	$effect(() => {
		const outsideIndex = drag?.status === 'outside' ? drag.index : null;
		untrack(() => {
			if (outsideIndex !== null && outsideIndex !== lastOutside) {
				detent = outsideIndex;
				clearTimeout(detentTimer);
				detentTimer = setTimeout(() => (detent = null), DETENT_MS);
			}
			lastOutside = outsideIndex;
		});
	});
	$effect(() => () => clearTimeout(detentTimer));

	// --- handles ----------------------------------------------------------------------------------

	const handleX = (band: Band) => (band.kind === 'OFF' ? 0 : xOf(band.freqHz));
	const handleY = (band: Band) => yOf(clamp(handleGain(band), DB_MIN, DB_MAX));

	function handleLabel(band: Band, index: number): string {
		if (band.kind === 'OFF') return '';
		if (isLockedKind(band.kind, layer)) {
			return m.curva_handle_locked({ index: String(index + 1), kind: band.kind }, messages);
		}
		return m.curva_handle_hint(
			{
				index: String(index + 1),
				kind: band.kind,
				freq: formatHz(band.freqHz, locale),
				gain: hasGain(band) ? formatSignedDb(band.gainDb, locale) : '',
				q: formatQ(band.qFactor, locale)
			},
			messages
		);
	}

	function readout(band: Band): string {
		if (band.kind === 'OFF') return '';
		const freq = formatHz(band.freqHz, locale);
		const q = formatQ(band.qFactor, locale);
		return hasGain(band)
			? m.curva_bubble({ freq, gain: formatSignedDb(band.gainDb, locale), q }, messages)
			: m.curva_bubble_nogain({ freq, q }, messages);
	}

	/** Readout bubble next to the handle being moved (pointer, wheel or advisory drag). */
	const bubble = $derived.by(() => {
		const index = active?.index ?? wheelState?.index ?? drag?.index ?? null;
		if (index === null) return null;
		const band = curve.bands[index];
		if (!band || band.kind === 'OFF') return null;
		const text = readout(band);
		const width = text.length * labelSize * 0.62 + 16;
		const height = labelSize + 12;
		const hx = handleX(band);
		const hy = handleY(band);
		const above = hy - ringR - 10 - height > PLOT.top;
		return {
			text,
			width,
			height,
			x: clamp(hx - width / 2, PLOT.left, PLOT.right - width),
			y: above ? hy - ringR - 10 - height : hy + ringR + 10,
			outside: drag?.index === index && drag.status === 'outside'
		};
	});

	function viewPoint(event: PointerEvent): { vx: number; vy: number } | null {
		if (!overlay) return null;
		const rect = overlay.getBoundingClientRect();
		return {
			vx: ((event.clientX - rect.left) / rect.width) * VIEW_WIDTH,
			vy: ((event.clientY - rect.top) / rect.height) * VIEW_HEIGHT
		};
	}

	function onpointerdown(event: PointerEvent, band: Band, index: number) {
		if (!editable || band.kind === 'OFF' || isLockedKind(band.kind, layer)) return;
		if (event.button > 0) return;
		event.preventDefault();
		if (event.currentTarget instanceof Element) {
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		selected = index;
		activeTarget = {};
		active = { index, pointer: event.pointerId, start: band };
	}
	function onpointermove(event: PointerEvent) {
		if (!active || active.pointer !== event.pointerId) return;
		const point = viewPoint(event);
		if (!point) return;
		const start = active.start;
		let target: DragTarget = pointerTarget(point.vx, point.vy, start);
		// Shift keeps the frequency, Alt keeps the gain (mock).
		if (event.shiftKey && start.kind !== 'OFF') target = { ...target, freqHz: start.freqHz };
		if (event.altKey && hasGain(start)) target = { ...target, gainDb: start.gainDb };
		activeTarget = target;
		ondrag(active.index, target);
	}
	function onpointerup(event: PointerEvent) {
		if (!active || active.pointer !== event.pointerId) return;
		const { index } = active;
		const target = activeTarget;
		activeTarget = {};
		active = null;
		if (Object.keys(target).length > 0) oncommit(index, target);
	}

	function onkeydown(event: KeyboardEvent, band: Band, index: number) {
		if (band.kind === 'OFF' || isLockedKind(band.kind, layer)) return;
		const target = keyTarget(event.key, band, event);
		if (!target) return;
		event.preventDefault();
		selected = index;
		oncommit(index, target);
	}

	// Parked points: the dragged point is drawn here (the band is still OFF); release asks the page.
	function parkDown(event: PointerEvent, index: number) {
		if (!editable || !onpark || event.button > 0) return;
		event.preventDefault();
		if (event.currentTarget instanceof Element) {
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		parkedFocus = index;
		const hz = PARKED_HZ[index] ?? 1000;
		parkedActive = { index, pointer: event.pointerId, target: {}, x: xOf(hz), y: yOf(0) };
	}
	function parkMove(event: PointerEvent) {
		if (!parkedActive || parkedActive.pointer !== event.pointerId) return;
		const point = viewPoint(event);
		if (!point) return;
		const target = pointerTarget(point.vx, point.vy, parkedBand(parkedActive.index));
		parkedActive = {
			...parkedActive,
			target,
			x: xOf(target.freqHz),
			y: yOf(clamp(target.gainDb ?? 0, DB_MIN, DB_MAX))
		};
	}
	function parkUp(event: PointerEvent) {
		if (!parkedActive || parkedActive.pointer !== event.pointerId) return;
		const { index, target } = parkedActive;
		parkedActive = null;
		if (event.type !== 'pointercancel' && Object.keys(target).length > 0) create(index, target);
	}
	function parkKey(event: KeyboardEvent, index: number) {
		if (!onpark) return;
		const target = keyTarget(event.key, parkedBand(index), event);
		if (!target) return;
		event.preventDefault();
		create(index, target);
	}
	/** Asks the page for the filter, then hands keyboard focus to its new handle. */
	async function create(index: number, target: DragTarget) {
		selected = index;
		onpark?.(index, target);
		await tick();
		overlay?.querySelector<SVGGElement>(`.handle[data-index="${index}"]`)?.focus();
	}

	/** Wheel over a handle: Q in 0.1 steps (Shift ×10, Alt ×0.1), committed 260 ms after the last. */
	function wheelQ(node: SVGSVGElement) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onwheel = (event: WheelEvent) => {
			const element = event.target instanceof Element ? event.target.closest('.handle') : null;
			if (!(element instanceof SVGGElement) || element.classList.contains('parked')) return;
			const index = Number(element.dataset.index);
			const band = curve.bands[index];
			if (!band || band.kind === 'OFF' || isLockedKind(band.kind, layer)) return;
			const delta = event.deltaY || event.deltaX;
			if (!delta) return;
			event.preventDefault();
			selected = index;
			const base = wheelState?.index === index ? wheelState.q : band.qFactor;
			const q = stepQ(base, delta < 0 ? 1 : -1, event.shiftKey ? 10 : event.altKey ? 0.1 : 1);
			wheelState = { index, q };
			ondrag(index, { qFactor: q });
			clearTimeout(timer);
			timer = setTimeout(() => {
				const state = wheelState;
				wheelState = null;
				if (state) oncommit(state.index, { qFactor: state.q });
			}, 260);
		};
		node.addEventListener('wheel', onwheel, { passive: false });
		return () => {
			node.removeEventListener('wheel', onwheel);
			clearTimeout(timer);
		};
	}

	function previewKey(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ' ') onpreviewwarm?.();
	}
	const previewNote = $derived(previewDisabled && previewReason ? previewReason : previewCaption);
	// A/B needs this page's chains, which exist while playing and while paused (`select()` works
	// on a paused preview); with no session there is nothing to switch, and the tabs say why.
	const abReady = $derived(playing || paused);
	const leverLabel = $derived(
		playing ? m.curva_preview_stop() : paused ? m.transport_toggle_resume() : m.curva_preview()
	);
	function chooseSide(next: ABSide): void {
		// aria-disabled keeps the tab focusable: a click, Enter or Space must still do nothing.
		if (!abReady) return;
		onside(next);
	}

	/** The layout provides the app context; isolated renders (tests) pass `engine` instead. */
	function optionalAppContext(): AppContext | null {
		try {
			return getAppContext();
		} catch (missing) {
			console.debug('ScopePanel rendered without the app context', missing);
			return null;
		}
	}
	const appContext = optionalAppContext();
	const transportEngine = $derived(engine ?? appContext?.client?.audio ?? null);
	/** Transport play with nothing of Curva paused: the page's own start (A/B, level match). */
	function onTransportPlay(): void {
		if (!previewDisabled && !playing) onpreview();
	}
</script>

<section class="psec ps-scope" aria-labelledby={legendId} data-dragging={dragging ? '' : undefined}>
	<div class="bezel" data-tour="curva-chart">
		<span class="screw s1" aria-hidden="true"></span>
		<span class="screw s2" aria-hidden="true"></span>
		<span class="screw s3" aria-hidden="true"></span>
		<span class="screw s4" aria-hidden="true"></span>
		<!-- A separate caption plate stays outside every handle's clipped plotting area. The
		     threshold line below still uses its exact dB coordinate, including for Neutro. -->
		<p class="lim-t" aria-hidden="true">
			{m.curva_limit_line({ db: formatSignedDb(OUTPUT_LIMIT_DB, locale, 2) })}
		</p>
		<div
			class="screen"
			class:reduced
			bind:clientWidth={screenWidth}
			style={`--gfs:${labelSize.toFixed(1)}px`}
		>
			<svg
				class="scope"
				viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
				role="img"
				aria-label={m.curva_scope_label()}
			>
				<title>{m.curva_scope_label()}</title>
				<desc>{m.curva_scope_desc()}</desc>
				<defs>
					<clipPath id="{legendId}-clip">
						<rect
							x={PLOT.left}
							y={PLOT.top}
							width={PLOT.right - PLOT.left}
							height={PLOT.bottom - PLOT.top}
						/>
					</clipPath>
					<pattern
						id="{legendId}-hatch"
						width="7"
						height="7"
						patternUnits="userSpaceOnUse"
						patternTransform="rotate(45)"
					>
						<line x1="0" y1="0" x2="0" y2="7" class="hatch-line" />
					</pattern>
					<linearGradient id="{legendId}-sweep" x1="0" x2="1">
						<stop offset="0" stop-color="#ff7a2f" stop-opacity="0" />
						<stop offset="1" stop-color="#ff7a2f" stop-opacity="0.08" />
					</linearGradient>
				</defs>
				<g class="grat" aria-hidden="true">
					{#each MINOR_FREQS as f (f)}
						<line x1={xOf(f)} x2={xOf(f)} y1={PLOT.top} y2={PLOT.bottom} />
					{/each}
					{#each MAJOR_FREQS as f, k (f)}
						<line class="gmaj" x1={xOf(f)} x2={xOf(f)} y1={PLOT.top} y2={PLOT.bottom} />
						{#if f !== 10000}
							<text
								class:alt={f === 50 || f === 200 || f === 2000 || f === 5000}
								x={xOf(f)}
								y={PLOT.bottom + 20}
								text-anchor={k === 0 ? 'start' : k === MAJOR_FREQS.length - 1 ? 'end' : 'middle'}
								>{f >= 1000 ? `${f / 1000}k` : f}</text
							>
						{/if}
					{/each}
					{#each [-15, -10, -5, 0, 5, 10, 15] as db (db)}
						<line
							class={db === 0 ? 'g0' : 'gmaj'}
							x1={PLOT.left}
							x2={PLOT.right}
							y1={yOf(db)}
							y2={yOf(db)}
						/>
						<text x={PLOT.left - 8} y={yOf(db) + 4} text-anchor="end"
							>{db > 0 ? `+${db}` : db < 0 ? `\u2212${-db}` : '0'}</text
						>
					{/each}
				</g>
				<g clip-path="url(#{legendId}-clip)" aria-hidden="true">
					{#if !reduced}
						<rect
							class="sweep"
							x={PLOT.left - 40}
							y={PLOT.top}
							width="40"
							height={PLOT.bottom - PLOT.top}
							fill="url(#{legendId}-sweep)"
						/>
					{/if}
					{#each nearOutput as s (s.fromHz)}
						<rect
							class="zone-near"
							x={xOf(s.fromHz)}
							y={PLOT.top}
							width={Math.max(2, xOf(s.toHz) - xOf(s.fromHz))}
							height={PLOT.bottom - PLOT.top}
						/>
					{/each}
					{#each overInternal as s (s.fromHz)}
						<rect
							class="zone-hot internal"
							x={xOf(s.fromHz)}
							y={PLOT.top}
							width={Math.max(2, xOf(s.toHz) - xOf(s.fromHz))}
							height={PLOT.bottom - PLOT.top}
						/>
					{/each}
					{#each overOutput as s (s.fromHz)}
						<rect
							class="zone-hot"
							x={xOf(s.fromHz)}
							y={PLOT.top}
							width={Math.max(2, xOf(s.toHz) - xOf(s.fromHz))}
							height={PLOT.bottom - PLOT.top}
						/>
					{/each}
					<line
						class="lim"
						x1={PLOT.left}
						x2={PLOT.right}
						y1={yOf(OUTPUT_LIMIT_DB)}
						y2={yOf(OUTPUT_LIMIT_DB)}
					/>
					{#if boxRect}
						<rect
							class="safe"
							class:out={!insideBox}
							class:lit={grabbed}
							x={boxRect.x}
							y={boxRect.y}
							width={boxRect.width}
							height={boxRect.height}
						/>
					{/if}
					{#each zones as zone (zone.kind)}
						<rect
							class="hard"
							x={xOf(zone.fMin)}
							y={yOf(Math.min(zone.gMax, DB_MAX))}
							width={xOf(zone.fMax) - xOf(zone.fMin)}
							height={yOf(Math.max(zone.gMin, DB_MIN)) - yOf(Math.min(zone.gMax, DB_MAX))}
							fill="url(#{legendId}-hatch)"
						/>
					{/each}
					{#if refPath}<path class="tr-ref" d={refPath} />{/if}
				</g>
			</svg>
			<!-- The live part of the plot, stacked right above it in the same order (so at rest the
			     screen looks exactly the same): the traces that move with a handle and the labels
			     drawn over them. While a point moves it gets its own layer (CSS [data-dragging]),
			     so the static plot underneath is never repainted. -->
			<svg class="scope-live" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} aria-hidden="true">
				<defs>
					<filter id="{legendId}-phos" x="-10%" y="-30%" width="120%" height="160%">
						<feGaussianBlur stdDeviation="2.2" result="b" />
						<feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
					</filter>
					<clipPath id="{legendId}-clip-live">
						<rect
							x={PLOT.left}
							y={PLOT.top}
							width={PLOT.right - PLOT.left}
							height={PLOT.bottom - PLOT.top}
						/>
					</clipPath>
				</defs>
				<g clip-path="url(#{legendId}-clip-live)" aria-hidden="true">
					{#if editable}
						{#each bandPaths as d, index (index)}
							{#if d}
								<path
									class="tr-band"
									class:sel={index === selected}
									class:out={drag?.index === index && drag.status === 'outside'}
									{d}
								/>
							{/if}
						{/each}
					{/if}
					{#if ghost}
						{#key ghost.key}
							<path class="tr-after" d={ghost.path} />
						{/key}
					{/if}
					{#key drawKey}
						<path class="tr-out" class:draw={drawKey > 0 && !reduced} pathLength="1" d={outPath} />
						<path
							class="tr-eq"
							class:draw={drawKey > 0 && !reduced}
							pathLength="1"
							d={eqPath}
							filter="url(#{legendId}-phos)"
						/>
					{/key}
					{#each overOutput as s (s.fromHz)}
						<path class="tr-hot" d={segmentPath(live.output, s.fromHz, s.toHz, grid)} />
					{/each}
					{#if peak && peak.db > DB_MIN && peak.db < DB_MAX}
						<circle class="peakmk" cx={xOf(clamp(peak.hz, 20, 20000))} cy={yOf(peak.db)} r="3.5" />
					{/if}
					{#if parked && !editable}
						{#each PARKED_HZ as hz, index (hz)}
							<g
								class="parked-dot"
								transform={`translate(${xOf(hz).toFixed(1)} ${yOf(0).toFixed(1)})`}
							>
								<circle r={ringR} />
								<text style={`font-size:${handleFont.toFixed(1)}px`}>{index + 1}</text>
							</g>
						{/each}
					{/if}
				</g>
				<g class="labels" aria-hidden="true">
					{#if boxRect}
						<text
							class="safe-t"
							class:out={!insideBox}
							class:lit={grabbed}
							x={boxRect.x + 6}
							y={boxRect.y + 14}>{m.curva_safe_box({}, messages)}</text
						>
					{/if}
					{#each zones as zone (zone.kind)}
						{#if zone.kind === 'pk-high-boost'}
							<text
								class="hard-t"
								x={xOf(zone.fMin) - 4}
								y={yOf(Math.min(zone.gMax, DB_MAX)) + 14}
								text-anchor="end">{m.curva_d7_zone({}, messages)}</text
							>
						{:else}
							<text class="hard-t" x={PLOT.left + 8} y={yOf(DB_MAX) + 14}
								>{m.curva_hard_limit({}, messages)}</text
							>
						{/if}
					{/each}
					{#if hotLabel}
						<text
							class="hot-t"
							x={clamp(
								xOf(Math.sqrt(hotLabel.fromHz * hotLabel.toHz)),
								PLOT.left + 70,
								PLOT.right - 70
							)}
							y={PLOT.bottom - 10}
							text-anchor="middle">{m.curva_hot_output({}, messages)}</text
						>
					{:else if internalLabel}
						<text
							class="hot-t"
							x={clamp(
								xOf(Math.sqrt(internalLabel.fromHz * internalLabel.toHz)),
								PLOT.left + 70,
								PLOT.right - 70
							)}
							y={PLOT.bottom - 10}
							text-anchor="middle">{m.curva_hot_internal({}, messages)}</text
						>
					{:else if nearOutput.length > 0}
						<text
							class="near-t"
							x={clamp(
								xOf(Math.sqrt((nearOutput[0]?.fromHz ?? 20) * (nearOutput[0]?.toHz ?? 20))),
								PLOT.left + 60,
								PLOT.right - 60
							)}
							y={PLOT.bottom - 10}
							text-anchor="middle">{m.curva_near_limit({}, messages)}</text
						>
					{/if}
				</g>
			</svg>
			{#if editable}
				<svg
					bind:this={overlay}
					class="handles"
					viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
					role="group"
					aria-label={m.curva_handles_label()}
					{@attach wheelQ}
				>
					{#each curve.bands as band, index (index)}
						{#if band.kind !== 'OFF'}
							{@const locked = isLockedKind(band.kind, layer)}
							<g
								class="handle"
								class:locked
								class:sel={selected === index && !locked}
								class:dragging={active?.index === index}
								class:outside={drag?.index === index && drag.status === 'outside'}
								class:detent={detent === index}
								class:refused={shake === index}
								data-index={index}
								role="slider"
								tabindex="0"
								aria-label={handleLabel(band, index)}
								aria-valuemin={20}
								aria-valuemax={20000}
								aria-valuenow={band.freqHz}
								aria-valuetext={`${formatHz(band.freqHz, locale)}${hasGain(band) ? `, ${formatSignedDb(band.gainDb, locale)}` : ''}`}
								aria-disabled={locked}
								transform={`translate(${handleX(band).toFixed(1)} ${handleY(band).toFixed(1)})`}
								onpointerdown={(event) => onpointerdown(event, band, index)}
								{onpointermove}
								{onpointerup}
								onpointercancel={onpointerup}
								onkeydown={(event) => onkeydown(event, band, index)}
								onfocus={() => {
									if (!locked) selected = index;
								}}
							>
								<circle r={hitR} class="hit" />
								<g class="body">
									<circle r={ringR} class="ring" />
									<text class="num" style={`font-size:${handleFont.toFixed(1)}px`}>{index + 1}</text
									>
								</g>
							</g>
						{/if}
					{/each}
					{#if parked}
						{#each PARKED_HZ as hz, index (hz)}
							{@const held = parkedActive?.index === index ? parkedActive : null}
							<g
								class="handle parked"
								class:sel={parkedFocus === index}
								class:dragging={held !== null}
								data-parked={index}
								role="slider"
								tabindex="0"
								aria-label={m.curva_v2_parked({ index: String(index + 1) })}
								aria-valuemin={20}
								aria-valuemax={20000}
								aria-valuenow={hz}
								aria-valuetext={`${formatHz(hz, locale)}, ${formatSignedDb(0, locale)}`}
								transform={`translate(${(held?.x ?? xOf(hz)).toFixed(1)} ${(held?.y ?? yOf(0)).toFixed(1)})`}
								onpointerdown={(event) => parkDown(event, index)}
								onpointermove={parkMove}
								onpointerup={parkUp}
								onpointercancel={parkUp}
								onkeydown={(event) => parkKey(event, index)}
								onfocus={() => (parkedFocus = index)}
								onblur={() => {
									if (parkedFocus === index && !parkedActive) parkedFocus = null;
								}}
							>
								<circle r={hitR} class="hit" />
								<g class="body">
									<circle r={ringR} class="ring" />
									<text class="num" style={`font-size:${handleFont.toFixed(1)}px`}>{index + 1}</text
									>
								</g>
							</g>
						{/each}
					{/if}
					{#if bubble}
						<g class="bubble" class:out={bubble.outside} aria-hidden="true">
							<rect x={bubble.x} y={bubble.y} width={bubble.width} height={bubble.height} rx="3" />
							<text x={bubble.x + bubble.width / 2} y={bubble.y + bubble.height / 2}
								>{bubble.text}</text
							>
						</g>
					{/if}
				</svg>
			{/if}
			{#if editable && chip}
				<p class="chip" data-state={chip} aria-hidden="true">
					<i class="led"></i><b>{m.curva_chip_label()}</b>{chipText}
					{#if chipWhy}<span class="chip-why">{chipWhy}</span>{/if}
				</p>
			{/if}
			{#if parked}
				<p class="park-hint">{m.empty_neutral_body()}</p>
			{/if}
		</div>
	</div>
	<div class="scope-legend">
		<span><i class="sw"></i>{m.curva_scope_eq()}</span>
		<span><i class="sw out"></i>{m.curva_scope_out()}</span>
		{#if refPath}<span><i class="sw ref"></i>{m.curva_scope_ref({ name: referenceName })}</span
			>{/if}
		{#if editable}<span class="leg-help"><i class="sw box"></i>{m.curva_safe_box()}</span><Explainer
				term="envelope"
			/>{/if}
		{#if peak}
			<span class="pk"
				>{m.curva_peak_at(
					{
						db: formatSignedDb(peak.db, locale, 2),
						freq: formatHz(Math.round(peak.hz), locale)
					},
					messages
				)}</span
			>
		{/if}
	</div>
	{#if message}
		<p class="scope-msg" class:danger={messageTone === 'danger'} role="status">{message}</p>
	{/if}
	{#if editable && curve.bands.some((band) => band.kind !== 'OFF' && isLockedKind(band.kind, layer))}
		<p class="exp-hint">{m.curva_exp_hint()}</p>
	{/if}
	<div class="spectrum">
		<MeterModeLabel mode={spectrumMode} />
		<SpectrumOverlay
			mode={spectrumMode}
			{analyser}
			width={820}
			height={90}
			label={m.curva_spectrum_label()}
		/>
	</div>
	<div class="preview-row">
		<button
			type="button"
			class="bat"
			aria-pressed={playing}
			aria-disabled={previewDisabled ? 'true' : undefined}
			aria-describedby="{legendId}-prev"
			onpointerdown={() => onpreviewwarm?.()}
			onkeydown={previewKey}
			onclick={() => {
				if (!previewDisabled) onpreview();
			}}
		>
			<span class="well" aria-hidden="true"><span class="lever"></span></span>
			<span class="bl">
				<span>{leverLabel}</span>
				<small id="{legendId}-prev" aria-hidden="true">{previewNote}</small>
			</span>
		</button>
		<div
			class="ab"
			role="radiogroup"
			aria-label={m.curva_ab_label()}
			aria-describedby={abReady ? undefined : `${legendId}-ab`}
		>
			<span class="well" data-pos={side} aria-hidden="true"><span class="lever"></span></span>
			<span class="ab-body">
				<span class="bl" aria-hidden="true">{m.curva_v2_ab_title()}</span>
				<span class="ab-keys">
					<button
						type="button"
						role="radio"
						class="tab"
						aria-checked={side === 'A'}
						aria-disabled={abReady ? undefined : 'true'}
						aria-describedby={abReady ? undefined : `${legendId}-ab`}
						onclick={() => chooseSide('A')}>{m.curva_ab_a({ name: referenceName })}</button
					>
					<button
						type="button"
						role="radio"
						class="tab"
						aria-checked={side === 'B'}
						aria-disabled={abReady ? undefined : 'true'}
						aria-describedby={abReady ? undefined : `${legendId}-ab`}
						onclick={() => chooseSide('B')}>{m.curva_ab_b()}</button
					>
				</span>
			</span>
		</div>
		{#if !abReady}
			<small class="ab-why" id="{legendId}-ab">{m.curva_v2_ab_unavailable()}</small>
		{/if}
		<div class="transport">
			<Transport
				engine={transportEngine}
				variant="compact"
				session={CURVA_SESSION}
				onplay={onTransportPlay}
				playDisabledReason={previewDisabled ? previewReason : null}
			/>
		</div>
		<div class="prev-note">{m.curva_preview_note()} <Explainer term="ab-nivel" /></div>
		{#if playing && approximate}
			<p class="prev-note prev-approx" role="status">{m.curva_approximate()}</p>
		{/if}
		{#if previewError}
			<p class="prev-error" role="alert">{previewError}</p>
		{/if}
	</div>
	<h2 class="legend-bar" id={legendId}>{m.curva_scope_heading()}</h2>
</section>

<style>
	.bezel {
		position: relative;
		padding: 13px;
		border-radius: var(--rad-2xl);
		background: linear-gradient(150deg, #323331, #1a1b1a 45%, #111211);
		box-shadow:
			inset 0 1px 0 rgb(255 255 255 / 0.09),
			inset 0 -2px 6px rgb(0 0 0 / 0.6),
			0 10px 22px rgb(0 0 0 / 0.55);
	}
	.screw {
		position: absolute;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background:
			linear-gradient(var(--r, 35deg), transparent 42%, #1a1a19 42% 58%, transparent 58%),
			radial-gradient(circle at 35% 35%, #d9d5cc, #77736b 70%);
	}
	.s1 {
		left: 5px;
		top: 5px;
	}
	.s2 {
		right: 5px;
		top: 5px;
		--r: -20deg;
	}
	.s3 {
		left: 5px;
		bottom: 5px;
		--r: 80deg;
	}
	.s4 {
		right: 5px;
		bottom: 5px;
	}
	.screen {
		position: relative;
		overflow: hidden;
		border-radius: 22px / 16px;
		background: radial-gradient(ellipse at 50% 45%, #1d140d 0%, #0d0a07 68%, #050403 100%);
		box-shadow:
			inset 0 0 44px rgb(0 0 0 / 0.95),
			inset 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent),
			0 0 28px color-mix(in srgb, var(--accent) 8%, transparent);
	}
	/* Curved glass: a reflection and fine scanlines over the phosphor (decorative). */
	.screen::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background:
			radial-gradient(120% 70% at 30% 0%, rgb(255 255 255 / 0.07), transparent 55%),
			linear-gradient(160deg, rgb(255 255 255 / 0.08), transparent 32%),
			repeating-linear-gradient(0deg, rgb(0 0 0 / 0.2) 0 1px, transparent 1px 3px);
		pointer-events: none;
	}
	.scope {
		display: block;
		width: 100%;
		height: auto;
		user-select: none;
	}
	/* Exactly over the static plot (same box and viewBox as the handles); never a hit target. */
	.scope-live {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		user-select: none;
	}
	.scope text,
	.scope-live text {
		font-family: var(--face-data);
		font-size: var(--gfs, 11px);
	}
	.grat line {
		stroke: rgb(255 140 70 / 0.12);
		stroke-width: 1;
	}
	.grat .gmaj {
		stroke: rgb(255 140 70 / 0.22);
	}
	.grat .g0 {
		stroke: rgb(255 160 90 / 0.42);
	}
	.grat text {
		fill: rgb(255 180 120 / 0.68);
	}
	.hatch-line {
		stroke: rgb(229 72 77 / 0.35);
		stroke-width: 2;
	}
	.sweep {
		animation: sweep 9s linear infinite;
	}
	@keyframes sweep {
		from {
			transform: translateX(0);
		}
		to {
			transform: translateX(764px);
		}
	}
	.zone-near {
		fill: rgb(255 176 64 / 0.08);
	}
	.zone-hot {
		fill: rgb(229 72 77 / 0.16);
	}
	.zone-hot.internal {
		fill: rgb(229 72 77 / 0.1);
	}
	.lim {
		stroke: rgb(255 215 190 / 0.45);
		stroke-dasharray: 2 5;
	}
	.lim-t {
		width: fit-content;
		max-width: 100%;
		margin: 0 0 8px auto;
		padding: 3px 8px;
		border-radius: var(--rad-sm);
		background: #0d0a07;
		color: rgb(255 215 190 / 0.7);
		font: 400 var(--label-min) / 1.3 var(--face-data);
		pointer-events: none;
		user-select: none;
	}
	.safe {
		fill: rgb(255 122 47 / 0.06);
		stroke: rgb(255 122 47 / 0.45);
		stroke-dasharray: 3 4;
		transition:
			fill var(--dur-fast) var(--ease-out),
			stroke var(--dur-fast) var(--ease-out),
			stroke-width var(--dur-fast) var(--ease-out);
	}
	/* A grabbed point: the box it may roam lights up. */
	.safe.lit {
		fill: rgb(255 122 47 / 0.13);
		stroke: var(--accent);
		stroke-width: 1.6;
		filter: drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 70%, transparent));
	}
	.safe.out {
		fill: rgb(255 176 64 / 0.04);
		stroke: rgb(255 176 64 / 0.75);
	}
	.safe-t {
		fill: rgb(255 160 110 / 0.8);
	}
	.safe-t.lit {
		fill: var(--accent-hi);
	}
	.safe-t.out {
		fill: rgb(255 196 120 / 0.95);
	}
	.hard {
		stroke: rgb(229 72 77 / 0.35);
		stroke-dasharray: 2 3;
	}
	.hard-t {
		fill: rgb(255 140 140 / 0.85);
	}
	.hot-t {
		fill: #ff8f8f;
		font-weight: 500;
	}
	.near-t {
		fill: #ffc078;
	}
	.tr-ref {
		fill: none;
		stroke: rgb(255 210 175 / 0.34);
		stroke-width: 1.2;
		stroke-dasharray: 4 4;
	}
	.tr-band {
		fill: none;
		stroke: rgb(255 122 47 / 0.26);
		stroke-width: 1;
	}
	.tr-band.sel {
		stroke: rgb(255 200 160 / 0.8);
		stroke-width: 1.4;
	}
	.tr-band.out {
		stroke: rgb(229 72 77 / 0.9);
	}
	.tr-after {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2.2;
		opacity: 0;
		animation: after 1.5s ease-out;
	}
	@keyframes after {
		from {
			opacity: 0.5;
		}
		to {
			opacity: 0;
		}
	}
	.tr-out {
		fill: none;
		stroke: #ffe0c7;
		stroke-width: 1.3;
		opacity: 0.8;
	}
	.tr-eq {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2.6;
		stroke-linejoin: round;
	}
	/* A preset loads: the beam traces the new curve once, left to right (pathLength = 1). */
	.draw {
		stroke-dasharray: 1;
		stroke-dashoffset: 1;
		animation: draw var(--dur-slow) var(--ease-out) forwards;
	}
	@keyframes draw {
		to {
			stroke-dashoffset: 0;
		}
	}
	.tr-hot {
		fill: none;
		stroke: #ff4d55;
		stroke-width: 2.4;
	}
	.peakmk {
		fill: #ffe0c7;
	}
	.parked-dot circle {
		fill: rgb(10 8 6 / 0.85);
		stroke: rgb(255 224 199 / 0.6);
		stroke-width: 1.4;
		stroke-dasharray: 3 2;
	}
	.parked-dot text {
		fill: rgb(255 224 199 / 0.8);
		text-anchor: middle;
		dominant-baseline: central;
	}
	.handles {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		touch-action: none;
		user-select: none;
	}
	.handle {
		cursor: grab;
		outline: none;
	}
	.handle .hit {
		fill: transparent;
	}
	.handle .ring {
		fill: rgb(10 8 6 / 0.85);
		stroke: #ffe0c7;
		stroke-width: 1.6;
		transition:
			stroke var(--dur-fast) var(--ease-out),
			fill var(--dur-fast) var(--ease-out);
	}
	.handle .num {
		fill: #ffe0c7;
		font-family: var(--face-data);
		font-weight: 500;
		text-anchor: middle;
		dominant-baseline: central;
		pointer-events: none;
	}
	.handle:hover .ring {
		stroke: #fff3e8;
		stroke-width: 2;
	}
	.handle.parked .ring {
		stroke-dasharray: 3 2;
	}
	.handle.sel .ring {
		stroke: var(--accent);
		stroke-width: 2.4;
		filter: drop-shadow(0 0 3px rgb(255 122 47 / 0.8));
	}
	.handle.sel .num {
		fill: var(--accent);
	}
	.handle:focus-visible .ring {
		stroke: var(--accent);
		stroke-width: 3.2;
	}
	.handle.dragging {
		cursor: grabbing;
	}
	.handle.dragging .ring {
		fill: var(--accent);
		stroke: #fff3e8;
		stroke-dasharray: none;
	}
	.handle.dragging .num {
		fill: var(--accent-ink);
	}
	.handle.outside .ring {
		fill: rgb(60 8 10 / 0.9);
		stroke: #ff4d55;
		filter: drop-shadow(0 0 4px rgb(229 72 77 / 0.9));
	}
	.handle.outside .num {
		fill: #ffb3b6;
	}
	/* The boundary detent: the ring knocks once against the stop (120 ms, mechanical easing). */
	.handle.detent .body {
		transform-box: fill-box;
		transform-origin: center;
		animation: detent var(--dur-fast) var(--ease-mech);
	}
	@keyframes detent {
		0% {
			transform: scale(1.28);
		}
		100% {
			transform: scale(1);
		}
	}
	.handle.refused .body {
		animation: refused 0.42s ease-out;
	}
	@keyframes refused {
		0%,
		100% {
			transform: translateX(0);
		}
		20% {
			transform: translateX(-5px);
		}
		40% {
			transform: translateX(4px);
		}
		60% {
			transform: translateX(-3px);
		}
		80% {
			transform: translateX(2px);
		}
	}
	.handle.locked {
		cursor: not-allowed;
	}
	.handle.locked .ring {
		stroke: #8d8778;
		stroke-dasharray: 3 2;
	}
	.handle.locked .num {
		fill: #c9c1ae;
	}
	.bubble rect {
		fill: rgb(8 6 4 / 0.92);
		stroke: rgb(255 122 47 / 0.6);
	}
	.bubble text {
		fill: #ffe0c7;
		font-family: var(--face-data);
		font-size: var(--gfs, 11px);
		text-anchor: middle;
		dominant-baseline: central;
	}
	.bubble.out rect {
		stroke: #ff4d55;
	}
	.bubble.out text {
		fill: #ffd6d7;
	}
	.chip {
		position: absolute;
		top: 10px;
		left: 50%;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
		align-items: center;
		justify-content: center;
		max-width: min(70%, 520px);
		margin: 0;
		padding: 3px 10px;
		border: 1px solid rgb(255 122 47 / 0.25);
		border-radius: var(--rad-xl);
		background: rgb(8 6 4 / 0.86);
		color: var(--text-2, #cfc9be);
		font: 400 var(--label-min) / 1.3 var(--face-data);
		pointer-events: none;
		transform: translateX(-50%);
	}
	.chip b {
		font-weight: 500;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--text, #ece7dd);
	}
	.chip .led {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--ok);
		box-shadow: 0 0 6px var(--ok);
	}
	.chip[data-state='checking'] .led {
		background: var(--warn);
		box-shadow: 0 0 6px var(--warn);
	}
	.chip[data-state='outside'] {
		border-color: rgb(229 72 77 / 0.7);
		color: #ffd6d7;
	}
	.chip[data-state='outside'] .led {
		background: var(--danger);
		box-shadow: 0 0 8px var(--danger);
	}
	.chip-why {
		flex: 1 1 100%;
		font-family: var(--face-body);
		text-align: center;
	}
	.park-hint {
		position: absolute;
		right: 5%;
		bottom: 17%;
		max-width: 46%;
		margin: 0;
		padding: 4px 10px;
		border: 1px dashed rgb(255 224 199 / 0.4);
		border-radius: var(--rad-md);
		background: rgb(8 6 4 / 0.78);
		color: #ffe0c7;
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
		pointer-events: none;
	}
	.scope-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
		align-items: center;
		margin-top: 9px;
		color: var(--text-2);
		font: 400 var(--label-min) / 1.3 var(--face-data);
	}
	.leg-help {
		display: inline-flex;
		align-items: center;
	}
	.sw {
		display: inline-block;
		width: 16px;
		height: 0;
		margin-right: 5px;
		border-top: 2px solid var(--accent);
		vertical-align: 3px;
	}
	.sw.out {
		border-top: 1px solid #ffe0c7;
	}
	.sw.ref {
		border-top: 1px dashed rgb(255 210 175 / 0.7);
	}
	.sw.box {
		height: 8px;
		border: 1px dashed rgb(255 122 47 / 0.7);
		vertical-align: -1px;
	}
	.pk {
		margin-left: auto;
		color: var(--accent-text);
	}
	.scope-msg,
	.exp-hint,
	.prev-error {
		margin: 8px 0 0;
		padding: 7px 10px;
		border-left: 3px solid var(--accent);
		border-radius: var(--rad-sm);
		background: rgb(255 122 47 / 0.06);
		color: var(--text);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.scope-msg.danger,
	.prev-error {
		border: 1px solid var(--danger);
		border-left-width: 3px;
		background: rgb(20 6 6 / 0.92);
		color: #ffd6d7;
	}
	.spectrum {
		display: grid;
		gap: 4px;
		justify-items: start;
		margin-top: 8px;
	}
	.preview-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 18px;
		align-items: center;
		margin-top: 10px;
	}
	.bat {
		display: flex;
		gap: 8px;
		align-items: center;
		min-height: 44px;
		padding: 2px;
		border: 0;
		border-radius: var(--rad-sm);
		background: none;
		color: inherit;
		cursor: pointer;
	}
	.bat[aria-disabled='true'] {
		cursor: not-allowed;
	}
	.bat[aria-disabled='true'] .well {
		opacity: 0.55;
	}
	.well {
		position: relative;
		flex: none;
		width: 26px;
		height: 40px;
		border-radius: 13px;
		background: radial-gradient(
			circle at 50% 50%,
			#d7d2c8 0 7px,
			#77736b 8px,
			#262523 10px,
			#121211 13px
		);
		box-shadow: 0 2px 4px rgb(0 0 0 / 0.7);
	}
	.lever {
		position: absolute;
		top: 0;
		left: 9px;
		width: 8px;
		height: 20px;
		border-radius: 4px;
		background: linear-gradient(90deg, #8a867e, #f4f0e7 45%, #a19c93);
		box-shadow: 0 2px 2px rgb(0 0 0 / 0.6);
		transition: top var(--dur-fast) var(--ease-mech);
	}
	.bat[aria-pressed='true'] .lever,
	.well[data-pos='B'] .lever {
		top: 20px;
	}
	.bl {
		display: grid;
		gap: 2px;
		color: var(--text);
		font: 600 var(--fs-caption) / 1.15 var(--face-engrave);
		letter-spacing: 0.14em;
		text-align: left;
		text-transform: uppercase;
	}
	.bl small {
		color: var(--text-2);
		font: 400 var(--label-min) / 1.2 var(--face-data);
		letter-spacing: 0;
		text-transform: none;
	}
	.bat:hover:not([aria-disabled='true']) .lever {
		filter: brightness(1.08);
	}
	.ab {
		display: inline-flex;
		gap: 8px;
		align-items: center;
	}
	.ab-body {
		display: grid;
		gap: 3px;
	}
	.ab-keys {
		display: inline-flex;
		gap: 2px;
	}
	.tab {
		min-height: 28px;
		padding: 4px 9px;
		border: 1px solid #2c2c2a;
		border-radius: var(--rad-sm);
		background: linear-gradient(#262725, #141514);
		box-shadow:
			var(--bevel),
			0 2px 3px rgb(0 0 0 / 0.6);
		color: var(--text);
		font: 500 var(--label-min) / 1 var(--face-body);
		cursor: pointer;
		transition:
			transform var(--dur-instant) var(--ease-mech),
			border-color var(--dur-fast) var(--ease-out);
	}
	.tab:hover:not([aria-disabled='true']) {
		border-color: var(--rule-control);
	}
	.tab:active:not([aria-disabled='true']) {
		transform: translateY(1px);
		box-shadow: var(--well);
	}
	.tab[aria-checked='true'] {
		border-color: color-mix(in srgb, var(--accent) 55%, transparent);
		color: var(--accent-text);
		box-shadow: var(--well);
		transform: translateY(1px);
	}
	.tab[aria-disabled='true'] {
		color: var(--muted-hi);
		cursor: not-allowed;
	}
	.ab-why {
		color: var(--text-2);
		font: 400 var(--label-min) / 1.3 var(--face-data);
	}
	.transport {
		flex: 1 1 320px;
		min-width: 0;
	}
	button:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	.prev-note {
		flex: 1 1 260px;
		margin: 0;
		color: var(--text-2);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	/* While a point moves the scope repaints on every frame (in software on machines without a
	   GPU). Everything below is restored on release, so at rest nothing changes:
	   - the blurred effects over large areas (phosphor glow of the EQ trace, the lit safe box's
	     halo, the handle shadows) give way to plain strokes; the outside state keeps its red
	     ring, drawn thicker instead of glowing; the sweep holds still;
	   - the glass (reflection and scanlines over the whole screen) steps aside;
	   - what changes every frame gets its own layer and layout boundary (the live traces, the
	     handles, the peak readout), so the static plot, the screen and the rest of the page
	     are neither repainted nor laid out again for a move. */
	.ps-scope[data-dragging] .tr-eq,
	.ps-scope[data-dragging] .safe.lit,
	.ps-scope[data-dragging] .handle .ring {
		filter: none;
	}
	.ps-scope[data-dragging] .handle.outside .ring {
		stroke-width: 2.8;
	}
	.ps-scope[data-dragging] .sweep {
		animation-play-state: paused;
	}
	.ps-scope[data-dragging] .screen::after {
		visibility: hidden;
	}
	.ps-scope[data-dragging] .scope-live {
		contain: strict;
	}
	.ps-scope[data-dragging] .handles {
		contain: strict;
	}
	.ps-scope[data-dragging] .scope-legend .pk {
	}
	.reduced .sweep,
	.reduced .tr-after,
	.reduced .draw,
	.reduced .handle.detent .body,
	.reduced .handle.refused .body {
		animation: none;
	}
	@media (prefers-reduced-motion: reduce) {
		.sweep,
		.tr-after,
		.draw,
		.handle.detent .body,
		.handle.refused .body {
			animation: none;
		}
		.draw {
			stroke-dashoffset: 0;
		}
		.safe,
		.handle .ring,
		.lever,
		.tab {
			transition: none;
		}
	}
	@media (max-width: 720px) {
		.grat :global(.alt) {
			display: none;
		}
		.park-hint {
			right: 3%;
			bottom: 20%;
			max-width: 70%;
		}
	}
</style>
