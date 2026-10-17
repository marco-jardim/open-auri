<!--
	Biblioteca console (spec §1.4b, §3.6). Two honest modes, labelled by the Chip primitive.
	The same five dials (same faces) stay mounted in both modes. Each dial is AO VIVO only while
	its own tap delivers real worklet readings; otherwise it keeps its calculated DADOS value.
	No dial ever mirrors another one's tap.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { Chip } from '#lib/components/primitives/index.ts';
	import type { MeterUpdate } from '#lib/audio/meters.ts';
	import type { CurveData } from '#lib/state/model.ts';
	import DataDial from './DataDial.svelte';
	import {
		correlationIndex,
		dataReadings,
		number,
		type Locale,
		type GateResult
	} from './archive.ts';

	const IDLE: MeterUpdate = { mode: 'data', frame: null };
	let {
		curve,
		current,
		reference,
		verdict,
		update,
		source = IDLE,
		output = IDLE,
		locale
	}: {
		curve: CurveData;
		/** The editor curve: level jump is always measured against what you have now. */
		current: CurveData;
		/** Comparison reference chosen in the page (defaults to the editor curve). */
		reference?: CurveData;
		verdict: GateResult | null;
		/** Pre-volume meter bus (what is playing, post-curve): correlation and peak. */
		update: MeterUpdate;
		/** Pre-volume source bus, before any curve: level. */
		source?: MeterUpdate;
		/** Selected A/B chain output of the track sheet (post-curve, post-trim): preamp. */
		output?: MeterUpdate;
		locale: Locale;
	} = $props();
	const data = $derived(dataReadings(curve, current, verdict));
	const diff = $derived(
		reference && reference !== current ? dataReadings(curve, reference, verdict) : data
	);
	const correlation = $derived(correlationIndex(diff.rmsDb));
	const frame = $derived(update.mode === 'live' ? update.frame : null);
	const sourceFrame = $derived(source.mode === 'live' ? source.frame : null);
	const outputFrame = $derived(output.mode === 'live' ? output.frame : null);
	function finite(value: number | undefined): number | null {
		return typeof value === 'number' && Number.isFinite(value) ? value : null;
	}
	function stereoMax(left: number | undefined, right: number | undefined): number | null {
		const l = finite(left);
		const r = finite(right);
		return l === null ? r : r === null ? l : Math.max(l, r);
	}
	// Each dial reads its own tap. Salto would need both A and B measured at once; only the
	// selected side is tapped, so it stays calculated DADOS.
	const level = $derived(stereoMax(sourceFrame?.vuL, sourceFrame?.vuR));
	const preamp = $derived(stereoMax(outputFrame?.vuL, outputFrame?.vuR));
	const liveCorrelation = $derived(finite(frame?.correlation));
	// The page requests PPM I, not truePeak: never use the unrequested truePeakDb field.
	const peak = $derived(stereoMax(frame?.ppmL, frame?.ppmR));
	const live = $derived(
		level !== null || preamp !== null || liveCorrelation !== null || peak !== null
	);
</script>

<section class="console" aria-label={m.biblioteca_console()} data-mode={live ? 'live' : 'data'}>
	<div class="console-top">
		<span class="plate">ARCHIVE MONITOR / 01</span>
		<Chip mode={live ? 'live' : 'data'} aria-live="polite" />
		<span class="enamel">{m.biblioteca_enamel()}</span>
	</div>
	<div class="data-meters">
		<DataDial
			label={m.biblioteca_level()}
			value={data.levelDb}
			live={level}
			liveUnit="VU"
			min={-30}
			max={3}
			{locale}
		/>
		<DataDial
			label={m.biblioteca_preamp()}
			value={data.preampDb}
			live={preamp}
			liveUnit="VU"
			min={-30}
			max={3}
			{locale}
		/>
		<DataDial
			label={m.biblioteca_correlator()}
			value={correlation}
			live={liveCorrelation}
			min={-1}
			max={1}
			unit=""
			digits={2}
			signed
			detail={m.biblioteca_correlator_detail({
				rms: number(diff.rmsDb, locale, 2),
				max: number(diff.maxDb, locale, 2)
			})}
			{locale}
		/>
		<DataDial
			label={m.biblioteca_peak()}
			value={data.peakDb}
			live={peak}
			liveUnit="dBFS"
			min={-30}
			max={3}
			{locale}
		/>
		<DataDial label={m.biblioteca_jump()} value={data.jumpDb} min={-12} max={12} {locale} />
	</div>
	<div class="meter-note">
		<span>{curve.name}</span>
		<span>{live ? m.biblioteca_live_note() : m.biblioteca_data_note()}</span>
		{#if !live}<span
				>{m.biblioteca_rms_note({
					rms: number(diff.rmsDb, locale),
					max: number(diff.maxDb, locale),
					freq: number(diff.maxFreqHz, locale, 0)
				})}</span
			>{/if}
	</div>
	{#if data.jumpDb >= 3}<p class="warning">{m.biblioteca_jump_warning()}</p>{/if}
	<div class="quadrants" aria-hidden="true">
		{#each Array.from({ length: 14 }).keys() as i (i)}<span class:central={i >= 5 && i <= 8}
			></span>{/each}
	</div>
	<div class="calibration">20 Hz–20 kHz / Q27 + Q23 / 96 kHz</div>
</section>

<style>
	.console {
		max-width: 1500px;
		margin: auto;
		padding: 23px 24px 15px;
		border: 1px solid #252a21;
		border-inline: 19px solid #492d1d;
		border-radius: 10px 10px 3px 3px;
		background:
			radial-gradient(ellipse at 15% 0, #b4b6a038, transparent 65%),
			repeating-linear-gradient(0deg, #ffffff03 0 1px, #00000003 1px 3px),
			linear-gradient(135deg, #6d7665, #505a4b);
		box-shadow:
			inset 2px 2px 3px #bec4a333,
			inset -2px -3px 3px #0008,
			0 15px 25px #0008;
	}
	.console-top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 12px;
		margin-bottom: 17px;
		color: #f1eedc;
		font: 400 var(--fs-eyebrow, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
	}
	.plate {
		padding: 5px 10px;
		background: #343e31;
		border: 1px solid #272e24;
		letter-spacing: 0.1em;
	}
	.enamel {
		font-family: var(--type, 'Courier Prime', monospace);
		font-size: var(--fs-caption, 12px);
	}
	.data-meters {
		display: grid;
		grid-template-columns: 1fr 1fr 0.88fr 1fr 1fr;
		gap: 15px;
		align-items: start;
	}
	.meter-note {
		display: flex;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px 20px;
		margin-top: 18px;
		font: 400 var(--label-min, 11px) / 1.7 var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums slashed-zero;
		color: #f0eedc;
	}
	.warning {
		color: #ffe0a0;
		font-size: var(--fs-caption, 12px);
	}
	.quadrants {
		display: flex;
		height: 43px;
		justify-content: space-evenly;
		align-items: center;
		border-top: 1px solid #c8d5a633;
		margin-top: 12px;
	}
	.quadrants span {
		width: 12px;
		height: 18px;
		background: linear-gradient(#4a5142, #292f23);
		border: 2px solid #262d20;
		box-shadow: 0 2px 2px #0006;
	}
	.quadrants .central {
		background: #9a8a5a;
	}
	.calibration {
		text-align: center;
		color: #e5e4cb;
		font: 400 var(--label-min, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.12em;
	}
	@media (max-width: 780px) {
		.console {
			padding: 14px 10px;
			border-inline-width: 11px;
		}
		.data-meters {
			grid-template-columns: 1fr 1fr;
		}
		.data-meters :global(.dial:nth-child(3)) {
			grid-column: 1 / -1;
			grid-row: 2;
			max-width: 220px;
			width: 100%;
			justify-self: center;
		}
	}
</style>
