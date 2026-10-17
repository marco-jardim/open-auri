<!--
	Channel LEDs (plan §3.6 "Comunidade: LEDs por canal com a cadeia do canal"). They exist only
	while this channel is the audible side of the page's preview: the ladder is fed by the real
	meter tap (AudioWorklet PPM) on the channel chain's output. Without a chain nothing is drawn;
	there is no decorative or idle animation (plan §0.12 item 7).
-->
<script lang="ts">
	import {
		tap as realTap,
		type MeterTap,
		type MeterUpdate,
		type TapOptions
	} from '#lib/audio/meters.ts';
	import type { PreviewChain } from '#lib/audio/engine.ts';
	import { LedLadder, MeterModeLabel } from '#lib/components/meters/index.ts';
	import { m } from '#lib/paraglide/messages.js';

	let {
		chain = null,
		label,
		tap = realTap
	}: {
		chain?: PreviewChain | null;
		label: string;
		tap?: (node: AudioNode, options?: TapOptions) => Promise<MeterTap>;
	} = $props();

	let update = $state<MeterUpdate>({ mode: 'data', frame: null });
	let failed = $state(false);
	const live = $derived(
		update.mode === 'live' && update.frame ? Math.max(update.frame.ppmL, update.frame.ppmR) : null
	);

	$effect(() => {
		const source = chain;
		update = { mode: 'data', frame: null };
		failed = false;
		if (!source) return;
		let disposed = false;
		let disconnect = () => {};
		tap(source.output, { kinds: ['ppm'] })
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
				if (!disposed) failed = true;
				console.warn(
					JSON.stringify({
						event: 'comunidade.meter_unavailable',
						error: error instanceof Error ? error.name : 'unknown'
					})
				);
			});
		return () => {
			disposed = true;
			disconnect();
		};
	});
</script>

{#if chain && !failed}
	<div class="channel-meter" data-testid="channel-leds">
		<LedLadder
			mode={update.mode}
			{live}
			{label}
			steps={[-48, -40, -32, -26, -20, -16, -12, -9, -6, -3, -1, 0]}
		/>
		<MeterModeLabel mode={update.mode} />
	</div>
{:else if chain && failed}
	<p class="meter-error">{m.comunidade_meter_error()}</p>
{/if}

<style>
	.channel-meter {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		--oa-led-off: #0f2619;
		--oa-led-ok: #2ed47e;
		--oa-led-warn: #e8d34b;
		--oa-led-over: #ff6b3d;
	}
	.channel-meter :global(.oa-led) {
		width: 14px;
		height: 5px;
	}
	.channel-meter :global(.oa-meter-mode) {
		font-size: var(--label-min);
		padding: 1px 4px;
	}
	.meter-error {
		margin: 0;
		font: 400 var(--label-min) / 1.3 var(--face-data);
		color: #d6bf95;
		text-align: center;
	}
</style>
