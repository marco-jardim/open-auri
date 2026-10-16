<script lang="ts">
	// /u/[apelido] (T4.11): public profile as a signed collection on a mixing console. Library
	// off → nickname, bio and counts only. Library on → creations (filter, license, sort, A/B
	// preview against the curve in the editor, through the shared audio engine) and public packs;
	// favorites only when the activity is public too. User text is rendered as text only.
	import { onDestroy } from 'svelte';
	import '@fontsource/courier-prime/400.css';
	import '@fontsource/courier-prime/700.css';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import type { ABPreview, AudioEngine } from '#lib/audio/engine.ts';
	import { neutralCurve } from '#lib/state/model.ts';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { m } from '#lib/paraglide/messages.js';
	import ChannelStrip from './ChannelStrip.svelte';
	import {
		LICENSE_OPTIONS,
		formatDate,
		mergePage,
		previewCurve,
		selectCreations,
		type CardPage,
		type CreationSort,
		type FavoriteCard,
		type License,
		type LineageCard,
		type PackCard,
		type ProfileView
	} from './model.ts';

	let { data, app = null }: { data: ProfileView; app?: ClientApp | null } = $props();
	const id = $props.id();
	const locale = $derived(getLocale());
	const profile = $derived(data.profile);
	const libraryOpen = $derived(profile.library === 'public');

	let creations = $state.raw<LineageCard[]>([]);
	let creationsCursor = $state<string | null>(null);
	let packs = $state.raw<PackCard[]>([]);
	let packsCursor = $state<string | null>(null);
	let favorites = $state.raw<FavoriteCard[]>([]);
	let favoritesCursor = $state<string | null>(null);
	$effect.pre(() => {
		creations = data.lineages?.items ?? [];
		creationsCursor = data.lineages?.nextCursor ?? null;
		packs = data.packs?.items ?? [];
		packsCursor = data.packs?.nextCursor ?? null;
		favorites = data.favorites?.items ?? [];
		favoritesCursor = data.favorites?.nextCursor ?? null;
	});

	let query = $state('');
	let license = $state<License | 'all'>('all');
	let sort = $state<CreationSort>('recent');
	const shown = $derived(selectCreations(creations, { query, license, sort, locale }));
	let loading = $state(false);
	let notice = $state('');

	// ---- A/B preview (shared engine; this page only stops what it started) ----
	let preview: ABPreview | null = null;
	let startedBy: AudioEngine | null = null;
	let playingId = $state<string | null>(null);
	let side = $state<'A' | 'B' | null>(null);
	let busy = $state(false);
	let attempt = 0;
	const fallback = neutralCurve();

	function stop() {
		attempt++;
		const engine = startedBy;
		startedBy = null;
		if (engine && engine.state().mode === 'chains') engine.stop();
		preview?.dispose();
		preview = null;
		playingId = null;
		side = null;
		busy = false;
	}
	onDestroy(stop);

	async function listen(item: LineageCard, chosen: 'A' | 'B') {
		if (!app || busy) return;
		const engine = app.audio;
		if (preview && playingId === item.id && engine.state().playing) {
			preview.select(chosen);
			side = chosen;
			return;
		}
		const curve = previewCurve(item.s1);
		if (!curve) {
			notice = m.perfil_preview_unavailable();
			return;
		}
		stop();
		const token = ++attempt;
		busy = true;
		try {
			const current = app.state.curve.current ?? fallback;
			preview = engine.createAB(current, curve, { experimental: true, initial: chosen });
			playingId = item.id;
			side = chosen;
			await engine.start('chains');
			if (token !== attempt) {
				if (engine.state().mode === 'chains') engine.stop();
				return;
			}
			startedBy = engine;
		} catch (error) {
			stop();
			notice = m.perfil_audio_error();
			console.error('Perfil preview failed', error instanceof Error ? error.name : 'unknown');
		} finally {
			if (token === attempt) busy = false;
		}
	}

	// ---- Pagination through GET /api/v1/users/[apelido]?list=… ----
	async function fetchPage<T>(list: 'lineages' | 'packs' | 'favorites', cursor: string) {
		const params = new URLSearchParams({ list, cursor });
		const response = await fetch(
			`/api/v1/users/${encodeURIComponent(profile.username)}?${params.toString()}`,
			{ headers: { accept: 'application/json' } }
		);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return (await response.json()) as CardPage<T>;
	}

	async function more(list: 'lineages' | 'packs' | 'favorites') {
		if (loading) return;
		loading = true;
		notice = '';
		try {
			if (list === 'lineages' && creationsCursor) {
				const page = await fetchPage<LineageCard>(list, creationsCursor);
				creations = mergePage(creations, page.items, (item) => item.id);
				creationsCursor = page.nextCursor;
			} else if (list === 'packs' && packsCursor) {
				const page = await fetchPage<PackCard>(list, packsCursor);
				packs = mergePage(packs, page.items, (item) => item.id);
				packsCursor = page.nextCursor;
			} else if (list === 'favorites' && favoritesCursor) {
				const page = await fetchPage<FavoriteCard>(list, favoritesCursor);
				favorites = mergePage(favorites, page.items, (item) => item.lineage.id);
				favoritesCursor = page.nextCursor;
			}
		} catch (error) {
			notice = m.perfil_load_error();
			console.error('Perfil page failed', error instanceof Error ? error.message : 'unknown');
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head
	><title>{m.perfil_meta_title({ name: profile.displayUsername })} · open-auri</title><meta
		name="description"
		content={m.perfil_meta_description({ name: profile.displayUsername })}
	/>{#if !libraryOpen}<meta name="robots" content="noindex" />{/if}</svelte:head
>

<div class="room">
	<section class="hero" aria-labelledby="{id}-title">
		<div class="caps">{m.perfil_eyebrow()}</div>
		<h1 id="{id}-title">{profile.displayUsername}</h1>
		<p class="handle">@{profile.username}</p>
		{#if profile.bio}<p class="bio">{profile.bio}</p>{/if}
		<dl class="counts">
			<div>
				<dt>{m.perfil_count_lineages()}</dt>
				<dd>{profile.counts.lineages}</dd>
			</div>
			<div>
				<dt>{m.perfil_count_packs()}</dt>
				<dd>{profile.counts.packs}</dd>
			</div>
		</dl>
	</section>

	{#if !libraryOpen}
		<p class="closed" data-testid="library-private">{m.perfil_library_private()}</p>
	{:else}
		<section class="console" aria-labelledby="{id}-creations">
			<div class="section-head">
				<h2 id="{id}-creations">{m.perfil_creations()}</h2>
				<span class="caps" aria-live="polite">{m.perfil_shown({ count: shown.length })}</span>
			</div>
			{#if creations.length > 0}
				<div class="controls">
					<label
						>{m.perfil_filter()}<input
							type="search"
							bind:value={query}
							placeholder={m.perfil_filter_placeholder()}
						/></label
					>
					<label
						>{m.perfil_license()}<select bind:value={license}
							><option value="all">{m.perfil_license_all()}</option
							>{#each LICENSE_OPTIONS as option (option)}<option value={option}>{option}</option
								>{/each}</select
						></label
					>
					<label
						>{m.perfil_sort()}<select bind:value={sort}
							><option value="recent">{m.perfil_sort_recent()}</option><option value="name"
								>{m.perfil_sort_name()}</option
							><option value="level">{m.perfil_sort_level()}</option></select
						></label
					>
				</div>
				<p class="ab-note">{m.perfil_ab_note()}</p>
			{/if}
			{#if creations.length === 0}
				<p class="empty" data-testid="creations-empty">{m.perfil_creations_empty()}</p>
			{:else if shown.length === 0}
				<div class="empty">
					<p data-testid="creations-no-match">{m.perfil_no_match()}</p>
					<button
						type="button"
						onclick={() => {
							query = '';
							license = 'all';
						}}>{m.perfil_clear()}</button
					>
				</div>
			{:else}
				<div class="strips">
					{#each shown as item, index (item.id)}
						<ChannelStrip
							{item}
							{index}
							{locale}
							side={playingId === item.id ? side : null}
							{busy}
							canPreview={app !== null}
							onListen={listen}
							onStop={stop}
						/>
					{/each}
				</div>
			{/if}
			{#if creationsCursor}
				<button type="button" class="more" disabled={loading} onclick={() => more('lineages')}
					>{m.perfil_load_more()}</button
				>
			{/if}
		</section>

		<section class="packs" aria-labelledby="{id}-packs">
			<h2 id="{id}-packs">{m.perfil_packs()}</h2>
			{#if packs.length === 0}
				<p class="empty" data-testid="packs-empty">{m.perfil_packs_empty()}</p>
			{:else}
				<ul>
					{#each packs as pack (pack.id)}
						<li>
							<strong>{pack.name}</strong>
							{#if pack.description}<span class="pack-description">{pack.description}</span>{/if}
							<small>{formatDate(pack.updatedAt, locale)}</small>
						</li>
					{/each}
				</ul>
			{/if}
			{#if packsCursor}
				<button type="button" class="more" disabled={loading} onclick={() => more('packs')}
					>{m.perfil_load_more()}</button
				>
			{/if}
		</section>

		{#if data.favorites !== null}
			<section class="favorites" aria-labelledby="{id}-favorites">
				<h2 id="{id}-favorites">{m.perfil_favorites()}</h2>
				{#if favorites.length === 0}
					<p class="empty" data-testid="favorites-empty">{m.perfil_favorites_empty()}</p>
				{:else}
					<ul>
						{#each favorites as favorite (favorite.lineage.id)}
							<li>
								<strong lang={favorite.lineage.lang}>{favorite.lineage.name}</strong>
								{#if favorite.lineage.author}<span
										>{m.perfil_by()} {favorite.lineage.author.displayUsername}</span
									>{/if}
								<small>{formatDate(favorite.at, locale)}</small>
							</li>
						{/each}
					</ul>
				{/if}
				{#if favoritesCursor}
					<button type="button" class="more" disabled={loading} onclick={() => more('favorites')}
						>{m.perfil_load_more()}</button
					>
				{/if}
			</section>
		{/if}
	{/if}

	<aside class="homage" aria-labelledby="{id}-homage">
		<div class="caps">{m.perfil_homage_eyebrow()}</div>
		<h2 id="{id}-homage">Chris Lord-Alge (1963–)</h2>
		<p>{m.perfil_homage_curiosity()}</p>
		<p class="sources">
			{m.perfil_homage_sources()}:
			<a href="https://en.wikipedia.org/wiki/Chris_Lord-Alge" rel="noopener noreferrer external"
				>Wikipedia</a
			>
			·
			<a
				href="https://solidstatelogic.com/media/chris-lord-alges-mix-la-installs-solid-state-logic-origin-for-its-intimate-and-artist-focused-studio-d"
				rel="noopener noreferrer external">Solid State Logic</a
			>
		</p>
	</aside>
	<div class="notice" role="status">{notice}</div>
</div>

<style>
	.room {
		padding: 0 28px 48px;
		color: #ece7dd;
		background:
			linear-gradient(180deg, #0008, transparent 240px),
			repeating-linear-gradient(90deg, #1c1d20 0 2px, #232428 2px 64px), #1f2023;
		font:
			14px/1.5 'Geist',
			Arial,
			sans-serif;
	}
	.caps {
		font:
			700 11px/1.2 'Courier Prime',
			monospace;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: #d9a441;
	}
	.hero {
		max-width: 920px;
		padding: 48px 0 24px;
	}
	h1 {
		margin: 8px 0 0;
		overflow-wrap: anywhere;
		font:
			700 clamp(32px, 6vw, 56px) / 1.05 'Courier Prime',
			monospace;
	}
	.handle {
		margin: 4px 0 0;
		color: #b9b2a3;
	}
	.bio {
		max-width: 64ch;
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.counts {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		margin: 16px 0 0;
	}
	.counts div {
		padding: 8px 12px;
		border: 1px solid #0008;
		border-radius: 3px;
		background: #111214;
	}
	.counts dt {
		font-size: 12px;
		color: #8f897c;
	}
	.counts dd {
		margin: 0;
		color: #9fe08a;
		font:
			700 22px/1.1 'Courier Prime',
			monospace;
	}
	.closed,
	.empty {
		max-width: 64ch;
		color: #cfc8b8;
	}
	.section-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}
	h2 {
		margin: 32px 0 12px;
		font:
			700 22px/1.2 'Courier Prime',
			monospace;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		margin-bottom: 8px;
	}
	.controls label {
		display: grid;
		gap: 4px;
		font-size: 12px;
		color: #b9b2a3;
	}
	.controls input,
	.controls select {
		min-height: 32px;
		padding: 4px 8px;
		border: 1px solid #000;
		border-radius: 3px;
		color: #ece7dd;
		background: #111214;
	}
	.ab-note {
		margin: 0 0 12px;
		font-size: 12px;
		color: #8f897c;
	}
	.strips {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 10px;
		padding: 12px;
		border-radius: 6px;
		background: linear-gradient(#141518, #0d0e10);
		box-shadow: inset 0 2px 10px #000c;
	}
	ul {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: grid;
		gap: 2px;
		padding: 10px 12px;
		border-left: 3px solid #d9a441;
		background: #ffffff0a;
		overflow-wrap: anywhere;
	}
	.pack-description {
		white-space: pre-line;
		color: #cfc8b8;
	}
	small {
		color: #8f897c;
	}
	.more,
	.empty button {
		margin-top: 12px;
		min-height: 32px;
		padding: 4px 12px;
		border: 1px solid #000;
		border-radius: 3px;
		color: #1d1a14;
		background: linear-gradient(#e9e3d5, #c9c1ae);
		cursor: pointer;
	}
	.homage {
		max-width: 720px;
		margin-top: 48px;
		padding: 16px 20px;
		border: 1px solid #d9a44155;
		border-radius: 4px;
		background: #00000040;
	}
	.homage h2 {
		margin-top: 6px;
	}
	.sources a {
		color: #ffcf7a;
	}
	.notice:empty {
		display: none;
	}
	.notice {
		margin-top: 16px;
		color: #ffcf7a;
	}
</style>
