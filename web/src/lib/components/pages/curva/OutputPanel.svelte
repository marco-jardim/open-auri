<!--
	Output section: live VU of the selected preview chain (DATA mode, dark, when idle), readouts from
	the full-grid gate metrics of the editor curve, the predicted level and the gate verdict with its
	mandatory caveat (a similarity policy, not a hardware safety proof).
-->
<script lang="ts">
	import { levelDb } from 'open-auri/safety';
	import { MeterModeLabel, VuMeter } from '#lib/components/meters/index.ts';
	import type { MeterFrame, MeterMode } from '#lib/audio/meters.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { formatHz, formatSignedDb } from './format.ts';
	import type { Curve } from './model.ts';
	import { firstReasonText, type GateVerdict } from './reasons.ts';

	interface Props {
		curve: Curve;
		verdict: GateVerdict;
		locale: string;
		mode: MeterMode;
		frame: MeterFrame | null;
	}
	let { curve, verdict, locale, mode, frame }: Props = $props();

	const legendId = $props.id();
	const live = $derived(frame ? Math.max(frame.vuL, frame.vuR) : null);
	const audible = $derived(verdict.metrics.outputAudible ?? null);
	const full = $derived(verdict.metrics.outputFull ?? null);
	const level = $derived(levelDb(curve.bands, curve.preampDb));
</script>

<section class="psec ps-out" aria-labelledby={legendId}>
	<div class="meter">
		<!-- DATA mode shows real curve data: the predicted level change (core levelDb, 300 Hz to
			3 kHz, with preamp) in dB on the VU scale, 0 VU = flat. Live mode shows the chain output. -->
		<VuMeter {mode} {live} data={level} label={m.curva_vu_label()} />
		<MeterModeLabel {mode} />
	</div>
	<dl class="ro-list">
		<div class="ro-row">
			<dt>{m.curva_out_preamp()}</dt>
			<dd>{formatSignedDb(curve.preampDb, locale)}</dd>
		</div>
		<div class="ro-row">
			<dt>{m.curva_out_peak()}</dt>
			<dd>
				{audible ? formatSignedDb(audible.db, locale, 2) : '?'}
				{#if audible?.frequencyHz}<small>{formatHz(audible.frequencyHz, locale)}</small>{/if}
			</dd>
		</div>
		<div class="ro-row">
			<dt>{m.curva_out_full()}</dt>
			<dd>{full ? formatSignedDb(full.db, locale, 2) : '?'}</dd>
		</div>
		<div class="ro-row">
			<dt>{m.curva_out_level()}</dt>
			<dd>{formatSignedDb(level, locale)}</dd>
		</div>
	</dl>
	<p class="gate" class:no={!verdict.ok}>
		<span class="lamp" aria-hidden="true"></span>
		{verdict.ok ? m.curva_gate_ok() : m.curva_gate_no()}
		{#if !verdict.ok}<small>{firstReasonText(verdict.reasons)}</small>{/if}
	</p>
	<p class="caveat">{m.curva_gate_note()}</p>
	<h2 class="legend-bar" id={legendId}>{m.curva_out_heading()}</h2>
</section>

<style>
	.meter {
		display: grid;
		gap: 4px;
		justify-items: center;
		padding: 8px;
		border-radius: 6px;
		background: linear-gradient(#f2e7cf, #dccfae);
		color: #1d1a14;
	}
	.ro-list {
		display: grid;
		gap: 4px;
		margin: 10px 0 0;
	}
	.ro-row {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		align-items: baseline;
	}
	dt {
		font: 600 10px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--curva-silk-2, #c9c1ae);
	}
	dd {
		display: grid;
		justify-items: end;
		margin: 0;
		padding: 2px 6px;
		border-radius: 2px;
		background: #0d1310;
		color: #b6edb0;
		font: 12px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
	}
	dd small {
		color: #acb8ae;
		font-size: 10px;
	}
	.gate {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
		margin: 10px 0 0;
		font-size: 12px;
		color: var(--curva-silk, #e9e3d4);
	}
	.gate small {
		flex: 1 1 100%;
	}
	.lamp {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: #3ddc97;
		box-shadow: 0 0 6px #3ddc97;
	}
	.gate.no .lamp {
		background: #ff5a4a;
		box-shadow: 0 0 6px #ff5a4a;
	}
	.caveat {
		margin: 6px 0 0;
		font-size: 11px;
		color: var(--curva-silk-2, #c9c1ae);
	}
</style>
