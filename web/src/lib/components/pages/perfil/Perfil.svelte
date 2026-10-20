<script lang="ts">
	// /u/[apelido]: public profile as a signed record collection. Library
	// off → nickname, bio and counts only. Library on → creations (filter, license, sort, A/B
	// preview against the curve in the editor, through the shared audio engine) and public packs;
	// favorites only when the activity is public too. User text is rendered as text only.
	import { onDestroy, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { Button, EmptyState, Panel, Skeleton } from '#lib/components/primitives/index.ts';
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import { Transport } from '#lib/components/audio/index.ts';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import type { ABPreview, AudioEngine, AudioEngineState } from '#lib/audio/engine.ts';
	import { neutralCurve } from '#lib/state/model.ts';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { m } from '#lib/paraglide/messages.js';
	import ProfileRecord from './ProfileRecord.svelte';
	import { getHiddenStore } from '#lib/social/hidden-context.ts';
	import { authorHiddenId, isHidden } from '#lib/social/hidden.ts';
	import HideActions from '#lib/components/social/HideActions.svelte';
	import HiddenItems from '#lib/components/social/HiddenItems.svelte';
	import ReportAction from '#lib/components/social/ReportAction.svelte';
	import LazyArt from '#lib/components/art/LazyArt.svelte';
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

	let {
		data,
		app = null,
		loading: profileLoading = false
	}: { data: ProfileView; app?: ClientApp | null; loading?: boolean } = $props();
	const id = $props.id();
	const locale = $derived(getLocale());
	const profile = $derived(data.profile);
	const libraryOpen = $derived(profile.library === 'public');
	const activityOpen = $derived(libraryOpen && profile.activity === 'public');

	let creations = $state.raw<LineageCard[]>(untrack(() => data.lineages?.items ?? []));
	let creationsCursor = $state<string | null>(untrack(() => data.lineages?.nextCursor ?? null));
	let packs = $state.raw<PackCard[]>(untrack(() => data.packs?.items ?? []));
	let packsCursor = $state<string | null>(untrack(() => data.packs?.nextCursor ?? null));
	let favorites = $state.raw<FavoriteCard[]>(untrack(() => data.favorites?.items ?? []));
	let favoritesCursor = $state<string | null>(untrack(() => data.favorites?.nextCursor ?? null));

	let query = $state('');
	let license = $state<License | 'all'>('all');
	let sort = $state<CreationSort>('recent');
	const hidden = getHiddenStore();
	const profileAuthorId = $derived(profile.authorId ?? profile.username.toLowerCase());
	const authorHidden = $derived($hidden.authors.includes(profileAuthorId));
	const shown = $derived(
		$hidden.ready
			? selectCreations(
					creations.filter((item) => !isHidden($hidden, item.id, authorHiddenId(item.author))),
					{ query, license, sort, locale }
				)
			: []
	);
	const shownFavorites = $derived(
		$hidden.ready
			? favorites.filter(
					(item) => !isHidden($hidden, item.lineage.id, authorHiddenId(item.lineage.author))
				)
			: []
	);
	let loading = $state(false);
	let notice = $state('');

	// ---- A/B preview (shared engine; this page only stops what it started) ----
	/** Session tag of this page's comparison (Transport, navbar). */
	const PERFIL_SESSION = 'perfil';
	let preview: ABPreview | null = null;
	let startedBy: AudioEngine | null = null;
	let unsubscribe: (() => void) | null = null;
	let playingId = $state<string | null>(null);
	let side = $state<'A' | 'B' | null>(null);
	let busy = $state(false);
	let attempt = 0;
	const fallback = neutralCurve();
	/** The creation of the current comparison: the Transport's play starts it again. */
	const playingItem = $derived(creations.find((item) => item.id === playingId) ?? null);

	/** The engine plays or holds paused this page's session (not raw, not another page's). */
	function owned(engine: AudioEngine): boolean {
		const state = engine.state();
		return state.session === PERFIL_SESSION && (state.playing || state.paused);
	}

	/**
	 * Follows the engine (as Comunidade's listener does): a pause or resume of this session from
	 * the Transport or the navbar keeps the comparison; a stop, raw playback or another page's
	 * session means it is no longer ours, so the record's "Parar" goes and the chains are disposed.
	 */
	function follow(state: AudioEngineState) {
		const ours = state.session === PERFIL_SESSION;
		if (ours && state.playing && state.mode === 'chains') return;
		if (ours && state.paused) return;
		stop();
	}

	/**
	 * Ends the comparison (teardown, "Parar", unmount, the engine moved on): `stop()` only on our
	 * own session.
	 */
	function stop() {
		attempt++;
		unsubscribe?.();
		unsubscribe = null;
		const engine = startedBy;
		startedBy = null;
		if (engine && owned(engine)) engine.stop();
		preview?.dispose();
		preview = null;
		playingId = null;
		side = null;
		busy = false;
	}
	onDestroy(stop);
	$effect(() => {
		if (
			playingId &&
			(!$hidden.ready || authorHidden || isHidden($hidden, playingId, profileAuthorId))
		)
			stop();
	});

	$effect.pre(() => {
		creations = libraryOpen ? (data.lineages?.items ?? []) : [];
		creationsCursor = libraryOpen ? (data.lineages?.nextCursor ?? null) : null;
		packs = libraryOpen ? (data.packs?.items ?? []) : [];
		packsCursor = libraryOpen ? (data.packs?.nextCursor ?? null) : null;
		favorites = activityOpen ? (data.favorites?.items ?? []) : [];
		favoritesCursor = activityOpen ? (data.favorites?.nextCursor ?? null) : null;
		untrack(stop);
		loading = false;
		notice = '';
	});

	async function listen(item: LineageCard, chosen: 'A' | 'B') {
		if (!app || busy) return;
		const engine = app.audio;
		if (preview && playingId === item.id && startedBy === engine && owned(engine)) {
			// Same comparison: switch sides at the same moment; a paused one continues.
			preview.select(chosen);
			side = chosen;
			if (!engine.state().playing) {
				try {
					await engine.resume();
				} catch (error) {
					notice = m.perfil_audio_error();
					console.error('Perfil resume failed', error instanceof Error ? error.name : 'unknown');
				}
			}
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
			// A comparison starts at a random point of the file (SEEK.2); the file loops.
			await engine.start('chains', { startAt: 'random', session: PERFIL_SESSION });
			if (token !== attempt) {
				if (owned(engine)) engine.stop();
				return;
			}
			startedBy = engine;
			unsubscribe = engine.onChange(follow);
			// Another page may have taken the engine between the start and this subscription.
			if (!owned(engine)) stop();
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
		if (loading || !libraryOpen || (list === 'favorites' && !activityOpen)) return;
		const requestedView = data;
		loading = true;
		notice = '';
		try {
			if (list === 'lineages' && creationsCursor) {
				const page = await fetchPage<LineageCard>(list, creationsCursor);
				if (data !== requestedView || !libraryOpen) return;
				creations = mergePage(creations, page.items, (item) => item.id);
				creationsCursor = page.nextCursor;
			} else if (list === 'packs' && packsCursor) {
				const page = await fetchPage<PackCard>(list, packsCursor);
				if (data !== requestedView || !libraryOpen) return;
				packs = mergePage(packs, page.items, (item) => item.id);
				packsCursor = page.nextCursor;
			} else if (list === 'favorites' && favoritesCursor) {
				const page = await fetchPage<FavoriteCard>(list, favoritesCursor);
				if (data !== requestedView || !activityOpen) return;
				favorites = mergePage(favorites, page.items, (item) => item.lineage.id);
				favoritesCursor = page.nextCursor;
			}
		} catch (error) {
			if (data === requestedView) notice = m.perfil_load_error();
			console.error('Perfil page failed', error instanceof Error ? error.message : 'unknown');
		} finally {
			if (data === requestedView) loading = false;
		}
	}
</script>

<svelte:head
	><title>{m.perfil_meta_title({ name: profile.displayUsername })} · open-auri</title><meta
		name="description"
		content={m.perfil_meta_description({ name: profile.displayUsername })}
	/>{#if !libraryOpen}<meta name="robots" content="noindex" />{/if}</svelte:head
>

<div class="room" data-page="biblioteca">
	<LazyArt load={() => import('#lib/components/art/PerfilArt.svelte')} />
	{#if profileLoading}
		<section
			class="profile-loading"
			aria-label={m.fux_p9_loading()}
			aria-busy="true"
			data-testid="profile-loading"
		>
			<div class="hero skeleton-header">
				<Skeleton width="12ch" height="var(--fs-eyebrow)" />
				<Skeleton width="min(18ch, 100%)" height="var(--fs-display-l)" />
				<Skeleton width="12ch" height="var(--fs-body)" />
				<Skeleton width="min(48ch, 100%)" height="calc(var(--fs-body) * 3)" />
			</div>
			<div class="strips skeleton-grid">
				{#each [0, 1, 2, 3] as slot (slot)}
					<div class="skeleton-record" aria-hidden="true">
						<div class="skeleton-disc"><Skeleton width="100%" height="100%" radius="50%" /></div>
						<Skeleton width="75%" height="var(--fs-title)" />
						<Skeleton width="100%" height="calc(var(--fs-body) * 5)" />
						<Skeleton width="100%" height="var(--hit)" />
					</div>
				{/each}
			</div>
		</section>
	{:else if !$hidden.ready || authorHidden}
		<p role="status">{$hidden.ready ? m.hidden_content() : m.hidden_loading()}</p>
		<HiddenItems />
	{:else}
		<section class="hero" aria-labelledby="{id}-title">
			<div class="caps">{m.perfil_eyebrow()}</div>
			<h1 class="h-display-l" id="{id}-title">{profile.displayUsername}</h1>
			<svg class="signature" viewBox="0 0 240 30" aria-hidden="true" fill="none">
				<path d="M4 21C43 4 86 6 139 11S208 18 234 5M76 21C125 15 174 17 218 23" />
			</svg>
			<p class="handle">@{profile.username}</p>
			<HideActions author={profileAuthorId} authorName={profile.displayUsername} />
			<ReportAction
				subject={{ kind: 'user', id: profile.username }}
				name={profile.displayUsername}
			/>
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
			<Panel><p class="closed" data-testid="library-private">{m.perfil_library_private()}</p></Panel
			>
		{:else}
			<Panel class="collection" aria-labelledby="{id}-creations">
				<div class="section-head">
					<h2 id="{id}-creations">{m.perfil_creations()}</h2>
					<span class="caps" aria-live="polite">{m.perfil_shown({ count: shown.length })}</span>
				</div>
				<p class="collection-note">{m.fux_p9_collection_note()}</p>
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
					<p class="ab-note">{m.fux_p9_ab_note()} <Explainer term="ab-nivel" /></p>
					<!-- Pause keeps the comparison (side, trims, position); a record's stop ends it. -->
					<Transport
						engine={app?.audio ?? null}
						variant="compact"
						session={PERFIL_SESSION}
						onplay={playingItem ? () => listen(playingItem, side ?? 'B') : undefined}
					/>
				{/if}
				{#if creations.length === 0}
					<div data-testid="creations-empty">
						<EmptyState
							title={m.fux_p9_empty_title()}
							why={m.fux_p9_empty_why()}
							explainHref="/docs"
						>
							{#snippet illustration()}
								<svg viewBox="0 0 128 96" width="128" height="96" fill="none" stroke="currentColor">
									<rect x="3" y="3" width="122" height="90" rx="6" stroke-dasharray="3 5" />
									<circle cx="64" cy="48" r="34" /><circle cx="64" cy="48" r="28" />
									<circle cx="64" cy="48" r="14" /><circle cx="64" cy="48" r="3" />
								</svg>
							{/snippet}
							{#snippet action()}
								<Button variant="primary" onclick={() => goto('/comunidade')}>
									{m.fux_p9_explore()}
								</Button>
							{/snippet}
						</EmptyState>
					</div>
				{:else if shown.length === 0}
					<div class="empty">
						<p data-testid="creations-no-match">{m.perfil_no_match()}</p>
						<Button
							onclick={() => {
								query = '';
								license = 'all';
							}}>{m.perfil_clear()}</Button
						>
					</div>
				{:else}
					<div class="strips">
						{#each shown as item, index (item.id)}
							<ProfileRecord
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
					<Button class="more" {loading} onclick={() => more('lineages')}
						>{m.perfil_load_more()}</Button
					>
				{/if}
			</Panel>

			<Panel class="packs" aria-labelledby="{id}-packs">
				<h2 id="{id}-packs">{m.perfil_packs()}</h2>
				{#if packs.length === 0}
					<p class="empty" data-testid="packs-empty">{m.perfil_packs_empty()}</p>
				{:else}
					<ul>
						{#each packs as pack (pack.id)}
							<li>
								<strong>{pack.name}</strong>
								<ReportAction subject={{ kind: 'pack', id: pack.id }} name={pack.name} />
								{#if pack.description}<span class="pack-description">{pack.description}</span>{/if}
								<small>{formatDate(pack.updatedAt, locale)}</small>
							</li>
						{/each}
					</ul>
				{/if}
				{#if packsCursor}
					<Button class="more" {loading} onclick={() => more('packs')}
						>{m.perfil_load_more()}</Button
					>
				{/if}
			</Panel>

			{#if activityOpen && data.favorites !== null}
				<Panel class="favorites" aria-labelledby="{id}-favorites">
					<h2 id="{id}-favorites">{m.perfil_favorites()}</h2>
					{#if favorites.length === 0}
						<p class="empty" data-testid="favorites-empty">{m.perfil_favorites_empty()}</p>
					{:else}
						<ul>
							{#each shownFavorites as favorite (favorite.lineage.id)}
								<li>
									<strong lang={favorite.lineage.lang}>{favorite.lineage.name}</strong>
									{#if favorite.lineage.author}<span
											>{m.perfil_by()} {favorite.lineage.author.displayUsername}</span
										>{/if}
									<small>{formatDate(favorite.at, locale)}</small>
									<HideActions
										lineageId={favorite.lineage.id}
										author={authorHiddenId(favorite.lineage.author)}
										curveName={favorite.lineage.name}
										authorName={favorite.lineage.author?.displayUsername}
									/>
								</li>
							{/each}
						</ul>
					{/if}
					{#if favoritesCursor}
						<Button class="more" {loading} onclick={() => more('favorites')}
							>{m.perfil_load_more()}</Button
						>
					{/if}
				</Panel>
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
	{/if}
</div>

<style>
	.room {
		--face-engrave: var(--cond);
		/* Holds the art layer (PerfilArt) under the content. */
		position: relative;
		isolation: isolate;
		display: grid;
		gap: var(--space-5);
		padding: 0 var(--gutter) var(--space-7);
		color: var(--text);
		background: linear-gradient(180deg, var(--ink-2), transparent 28rem), var(--ink);
		font: var(--fs-body) / var(--lh-body) var(--face-body);
	}
	.caps {
		font: 500 var(--fs-eyebrow) / var(--lh-caps) var(--face-data);
		letter-spacing: var(--tracking-eyebrow);
		text-transform: uppercase;
		color: var(--accent-text);
	}
	.hero {
		position: relative;
		padding: var(--space-7) 0 var(--space-5);
	}
	h1 {
		margin: var(--space-3) 0 0;
		overflow-wrap: anywhere;
	}
	.signature {
		display: block;
		width: min(15rem, 65%);
		height: var(--space-6);
		color: var(--accent);
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
	}
	.handle {
		margin: var(--space-1) 0 0;
		color: var(--text-2);
	}
	.bio {
		max-width: 64ch;
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.counts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-5);
		margin: var(--space-5) 0 0;
	}
	.counts div {
		display: flex;
		flex-direction: column-reverse;
		gap: var(--space-1);
	}
	.counts dt {
		font-size: var(--fs-small);
		color: var(--muted);
	}
	.counts dd {
		margin: 0;
		color: var(--text);
		font: 500 var(--fs-readout-l) / var(--lh-readout) var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.closed,
	.empty {
		max-width: 64ch;
		color: var(--text-2);
	}
	.section-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	h2 {
		margin: 0 0 var(--space-3);
		font: 400 var(--fs-title) / var(--lh-title) var(--face-display);
		letter-spacing: var(--tracking-title);
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		margin-bottom: var(--space-3);
	}
	.controls label {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
		font-size: var(--fs-ui);
		color: var(--text-2);
		flex: 1 1 12rem;
	}
	.controls input,
	.controls select {
		width: 100%;
		min-height: var(--hit);
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-md);
		color: var(--text);
		background: var(--ink);
		font: inherit;
	}
	.collection-note,
	.ab-note {
		max-width: 72ch;
		margin: 0 0 var(--space-5);
		font-size: var(--fs-small);
		color: var(--text-2);
	}
	.strips {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
		gap: var(--space-5);
		padding: var(--space-5) 0;
	}
	ul {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-3) var(--space-4);
		border-left: 2px solid var(--accent);
		background: var(--ink-2);
		overflow-wrap: anywhere;
	}
	.pack-description {
		white-space: pre-line;
		color: var(--text-2);
	}
	small {
		color: var(--muted-hi);
	}
	.room :global(.more) {
		margin-top: var(--space-4);
	}
	.homage {
		max-width: 72ch;
		margin-top: var(--space-6);
		padding: var(--space-5) 0;
		border-top: 1px solid var(--rule);
	}
	.homage h2 {
		margin-top: var(--space-2);
		font-size: var(--fs-honoree);
	}
	.sources a {
		color: var(--accent-text);
	}
	.notice:empty {
		display: none;
	}
	.notice {
		margin-top: var(--space-4);
		color: var(--accent-text);
	}
	.skeleton-header,
	.skeleton-record {
		display: grid;
		gap: var(--space-4);
	}
	.skeleton-grid {
		padding: var(--panel-pad);
	}
	.skeleton-record {
		padding: var(--space-4);
	}
	.skeleton-disc {
		width: 100%;
		aspect-ratio: 1;
	}
</style>
