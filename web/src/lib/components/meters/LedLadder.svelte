<!--
	LED ladder for PPM readings in dBFS, with a 1.5 s peak hold. The PPM ballistics come from the
	core meter in the worklet; the hold only changes when a new value arrives, so nothing moves
	without data. Data mode shows `data` (for example a stage peak computed from the curve) or stays
	dark.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { MeterMode } from '#lib/audio/meters.ts';
	import { PEAK_HOLD_MS, clamp, formatSigned, pick } from './format.ts';
	import { PeakHold, ThrottledNumber } from './motion.svelte.ts';

	interface Props {
		mode: MeterMode;
		/** Live PPM reading in dBFS. */
		live?: number | null;
		/** Level from curve data in dBFS, shown in data mode. */
		data?: number | null;
		label?: string;
		/** LED thresholds in dBFS, ascending. */
		steps?: readonly number[];
		/** Levels at or above this light amber, in dBFS. */
		warnDb?: number;
		/** Levels at or above this light red, in dBFS. */
		overDb?: number;
		holdMs?: number;
		orientation?: 'vertical' | 'horizontal';
		class?: string;
	}

	let {
		mode,
		live = null,
		data = null,
		label = m.meter_led_label(),
		steps = [-60, -48, -40, -32, -26, -20, -16, -12, -9, -6, -4, -2, -1, 0],
		warnDb = -9,
		overDb = -1,
		holdMs = PEAK_HOLD_MS,
		orientation = 'vertical',
		class: className = ''
	}: Props = $props();

	const value = $derived(pick(mode, live, data));
	const hold = $derived(new PeakHold(holdMs));
	$effect(() => {
		hold.push(value);
	});
	const readout = new ThrottledNumber();
	$effect(() => {
		readout.push(value);
	});
	$effect(() => () => readout.destroy());

	const heldStep = $derived.by(() => {
		const held = hold.value;
		if (held === null) return null;
		let index: number | null = null;
		for (let i = 0; i < steps.length; i++) if (held >= steps[i]) index = i;
		return index;
	});

	function zone(step: number): 'ok' | 'warn' | 'over' {
		return step >= overDb ? 'over' : step >= warnDb ? 'warn' : 'ok';
	}

	function db(reading: number): string {
		return m.meter_value_dbfs({ value: formatSigned(reading, 1, getLocale()) });
	}

	const shown = $derived(readout.value);
	const min = $derived(steps[0] ?? -60);
	const max = $derived(steps[steps.length - 1] ?? 0);
	const valueText = $derived.by(() => {
		if (shown === null) return m.meter_no_data();
		const held = hold.value;
		const holdText =
			held === null ? '' : `, ${m.meter_peak_hold({ value: formatSigned(held, 1, getLocale()) })}`;
		return `${db(shown)}${holdText}`;
	});
</script>

<div
	class="oa-leds {className}"
	data-mode={mode}
	data-orientation={orientation}
	data-dark={value === null}
	role={shown === null ? 'img' : 'meter'}
	aria-label={label}
	aria-valuemin={shown === null ? undefined : min}
	aria-valuemax={shown === null ? undefined : max}
	aria-valuenow={shown === null ? undefined : clamp(Math.round(shown * 10) / 10, min, max)}
	aria-valuetext={shown === null ? undefined : valueText}
>
	<ol class="oa-leds-list" aria-hidden="true">
		{#each steps as step, index (step)}
			<li
				class="oa-led"
				data-zone={zone(step)}
				data-lit={value !== null && value >= step}
				data-hold={heldStep === index && !(value !== null && value >= step)}
			></li>
		{/each}
	</ol>
</div>

<style>
	.oa-leds {
		display: inline-flex;
	}
	.oa-leds-list {
		display: flex;
		flex-direction: column-reverse;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.oa-leds[data-orientation='horizontal'] .oa-leds-list {
		flex-direction: row;
	}
	.oa-led {
		width: 0.75rem;
		height: 0.375rem;
		border-radius: 1px;
		background: var(--oa-led-off, #d1d5db);
	}
	.oa-leds[data-orientation='horizontal'] .oa-led {
		width: 0.375rem;
		height: 0.75rem;
	}
	.oa-led[data-lit='true'][data-zone='ok'],
	.oa-led[data-hold='true'][data-zone='ok'] {
		background: var(--oa-led-ok, #15803d);
	}
	.oa-led[data-lit='true'][data-zone='warn'],
	.oa-led[data-hold='true'][data-zone='warn'] {
		background: var(--oa-led-warn, #b45309);
	}
	.oa-led[data-lit='true'][data-zone='over'],
	.oa-led[data-hold='true'][data-zone='over'] {
		background: var(--oa-led-over, #b91c1c);
	}
</style>
