<!--
	Stereo correlation, −1…+1 (core correlation meter in the worklet). The marker sits at the reading
	with no transition. Data mode shows `data` or stays dark. Readout at 10 Hz; with reduced motion
	the marker is hidden and only the number is shown.
-->
<script lang="ts">
	import { prefersReducedMotion } from 'svelte/motion';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { MeterMode } from '#lib/audio/meters.ts';
	import { clamp, formatSigned, linearPosition, pick } from './format.ts';
	import { ThrottledNumber } from './motion.svelte.ts';

	interface Props {
		mode: MeterMode;
		live?: number | null;
		data?: number | null;
		label?: string;
		reducedMotion?: boolean;
		class?: string;
	}

	let {
		mode,
		live = null,
		data = null,
		label = m.meter_correlation_label(),
		reducedMotion,
		class: className = ''
	}: Props = $props();

	const value = $derived.by(() => {
		const picked = pick(mode, live, data);
		return picked === null ? null : clamp(picked, -1, 1);
	});
	const reduced = $derived(reducedMotion ?? prefersReducedMotion.current);
	const readout = new ThrottledNumber();
	$effect(() => {
		readout.push(value);
	});
	$effect(() => () => readout.destroy());
	const shown = $derived(readout.value);

	function text(reading: number | null): string {
		return reading === null ? m.meter_no_data() : formatSigned(reading, 2, getLocale());
	}
</script>

<div
	class="oa-corr {className}"
	data-mode={mode}
	data-dark={value === null}
	role={shown === null ? 'img' : 'meter'}
	aria-label={label}
	aria-valuemin={shown === null ? undefined : -1}
	aria-valuemax={shown === null ? undefined : 1}
	aria-valuenow={shown === null ? undefined : Math.round(shown * 100) / 100}
	aria-valuetext={text(shown)}
>
	{#if !reduced}
		<span class="oa-corr-track" aria-hidden="true">
			<span class="oa-corr-scale">
				<span>−1</span><span>0</span><span>+1</span>
			</span>
			{#if value !== null}
				<span class="oa-corr-marker" style:left="{linearPosition(value, -1, 1) * 100}%"></span>
			{/if}
		</span>
	{/if}
	<output class="oa-corr-readout">{text(shown)}</output>
</div>

<style>
	.oa-corr {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.75rem;
	}
	.oa-corr[data-dark='true'] {
		opacity: 0.45;
	}
	.oa-corr-track {
		position: relative;
		display: block;
		width: 8rem;
		height: 1rem;
		border-bottom: 1px solid currentColor;
	}
	.oa-corr-scale {
		display: flex;
		justify-content: space-between;
		font-size: 0.625rem;
	}
	.oa-corr-marker {
		position: absolute;
		bottom: 0;
		width: 2px;
		height: 0.625rem;
		margin-left: -1px;
		background: var(--oa-meter-needle, currentColor);
	}
	.oa-corr-readout {
		min-width: 3rem;
		font-variant-numeric: tabular-nums;
	}
</style>
