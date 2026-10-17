<!--
	Inspector (Engenharia) for the selected section: designed (float) coefficients from core
	`designSection`, the five Q27 wire words and pole radius / section peak from the full-grid gate
	analysis, poles and zeros (shared PoleZeroPlot) and the section's place in the 220-byte payload.
-->
<script lang="ts">
	import { designSection } from 'open-auri/dsp';
	import { THRESHOLDS } from 'open-auri/safety';
	import ByteMap from '#lib/charts/ByteMap.svelte';
	import PoleZeroPlot from '#lib/charts/PoleZeroPlot.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { formatNumber, formatSignedDb, hex } from './format.ts';
	import type { Curve } from './model.ts';
	import type { GateVerdict } from './reasons.ts';

	interface Props {
		curve: Curve;
		verdict: GateVerdict;
		selected: number;
		locale: string;
	}
	let { curve, verdict, selected, locale }: Props = $props();

	const headingId = $props.id();
	const band = $derived(curve.bands[selected] ?? { kind: 'OFF' as const });
	const analysis = $derived(verdict.metrics.sections?.[selected] ?? null);
	const design = $derived(band.kind === 'OFF' ? null : designSection(band));
	const WIRE = ['b0', 'b2', '−a1', 'b1', '−a2'] as const;
	const COEFS = ['b0', 'b1', 'b2', 'a1', 'a2'] as const;
	const poleLimit = THRESHOLDS.poleRadius;
</script>

<section class="mod-panel" aria-labelledby={headingId}>
	<h3 id={headingId}>{m.curva_v2_insp_heading({ index: String(selected + 1) })}</h3>
	{#if band.kind === 'OFF'}
		<p class="note">{m.curva_insp_off()}</p>
	{:else}
		<div class="insp">
			<div class="insp-col">
				<h4>{m.curva_insp_coef()}</h4>
				{#if design}
					<dl class="coef">
						{#each COEFS as key (key)}
							<div>
								<dt>{key}</dt>
								<dd>{formatNumber(design[key], locale, 9)}</dd>
							</div>
						{/each}
					</dl>
				{/if}
				{#if analysis}
					<p class="read">
						{m.curva_insp_pole({ value: formatNumber(analysis.poleRadius, locale, 6) })}
						<small>{m.curva_insp_limit({ value: formatNumber(poleLimit, locale, 6) })}</small>
					</p>
					<p class="read">
						{m.curva_insp_peak({ value: formatSignedDb(analysis.fullPeak.db, locale, 2) })}
					</p>
				{/if}
			</div>
			<div class="insp-col">
				<h4>{m.curva_insp_wire()}</h4>
				{#if analysis}
					<ol class="words">
						{#each analysis.words as word, i (i)}
							<li>
								<span>{WIRE[i]}</span>
								<code>{word}</code>
								<code>0x{hex(word, 8)}</code>
							</li>
						{/each}
					</ol>
				{/if}
			</div>
			<div class="insp-col">
				<PoleZeroPlot
					bands={[band]}
					{locale}
					label={m.curva_pz_label()}
					description={m.curva_pz_desc({ index: String(selected + 1) })}
				/>
			</div>
		</div>
	{/if}
	<ByteMap
		{curve}
		selectedSection={selected}
		label={m.curva_bytes_label()}
		description={m.curva_bytes_desc()}
	/>
</section>

<style>
	.mod-panel {
		padding: 14px;
		border-radius: 6px;
		background: linear-gradient(#2e2d2b, #1f1e1c);
		color: var(--curva-silk, #e9e3d4);
	}
	h3 {
		margin: 0 0 8px;
		font: 400 22px/1.1 var(--font-display, 'Instrument Serif', serif);
	}
	h4 {
		margin: 0 0 6px;
		font: 600 10px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--curva-silk-2, #c9c1ae);
	}
	.insp {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 14px;
		margin-bottom: 12px;
	}
	.coef {
		display: grid;
		gap: 2px;
		margin: 0;
	}
	.coef div,
	.words li {
		display: flex;
		gap: 8px;
		justify-content: space-between;
		font: 11px/1.4 var(--font-mono, 'JetBrains Mono', monospace);
	}
	dd {
		margin: 0;
	}
	.words {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.read,
	.note {
		margin: 6px 0 0;
		font-size: 12px;
	}
	.read small {
		color: var(--curva-silk-2, #c9c1ae);
	}
	@media (max-width: 900px) {
		.insp {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
