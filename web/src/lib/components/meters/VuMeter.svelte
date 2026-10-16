<!--
	VU meter, scale −20…+3 VU. The needle is placed directly at the reading of the core VU meter
	(its ballistics already run in the worklet): no transition or easing is added here.
	- live mode: `live` (frame.vuL / frame.vuR); data mode: `data` (curve value) or dark when null.
	- reduced motion: no needle motion; a numeric readout updated at 10 Hz.
-->
<script lang="ts">
	import { prefersReducedMotion } from 'svelte/motion';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { MeterMode } from '#lib/audio/meters.ts';
	import { VU_MAX, VU_MIN, clamp, formatSigned, pick, vuPosition } from './format.ts';
	import { ThrottledNumber } from './motion.svelte.ts';

	interface Props {
		mode: MeterMode;
		/** Live VU reading (VU, from the worklet frame). */
		live?: number | null;
		/** VU value derived from curve data, shown in data mode. */
		data?: number | null;
		label?: string;
		/** Overrides the `prefers-reduced-motion` media query. */
		reducedMotion?: boolean;
		class?: string;
	}

	let {
		mode,
		live = null,
		data = null,
		label = m.meter_vu_label(),
		reducedMotion,
		class: className = ''
	}: Props = $props();

	const TICKS = [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3];
	const LABELED = new Set([-20, -10, -5, -3, 0, 3]);
	const CX = 100;
	const CY = 112;
	const RADIUS = 88;
	const SWEEP = 100;

	const value = $derived(pick(mode, live, data));
	const reduced = $derived(reducedMotion ?? prefersReducedMotion.current);
	const angle = $derived(value === null ? -SWEEP / 2 : -SWEEP / 2 + SWEEP * vuPosition(value));

	const readout = new ThrottledNumber();
	$effect(() => {
		readout.push(value);
	});
	$effect(() => () => readout.destroy());

	function point(position: number, radius: number): { x: number; y: number } {
		const radians = ((-SWEEP / 2 + SWEEP * position - 90) * Math.PI) / 180;
		return { x: CX + radius * Math.cos(radians), y: CY + radius * Math.sin(radians) };
	}

	const ticks = TICKS.map((tick) => {
		const position = vuPosition(tick);
		return {
			tick,
			inner: point(position, RADIUS - (LABELED.has(tick) ? 10 : 6)),
			outer: point(position, RADIUS),
			text: point(position, RADIUS - 20),
			red: tick > 0
		};
	});
	const zeroStart = point(vuPosition(0), RADIUS);
	const arcStart = point(0, RADIUS);
	const arcEnd = point(1, RADIUS);

	function text(reading: number | null): string {
		if (reading === null) return m.meter_no_data();
		return m.meter_value_vu({ value: formatSigned(reading, 1, getLocale()) });
	}

	const shown = $derived(readout.value);
	const ariaNow = $derived(shown === null ? undefined : clamp(Math.round(shown * 10) / 10, -20, 3));
</script>

<div
	class="oa-vu {className}"
	data-mode={mode}
	data-dark={value === null}
	role={shown === null ? 'img' : 'meter'}
	aria-label={label}
	aria-valuemin={shown === null ? undefined : VU_MIN}
	aria-valuemax={shown === null ? undefined : VU_MAX}
	aria-valuenow={ariaNow}
	aria-valuetext={shown === null ? undefined : text(shown)}
>
	<svg viewBox="0 0 200 124" aria-hidden="true" focusable="false">
		<path
			class="oa-vu-arc"
			d="M {arcStart.x} {arcStart.y} A {RADIUS} {RADIUS} 0 0 1 {zeroStart.x} {zeroStart.y}"
		/>
		<path
			class="oa-vu-arc oa-vu-arc-red"
			d="M {zeroStart.x} {zeroStart.y} A {RADIUS} {RADIUS} 0 0 1 {arcEnd.x} {arcEnd.y}"
		/>
		{#each ticks as t (t.tick)}
			<line
				class="oa-vu-tick"
				class:oa-vu-red={t.red}
				x1={t.inner.x}
				y1={t.inner.y}
				x2={t.outer.x}
				y2={t.outer.y}
			/>
			{#if LABELED.has(t.tick)}
				<text class="oa-vu-label" class:oa-vu-red={t.red} x={t.text.x} y={t.text.y}>
					{t.tick > 0 ? `+${t.tick}` : t.tick === 0 ? '0' : `\u2212${-t.tick}`}
				</text>
			{/if}
		{/each}
		<text class="oa-vu-name" x={CX} y={CY - 32}>{label}</text>
		{#if value !== null && !reduced}
			<line
				class="oa-vu-needle"
				x1={CX}
				y1={CY}
				x2={CX}
				y2={CY - RADIUS - 2}
				transform="rotate({angle} {CX} {CY})"
			/>
		{/if}
		<circle class="oa-vu-pivot" cx={CX} cy={CY} r="4" />
	</svg>
	{#if reduced}
		<output class="oa-vu-readout" data-testid="vu-readout">{text(shown)}</output>
	{/if}
</div>

<style>
	.oa-vu {
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		color: var(--oa-meter-ink, currentColor);
	}
	.oa-vu svg {
		width: 100%;
		max-width: 16rem;
		height: auto;
	}
	.oa-vu[data-dark='true'] {
		opacity: 0.45;
	}
	.oa-vu-arc {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
	}
	.oa-vu-tick {
		stroke: currentColor;
		stroke-width: 1.5;
	}
	.oa-vu-red,
	.oa-vu-arc-red {
		stroke: var(--oa-meter-over, #b91c1c);
		fill: var(--oa-meter-over, #b91c1c);
	}
	.oa-vu-arc-red {
		fill: none;
		stroke-width: 3;
	}
	.oa-vu-label {
		font-size: 9px;
		text-anchor: middle;
		dominant-baseline: middle;
		fill: currentColor;
		stroke: none;
	}
	.oa-vu-label.oa-vu-red {
		fill: var(--oa-meter-over, #b91c1c);
	}
	.oa-vu-name {
		font-size: 12px;
		font-weight: 600;
		text-anchor: middle;
		fill: currentColor;
	}
	.oa-vu-needle {
		stroke: var(--oa-meter-needle, currentColor);
		stroke-width: 1.5;
		stroke-linecap: round;
	}
	.oa-vu-pivot {
		fill: currentColor;
	}
	.oa-vu-readout {
		font-variant-numeric: tabular-nums;
		font-size: 0.875rem;
	}
</style>
