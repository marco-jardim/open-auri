<!--
	Horizontal PPM bar in dBFS (reading of the core PPM, type I or II, from the worklet). The bar
	length follows the reading directly, with no transition. Data mode shows `data` or stays dark.
	The numeric readout updates at 10 Hz; with reduced motion the bar is hidden and only the number
	is shown.
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
		min?: number;
		max?: number;
		reducedMotion?: boolean;
		class?: string;
	}

	let {
		mode,
		live = null,
		data = null,
		label = m.meter_ppm_label(),
		min = -50,
		max = 0,
		reducedMotion,
		class: className = ''
	}: Props = $props();

	const value = $derived(pick(mode, live, data));
	const reduced = $derived(reducedMotion ?? prefersReducedMotion.current);
	const readout = new ThrottledNumber();
	$effect(() => {
		readout.push(value);
	});
	$effect(() => () => readout.destroy());
	const shown = $derived(readout.value);

	function text(reading: number | null): string {
		if (reading === null) return m.meter_no_data();
		return m.meter_value_dbfs({ value: formatSigned(reading, 1, getLocale()) });
	}
</script>

<div
	class="oa-ppm {className}"
	data-mode={mode}
	data-dark={value === null}
	role={shown === null ? 'img' : 'meter'}
	aria-label={label}
	aria-valuemin={shown === null ? undefined : min}
	aria-valuemax={shown === null ? undefined : max}
	aria-valuenow={shown === null ? undefined : clamp(Math.round(shown * 10) / 10, min, max)}
	aria-valuetext={shown === null ? undefined : text(shown)}
>
	<span class="oa-ppm-name">{label}</span>
	{#if !reduced}
		<span class="oa-ppm-track" aria-hidden="true">
			{#if value !== null}
				<span class="oa-ppm-fill" style:width="{linearPosition(value, min, max) * 100}%"></span>
			{/if}
		</span>
	{/if}
	<output class="oa-ppm-readout">{text(shown)}</output>
</div>

<style>
	.oa-ppm {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.75rem;
	}
	.oa-ppm[data-dark='true'] {
		opacity: 0.45;
	}
	.oa-ppm-track {
		position: relative;
		display: block;
		width: 8rem;
		height: 0.5rem;
		background: var(--oa-led-off, #d1d5db);
	}
	.oa-ppm-fill {
		position: absolute;
		inset: 0 auto 0 0;
		background: var(--oa-led-ok, #15803d);
	}
	.oa-ppm-readout {
		min-width: 6rem;
		font-variant-numeric: tabular-nums;
	}
</style>
