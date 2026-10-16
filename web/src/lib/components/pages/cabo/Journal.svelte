<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { formatCrc, formatNumber } from '#lib/components/cable/i18n.ts';
	import type { JournalEntry, JournalStatus } from '#lib/cable/types.ts';
	import { MiniCurve } from '#lib/charts/index.ts';
	import { encoderData } from './model.ts';

	let {
		entries,
		onload
	}: { entries: readonly JournalEntry[]; onload?: (entry: JournalEntry) => void } = $props();
	const status: Record<JournalStatus, () => string> = {
		ok: () => m.cabo_status_ok(),
		interrupted: () => m.cabo_status_interrupted(),
		simulated: () => m.cabo_status_simulated()
	};

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
		<p class="note">{m.cabo_journal_empty()}</p>
	{:else}
		<ol class="cards">
			{#each entries.toReversed() as entry, index (index)}
				{@const encoded = encoderData(entry)}
				<li class="card" data-status={entry.status}>
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
					<button type="button" disabled={!onload} onclick={() => onload?.(entry)}
						>{m.cabo_load()}</button
					>
				</li>
			{/each}
		</ol>
	{/if}
</div>
<button class="export" type="button" disabled={entries.length === 0} onclick={exportJournal}
	>{m.cabo_export()}</button
>

<style>
	.note {
		font-size: 12.5px;
		line-height: 1.55;
		color: #b6bdb7;
	}
	.tray {
		padding: 16px;
		border-radius: 5px;
		background: linear-gradient(#0b0c0d, #16181a);
		box-shadow: inset 0 3px 8px #000;
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
		gap: 18px;
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.card {
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
	header {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: space-between;
		font: 10px/1.4 var(--mono, monospace);
	}
	.tag {
		padding: 2px 5px;
		border: 1px solid #6a5d45;
		font:
			600 11px 'Barlow Condensed',
			sans-serif;
		text-transform: uppercase;
	}
	[data-status='interrupted'] .tag {
		color: #901e23;
		border-color: #901e23;
	}
	h3 {
		overflow-wrap: anywhere;
		margin: 12px 0 4px;
		font:
			700 24px/1.1 'Barlow Condensed',
			sans-serif;
	}
	.device {
		overflow-wrap: anywhere;
		font: 11px/1.5 var(--mono, monospace);
	}
	.mini {
		max-height: 70px;
		overflow: hidden;
	}
	dl {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 20px;
		font: 11px var(--mono, monospace);
	}
	dl div {
		display: flex;
		gap: 8px;
	}
	dd {
		margin: 0;
	}
	button {
		min-height: 36px;
		border: 1px solid currentColor;
		border-radius: 3px;
		background: transparent;
		color: inherit;
		padding: 6px 10px;
		font:
			600 12px 'Barlow Condensed',
			sans-serif;
	}
	.export {
		margin-top: 14px;
	}
	button:disabled {
		opacity: 0.5;
	}
	:focus-visible {
		outline: 2px solid currentColor;
		outline-offset: 3px;
	}
</style>
