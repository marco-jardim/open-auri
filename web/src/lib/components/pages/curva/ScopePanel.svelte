<!--
	Oscilloscope: the shared ResponseChart (core response), draggable filter handles (Ajustar and
	Engenharia), the live spectrum strip and the A/B preview switches.
	- Pointer moves ask the page for an advisory gate drag; release (or a key) commits: the page
	  rounds to the UI grid and revalidates on the full grid. Where the gate stops the band, the
	  reason is shown in plain language.
	- HS/LP/HP handles are locked outside Engenharia, with a hint.
-->
<script lang="ts">
	import { ResponseChart, RESPONSE_BOX, dbScale, logScale } from '#lib/charts/index.ts';
	import { MeterModeLabel, SpectrumOverlay } from '#lib/components/meters/index.ts';
	import type { MeterMode } from '#lib/audio/meters.ts';
	import type { ABSide } from '#lib/audio/engine.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { formatHz, formatQ, formatSignedDb } from './format.ts';
	import { isLockedKind, type Layer } from './layers.ts';
	import { hasGain, type Band, type Curve } from './model.ts';
	import type { DragTarget } from './drag.ts';

	interface Props {
		curve: Curve;
		layer: Layer;
		locale: string;
		/** Plain-language stop/refusal message from the last drag. */
		message?: string | null;
		spectrumMode: MeterMode;
		analyser: AnalyserNode | null;
		playing: boolean;
		side: ABSide;
		referenceName: string;
		previewError?: string | null;
		previewDisabled?: boolean;
		ondrag: (index: number, target: DragTarget) => void;
		oncommit: (index: number, target: DragTarget) => void;
		onpreview: () => void;
		onside: (side: ABSide) => void;
	}
	let {
		curve,
		layer,
		locale,
		message = null,
		spectrumMode,
		analyser,
		playing,
		side,
		referenceName,
		previewError = null,
		previewDisabled = false,
		ondrag,
		oncommit,
		onpreview,
		onside
	}: Props = $props();

	const MIN_DB = -24;
	const MAX_DB = 12;
	const box = RESPONSE_BOX;
	const x = logScale(20, 20000, box.left, box.left + box.width);
	const y = dbScale(MIN_DB, MAX_DB, box.top + box.height, box.top);
	const editable = $derived(layer !== 'ouvir');
	const legendId = $props.id();
	let overlay: SVGSVGElement | undefined = $state();
	let active = $state<{ index: number; pointer: number; target: DragTarget } | null>(null);

	const kindLabel = (band: Band) => band.kind;
	const gainOf = (band: Band) => (hasGain(band) ? band.gainDb : 0);

	function handleLabel(band: Band, index: number): string {
		if (band.kind === 'OFF') return '';
		if (isLockedKind(band.kind, layer)) {
			return m.curva_handle_locked({ index: String(index + 1), kind: kindLabel(band) });
		}
		return m.curva_handle_aria({
			index: String(index + 1),
			kind: kindLabel(band),
			freq: formatHz(band.freqHz, locale),
			gain: hasGain(band) ? formatSignedDb(band.gainDb, locale) : '',
			q: formatQ(band.qFactor, locale)
		});
	}

	function toTarget(event: PointerEvent, band: Band): DragTarget {
		if (!overlay) return {};
		const rect = overlay.getBoundingClientRect();
		const vx = ((event.clientX - rect.left) / rect.width) * 820;
		const vy = ((event.clientY - rect.top) / rect.height) * 380;
		const t = Math.min(1, Math.max(0, (vx - box.left) / box.width));
		const freqHz = Math.round(20 * Math.pow(1000, t));
		const db = MIN_DB + ((box.top + box.height - vy) / box.height) * (MAX_DB - MIN_DB);
		const gainDb = Math.round(Math.min(9.2, Math.max(-24, db)) * 10) / 10;
		return hasGain(band) ? { freqHz, gainDb } : { freqHz };
	}

	function onpointerdown(event: PointerEvent, band: Band, index: number) {
		if (!editable || band.kind === 'OFF' || isLockedKind(band.kind, layer)) return;
		event.preventDefault();
		(event.currentTarget as Element).setPointerCapture(event.pointerId);
		active = { index, pointer: event.pointerId, target: {} };
	}
	function onpointermove(event: PointerEvent, band: Band) {
		if (!active || active.pointer !== event.pointerId) return;
		const target = toTarget(event, band);
		active = { ...active, target };
		ondrag(active.index, target);
	}
	function onpointerup(event: PointerEvent) {
		if (!active || active.pointer !== event.pointerId) return;
		const { index, target } = active;
		active = null;
		if (Object.keys(target).length > 0) oncommit(index, target);
	}

	function onkeydown(event: KeyboardEvent, band: Band, index: number) {
		if (band.kind === 'OFF' || isLockedKind(band.kind, layer)) return;
		const scale = event.shiftKey ? 6 : event.altKey ? 0.25 : 1;
		let target: DragTarget;
		switch (event.key) {
			case 'ArrowLeft':
			case 'ArrowRight': {
				const octaves = (event.key === 'ArrowRight' ? 1 : -1) * (scale / 12);
				target = { freqHz: Math.round(band.freqHz * Math.pow(2, octaves)) };
				break;
			}
			case 'ArrowUp':
			case 'ArrowDown':
				if (!hasGain(band)) return;
				target = {
					gainDb:
						Math.round((band.gainDb + (event.key === 'ArrowUp' ? 0.5 : -0.5) * scale) * 10) / 10
				};
				break;
			case 'PageUp':
			case 'PageDown': {
				const factor = Math.pow(event.key === 'PageUp' ? 1.1 : 1 / 1.1, scale);
				target = { qFactor: Math.round(band.qFactor * factor * 100) / 100 };
				break;
			}
			default:
				return;
		}
		event.preventDefault();
		oncommit(index, target);
	}
</script>

<section class="psec ps-scope" aria-labelledby={legendId}>
	<div class="bezel">
		<div class="screen">
			<ResponseChart
				{curve}
				{locale}
				minDb={MIN_DB}
				maxDb={MAX_DB}
				label={m.curva_scope_label()}
				description={m.curva_scope_desc()}
				eqLabel={m.curva_scope_eq()}
				outputLabel={m.curva_scope_out()}
			/>
			{#if editable}
				<svg
					bind:this={overlay}
					class="handles"
					viewBox="0 0 820 380"
					role="group"
					aria-label={m.curva_handles_label()}
				>
					{#each curve.bands as band, index (index)}
						{#if band.kind !== 'OFF'}
							{@const locked = isLockedKind(band.kind, layer)}
							<g
								class="handle"
								class:locked
								class:dragging={active?.index === index}
								role="slider"
								tabindex="0"
								aria-label={handleLabel(band, index)}
								aria-valuemin={20}
								aria-valuemax={20000}
								aria-valuenow={band.freqHz}
								aria-valuetext={`${formatHz(band.freqHz, locale)}${hasGain(band) ? `, ${formatSignedDb(band.gainDb, locale)}` : ''}`}
								aria-disabled={locked}
								transform={`translate(${x(band.freqHz)} ${y(Math.max(MIN_DB, Math.min(MAX_DB, gainOf(band))))})`}
								onpointerdown={(event) => onpointerdown(event, band, index)}
								onpointermove={(event) => onpointermove(event, band)}
								{onpointerup}
								onpointercancel={onpointerup}
								onkeydown={(event) => onkeydown(event, band, index)}
							>
								<circle r="14" class="hit" />
								<circle r="8" class="dot" />
								<text y="4" text-anchor="middle">{index + 1}</text>
							</g>
						{/if}
					{/each}
				</svg>
			{/if}
		</div>
	</div>
	{#if message}
		<p class="scope-msg" role="status">{message}</p>
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
			disabled={previewDisabled}
			onclick={onpreview}
		>
			<span class="lever" aria-hidden="true"></span>
			{playing ? m.curva_preview_stop() : m.curva_preview()}
		</button>
		<div class="ab" role="radiogroup" aria-label={m.curva_ab_label()}>
			<button
				type="button"
				role="radio"
				aria-checked={side === 'A'}
				disabled={!playing}
				onclick={() => onside('A')}>{m.curva_ab_a({ name: referenceName })}</button
			>
			<button
				type="button"
				role="radio"
				aria-checked={side === 'B'}
				disabled={!playing}
				onclick={() => onside('B')}>{m.curva_ab_b()}</button
			>
		</div>
		<p class="prev-note">{m.curva_preview_note()}</p>
		{#if previewError}
			<p class="prev-error" role="alert">{previewError}</p>
		{/if}
	</div>
	<h2 class="legend-bar" id={legendId}>{m.curva_scope_heading()}</h2>
</section>

<style>
	.bezel {
		padding: 12px;
		border-radius: 14px;
		background: linear-gradient(#202020, #0b0b0b);
		box-shadow:
			inset 0 1px 0 rgb(255 255 255 / 0.08),
			0 6px 18px rgb(0 0 0 / 0.5);
	}
	.screen {
		position: relative;
		border-radius: 16px / 12px;
		overflow: hidden;
	}
	.handles {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		touch-action: none;
	}
	.handle {
		cursor: grab;
		outline: none;
	}
	.handle .hit {
		fill: transparent;
	}
	.handle .dot {
		fill: #101a16;
		stroke: var(--accent, #ff7a2f);
		stroke-width: 2;
	}
	.handle text {
		fill: var(--accent, #ff7a2f);
		font: 600 9px var(--font-mono, 'JetBrains Mono', monospace);
		pointer-events: none;
	}
	.handle.dragging {
		cursor: grabbing;
	}
	.handle.dragging .dot,
	.handle:focus-visible .dot {
		fill: var(--accent, #ff7a2f);
		stroke: #fff;
		stroke-width: 3;
	}
	.handle:focus-visible text,
	.handle.dragging text {
		fill: #101a16;
	}
	.handle.locked {
		cursor: not-allowed;
	}
	.handle.locked .dot {
		stroke: #8d8778;
		stroke-dasharray: 3 2;
	}
	.handle.locked text {
		fill: #c9c1ae;
	}
	.scope-msg,
	.exp-hint,
	.prev-error {
		margin: 8px 0 0;
		padding: 6px 8px;
		border-left: 3px solid var(--accent, #ff7a2f);
		font-size: 12px;
		color: var(--curva-silk, #e9e3d4);
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
		gap: 8px 12px;
		align-items: center;
		margin-top: 10px;
	}
	.bat,
	.ab button {
		min-height: 32px;
		padding: 4px 10px;
		border: 1px solid rgb(238 233 222 / 0.25);
		border-radius: 3px;
		background: linear-gradient(#2c2b29, #1d1c1b);
		color: var(--curva-silk, #e9e3d4);
		font: 600 11px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.06em;
		cursor: pointer;
	}
	.bat {
		display: inline-flex;
		gap: 8px;
		align-items: center;
	}
	.lever {
		width: 10px;
		height: 18px;
		border-radius: 2px;
		background: #555;
	}
	.bat[aria-pressed='true'] .lever {
		background: var(--accent, #ff7a2f);
	}
	.ab {
		display: inline-flex;
		gap: 2px;
	}
	.ab button[aria-checked='true'] {
		border-color: var(--accent, #ff7a2f);
		color: var(--accent, #ff7a2f);
	}
	button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	button:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 2px;
	}
	.prev-note {
		flex: 1 1 100%;
		margin: 0;
		font-size: 11px;
		color: var(--curva-silk-2, #c9c1ae);
	}
</style>
