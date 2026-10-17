<script lang="ts">
	import { onDestroy } from 'svelte';
	import { decodeS1 } from 'open-auri/share';
	import { m } from '#lib/paraglide/messages.js';
	import { Button } from '#lib/components/primitives/index.ts';
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
	/** The running operation ('load', 'more' or `add:<id>`): its button shows `loading`. */
	let pending = $state<string | null>(null);
	let message = $state('');
	let generation = 0;
	let abort: AbortController | undefined;
	const filtered = $derived(
		rows.filter((row) => row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
	);
	// Unavailable always says why (spec §2.6); behaviour is the same as the old `disabled`.
	// "Load more" can disappear while focused (last page), so it never carries a reason tooltip
	// for a running operation: it shows `loading` instead.
	const testRunning = $derived(disabled ? m.cego_fuxb_reason_test_running() : null);
	const loadReason = $derived(
		testRunning ?? (busy && pending !== 'load' ? m.cego_fuxb_reason_busy() : null)
	);
	function addReason(row: Row) {
		if (testRunning) return testRunning;
		if (added.includes(`community:${row.versionId}`)) return m.cego_fuxb_reason_added();
		return busy && pending !== `add:${row.id}` ? m.cego_fuxb_reason_busy() : null;
	}

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
		pending = null;
		message = '';
	}
	onDestroy(reset);

	async function load(more = false) {
		if (api === null || busy) return;
		const token = ++generation;
		abort?.abort();
		abort = new AbortController();
		busy = true;
		pending = more ? 'more' : 'load';
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
			if (token === generation) {
				busy = false;
				pending = null;
			}
		}
	}

	async function add(row: Row) {
		if (api === null || busy || disabled) return;
		const token = ++generation;
		abort = new AbortController();
		busy = true;
		pending = `add:${row.id}`;
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
			if (token === generation) {
				busy = false;
				pending = null;
			}
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
				<select
					bind:value={source}
					onchange={reset}
					{disabled}
					aria-describedby={disabled ? `${uid}-locked` : undefined}
				>
					<option value="feed">{m.cegocom_feed()}</option>
					<option value="rankings">{m.cegocom_rankings()}</option>
				</select></label
			>
			<label
				>{m.cegocom_search()}
				<input
					type="search"
					bind:value={query}
					{disabled}
					aria-describedby={disabled ? `${uid}-locked` : undefined}
				/></label
			>
			<Button disabledReason={loadReason} loading={pending === 'load'} onclick={() => load()}
				>{m.cegocom_load()}</Button
			>
		</div>
		{#if disabled}<p id="{uid}-locked" class="note">{m.cego_fuxb_reason_test_running()}</p>{/if}
		{#if loaded}
			{#if filtered.length > 0}
				<ul class="rows">
					{#each filtered as row (row.id)}
						<li>
							<span>{row.name}</span>
							<Button
								size="sm"
								disabledReason={addReason(row)}
								loading={pending === `add:${row.id}`}
								aria-label={m.cegocom_add_label({ name: row.name })}
								onclick={() => add(row)}>{m.cegocom_add()}</Button
							>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="note">{m.cegocom_empty()}</p>
			{/if}
			{#if cursor}
				<div class="more">
					<Button disabledReason={testRunning} loading={busy} onclick={() => load(true)}
						>{m.cegocom_more()}</Button
					>
				</div>
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
	select:disabled,
	input:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.more {
		margin-top: 10px;
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
