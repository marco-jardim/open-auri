<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { prefersReducedMotion } from 'svelte/motion';
	import { tap, type MeterUpdate } from '#lib/audio/meters.ts';
	import type { PreviewChain } from '#lib/audio/engine.ts';
	// Direct imports (FUX.B): the meters barrel would bring every meter component into the page.
	import MeterModeLabel from '#lib/components/meters/MeterModeLabel.svelte';
	import { ThrottledNumber } from '#lib/components/meters/motion.svelte.ts';
	import { formatSigned } from '#lib/components/meters/format.ts';
	let {
		chain = null,
		enabled = false,
		label
	}: {
		chain?: PreviewChain | null;
		enabled?: boolean;
		label: string;
	} = $props();
	let update = $state<MeterUpdate>({ mode: 'data', frame: null });
	let failed = $state(false);
	const readout = new ThrottledNumber();
	const shown = $derived(readout.value);
	const mode = $derived(enabled ? update.mode : 'data');
	const reading = $derived(mode === 'live' ? shown : null);
	const valueText = $derived(
		reading === null
			? m.meter_no_data()
			: m.meter_value_dbfs({ value: formatSigned(reading, 1, getLocale()) })
	);
	$effect(() => {
		readout.push(
			mode === 'live' && update.frame ? Math.max(update.frame.ppmL, update.frame.ppmR) : null
		);
	});
	$effect(() => () => readout.destroy());
	$effect(() => {
		const source = chain;
		update = { mode: 'data', frame: null };
		if (!source || !enabled) return;
		let disposed = false;
		let disconnect = () => {};
		failed = false;
		void tap(source.output, { kinds: ['ppm'] })
			.then((meter) => {
				if (disposed) {
					meter.disconnect();
					return;
				}
				const unsubscribe = meter.subscribe((value) => {
					update = value;
				});
				disconnect = () => {
					unsubscribe();
					meter.disconnect();
				};
			})
			.catch((error: unknown) => {
				if (!disposed) {
					failed = true;
					update = { mode: 'data', frame: null };
				}
				console.warn('blind test meter unavailable', error);
			});
		return () => {
			disposed = true;
			disconnect();
		};
	});
</script>

<div class="candidate-meter">
	<div class="level" data-mode={mode} data-dark={reading === null}>
		<span class="level-name">{label}</span>
		{#if reading === null}
			<div class="idle-level" role="img" aria-label="{label}: {valueText}"></div>
		{:else}
			<meter
				class:numeric-only={prefersReducedMotion.current}
				min="-50"
				max="0"
				value={Math.min(0, Math.max(-50, reading))}
				aria-label={label}
				aria-valuetext={valueText}
			></meter>
		{/if}
		<output>{valueText}</output>
	</div>
	<MeterModeLabel {mode} />
	{#if failed}<p>{m.cego_meter_error()}</p>{/if}
</div>

<style>
	.candidate-meter {
		display: grid;
		gap: 6px;
		margin: 10px 0;
		max-width: 100%;
		--oa-led-off: #28231a;
		--oa-led-ok: #ffd27a;
		--oa-meter-data: #b5ad9f;
		--oa-meter-live: #ffd27a;
	}
	.level {
		display: flex;
		flex-wrap: wrap;
		min-width: 0;
		width: 100%;
		gap: 4px;
	}
	.level-name {
		width: 100%;
		font-size: 10px;
	}
	meter,
	.idle-level {
		width: 100%;
		height: 8px;
		border: 0;
		border-radius: 2px;
		background: #28231a;
		accent-color: #ffd27a;
	}
	meter::-webkit-meter-bar {
		border: 0;
		background: #28231a;
	}
	meter::-webkit-meter-optimum-value {
		background: #ffd27a;
	}
	meter::-moz-meter-bar {
		background: #ffd27a;
	}
	.numeric-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
	output {
		min-width: 0;
		font-size: 10px;
	}
	.candidate-meter :global(.oa-meter-mode) {
		font-size: 9px;
		justify-self: start;
		padding: 2px 4px;
	}
	p {
		color: #d6bf95;
		font-size: 12px;
		margin: 0;
	}
</style>
