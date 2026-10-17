<!--
	Output section (v2 mock): the output meter, readouts from the full-grid gate metrics of the editor
	curve and the gate verdict with its mandatory caveat (a similarity policy, not a hardware safety
	proof).
	- Meter, DATA mode (no preview): the needle shows the predicted OUTPUT PEAK of the curve (gate
	  metric `outputAudible`, dB) and glides to each new value (.9 s, mock). Hot arc from the gate's
	  output limit (−0,47 dB).
	- Meter, AO VIVO (preview playing): the needle shows the live VU of the selected chain output
	  (real meter tap, ballistics from the worklet, no added easing). Hot arc from 0 VU.
	- No metric (e.g. a codec failure): the needle rests, the face dims, the readouts say so. The
	  needle never moves without data. Reduced motion: no easing and a numeric readout.
	- "Máximo sem clipping" (mock headroom button): the page sets the highest preamp the full gate
	  accepts and the result is said here.
-->
<script lang="ts">
	import { prefersReducedMotion } from 'svelte/motion';
	import { levelDb } from 'open-auri/safety';
	// Direct imports (FUX.B): the meters barrel would bring every meter component into the page.
	import MeterModeLabel from '#lib/components/meters/MeterModeLabel.svelte';
	import { ThrottledNumber } from '#lib/components/meters/motion.svelte.ts';
	import type { MeterFrame, MeterMode } from '#lib/audio/meters.ts';
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import Button from '#lib/components/primitives/Button.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { formatHz, formatNumber, formatSignedDb } from './format.ts';
	import type { Curve } from './model.ts';
	import { firstReasonText, type GateVerdict } from './reasons.ts';
	import { OUTPUT_LIMIT_DB } from './scope.ts';

	interface Props {
		curve: Curve;
		verdict: GateVerdict;
		locale: string;
		mode: MeterMode;
		frame: MeterFrame | null;
		/** Preview side feeding the live meter. */
		side?: 'A' | 'B';
		/** Overrides the `prefers-reduced-motion` media query. */
		reducedMotion?: boolean;
		/** "Máximo sem clipping": sets the highest gate-approved preamp (omitted: no button). */
		onmaxclip?: () => void;
		/** Result of the last "Máximo sem clipping" press, in plain language. */
		maxClipMessage?: string | null;
		disabled?: boolean;
		/** Why "Máximo sem clipping" is unavailable while `disabled` (default: the editor is loading). */
		disabledReason?: string | null;
	}
	let {
		curve,
		verdict,
		locale,
		mode,
		frame,
		side = 'B',
		reducedMotion,
		onmaxclip,
		maxClipMessage = null,
		disabled = false,
		disabledReason = null
	}: Props = $props();

	const legendId = $props.id();
	const MIN = -12;
	const MAX = 3;
	const CX = 80;
	const CY = 112;
	const R = 80;
	const TICKS = [-12, -9, -6, -3, 0, 3];

	const clamp = (value: number) => (value < MIN ? MIN : value > MAX ? MAX : value);
	const angleOf = (value: number) => -50 + ((clamp(value) - MIN) / (MAX - MIN)) * 100;
	function polar(value: number, radius: number): { x: number; y: number } {
		const a = (angleOf(value) * Math.PI) / 180;
		return { x: CX + radius * Math.sin(a), y: CY - radius * Math.cos(a) };
	}
	const arc = (from: number, to: number) => {
		const a = polar(from, R);
		const b = polar(to, R);
		return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} A${R} ${R} 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
	};
	const ticks = TICKS.map((tick) => ({
		tick,
		outer: polar(tick, R),
		inner: polar(tick, R - 8),
		text: polar(tick, R - 17),
		label: tick > 0 ? `+${tick}` : tick < 0 ? `\u2212${-tick}` : '0'
	}));

	const audible = $derived(verdict.metrics.outputAudible ?? null);
	const full = $derived(verdict.metrics.outputFull ?? null);
	const level = $derived(levelDb(curve.bands, curve.preampDb));
	const isLive = $derived(mode === 'live' && frame !== null);
	const value = $derived.by(() => {
		if (isLive && frame) {
			const vu = Math.max(frame.vuL, frame.vuR);
			return Number.isFinite(vu) ? vu : null;
		}
		return audible && Number.isFinite(audible.db) ? audible.db : null;
	});
	const reduced = $derived(reducedMotion ?? prefersReducedMotion.current);
	const angle = $derived(value === null ? -50 : angleOf(value));
	const hotFrom = $derived(isLive ? 0 : OUTPUT_LIMIT_DB);

	// Text and ARIA follow the needle at most 10 times a second (live frames arrive every frame).
	const readout = new ThrottledNumber();
	$effect(() => {
		readout.push(value);
	});
	$effect(() => () => readout.destroy());
	const shown = $derived(readout.value);
	const valueText = $derived(
		shown === null
			? m.meter_no_data()
			: isLive
				? m.curva_vu_value_live({ vu: formatNumber(shown, locale, 1) })
				: m.curva_vu_value_data({ db: formatSignedDb(shown, locale, 2) })
	);
	const reasonContext = $derived({ bands: curve.bands, locale });
</script>

<section class="psec ps-out" aria-labelledby={legendId}>
	<div
		class="meter"
		data-mode={isLive ? 'live' : 'data'}
		data-dark={value === null}
		class:reduced
		role={shown === null ? 'img' : 'meter'}
		aria-label={m.curva_vu_label()}
		aria-valuemin={shown === null ? undefined : MIN}
		aria-valuemax={shown === null ? undefined : MAX}
		aria-valuenow={shown === null ? undefined : Math.round(clamp(shown) * 10) / 10}
		aria-valuetext={valueText}
	>
		<svg viewBox="0 0 160 100" aria-hidden="true" focusable="false">
			<path class="arc" d={arc(MIN, MAX)} />
			<path class="arc-hot" d={arc(hotFrom, MAX)} />
			{#each ticks as t (t.tick)}
				<line class="tick" x1={t.outer.x} y1={t.outer.y} x2={t.inner.x} y2={t.inner.y} />
				<text x={t.text.x} y={t.text.y + 3}>{t.label}</text>
			{/each}
			<text class="unit" x={CX} y="86">{isLive ? 'VU' : 'dB'}</text>
			<g class="needle" style={`transform: rotate(${angle.toFixed(2)}deg)`}>
				<line x1={CX} y1={CY} x2={CX} y2="26" />
			</g>
			<circle cx={CX} cy={CY} r="16" class="pivot" />
		</svg>
		<span class="glass" aria-hidden="true"></span>
	</div>
	<div class="meter-cap">
		<MeterModeLabel mode={isLive ? 'live' : 'data'} />
		<span>{isLive ? m.curva_vu_caption_live({ side }) : m.curva_vu_caption_data()}</span>
	</div>
	{#if reduced}
		<output class="vu-readout" data-testid="vu-readout">{valueText}</output>
	{/if}
	<dl class="ro-list">
		<div class="ro-row">
			<dt>{m.curva_out_preamp()} <Explainer term="preamp" /></dt>
			<dd><span class="ro-win">{formatSignedDb(curve.preampDb, locale)}</span></dd>
		</div>
		<div class="ro-row">
			<dt>{m.curva_out_peak()}</dt>
			<dd>
				<span class="ro-win" class:none={!audible}
					>{audible ? formatSignedDb(audible.db, locale, 2) : m.curva_out_unknown()}</span
				>
				{#if audible?.frequencyHz}<small
						>@ {formatHz(Math.round(audible.frequencyHz), locale)}</small
					>{/if}
			</dd>
		</div>
		<div class="ro-row">
			<dt>{m.curva_out_full()}</dt>
			<dd>
				<span class="ro-win" class:none={!full}
					>{full ? formatSignedDb(full.db, locale, 2) : m.curva_out_unknown()}</span
				>
			</dd>
		</div>
		<div class="ro-row">
			<dt>{m.curva_out_level()}</dt>
			<dd><span class="ro-win">{formatSignedDb(level, locale)}</span></dd>
		</div>
	</dl>
	{#if onmaxclip}
		<Button
			variant="plate"
			size="sm"
			caps
			class="maxclip"
			disabledReason={disabled ? (disabledReason ?? m.curva_v2_loading_reason()) : null}
			onclick={onmaxclip}>{m.curva_maxclip()}</Button
		>
		{#if maxClipMessage}
			<p class="maxclip-msg" role="status">{maxClipMessage}</p>
		{/if}
	{/if}
	<div class="gate-row">
		<p class="gate" class:no={!verdict.ok}>
			<span class="lamp" aria-hidden="true"></span>
			{verdict.ok ? m.curva_gate_ok() : m.curva_gate_no()}
			{#if !verdict.ok}<small>{firstReasonText(verdict.reasons, reasonContext)}</small>{/if}
		</p>
		<Explainer term="gate" />
	</div>
	<p class="caveat">{m.curva_gate_note()}</p>
	<h2 class="legend-bar" id={legendId}>{m.curva_out_heading()}</h2>
</section>

<style>
	.meter {
		position: relative;
		height: 96px;
		margin: 2px 0 6px;
		overflow: hidden;
		border-radius: 5px;
		background: linear-gradient(180deg, #f3ead2, #e4d7b6);
		box-shadow:
			inset 0 2px 6px rgb(0 0 0 / 0.55),
			0 0 0 3px #0a0a0a,
			0 0 0 4px #2b2b29;
		transition: filter 0.3s;
	}
	.meter[data-dark='true'] {
		filter: brightness(0.62) saturate(0.6);
	}
	.meter svg {
		display: block;
		width: 100%;
		height: 100%;
	}
	.arc {
		fill: none;
		stroke: #2a2620;
		stroke-width: 1.2;
	}
	.arc-hot {
		fill: none;
		stroke: var(--accent, #ff7a2f);
		stroke-width: 4;
	}
	.tick {
		stroke: #2a2620;
		stroke-width: 1.2;
	}
	.meter text {
		fill: #2a2620;
		font: 600 9px var(--font-cond, 'Barlow Condensed', 'Arial Narrow', sans-serif);
		text-anchor: middle;
	}
	.meter .unit {
		font-size: 10px;
		letter-spacing: 0.2em;
	}
	.needle {
		transform-origin: 80px 112px;
	}
	.meter[data-mode='data'] .needle {
		transition: transform 0.9s cubic-bezier(0.25, 1.6, 0.45, 1);
	}
	.meter.reduced .needle {
		transition: none;
	}
	.needle line {
		stroke: #1c1a17;
		stroke-width: 1.3;
	}
	.pivot {
		fill: #151514;
	}
	.glass {
		position: absolute;
		inset: 0;
		background: linear-gradient(165deg, rgb(255 255 255 / 0.35), transparent 40%);
		pointer-events: none;
	}
	.meter-cap {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 8px;
		align-items: center;
		margin: 4px 0 8px;
		font: 400 var(--label-min) / var(--lh-small) var(--face-data);
		color: var(--text-2);
	}
	.vu-readout {
		display: block;
		margin: 0 0 8px;
		font: 400 var(--fs-caption) / var(--lh-readout) var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
		color: var(--text);
	}
	.ro-list {
		display: grid;
		gap: 7px;
		margin: 6px 0 0;
	}
	.ro-row {
		display: flex;
		justify-content: space-between;
		gap: 6px;
		align-items: baseline;
	}
	dt {
		display: inline-flex;
		gap: var(--space-1);
		align-items: center;
		font: 500 var(--fs-caption) / var(--lh-ui) var(--face-body);
		color: var(--text-2);
	}
	dd {
		display: grid;
		justify-items: end;
		margin: 0;
	}
	.ro-win {
		padding: 1px 6px;
		border: 1px solid #262624;
		border-radius: 2px;
		background: #050505;
		box-shadow: inset 0 1px 4px #000;
		/* The LCD well is a fixed dark surface: its text keeps a fallback even without the tokens. */
		color: var(--accent-text, #ff7a2f);
		font: 500 var(--fs-readout) / var(--lh-readout) var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
		letter-spacing: var(--tracking-data);
		text-shadow: 0 0 6px color-mix(in srgb, var(--accent) 55%, transparent);
		white-space: nowrap;
	}
	.ro-win.none {
		color: var(--text-2, #cfc9be);
		text-shadow: none;
		font-size: var(--label-min);
	}
	dd small {
		margin-top: 2px;
		color: var(--text-2);
		font: 400 var(--label-min) var(--face-data);
	}
	.ps-out :global(.maxclip) {
		width: 100%;
		margin-top: 10px;
	}
	.maxclip-msg {
		margin: 6px 0 0;
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
		color: var(--text);
	}
	.gate-row {
		display: flex;
		gap: var(--space-2);
		align-items: flex-start;
		margin: 10px 0 0;
	}
	.gate {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		gap: 7px;
		align-items: center;
		margin: 0;
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-data);
		color: var(--text-2);
	}
	.gate small {
		flex: 1 1 100%;
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
		color: #ffd6d7;
	}
	.lamp {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 35%, #e6ffef, #3ddc97);
		box-shadow: 0 0 8px #3ddc97;
	}
	.gate.no .lamp {
		background: radial-gradient(circle at 35% 35%, #ffe3e3, #e5484d);
		box-shadow: 0 0 8px #e5484d;
	}
	.caveat {
		margin: 6px 0 0;
		font: 400 var(--label-min) / var(--lh-small) var(--face-body);
		color: var(--text-2);
	}
	@media (prefers-reduced-motion: reduce) {
		.meter,
		.meter[data-mode='data'] .needle {
			transition: none;
		}
	}
</style>
