<!--
	Inspector (Engenharia) for the selected section: designed (float) coefficients from core
	`designSection`, the five Q27 wire words and pole radius / section peak from the full-grid gate
	analysis, poles and zeros (shared PoleZeroPlot) and the section's place in the 220-byte payload.
	Wide panels keep the plot alone in the right column, with tables, readouts and the plot help
	filling the left; medium panels put the plot beside the help; narrow panels stack.
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
	const peakLimit = THRESHOLDS.sectionPeakDb;
	const poleValue = $derived(analysis ? formatNumber(analysis.poleRadius, locale, 6) : '');
	const peakValue = $derived(analysis ? formatSignedDb(analysis.fullPeak.db, locale, 2) : '');
</script>

<section class="mod-panel" aria-labelledby={headingId}>
	<h3 id={headingId}>{m.curva_v2_insp_title()}</h3>
	{#if band.kind === 'OFF'}
		<p class="note">{m.curva_insp_off()}</p>
	{:else}
		<!-- DOM order is the narrow stack (tables, readouts, plot, help); wider panels place the
		same blocks by grid area, keyed to the panel's own width. -->
		<div class="insp">
			<div class="insp-block insp-coef">
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
			</div>
			<div class="insp-block insp-wire">
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
			{#if analysis}
				<div class="insp-stats">
					<p class="stat">
						<span>{m.curva_insp_pole({ value: poleValue })}</span>
						<small>{m.curva_insp_limit({ value: formatNumber(poleLimit, locale, 6) })}</small>
					</p>
					<p class="stat">
						<span>{m.curva_insp_peak({ value: peakValue })}</span>
						<small>{m.curva_insp_limit({ value: formatSignedDb(peakLimit, locale, 1) })}</small>
					</p>
				</div>
			{/if}
			<div class="insp-plot">
				<PoleZeroPlot
					bands={[band]}
					{locale}
					label={m.curva_pz_label()}
					description={m.curva_pz_desc({ index: String(selected + 1) })}
				/>
			</div>
			<div class="pz-help">
				<p class="pz-help-title"><strong>{m.curva_v2_pz_help_title()}</strong></p>
				<p class="pz-help-body">{m.curva_v2_pz_help()}</p>
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
		/* The panel's width (not the viewport) picks the layout: it sits in a 3fr column on wide
		   screens and spans the page below 1100 px. */
		container: insp / inline-size;
		min-width: 0;
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
		font: 500 var(--fs-eyebrow, 11px) / var(--lh-caps, 1.35)
			var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--curva-silk-2, #c9c1ae);
	}
	/* Narrow: one column, in DOM order (tables, readouts, plot, help). */
	.insp {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas: 'coef' 'wire' 'stats' 'plot' 'help';
		gap: var(--space-4, 16px);
		margin-bottom: var(--space-3, 12px);
	}
	.insp-coef {
		grid-area: coef;
	}
	.insp-wire {
		grid-area: wire;
	}
	.insp-stats {
		grid-area: stats;
	}
	.insp-plot {
		grid-area: plot;
		justify-self: center;
		width: 100%;
		max-width: 340px;
		min-width: 0;
	}
	.pz-help {
		grid-area: help;
	}
	/* A table never widens the panel: it scrolls inside its own box if it ever has to. */
	.insp-block {
		min-width: 0;
		overflow-x: auto;
	}
	.coef,
	.words {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.coef div,
	.words li {
		padding: 3px 0;
		border-bottom: 1px solid var(--rule, rgba(236, 231, 221, 0.12));
		font: 400 var(--fs-caption, 12px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums;
	}
	.coef div {
		display: flex;
		gap: var(--space-2, 8px);
		justify-content: space-between;
	}
	.words li {
		display: grid;
		grid-template-columns: 4ch minmax(0, 1fr) auto;
		gap: var(--space-2, 8px);
	}
	.words code {
		font: inherit;
		text-align: right;
	}
	.coef dt,
	.words span {
		color: var(--curva-silk-2, #c9c1ae);
	}
	dd {
		margin: 0;
	}
	/* Readouts: the real pole radius and section peak, each with its gate limit. */
	.insp-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
		gap: var(--space-3, 12px);
	}
	.stat {
		display: grid;
		align-content: start;
		gap: 2px;
		margin: 0;
		padding: var(--space-2, 8px) var(--space-3, 12px);
		border-radius: var(--rad-md, 4px);
		background: rgba(0, 0, 0, 0.22);
		box-shadow: var(--well, inset 0 2px 6px rgba(0, 0, 0, 0.7), inset 0 0 0 1px rgba(0, 0, 0, 0.6));
		font: 400 var(--fs-readout, 14px) / 1.3 var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: var(--tracking-data, 0.02em);
		overflow-wrap: break-word;
	}
	.stat small {
		font: 400 var(--fs-caption, 12px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		color: var(--curva-silk-2, #c9c1ae);
	}
	.pz-help {
		min-width: 0;
		color: var(--text-2, #cfc9be);
		font: 400 var(--fs-small, 13px) / var(--lh-body, 1.55) var(--face-body, sans-serif);
	}
	.pz-help p {
		margin: 0;
	}
	.pz-help-title {
		margin-bottom: var(--space-1, 4px);
		color: var(--curva-silk, #e9e3d4);
	}
	.pz-help-title strong {
		font-weight: 600;
	}
	.pz-help-body {
		overflow-wrap: break-word;
	}
	.note {
		margin: 6px 0 0;
		font-size: 12px;
	}
	/* Medium: tables side by side, readouts across, then the plot beside the help. */
	@container insp (min-width: 480px) {
		.insp {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			grid-template-areas:
				'coef wire'
				'stats stats'
				'plot help';
		}
		.insp-plot {
			align-self: start;
			max-width: none;
		}
	}
	/* Wide: the plot alone in the right column; tables, readouts and the help fill the left.
	   Each table column is at least as wide as its one-line header (the wire header is the widest,
	   about 270 px in pt-BR and 310 px in en-US at 11 px); the plot gives up the difference, never
	   below 240 px. Only the table blocks set that floor, so the help text cannot widen the tracks. */
	@container insp (min-width: 780px) {
		.insp {
			grid-template-columns: 1fr 1fr minmax(240px, 320px);
			grid-template-rows: auto auto 1fr;
			grid-template-areas:
				'coef wire plot'
				'stats stats plot'
				'help help plot';
		}
		.insp-block {
			min-width: max-content;
		}
		.insp-block h4 {
			white-space: nowrap;
		}
		.insp-stats {
			min-width: 0;
		}
		.pz-help-body {
			columns: 2 24ch;
			column-gap: var(--space-5, 24px);
		}
	}
</style>
