<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { formatCrc, formatNumber } from '#lib/components/cable/i18n.ts';
	import type { JournalEntry, JournalStatus } from '#lib/cable/types.ts';
	import MiniCurve from '#lib/charts/MiniCurve.svelte';
	import { Button, EmptyState } from '#lib/components/primitives/index.ts';
	import Explainer from '#lib/components/comprehension/Explainer.svelte';
	import { encoderData, exampleBoxes } from './model.ts';

	let {
		entries,
		onload,
		checklistHref = '#cabo-calibracao'
	}: {
		entries: readonly JournalEntry[];
		onload?: (entry: JournalEntry) => void;
		/** In-page link to the calibration unit (the empty state's action). */
		checklistHref?: string;
	} = $props();
	const status: Record<JournalStatus, () => string> = {
		ok: () => m.cabo_status_ok(),
		interrupted: () => m.cabo_status_interrupted(),
		simulated: () => m.cabo_status_simulated()
	};
	/** Spec §4.4: three non-interactive EXAMPLE boxes; never entries, never loadable. */
	const examples = exampleBoxes();

	function exportJournal() {
		const url = URL.createObjectURL(
			new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' })
		);
		const link = document.createElement('a');
		link.href = url;
		link.download = 'open-auri-journal.json';
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
</script>

<p class="note">{m.cabo_journal_note()}</p>
<div class="tray">
	{#if entries.length === 0}
		<EmptyState title={m.empty_journal_title()} why={m.empty_journal_body()} class="journal-empty">
			{#snippet illustration()}
				<svg viewBox="0 0 96 64" width="96" height="64" fill="none" stroke="currentColor">
					<rect x="6" y="10" width="84" height="46" rx="3" stroke-width="1.5" />
					<circle cx="30" cy="33" r="10" stroke-width="1.5" />
					<circle cx="66" cy="33" r="10" stroke-width="1.5" />
					<path d="M30 43h36" stroke-width="1.5" />
					<path d="M14 18h68" stroke-width="1" stroke-dasharray="3 4" opacity=".6" />
				</svg>
			{/snippet}
			{#snippet action()}
				<a class="action" href={checklistHref}>{m.empty_journal_action()}</a>
			{/snippet}
			{#snippet explain()}
				<Explainer term="checklist" />
			{/snippet}
		</EmptyState>
		<ul class="cards examples" aria-label={m.cabo_fux_examples_label()}>
			{#each examples as example, index (example.id)}
				<li class="card example" data-example={example.id} style:--tilt={`${index - 1}deg`}>
					<div class="card-head">
						<span class="tag">{m.empty_example()}</span>
					</div>
					<p class="card-name">{example.name}</p>
					<div class="mini">
						<MiniCurve
							curve={{ bands: example.bands, preampDb: example.preampDb }}
							label={m.cabo_response()}
							description={m.cabo_response_description()}
							color="#1b5e58"
						/>
					</div>
					<dl>
						<div>
							<dt>CRC</dt>
							<dd>{formatCrc(example.crc)}</dd>
						</div>
						<div>
							<dt>Preamp</dt>
							<dd>{formatNumber(example.preampDb)} dB</dd>
						</div>
					</dl>
				</li>
			{/each}
		</ul>
	{:else}
		<ol class="cards">
			{#each entries.toReversed() as entry, index (index)}
				{@const encoded = encoderData(entry)}
				<li
					class="card"
					data-status={entry.status}
					data-yolo={entry.profile === 'yolo' ? 'true' : undefined}
				>
					{#if entry.profile === 'yolo'}
						<!-- A Modo YOLO write: red tape, with the criteria it waived. -->
						<span
							class="yolo-tape"
							title={m.yolo_journal_entry({ criteria: (entry.waived ?? []).join(', ') || '-' })}
							>{m.yolo_tape()}</span
						>
					{/if}
					<header>
						<time datetime={new Date(entry.at).toISOString()}
							>{new Intl.DateTimeFormat(getLocale(), {
								dateStyle: 'short',
								timeStyle: 'short'
							}).format(entry.at)}</time
						>
						<span class="tag">{status[entry.status]()}</span>
					</header>
					<h3>{entry.name}</h3>
					<p class="device">{entry.device}</p>
					{#if encoded.ok}
						<div class="mini">
							<MiniCurve
								curve={entry}
								label={m.cabo_response()}
								description={m.cabo_response_description()}
								color="#1b5e58"
							/>
						</div>
					{/if}
					<dl>
						<div>
							<dt>CRC</dt>
							<dd>{formatCrc(entry.crc)}</dd>
						</div>
						<div>
							<dt>Preamp</dt>
							<dd>{formatNumber(entry.preampDb)} dB</dd>
						</div>
					</dl>
					<Button
						size="sm"
						class="load"
						disabledReason={onload ? null : m.cabo_fux_load_wait()}
						onclick={() => onload?.(entry)}>{m.cabo_load()}</Button
					>
				</li>
			{/each}
		</ol>
	{/if}
</div>
<div class="foot">
	<Button
		size="sm"
		disabledReason={entries.length === 0 ? m.cabo_fux_export_empty() : null}
		onclick={exportJournal}>{m.cabo_export()}</Button
	>
</div>

<style>
	.note {
		font-size: var(--fs-small, 13px);
		line-height: 1.55;
		color: #b6bdb7;
	}
	.tray {
		display: grid;
		gap: 18px;
		padding: 16px;
		border-radius: 5px;
		background: linear-gradient(#0b0c0d, #16181a);
		box-shadow: inset 0 3px 8px #000;
	}
	.tray :global(.journal-empty) {
		color: #ece7dd;
	}
	.action {
		color: #8fe9df;
		font: 500 var(--fs-ui, 14px) var(--face-body, 'Geist', sans-serif);
		text-underline-offset: 4px;
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr));
		gap: 18px;
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.card {
		position: relative;
		min-width: 0;
		padding: 12px 14px;
		color: #2b2a26;
		border-radius: 2px;
		background:
			repeating-linear-gradient(180deg, transparent 0 21px, #6f8fb033 21px 22px),
			linear-gradient(#f3ead2, #e4d9bb);
		box-shadow:
			0 2px #b8ab8b,
			0 7px 12px #000a;
	}
	.example {
		transform: rotate(var(--tilt, 0deg));
	}
	header,
	.card-head {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: space-between;
		font: 400 var(--label-min, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
	}
	.card-head {
		justify-content: flex-end;
	}
	.tag {
		padding: 2px 5px;
		border: 1.5px solid #6a5d45;
		color: #5c503a;
		font: 700 var(--label-min, 11px) var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
	.example .tag {
		transform: rotate(-5deg);
	}
	.yolo-tape {
		display: inline-block;
		margin-bottom: 4px;
		padding: 1px 8px;
		background: #a3262c;
		color: #fff;
		font: 700 var(--fs-caption, 12px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.16em;
		transform: rotate(-2deg);
	}
	[data-status='interrupted'] .tag {
		color: #901e23;
		border-color: #901e23;
	}
	h3,
	.card-name {
		overflow-wrap: anywhere;
		margin: 12px 0 4px;
		font: 700 24px/1.1 var(--cond, 'Barlow Condensed', sans-serif);
	}
	.device {
		overflow-wrap: anywhere;
		font: 400 var(--label-min, 11px) / 1.5 var(--face-data, 'JetBrains Mono', monospace);
	}
	.mini {
		max-height: 70px;
		overflow: hidden;
	}
	dl {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 20px;
		font: 400 var(--label-min, 11px) var(--face-data, 'JetBrains Mono', monospace);
	}
	dl div {
		display: flex;
		gap: 8px;
	}
	dd {
		margin: 0;
	}
	.foot {
		margin-top: 14px;
	}
</style>
