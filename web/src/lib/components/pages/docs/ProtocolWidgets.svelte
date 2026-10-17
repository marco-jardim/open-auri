<script lang="ts">
	import { ByteMap, ReportTimeline } from '#lib/charts/index.ts';
	import { THRESHOLDS } from 'open-auri/safety';
	import type { DocsContent } from '#lib/content/docs/types.ts';
	import type { DocsUi } from './ui.ts';
	import { auriPreset, crcExample, exactNumber, q23Example, reportHex } from './model.ts';
	import { keyboardScroll } from './keyboard-scroll.ts';
	import { traceOnce } from './trace.ts';
	let { ui, content }: { ui: DocsUi; content: DocsContent } = $props();
	let preamp = $state('−6');
	let crcInput = $state('123456789');
	let frequency = $state(72);
	const q23 = $derived(q23Example(preamp));
	const crc = $derived(crcExample(crcInput));
	const id = $props.id();
	// Illustration of sampling, not an audio/DSP implementation or measurement.
	const path = (khz: number) =>
		Array.from({ length: 701 }, (_, i) => {
			const x = 30 + i;
			const y = 95 - 62 * Math.cos(2 * Math.PI * khz * (i / 700) * 0.125);
			return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
		}).join(' ');
</script>

<figure class="plate" use:traceOnce>
	<ByteMap
		curve={auriPreset}
		label={ui.bytes}
		description={content.sections.find((section) => section.id === 'protocolo')!.paragraphs[0]}
	/>
	<figcaption>{ui.bytes} · 0…13 / 14…17 / 18…217 / 218…219</figcaption>
</figure>
<figure class="plate framing" use:traceOnce>
	<ReportTimeline
		curve={auriPreset}
		label={ui.framing}
		description={content.sections.find((section) => section.id === 'protocolo')!.paragraphs[2]}
	/>
	<figcaption>{ui.framing}</figcaption>
</figure>
<details>
	<summary>{ui.reports}</summary>
	<pre use:keyboardScroll role="region" aria-label={ui.reports}>{reportHex}</pre>
</details>
<figure class="plate" use:traceOnce>
	<div class="sampling-scene">
		<svg viewBox="0 0 760 220" role="img" aria-label={ui.sampling}>
			<title>{ui.sampling}</title>
			<path d="M30 95H730" stroke="#ad9c81" />
			<path d={path(frequency)} fill="none" stroke="#8c2f2f" stroke-width="1" />
			<path
				d={path(96 - frequency)}
				fill="none"
				stroke="#365c55"
				stroke-width="2"
				stroke-dasharray="5 3"
			/>
			{#each Array.from({ length: 13 }, (_, i) => i) as sample (sample)}
				<circle
					cx={30 + (sample * 700) / 12}
					cy={95 - 62 * Math.cos((2 * Math.PI * frequency * sample) / 96)}
					r="3"
					fill="#29251f"
				/>
			{/each}
			<text x="30" y="205">0</text><text x="730" y="205" text-anchor="end"
				>{exactNumber(0.125, content.locale)} ms · 96 kHz</text
			>
		</svg>
	</div>
	<label for="{id}-frequency">{ui.frequency}</label>
	<input id="{id}-frequency" type="range" min="49" max="90" step="1" bind:value={frequency} />
	<output for="{id}-frequency">{frequency} kHz → {ui.alias} {96 - frequency} kHz</output>
	<figcaption>{ui.sampling}</figcaption>
</figure>
<div class="widgets">
	<section aria-labelledby="{id}-q23">
		<h3 id="{id}-q23">{ui.q23}</h3>
		<label for="{id}-preamp">{ui.preamp}</label>
		<input
			id="{id}-preamp"
			type="text"
			inputmode="decimal"
			bind:value={preamp}
			aria-invalid={!q23}
			aria-describedby="{id}-preamp-note"
		/>
		<output for="{id}-preamp" aria-live="polite">{q23?.bytes ?? '·· ·· ·· ··'}</output>
		<p>{q23 ? `${q23.word} · int32 LE / Q23` : ui.preampInvalid}</p>
		<p id="{id}-preamp-note">
			round(10^(dB/20) × 2²³) · {exactNumber(THRESHOLDS.preampMinDb, content.locale)}…{exactNumber(
				THRESHOLDS.preampMaxDb,
				content.locale
			)} dB
		</p>
	</section>
	<section aria-labelledby="{id}-crc">
		<h3 id="{id}-crc">{ui.crc}</h3>
		<label for="{id}-crc-input">{ui.crcInput}</label>
		<input id="{id}-crc-input" type="text" maxlength="256" bind:value={crcInput} />
		<output for="{id}-crc-input" aria-live="polite">{crc.value}</output>
		<p>LE / {crc.bytes}</p>
		<p>CCITT-FALSE · poly 0x1021 · init 0xFFFF</p>
	</section>
</div>

<style>
	.plate {
		margin: 24px 0;
		padding: 14px;
		border: 1px solid #ad9c81;
	}
	.plate :global(.chart),
	.sampling-scene {
		content-visibility: auto;
		contain-intrinsic-size: auto 240px;
	}
	.plate :global(.chart) {
		/* Match the SVG viewBox before or after rendering, including its existing border.
		   This keeps every later TOC/anchor offset stable while the scene is skipped. */
		box-sizing: content-box;
		width: auto;
		aspect-ratio: 820 / 245;
	}
	.framing :global(.chart) {
		aspect-ratio: 820 / 240;
	}
	.sampling-scene {
		aspect-ratio: 760 / 220;
	}
	figcaption {
		margin-top: 10px;
		font-size: 16px;
	}
	.framing {
		background: #111c1e;
		color: #ece8dd;
	}
	pre {
		overflow-x: auto;
		max-width: 100%;
		font: 11px/1.8 var(--font-mono, monospace);
		padding: 12px;
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
	}
	svg text {
		font: 12px var(--font-mono, monospace);
		fill: #29251f;
	}
	.widgets {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 20px;
		margin-top: 24px;
	}
	.widgets section {
		min-width: 0;
		padding: 18px;
		border: 1px solid #ad9c81;
	}
	h3 {
		margin: 0 0 16px;
		font-size: 23px;
	}
	label {
		display: block;
		font: 12px/1.5 var(--font-sans, sans-serif);
		margin-top: 14px;
	}
	input[type='text'] {
		display: block;
		width: 100%;
		padding: 8px;
		margin-top: 6px;
		border: 1px solid #6b5e4c;
		background: #fff3;
		color: inherit;
	}
	input[type='range'] {
		width: 100%;
		accent-color: #8c2f2f;
	}
	output {
		display: block;
		padding: 12px 0;
		font: 18px var(--font-mono, monospace);
		color: #8c2f2f;
		overflow-wrap: anywhere;
	}
	.widgets p {
		font: 11px/1.6 var(--font-mono, monospace);
		overflow-wrap: anywhere;
	}
	:focus-visible {
		outline: 2px solid #8c2f2f;
		outline-offset: 4px;
	}
	@media (max-width: 760px) {
		.widgets {
			grid-template-columns: 1fr;
		}
	}
	@media print {
		.plate :global(.chart),
		.sampling-scene {
			content-visibility: visible;
			contain-intrinsic-size: none;
		}
	}
</style>
