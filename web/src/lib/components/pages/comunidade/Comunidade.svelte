<!--
	Comunidade `/comunidade` (T4.13, FUX.P4; homage to Bob Clearmountain): the live console of
	published curves (feed by channels: recent, most favorited and most installed per 7d / 30d /
	all), the master scope with A/B, Total Recall for owners, "NO AR / Publicar" with the server
	gate, the blind panels (anonymous preference, blind trade, "Comunidade prefere") and, with less
	weight, drawers for sharing, packs and reports (spec §1.5, T13).

	Safety (plan §0.12): nothing here writes to a cable; "Gravar no cabo" hands a copy of the curve to
	`app.requestWrite`, which opens the checklist (gesture + browser gate). Channel LEDs exist only
	while that channel really plays (real meter tap); no decorative meters, no meter skeleton. User
	text is only interpolated. Without an account browsing and listening work; ONE account card
	says what needs an account (T9) and each social action says why it is unavailable (T8). Offline
	or with the API down the page stays usable and says so. `app` is null until the layout mounts
	the runtime (FUX.2): everything that needs it degrades with a reason, never an error.

	Loading (spec §5.3 L6): the Turnstile widget and the QR module are imported on demand (after
	the consent / when the drawer opens); the share, packs and report drawers mount their panels
	only when opened; FUX.B: those three panels are their own chunks, warmed on hover or focus of
	the drawer and loaded when it opens (a skeleton holds the drawer meanwhile).
-->
<script module lang="ts">
	import { LazyModule } from '#lib/app/lazy.svelte.ts';

	const sharePanel = new LazyModule(() => import('./SharePanel.svelte'));
	const packsPanel = new LazyModule(() => import('./PacksPanel.svelte'));
	const reportPanel = new LazyModule(() => import('./ReportPanel.svelte'));
</script>

<script lang="ts">
	import './comunidade.css';
	import { onDestroy, untrack } from 'svelte';
	import { OFFICIAL_PRESETS } from 'open-auri/catalog';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import type { MeterTap, TapOptions } from '#lib/audio/meters.ts';
	import ComunidadeArt from '#lib/components/art/ComunidadeArt.svelte';
	import {
		Tour,
		TourTrigger,
		tour,
		type TourController
	} from '#lib/components/comprehension/index.ts';
	import Button from '#lib/components/primitives/Button.svelte';
	import EmptyState from '#lib/components/primitives/EmptyState.svelte';
	import Lamp from '#lib/components/primitives/Lamp.svelte';
	import Skeleton from '#lib/components/primitives/Skeleton.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { checkedCurve, type CurrentCurve } from '#lib/state/model.ts';
	import {
		isSocialApiError,
		rememberOrigin,
		type LibraryItem,
		type PublishedInfo,
		type SocialApi,
		type SocialOutbox
	} from '#lib/social/index.ts';
	import ChannelStrip from './ChannelStrip.svelte';
	import ExampleStrip from './ExampleStrip.svelte';
	import LoginPrompt from './LoginPrompt.svelte';
	import MasterScope from './MasterScope.svelte';
	import OnAir from './OnAir.svelte';
	import PrefersPanel from './PrefersPanel.svelte';
	import S6Panel from './S6Panel.svelte';
	import S7Panel from './S7Panel.svelte';
	import TotalRecall from './TotalRecall.svelte';
	import { createListener } from './listener.svelte.ts';
	import {
		FEED_PAGE_SIZE,
		FEED_SORTS,
		FEED_WINDOWS,
		browserStorage,
		channelOf,
		encodeCurve,
		errorText,
		isUnreachable,
		type Channel,
		type DecodedCurve,
		type FeedSortKey,
		type FeedWindowKey,
		type ReceiptStorage,
		type SessionView
	} from './model.ts';

	const SELECT_MAX = 4;
	/** Skeleton strips while the first feed page loads (spec §5.5). */
	const SKELETON_SLOTS = [1, 2, 3, 4, 5, 6] as const;
	/** Empty console: three official presets drawn as EXAMPLE strips (spec §4.4). */
	const EXAMPLES = OFFICIAL_PRESETS.slice(0, 3).map((preset) => ({
		id: preset.id,
		name: preset.label,
		curve: { preampDb: preset.preampDb, bands: preset.bands }
	}));

	let {
		app = null,
		api,
		session,
		outbox = null,
		siteKey = '',
		signupOpen = true,
		tourController = tour,
		remember = rememberOrigin,
		storage = browserStorage(),
		tap,
		isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false
	}: {
		app?: ClientApp | null;
		api: SocialApi;
		session: SessionView;
		/** Activity outbox (the layout's SocialSync flushes it). */
		outbox?: Pick<SocialOutbox, 'enqueue'> | null;
		siteKey?: string;
		/** Sign-up state for the account card; the prerendered page shows the open variant. */
		signupOpen?: boolean;
		/** Guided tour controller (tests inject one that never auto-opens). */
		tourController?: TourController;
		remember?: typeof rememberOrigin;
		storage?: ReceiptStorage | null;
		tap?: (node: AudioNode, options?: TapOptions) => Promise<MeterTap>;
		isOnline?: () => boolean;
	} = $props();

	const id = $props.id();
	const locale = $derived(getLocale());

	// ---- Header legend: the door of the guided tour ------------------------------------------------

	const facts = $derived([
		{
			key: 'channel',
			label: m.comunidade_fact_channel(),
			text: m.comunidade_fact_channel_text(),
			step: 0
		},
		{ key: 'solo', label: 'SOLO / SEL', text: m.comunidade_fact_solo_text(), step: 1 },
		{ key: 'recall', label: 'Total Recall', text: m.comunidade_fact_recall_text(), step: 1 },
		{
			key: 'onair',
			label: m.comunidade_fact_onair(),
			text: m.comunidade_fact_onair_text(),
			step: 2
		}
	]);

	function openTour(step: number) {
		tourController.open('comunidade');
		tourController.goTo(step);
	}

	// ---- Connectivity -----------------------------------------------------------------------------

	let online = $state(true);
	$effect(() => {
		online = isOnline();
		const update = () => {
			online = isOnline();
		};
		window.addEventListener('online', update);
		window.addEventListener('offline', update);
		return () => {
			window.removeEventListener('online', update);
			window.removeEventListener('offline', update);
		};
	});

	// ---- Feed -------------------------------------------------------------------------------------

	let sort = $state<FeedSortKey>('new');
	let feedWindow = $state<FeedWindowKey>('7d');
	let channels = $state.raw<Channel[]>([]);
	let cursor = $state<string | null>(null);
	let feedStatus = $state<'loading' | 'ready' | 'offline' | 'error'>('loading');
	let feedError = $state('');
	let loadingMore = $state(false);
	let generation = 0;
	/** The server signal lamp: lit only while the feed really answered and the network is up. */
	const feedLive = $derived(online && feedStatus === 'ready');

	async function loadFeed(
		nextSort: FeedSortKey,
		nextWindow: FeedWindowKey,
		after: string | null
	): Promise<void> {
		const token = ++generation;
		if (after === null) feedStatus = 'loading';
		else loadingMore = true;
		try {
			const page = await api.feed({
				sort: nextSort,
				...(nextSort === 'new' ? {} : { window: nextWindow }),
				cursor: after,
				limit: FEED_PAGE_SIZE
			});
			if (token !== generation) return;
			const fresh = page.items.map(channelOf);
			channels = after === null ? fresh : [...channels, ...fresh];
			cursor = page.nextCursor;
			feedStatus = 'ready';
		} catch (error) {
			if (token !== generation) return;
			if (after !== null) {
				notice = errorText(error);
			} else if (isUnreachable(error)) {
				feedStatus = 'offline';
			} else {
				feedStatus = 'error';
				feedError = errorText(error);
			}
		} finally {
			if (token === generation) loadingMore = false;
		}
	}

	$effect(() => {
		const nextSort = sort;
		const nextWindow = feedWindow;
		const connected = online;
		untrack(() => {
			if (!connected && channels.length > 0) return;
			void loadFeed(nextSort, nextWindow, null);
		});
	});

	function sortLabel(value: FeedSortKey): string {
		if (value === 'new') return m.comunidade_sort_new();
		return value === 'favorites' ? m.comunidade_sort_favorites() : m.comunidade_sort_installs();
	}

	function windowLabel(value: FeedWindowKey): string {
		if (value === '7d') return m.comunidade_window_7d();
		return value === '30d' ? m.comunidade_window_30d() : m.comunidade_window_all();
	}

	/** "Publicar a curva do editor" (empty console): go to the publishing desk and focus it. */
	function goPublish(event: MouseEvent) {
		const desk = document.getElementById('publicar');
		if (!desk) return;
		event.preventDefault();
		const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		desk.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
		const field = desk.querySelector<HTMLInputElement>('input:not(:disabled)');
		(field ?? desk).focus({ preventScroll: true });
	}

	// ---- Editor curve, audio and origins ----------------------------------------------------------

	let notice = $state('');
	const editorCurve = $derived(app ? app.state.curve.current : null);
	const editor = $derived<DecodedCurve | null>(
		editorCurve ? { preampDb: editorCurve.preampDb, bands: editorCurve.bands } : null
	);
	const editorS1 = $derived(editor ? encodeCurve(editor) : null);
	let onAirS1 = $state<string | null>(null);

	const listener = createListener({
		engine: () => app?.audio ?? null,
		onPreviewed: (lineageId, durationMs) => {
			// Only a signed-in, verified listener's preview is activity; anonymous listening is never
			// stored for a later account (the outbox refuses it as well).
			if (!outbox || !session.signedIn || !session.verified) return;
			void outbox.enqueue({ kind: 'previewed', lineageId, durationMs }).then((result) => {
				if (!result.ok && result.reason !== 'signed-out' && result.reason !== 'unverified') {
					console.warn(
						JSON.stringify({ event: 'comunidade.previewed_not_queued', reason: result.reason })
					);
				}
			});
		}
	});
	onDestroy(() => listener.stop());

	function recordOrigin(channel: Channel) {
		void remember({
			s1: channel.s1,
			lineageId: channel.lineageId,
			versionId: channel.versionId
		});
	}

	async function listen(channel: Channel) {
		if (listener.owner === 'channel' && listener.isPlaying(channel.lineageId)) {
			listener.stop();
			return;
		}
		if (!app || !editor || !channel.curve) {
			notice = m.comunidade_audio_unavailable();
			return;
		}
		notice = '';
		try {
			await listener.play({
				a: { lineageId: null, curve: editor },
				b: { lineageId: channel.lineageId, curve: channel.curve },
				initial: 'B',
				owner: 'channel'
			});
			recordOrigin(channel);
		} catch (error) {
			notice = m.comunidade_audio_error();
			console.warn(
				JSON.stringify({
					event: 'comunidade.listen_failed',
					error: error instanceof Error ? error.name : 'unknown'
				})
			);
		}
	}

	// ---- Selection (SEL → master scope) -----------------------------------------------------------

	let selected = $state.raw<Channel[]>([]);
	const target = $derived(selected[0] ?? null);

	function toggleSelect(channel: Channel) {
		if (selected.some((item) => item.lineageId === channel.lineageId)) {
			selected = selected.filter((item) => item.lineageId !== channel.lineageId);
			return;
		}
		selected = [channel, ...selected].slice(0, SELECT_MAX);
		recordOrigin(channel);
	}

	function curveOf(channel: Channel): CurrentCurve | null {
		if (!channel.curve) return null;
		try {
			return checkedCurve({
				schema: 1,
				name: channel.name,
				source: `community:${channel.lineageId}`,
				preampDb: channel.curve.preampDb,
				bands: channel.curve.bands,
				updatedAt: Date.now()
			});
		} catch (error) {
			console.warn(
				JSON.stringify({
					event: 'comunidade.curve_invalid',
					error: error instanceof Error ? error.name : 'unknown'
				})
			);
			return null;
		}
	}

	function useCurve(channel: Channel) {
		const curve = curveOf(channel);
		if (!app || !curve) {
			notice = m.comunidade_audio_unavailable();
			return;
		}
		recordOrigin(channel);
		app.state.curve.update({
			name: curve.name,
			source: curve.source,
			preampDb: curve.preampDb,
			bands: curve.bands
		});
		notice = m.comunidade_used({ name: channel.name });
	}

	function install(channel: Channel) {
		const curve = curveOf(channel);
		if (!app || !curve) {
			notice = m.comunidade_install_unavailable();
			return;
		}
		recordOrigin(channel);
		listener.stop();
		// Opens the pre-write checklist only; its confirmation writes (and the gate runs again).
		app.requestWrite(curve);
	}

	// ---- The signed-in user's creations (Total Recall, S7) ---------------------------------------

	let owned = $state.raw<LibraryItem[]>([]);

	async function loadOwned() {
		try {
			const page = await api.myLibrary({ shelf: 'created', limit: 100 });
			owned = page.items;
		} catch (error) {
			owned = [];
			console.warn(
				JSON.stringify({
					event: 'comunidade.owned_failed',
					code: isSocialApiError(error)
						? error.code
						: error instanceof Error
							? error.name
							: 'unknown'
				})
			);
		}
	}

	$effect(() => {
		if (session.signedIn && online) void loadOwned();
		else owned = [];
	});

	const ownedList = $derived(owned.map((item) => ({ id: item.id, name: item.head.name })));
	const preferredRecall = $derived(
		target &&
			target.author &&
			session.nickname &&
			target.author.username.toLowerCase() === session.nickname.toLowerCase()
			? target.lineageId
			: null
	);

	function published(info: PublishedInfo, s1: string) {
		onAirS1 = s1;
		void remember({ s1, lineageId: info.lineageId, versionId: info.versionId });
		void loadOwned();
		if (sort === 'new') void loadFeed(sort, feedWindow, null);
	}

	// ---- Drawers (mounted only when opened: QR, Turnstile and their requests wait for the gesture)

	let shareOpen = $state(false);
	let packsOpen = $state(false);
	let reportOpen = $state(false);
	/** A drawer chunk that could not load (offline before it was cached): say so; retried on reopen. */
	function drawerFailed(error: unknown): void {
		console.error('A Comunidade drawer could not load', error);
		notice = m.layout_error_generic();
	}
</script>

{#snippet emptyDesk()}
	<svg viewBox="0 0 96 64" width="96" height="64" fill="none" stroke="currentColor">
		<rect x="4" y="6" width="88" height="52" rx="4" stroke-width="1.5" opacity=".6" />
		<path d="M22 14v36M48 14v36M74 14v36" stroke-width="1.5" />
		<rect x="15" y="34" width="14" height="7" rx="1.5" stroke-width="1.5" />
		<rect x="41" y="22" width="14" height="7" rx="1.5" stroke-width="1.5" />
		<rect x="67" y="40" width="14" height="7" rx="1.5" stroke-width="1.5" />
	</svg>
{/snippet}

<div class="oa-comunidade">
	<ComunidadeArt />
	<Tour page="comunidade" controller={tourController} />

	<section class="hero" aria-labelledby="{id}-title">
		<div class="hero-copy">
			<p class="eyebrow kicker">{m.comunidade_kicker()}</p>
			<h1 id="{id}-title" class="h-display-xl">{m.comunidade_title()}</h1>
			<p class="lede hero-lede">{m.comunidade_lede()}</p>
			<div class="hero-actions">
				<TourTrigger page="comunidade" controller={tourController} />
			</div>
		</div>
		<div class="legend">
			<p class="legend-hint" id="{id}-legend">{m.comunidade_v2_legend_hint()}</p>
			<ul class="facts" aria-labelledby="{id}-legend">
				{#each facts as fact (fact.key)}
					<li>
						<button
							type="button"
							class="fact"
							aria-haspopup="dialog"
							data-testid="legend-{fact.key}"
							onclick={() => openTour(fact.step)}
							><b>{fact.label}</b><span>{fact.text}</span></button
						>
					</li>
				{/each}
			</ul>
		</div>
	</section>

	<div class="desk">
		{#if !online}
			<p class="offline-banner" role="status">{m.comunidade_offline()}</p>
		{/if}

		<section class="console" aria-labelledby="{id}-console" data-tour="comunidade-channels">
			<div class="console-head">
				<h2 id="{id}-console" class="plate-title">{m.comunidade_console_title()}</h2>
				<span class="signal" data-testid="feed-signal" data-on={feedLive}>
					<Lamp on={feedLive} tone="ok" label={m.comunidade_v2_feed_lamp()} />
					<span class="signal-txt" aria-hidden="true">{m.comunidade_v2_feed_lamp()}</span>
				</span>
				<div class="push-group" role="group" aria-label={m.comunidade_sort_label()}>
					{#each FEED_SORTS as value (value)}
						<button
							type="button"
							class="push"
							aria-pressed={sort === value}
							onclick={() => (sort = value)}>{sortLabel(value)}</button
						>
					{/each}
				</div>
				{#if sort !== 'new'}
					<div class="push-group" role="group" aria-label={m.comunidade_window_label()}>
						{#each FEED_WINDOWS as value (value)}
							<button
								type="button"
								class="push"
								aria-pressed={feedWindow === value}
								onclick={() => (feedWindow = value)}>{windowLabel(value)}</button
							>
						{/each}
					</div>
				{/if}
				<span class="head-spacer"></span>
				<span
					class="mini-tally"
					class:lit={onAirS1 !== null && onAirS1 === editorS1}
					aria-hidden="true">{m.comunidade_onair_lamp()}</span
				>
			</div>
			<div class="bank-wrap">
				{#if feedStatus === 'loading' && channels.length === 0}
					<div class="bank skel-bank" role="status" aria-busy="true" data-testid="feed-loading">
						<span class="sr-only">{m.comunidade_loading()}</span>
						{#each SKELETON_SLOTS as slot (slot)}
							<span class="skel-strip" aria-hidden="true">
								<!-- The meter bridge stays a static dark well: meters never get an
								     animated skeleton (plan §3.6). -->
								<span class="skel-bridge"></span>
								<span class="skeleton skel-face"></span>
							</span>
						{/each}
					</div>
				{:else if feedStatus === 'offline' && channels.length === 0}
					<p class="bank-state" role="status" data-testid="feed-offline">
						{m.comunidade_feed_offline()}
					</p>
				{:else if feedStatus === 'error' && channels.length === 0}
					<div class="bank-state" role="alert">
						<p>{feedError}</p>
						<Button onclick={() => loadFeed(sort, feedWindow, null)}>{m.comunidade_retry()}</Button>
					</div>
				{:else if channels.length === 0 && sort === 'new'}
					<div class="empty-desk" data-testid="feed-empty">
						<EmptyState
							level={3}
							class="desk-empty"
							title={m.empty_community_title()}
							why={m.comunidade_v2_empty_why()}
							illustration={emptyDesk}
						>
							{#snippet action()}
								<a class="btn btn--primary btn--md" href="#publicar" onclick={goPublish}
									>{m.empty_community_action()}</a
								>
							{/snippet}
						</EmptyState>
						<ol class="bank examples" aria-label={m.comunidade_v2_examples_label()}>
							{#each EXAMPLES as example, index (example.id)}
								<ExampleStrip name={example.name} curve={example.curve} number={index + 1} />
							{/each}
						</ol>
					</div>
				{:else if channels.length === 0}
					<p class="bank-state" data-testid="feed-empty">{m.comunidade_feed_empty_ranking()}</p>
				{:else}
					<ol class="bank" aria-label={m.comunidade_console_title()}>
						{#each channels as channel, index (channel.lineageId)}
							<ChannelStrip
								{channel}
								number={index + 1}
								playing={listener.isPlaying(channel.lineageId)}
								chain={listener.chainOf(channel.lineageId)}
								selected={selected.some((item) => item.lineageId === channel.lineageId)}
								disabled={listener.busy}
								{tap}
								onlisten={listen}
								onselect={toggleSelect}
							/>
						{/each}
					</ol>
				{/if}
			</div>
			<div class="armrest" aria-hidden="true"><span>MESA A · 1985</span></div>
		</section>
		<div class="bank-count">
			{#if channels.length > 0}
				<span aria-live="polite"
					>{m.comunidade_channel_count({ count: String(channels.length) })}</span
				>
			{/if}
			{#if cursor && feedStatus === 'ready'}
				<Button
					size="sm"
					loading={loadingMore}
					disabledReason={online ? null : m.comunidade_offline()}
					onclick={() => loadFeed(sort, feedWindow, cursor)}>{m.comunidade_load_more()}</Button
				>
			{/if}
			<span class="leds-note">{m.comunidade_leds_note()}</span>
		</div>
		<p class="page-notice" role="status">{notice}</p>

		<section class="centre" aria-label={m.comunidade_centre_label()}>
			<div class="centre-grid">
				<MasterScope
					{selected}
					{editor}
					{listener}
					{locale}
					canListen={app !== null}
					onnotice={(message) => (notice = message)}
					onuse={useCurve}
					oninstall={install}
					onopen={recordOrigin}
				/>
				{#if session.signedIn}
					<TotalRecall
						{api}
						owned={ownedList}
						preferred={preferredRecall}
						canWrite={session.verified}
						{online}
						onrestored={() => void loadOwned()}
					/>
				{:else}
					<div class="recall-anon">
						<h2>{m.comunidade_recall_title()}</h2>
						<div class="recall-off">
							<p>{m.comunidade_recall_owner_only()}</p>
						</div>
					</div>
				{/if}
			</div>
		</section>

		{#if session.known && !session.verified}
			<LoginPrompt signedIn={session.signedIn} {signupOpen} />
		{/if}

		<OnAir
			{api}
			{session}
			{editor}
			editorName={editorCurve?.name ?? ''}
			{online}
			onpublished={published}
		/>

		<div class="blind" data-tour="comunidade-blind">
			<p class="eyebrow blind-eyebrow">{m.comunidade_v2_blind_eyebrow()}</p>
			<S6Panel
				{api}
				channels={selected}
				{listener}
				canListen={app !== null}
				{siteKey}
				{online}
				{storage}
				onnotice={(message) => (notice = message)}
			/>
			<div class="pair-grid">
				<S7Panel
					{api}
					{session}
					{owned}
					{editor}
					{listener}
					canListen={app !== null}
					{online}
					onnotice={(message) => (notice = message)}
				/>
				<PrefersPanel {api} {channels} {online} />
			</div>
		</div>

		<section class="tools" aria-labelledby="{id}-tools">
			<div class="tools-head">
				<h2 id="{id}-tools" class="tools-title">{m.comunidade_v2_tools_title()}</h2>
				<p class="tools-lede">{m.comunidade_v2_tools_lede()}</p>
			</div>
			<!-- FUX.B: `toggle` fires for the reader's press and for programmatic opens alike. -->
			<details
				class="drawer disclosure"
				bind:open={shareOpen}
				data-testid="drawer-share"
				ontoggle={(event) => event.currentTarget.open && sharePanel.request(drawerFailed)}
			>
				<summary onpointerenter={() => sharePanel.request()} onfocus={() => sharePanel.request()}
					><span class="drawer-title">{m.comunidade_share_title()}</span><span class="drawer-lede"
						>{m.comunidade_share_lede()}</span
					></summary
				>
				{#if shareOpen}
					{#if sharePanel.current}
						{@const SharePanel = sharePanel.current}
						<SharePanel {api} {session} channel={target} {online} />
					{:else}
						<Skeleton width="100%" height="12rem" />
					{/if}
				{/if}
			</details>
			<details
				class="drawer disclosure"
				bind:open={packsOpen}
				data-testid="drawer-packs"
				ontoggle={(event) => event.currentTarget.open && packsPanel.request(drawerFailed)}
			>
				<summary onpointerenter={() => packsPanel.request()} onfocus={() => packsPanel.request()}
					><span class="drawer-title">{m.comunidade_packs_title()}</span><span class="drawer-lede"
						>{m.comunidade_packs_lede()}</span
					></summary
				>
				{#if packsOpen}
					{#if packsPanel.current}
						{@const PacksPanel = packsPanel.current}
						<PacksPanel {api} {session} {online} />
					{:else}
						<Skeleton width="100%" height="12rem" />
					{/if}
				{/if}
			</details>
			<details
				class="drawer disclosure"
				bind:open={reportOpen}
				data-testid="drawer-report"
				ontoggle={(event) => event.currentTarget.open && reportPanel.request(drawerFailed)}
			>
				<summary onpointerenter={() => reportPanel.request()} onfocus={() => reportPanel.request()}
					><span class="drawer-title">{m.comunidade_report_title()}</span><span class="drawer-lede"
						>{m.comunidade_report_lede()}</span
					></summary
				>
				{#if reportOpen}
					{#if reportPanel.current}
						{@const ReportPanel = reportPanel.current}
						<ReportPanel {api} {session} channel={target} {siteKey} {online} />
					{:else}
						<Skeleton width="100%" height="12rem" />
					{/if}
				{/if}
			</details>
		</section>
	</div>
</div>

<style>
	.hero {
		max-width: 1520px;
		margin: 0 auto;
		padding: var(--space-7) var(--space-6) var(--space-5);
		display: grid;
		grid-template-columns: 1.25fr 1fr;
		gap: var(--space-6);
		align-items: end;
	}
	.kicker {
		color: var(--text-2);
	}
	.hero h1 {
		margin-top: var(--space-2);
		font-style: italic;
		text-shadow: 0 8px 40px #000;
	}
	.hero-lede {
		max-width: 62ch;
		margin-top: var(--space-4);
		color: var(--text-2);
	}
	.hero-actions {
		margin-top: var(--space-4);
	}
	.legend-hint {
		margin-bottom: var(--space-2);
		color: var(--muted-hi);
		font-size: var(--fs-caption);
	}
	.facts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-2);
	}
	/* The legend plates are the door of the tour: a press opens it at the matching step. */
	.fact {
		display: block;
		box-sizing: border-box;
		width: 100%;
		height: 100%;
		min-height: var(--hit);
		padding: 9px 11px;
		border: 1px solid #000;
		border-radius: var(--rad-sm);
		background: linear-gradient(160deg, #2c2f33, #1f2124);
		box-shadow:
			inset 0 1px 0 #ffffff1a,
			0 4px 10px #0008;
		color: var(--text-2);
		font: var(--fs-caption) / var(--lh-small) var(--face-body);
		text-align: left;
		cursor: pointer;
		transition:
			transform var(--dur-fast) var(--ease-out),
			box-shadow var(--dur-fast) var(--ease-out);
	}
	.fact:hover {
		transform: translateY(-1px);
		box-shadow:
			inset 0 1px 0 #ffffff1a,
			var(--glow-1);
	}
	.fact:active {
		transform: translateY(1px);
		box-shadow: var(--well);
	}
	.fact:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}
	.fact b {
		display: block;
		margin-bottom: 3px;
		color: var(--accent-text);
		font: 600 var(--label-min) / var(--lh-caps) var(--face-body);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}
	.fact span {
		display: block;
	}
	.desk {
		max-width: 1540px;
		margin: 0 auto;
		padding: 0 18px var(--space-7);
	}
	.offline-banner {
		margin: 0 0 var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-left: 3px solid var(--amber);
		background: #ffb54714;
		color: #f6dcae;
		font-size: var(--fs-small);
	}
	/* The live console: the page's hero material, heavier than every panel below it. */
	.console {
		position: relative;
		padding: var(--space-3) var(--space-4) 0;
		border: 1px solid #000;
		border-radius: var(--rad-2xl) var(--rad-2xl) var(--rad-xl) var(--rad-xl);
		background: var(--console-metal);
		box-shadow:
			0 40px 80px #000d,
			inset 0 1px 0 #ffffff26,
			inset 0 -2px 0 #000a;
	}
	.console-head {
		display: flex;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
		padding: 6px 6px var(--space-3);
		border-bottom: 1px solid #0008;
		box-shadow: 0 1px 0 #ffffff10;
		margin-bottom: 10px;
	}
	.plate-title {
		color: #e4e0d6;
		font: 500 var(--fs-caption) / var(--lh-caps) var(--face-data);
		letter-spacing: 0.2em;
		text-transform: uppercase;
	}
	.signal {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border: 1px solid #000;
		border-radius: var(--rad-sm);
		background: #17181a;
		box-shadow: var(--well);
	}
	.signal-txt {
		color: var(--muted-hi);
		font: 500 var(--label-min) / 1 var(--face-data);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}
	.signal[data-on='true'] .signal-txt {
		color: var(--text);
	}
	.head-spacer {
		flex: 1;
	}
	.mini-tally {
		padding: 5px 10px;
		border: 1px solid #000;
		border-radius: var(--rad-sm);
		background: #251c14;
		box-shadow: inset 0 1px 3px #000;
		/* Unlit but legible (>= 4.5:1 on the dark lens). */
		color: #a8916f;
		font: 600 var(--label-min) / 1 var(--face-body);
		letter-spacing: 0.24em;
	}
	.mini-tally.lit {
		background: radial-gradient(circle, #ffe2a0, #ff9b2e 70%);
		color: #3a1d05;
		box-shadow: 0 0 18px #ff9b2e88;
	}
	.bank-wrap {
		overflow-x: auto;
		scrollbar-color: #555 #1a1b1c;
		min-height: 120px;
	}
	.bank {
		display: flex;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	/* Skeleton strips: the geometry of a channel strip (bridge + face), CLS zero. */
	.skel-strip {
		display: flex;
		flex: 0 0 104px;
		flex-direction: column;
		gap: var(--space-2);
		width: 104px;
		padding: 0 var(--space-1);
		box-sizing: border-box;
		border-right: 1px solid #0b0c0d;
	}
	.skel-bridge {
		display: block;
		height: 132px;
		border-radius: var(--rad-xs);
		background: linear-gradient(#111213, #1b1c1e);
		box-shadow: var(--well);
	}
	.skel-face {
		height: 330px;
	}
	.bank-state {
		display: grid;
		place-items: center;
		gap: 10px;
		min-height: 220px;
		margin: 0;
		padding: 20px;
		color: var(--amber);
		font: var(--fs-readout-l) var(--crt);
		text-align: center;
	}
	.bank-state p {
		margin: 0;
	}
	.empty-desk {
		display: flex;
		flex-wrap: wrap;
		align-items: stretch;
		gap: var(--space-5);
		padding: var(--space-3) 0;
	}
	.empty-desk :global(.desk-empty) {
		flex: 1 1 320px;
		align-content: center;
		background: #17181acc;
		box-shadow: var(--well);
	}
	.examples {
		flex: 0 0 auto;
		border-left: 1px solid #0b0c0d;
	}
	.armrest {
		height: 48px;
		margin: 0 calc(-1 * var(--space-4));
		border-radius: 0 0 var(--rad-xl) var(--rad-xl);
		background: radial-gradient(120% 160% at 50% -50%, #3d3029, #1b1512 62%);
		box-shadow:
			inset 0 2px 0 #ffffff14,
			inset 0 -8px 14px #000;
		position: relative;
	}
	.armrest span {
		position: absolute;
		right: 22px;
		bottom: 9px;
		color: #b39c88;
		font: 400 var(--label-min) var(--face-data);
		letter-spacing: var(--tracking-caps);
	}
	.bank-count {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
		margin: 10px 4px 0;
		color: var(--text-2);
		font: var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.leds-note {
		margin-left: auto;
	}
	.page-notice {
		margin: var(--space-2) 4px 0;
		color: #f6dcae;
		font: var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.page-notice:empty {
		display: none;
	}
	.centre {
		margin-top: var(--space-5);
		padding: 20px;
		border: 1px solid #000;
		border-radius: var(--rad-xl);
		background:
			radial-gradient(80% 60% at 10% 0, #ffffff0e, transparent 60%),
			linear-gradient(180deg, #303337, #232528);
		box-shadow:
			0 30px 60px #000c,
			inset 0 1px 0 #ffffff22;
	}
	.centre-grid {
		display: grid;
		grid-template-columns: 1.25fr 1fr;
		gap: 22px;
	}
	.recall-anon {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.recall-anon h2 {
		font: italic 400 var(--fs-title) / var(--lh-title) var(--face-display);
	}
	.recall-off {
		display: grid;
		place-items: center;
		min-height: 160px;
		padding: var(--space-4);
		border-radius: var(--rad-xl);
		background: radial-gradient(130% 100% at 50% 40%, #16120a, #070604 85%);
		box-shadow:
			inset 0 0 40px #000,
			inset 0 0 0 3px #2a2418;
		color: #d39a46;
		font: var(--fs-lede) / 1.25 var(--crt);
		text-align: center;
	}
	.blind {
		margin-top: var(--section-gap);
	}
	.blind-eyebrow {
		color: var(--text-2);
	}
	.pair-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0 22px;
	}
	/* Tools: lighter than the desk above (spec §1.5: they must not compete with what works). */
	.tools {
		display: grid;
		gap: var(--space-2);
		margin-top: var(--section-gap);
		padding-top: var(--space-5);
		border-top: 1px solid var(--rule);
	}
	.tools-head {
		display: grid;
		gap: var(--space-1);
		margin-bottom: var(--space-2);
	}
	.tools-title {
		font: italic 400 var(--fs-title) / var(--lh-title) var(--face-display);
	}
	.tools-lede {
		color: var(--muted);
		font-size: var(--fs-small);
	}
	.drawer {
		padding: var(--space-2) var(--space-4);
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-lg);
		background: #15161899;
	}
	.drawer > summary {
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px var(--space-3);
		width: 100%;
		padding: var(--space-1) 0;
	}
	.drawer-title {
		font: italic 400 var(--fs-lede) / var(--lh-title) var(--face-display);
	}
	.drawer-lede {
		flex: 1 1 320px;
		color: var(--muted);
		font: var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.drawer[open] {
		padding-bottom: var(--space-4);
		background: #1a1c1f;
	}
	@media (max-width: 1350px) {
		.centre-grid {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 1000px) {
		.hero {
			grid-template-columns: 1fr;
		}
		.pair-grid {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 640px) {
		.hero {
			padding: var(--space-6) 18px 18px;
		}
		.facts {
			grid-template-columns: 1fr;
		}
		.desk {
			padding: 0 10px var(--space-6);
		}
		.leds-note {
			margin-left: 0;
		}
	}
</style>
