<script lang="ts">
	import { onDestroy } from 'svelte';
	import { decodeS1 } from 'open-auri/share';
	import { rememberOrigin, requireLoginHref } from '#lib/social/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { CurveData } from '#lib/state/model.ts';
	import type { CurveSocial } from './social.svelte.ts';
	import { getHiddenStore } from '#lib/social/hidden-context.ts';
	import { authorHiddenId, isHidden } from '#lib/social/hidden.ts';

	let {
		social,
		path,
		onload
	}: {
		social: CurveSocial;
		path: string;
		onload: (curve: CurveData) => void;
	} = $props();
	type Row = { id: string; versionId: string; name: string; author: string | null };
	const hidden = getHiddenStore();
	let source = $state('feed');
	let shelf = $state<'created' | 'favorites' | 'installed'>('created');
	let query = $state('');
	let rows = $state.raw<Row[]>([]);
	let selected = $state('');
	let cursor = $state<string | null>(null);
	let busy = $state(false);
	let loaded = $state(false);
	let error = $state('');
	let generation = 0;
	let abort: AbortController | undefined;
	const filtered = $derived(
		$hidden.ready
			? rows.filter(
					(row) =>
						!isHidden($hidden, row.id, row.author) &&
						row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())
				)
			: []
	);
	function reset() {
		generation++;
		abort?.abort();
		rows = [];
		selected = '';
		cursor = null;
		loaded = false;
		busy = false;
		error = '';
	}
	onDestroy(reset);
	async function load(more = false) {
		if (busy || social.unavailable || (source === 'library' && !social.session.signedIn)) return;
		const token = ++generation;
		abort?.abort();
		abort = new AbortController();
		busy = true;
		error = '';
		try {
			const opts = { signal: abort.signal };
			const next = more ? cursor : null;
			const page =
				source === 'library'
					? await social.api.myLibrary({ shelf, cursor: next, limit: 50 }, opts)
					: source === 'rankings'
						? await social.api.rankings({ cursor: next, limit: 50 }, opts)
						: await social.api.feed({ sort: 'new', cursor: next, limit: 50 }, opts);
			if (token !== generation) return;
			const items = page.items.map((item) => {
				const lineage = 'lineage' in item ? item.lineage : item;
				return {
					id: lineage.id,
					versionId: lineage.head.id,
					name: lineage.head.name,
					author: authorHiddenId(lineage.author)
				};
			});
			rows = more ? [...rows, ...items] : items;
			cursor = page.nextCursor;
			loaded = true;
		} catch (cause) {
			if (token === generation) error = social.failure(cause);
		} finally {
			if (token === generation) busy = false;
		}
	}
	async function use() {
		const row = filtered.find((row) => row.id === selected);
		if (!row || busy || social.unavailable) return;
		const token = ++generation;
		abort = new AbortController();
		busy = true;
		error = '';
		try {
			const result = await social.api.getCurve(
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
			onload({
				bands: curve.bands,
				preampDb: curve.preampDb,
				name: result.version.name,
				source: `community:${result.lineage.id}`,
				// The version's filter labels (detail read; never from list cards).
				labels: result.version.labels
			});
		} catch (cause) {
			if (token === generation) error = social.failure(cause);
		} finally {
			if (token === generation) busy = false;
		}
	}
</script>

<fieldset class="social-sources">
	<legend>{m.curve_social_sources()}</legend>
	<label
		>{m.curve_social_sources()}
		<select bind:value={source} onchange={reset}>
			<option value="feed">{m.curve_social_feed()}</option>
			<option value="rankings">{m.curve_social_rankings()}</option>
			<option value="library">{m.curve_social_library()}</option>
		</select>
	</label>
	{#if source === 'library' && !social.session.signedIn}
		<a href={requireLoginHref(path)}>{m.curve_social_login()}</a>
	{:else}
		{#if source === 'library'}
			<select aria-label={m.curve_social_library()} bind:value={shelf} onchange={reset}>
				<option value="created">{m.curve_social_library()}</option>
				<option value="favorites">{m.curve_social_favorites()}</option>
				<option value="installed">{m.curve_social_installed()}</option>
			</select>
		{/if}
		<button type="button" disabled={busy || social.unavailable} onclick={() => load()}
			>{m.curve_social_load()}</button
		>
		<label>{m.curve_social_search()}<input type="search" bind:value={query} /></label>
		<label
			>{m.curve_social_choose()}
			<select bind:value={selected} disabled={busy}>
				<option value="">{m.curve_social_choose()}</option>
				{#each filtered as row (`${row.id}:${row.versionId}`)}<option value={row.id}
						>{row.name}</option
					>{/each}
			</select>
		</label>
		<button type="button" disabled={!selected || busy || social.unavailable} onclick={use}
			>{m.curve_social_add()}</button
		>
		{#if cursor}<button
				type="button"
				disabled={busy || social.unavailable}
				onclick={() => load(true)}>{m.curve_social_more()}</button
			>{/if}
		{#if loaded && !filtered.length && !error && !social.unavailable}<p>
				{m.curve_social_empty()}
			</p>{/if}
	{/if}
	{#if busy}<p role="status">{m.curve_social_loading()}</p>{/if}
	{#if social.unavailable}<p role="status">{m.curve_social_offline()}</p>
		<button
			type="button"
			onclick={() => {
				social.retry();
				void load();
			}}>{m.curve_social_load()}</button
		>
	{:else if error}<p role="status">{error}</p>{/if}
</fieldset>

<style>
	.social-sources {
		display: grid;
		gap: 0.6rem;
		margin-block: 1rem;
		padding: 1rem;
		border: 1px solid currentColor;
		min-width: 0;
	}
	label {
		display: grid;
		gap: 0.3rem;
	}
	input,
	select,
	button {
		max-width: 100%;
		min-width: 0;
		padding: 0.5rem;
		color: inherit;
		background: #182019;
		border: 1px solid #859175;
	}
	a {
		color: inherit;
	}
	:focus-visible {
		outline: 2px solid #f2b33d;
		outline-offset: 3px;
	}
</style>
