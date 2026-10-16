<!--
	Sequencer (Engenharia): the 9 HID reports and the commit a write of the current curve would send
	(core encoders), shown as a timeline and as a TX log with nominal timing. "Send" only opens the
	layout's pre-write checklist via the `onsend` callback (`app.requestWrite()`); nothing is sent here.
-->
<script lang="ts">
	import { ReportTimeline } from '#lib/charts/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { hexBytes, payloadCrc } from './format.ts';
	import type { Curve } from './model.ts';
	import { txLog } from './reports.ts';

	interface Props {
		curve: Curve;
		disabled?: boolean;
		onsend: () => void;
	}
	let { curve, disabled = false, onsend }: Props = $props();

	const headingId = $props.id();
	const log = $derived(txLog(curve));
	const crc = $derived(payloadCrc(log.payload));
</script>

<section class="mod-panel" aria-labelledby={headingId}>
	<div class="mp-title">
		<h3 id={headingId}>{m.curva_seq_heading()}</h3>
		<span>{m.curva_seq_sub({ crc })}</span>
	</div>
	<ReportTimeline
		{curve}
		label={m.curva_timeline_label()}
		description={m.curva_timeline_desc()}
		commitLabel={m.curva_timeline_commit()}
	/>
	<div class="seq-actions">
		<button type="button" class="btn-pl acc" {disabled} onclick={onsend}
			>{m.curva_seq_send()}</button
		>
		<span>{m.curva_seq_note()}</span>
	</div>
	<h4>{m.curva_tx_label()}</h4>
	<ol class="tape" aria-label={m.curva_tx_label()}>
		{#each log.rows as row, i (i)}
			<li>
				<span class="when">
					{row.index === null
						? m.curva_tx_commit({ time: String(row.atMs) })
						: m.curva_tx_report({
								index: String(row.index),
								time: String(row.atMs),
								count: String(row.dataBytes)
							})}
				</span>
				<code>{hexBytes(row.bytes)}</code>
			</li>
		{/each}
	</ol>
</section>

<style>
	.mod-panel {
		content-visibility: auto;
		contain-intrinsic-size: auto 650px;
		padding: 14px;
		border-radius: 6px;
		background: linear-gradient(#2e2d2b, #1f1e1c);
		color: var(--curva-silk, #e9e3d4);
	}
	.mp-title {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 8px;
	}
	h3 {
		margin: 0;
		font: 400 22px/1.1 var(--font-display, 'Instrument Serif', serif);
	}
	.mp-title span,
	.seq-actions span {
		font: 11px/1.3 var(--font-mono, 'JetBrains Mono', monospace);
		color: var(--curva-silk-2, #c9c1ae);
	}
	h4 {
		margin: 12px 0 6px;
		font: 600 10px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--curva-silk-2, #c9c1ae);
	}
	.seq-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		margin-top: 10px;
	}
	.tape {
		display: grid;
		gap: 3px;
		/* Ten rows only: no inner scroll region (it would need keyboard access). */
		margin: 0;
		padding: 8px;
		border-radius: 3px;
		background: #efe6d2;
		color: #29251f;
		list-style: none;
	}
	.tape li {
		display: grid;
		gap: 1px;
		font: 10.5px/1.35 var(--font-mono, 'JetBrains Mono', monospace);
	}
	.when {
		font-weight: 600;
	}
	code {
		overflow-wrap: anywhere;
	}
</style>
