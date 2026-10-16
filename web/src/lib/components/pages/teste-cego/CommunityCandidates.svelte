<script lang="ts">
	import { onDestroy } from 'svelte';
	import { decodeS1 } from 'open-auri/share';
	import { m } from '#lib/paraglide/messages.js';
	import { isSocialApiError, rememberOrigin, type SocialApi } from '#lib/social/index.ts';
	import { candidate, type Candidate } from './experiment.ts';

	let {
		api = null,
		disabled = false,
		added = [],
		onadd
	}: {
		/** Public reads only: feed, rankings and one published curve. */
		api?: Pick<SocialApi, 'feed' | 'rankings' | 'getCurve'> | null;
		disabled?: boolean;
		/** Candidate ids already in the list. */
		added?: readonly string[];
		onadd: (value: Candidate) => void;
	} = $props();

	type Row = { id: string; versionId: string; name: string };
	const uid = $props.id();
	let source = $state<'feed' | 'rankings'>('feed');
	let query = $state('');
	let rows = $state.raw<Row[]>([]);
	let cursor = $state<string | null>(null);
	let loaded = $state(false);
	let busy = $state(false);
	let message = $state('');
	let generation = 0;
	let abort: AbortController | undefined;
	const filtered = $derived(
		rows.filter((row) => row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
	);

	function failure(cause: unknown): string {
		if (isSocialApiError(cause)) {
			return cause.unreachable ? m.cegocom_offline() : m.cegocom_failed();
		}
		console.warn(JSON.stringify({ event: 'cego.community', error: (cause as Error).name }));
		return m.cegocom_failed();
	}

	function reset() {
		generation++;
		abort?.abort();
		rows = [];
		cursor = null;
		loaded = false;
		busy = false;
		message = '';
	}
	onDestroy(reset);

	async function load(more = false) {
		if (api === null || busy) return;
		const token = ++generation;
		abort?.abort();
		abort = new AbortController();
		busy = true;
		message = '';
		try {
			const opts = { signal: abort.signal };
			const next = more ? cursor : null;
			const page =
				source === 'rankings'
					? await api.rankings({ cursor: next, limit: 50 }, opts)
					: await api.feed({ sort: 'new', cursor: next, limit: 50 }, opts);
			if (token !== generation) return;
			const items = page.items.map((item) => {
				const lineage = item.lineage;
				return { id: lineage.id, versionId: lineage.head.id, name: lineage.head.name };
			});
			rows = more ? [...rows, ...items] : items;
			cursor = page.nextCursor;
			loaded = true;
		} catch (cause) {
			if (token === generation && !(cause instanceof DOMException && cause.name === 'AbortError')) {
				message = failure(cause);
			}
		} finally {
			if (token === generation) busy = false;
		}
	}

	async function add(row: Row) {
		if (api === null || busy || disabled) return;
		const token = ++generation;
		abort = new AbortController();
		busy = true;
		message = '';
		try {
			const result = await api.getCurve(
				row.id,
				{ versionId: row.versionId },
				{ signal: abort.signal }
			);
			if (token !== generation) return;
			const curve = decodeS1(result.curve.s1);
			await rememberOrigin({
				s1: result.curve.s1,
				lineageId: result.lineage.id,
				versionId: result.version.id
			});
			if (token !== generation) return;
			const value = candidate(`community:${result.version.id}`, result.version.name, {
				bands: curve.bands,
				preampDb: curve.preampDb
			});
			onadd(value);
			message = value.accepted ? m.cegocom_added({ name: value.name }) : m.cegocom_rejected();
		} catch (cause) {
			if (token === generation) message = failure(cause);
		} finally {
			if (token === generation) busy = false;
		}
	}
</script>

{#if api}
	<section class="card community" aria-labelledby="{uid}-title">
		<h3 id="{uid}-title">{m.cegocom_title()}</h3>
		<p class="note">{m.cegocom_note()}</p>
		<div class="controls">
			<label
				>{m.cegocom_source()}
				<select bind:value={source} onchange={reset} {disabled}>
					<option value="feed">{m.cegocom_feed()}</option>
					<option value="rankings">{m.cegocom_rankings()}</option>
				</select></label
			>
			<label
				>{m.cegocom_search()}
				<input type="search" bind:value={query} {disabled} /></label
			>
			<button type="button" disabled={disabled || busy} onclick={() => load()}
				>{m.cegocom_load()}</button
			>
		</div>
		{#if loaded}
			{#if filtered.length > 0}
				<ul class="rows">
					{#each filtered as row (row.id)}
						<li>
							<span>{row.name}</span>
							<button
								type="button"
								disabled={disabled || busy || added.includes(`community:${row.versionId}`)}
								aria-label={m.cegocom_add_label({ name: row.name })}
								onclick={() => add(row)}>{m.cegocom_add()}</button
							>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="note">{m.cegocom_empty()}</p>
			{/if}
			{#if cursor}
				<button type="button" disabled={disabled || busy} onclick={() => load(true)}
					>{m.cegocom_more()}</button
				>
			{/if}
		{/if}
		<p class="message" role="status">{message}</p>
	</section>
{/if}

<style>
	.card {
		border: 1px solid #ece7dd24;
		border-radius: 12px;
		padding: 16px;
		background: #ffffff04;
		margin: 14px 0;
		min-width: 0;
	}
	h3 {
		font-size: 13px;
		font-weight: 600;
		margin: 0 0 6px;
	}
	.note {
		font-size: 12px;
		color: #b5ad9f;
		margin: 6px 0 0;
	}
	.message {
		min-height: 1.5em;
		color: #e8d3a6;
		font-size: 13px;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: flex-end;
		margin-top: 10px;
	}
	label {
		display: grid;
		gap: 4px;
		font-size: 13px;
	}
	select,
	input {
		font: inherit;
		color: #ece7dd;
		background: #0c0b09;
		border: 1px solid #ece7dd24;
		border-radius: 8px;
		padding: 6px 8px;
	}
	button {
		font: inherit;
		border: 1px solid #ece7dd24;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		padding: 7px 12px;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.rows {
		list-style: none;
		padding: 0;
		margin: 12px 0 0;
		display: grid;
		gap: 6px;
		max-height: 260px;
		overflow: auto;
	}
	.rows li {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		align-items: center;
		font-size: 13px;
		overflow-wrap: anywhere;
	}
</style>
