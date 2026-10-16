<!--
	True-peak lamp: lit when the true peak (core BS.1770 true-peak meter in the worklet, or a peak
	from curve data in data mode) exceeds −1 dBTP. It stays lit for 1.5 s after the last over, and
	only goes out when a new value arrives after that, so it never changes without data.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { MeterMode } from '#lib/audio/meters.ts';
	import { PEAK_HOLD_MS, TRUE_PEAK_LIMIT_DB, pick } from './format.ts';

	interface Props {
		mode: MeterMode;
		/** Live true peak in dBTP (frame.truePeakDb). */
		live?: number | null;
		/** Peak from curve data in dBTP, shown in data mode. */
		data?: number | null;
		label?: string;
		threshold?: number;
		holdMs?: number;
		class?: string;
	}

	let {
		mode,
		live = null,
		data = null,
		label = m.meter_true_peak_label(),
		threshold = TRUE_PEAK_LIMIT_DB,
		holdMs = PEAK_HOLD_MS,
		class: className = ''
	}: Props = $props();

	const value = $derived(pick(mode, live, data));
	let lit = $state(false);
	let litAt = Number.NEGATIVE_INFINITY;

	$effect(() => {
		const reading = value;
		untrack(() => {
			if (reading === null) {
				lit = false;
				return;
			}
			const now = performance.now();
			if (reading > threshold) {
				lit = true;
				litAt = now;
			} else if (lit && now - litAt >= holdMs) {
				lit = false;
			}
		});
	});

	const description = $derived(
		value === null ? m.meter_no_data() : lit ? m.meter_true_peak_over() : m.meter_true_peak_ok()
	);
</script>

<span
	class="oa-lamp {className}"
	data-mode={mode}
	data-dark={value === null}
	data-lit={lit}
	role="img"
	aria-label="{label}: {description}"
>
	<span class="oa-lamp-dot" aria-hidden="true"></span>
	<span class="oa-lamp-name" aria-hidden="true">{label}</span>
</span>

<style>
	.oa-lamp {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.75rem;
	}
	.oa-lamp[data-dark='true'] {
		opacity: 0.45;
	}
	.oa-lamp-dot {
		width: 0.625rem;
		height: 0.625rem;
		border-radius: 50%;
		border: 1px solid currentColor;
		background: var(--oa-led-off, #d1d5db);
	}
	.oa-lamp[data-lit='true'] .oa-lamp-dot {
		background: var(--oa-led-over, #b91c1c);
	}
</style>
