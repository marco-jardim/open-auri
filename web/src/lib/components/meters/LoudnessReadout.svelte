<!--
	Momentary (400 ms) and short-term (3 s) loudness from the core BS.1770 meter in the worklet.
	Numbers update at 10 Hz (readable, and the reduced-motion path at the same time). Data mode shows
	`data` or the "no data" text. Readings below the BS.1770 absolute gate (−70 LUFS) show
	"no signal".
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { MeterMode } from '#lib/audio/meters.ts';
	import { LOUDNESS_GATE_LUFS, formatSigned, pick } from './format.ts';
	import { ThrottledNumber } from './motion.svelte.ts';

	interface Loudness {
		lufsM: number;
		lufsS: number;
	}

	interface Props {
		mode: MeterMode;
		/** Live readings (a meter frame fits). */
		live?: Loudness | null;
		/** Readings from curve data, shown in data mode. */
		data?: Partial<Loudness> | null;
		label?: string;
		class?: string;
	}

	let {
		mode,
		live = null,
		data = null,
		label = m.meter_loudness_label(),
		class: className = ''
	}: Props = $props();

	const momentaryValue = $derived(pick(mode, live?.lufsM, data?.lufsM));
	const shortTermValue = $derived(pick(mode, live?.lufsS, data?.lufsS));
	const momentary = new ThrottledNumber();
	const shortTerm = new ThrottledNumber();
	$effect(() => {
		momentary.push(momentaryValue);
	});
	$effect(() => {
		shortTerm.push(shortTermValue);
	});
	$effect(() => () => {
		momentary.destroy();
		shortTerm.destroy();
	});

	function text(reading: number | null): string {
		if (reading === null) return m.meter_no_data();
		if (reading < LOUDNESS_GATE_LUFS) return m.meter_no_signal();
		return m.meter_value_lufs({ value: formatSigned(reading, 1, getLocale()) });
	}
</script>

<div
	class="oa-loudness {className}"
	data-mode={mode}
	data-dark={momentaryValue === null && shortTermValue === null}
	role="group"
	aria-label={label}
>
	<dl class="oa-loudness-list">
		<div>
			<dt>{m.meter_lufs_m()}</dt>
			<dd><output data-testid="lufs-m">{text(momentary.value)}</output></dd>
		</div>
		<div>
			<dt>{m.meter_lufs_s()}</dt>
			<dd><output data-testid="lufs-s">{text(shortTerm.value)}</output></dd>
		</div>
	</dl>
</div>

<style>
	.oa-loudness-list {
		display: flex;
		gap: 1rem;
		margin: 0;
		font-size: 0.75rem;
	}
	.oa-loudness-list dt {
		font-weight: 600;
	}
	.oa-loudness-list dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}
	.oa-loudness[data-dark='true'] {
		opacity: 0.45;
	}
</style>
