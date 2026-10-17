<!--
	Comunidade `/comunidade` (T4.13, homage to Bob Clearmountain): the console of published curves
	(feed by channels: recent, most favorited and most installed per 7d / 30d / all), the master
	scope with A/B, Total Recall for owners, "NO AR / Publicar" with the server gate, and the share,
	S6, S7, packs, report and "Comunidade prefere" panels.

	Safety (plan §0.12): nothing here writes to a cable; "Gravar no cabo" hands a copy of the curve to
	`app.requestWrite`, which opens the checklist (gesture + browser gate). Channel LEDs exist only
	while that channel really plays (real meter tap); no decorative meters. User text is only
	interpolated. Without an account browsing and listening work; social actions show the sign-in
	prompt. Offline or with the API down the page stays usable and says so.
-->
<script lang="ts">
	import '@fontsource/permanent-marker/400.css';
	import '@fontsource/vt323/400.css';
	import './comunidade.css';
	import { onDestroy, untrack } from 'svelte';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import type { MeterTap, TapOptions } from '#lib/audio/meters.ts';
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
	import LoginPrompt from './LoginPrompt.svelte';
	import MasterScope from './MasterScope.svelte';
	import OnAir from './OnAir.svelte';
	import PacksPanel from './PacksPanel.svelte';
	import PrefersPanel from './PrefersPanel.svelte';
	import ReportPanel from './ReportPanel.svelte';
	import S6Panel from './S6Panel.svelte';
	import S7Panel from './S7Panel.svelte';
	import SharePanel from './SharePanel.svelte';
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

	let {
		app = null,
		api,
		session,
		outbox = null,
		siteKey = '',
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
		remember?: typeof rememberOrigin;
		storage?: ReceiptStorage | null;
		tap?: (node: AudioNode, options?: TapOptions) => Promise<MeterTap>;
		isOnline?: () => boolean;
	} = $props();

	const id = $props.id();
	const locale = $derived(getLocale());

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
</script>

<div class="oa-comunidade">
	<section class="hero" aria-labelledby="{id}-title">
		<div>
			<span class="kicker">{m.comunidade_kicker()}</span>
			<h1 id="{id}-title">{m.comunidade_title()}</h1>
			<p>{m.comunidade_lede()}</p>
		</div>
		<ul class="facts">
			<li><b>{m.comunidade_fact_channel()}</b><span>{m.comunidade_fact_channel_text()}</span></li>
			<li><b>SOLO / SEL</b><span>{m.comunidade_fact_solo_text()}</span></li>
			<li><b>Total Recall</b><span>{m.comunidade_fact_recall_text()}</span></li>
			<li><b>{m.comunidade_fact_onair()}</b><span>{m.comunidade_fact_onair_text()}</span></li>
		</ul>
	</section>

	<div class="desk">
		{#if !online}
			<p class="offline-banner" role="status">{m.comunidade_offline()}</p>
		{/if}

		<section class="console" aria-labelledby="{id}-console">
			<div class="console-head">
				<h2 id="{id}-console" class="plate-title">{m.comunidade_console_title()}</h2>
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
					<p class="bank-state" role="status">{m.comunidade_loading()}</p>
				{:else if feedStatus === 'offline' && channels.length === 0}
					<p class="bank-state" role="status" data-testid="feed-offline">
						{m.comunidade_feed_offline()}
					</p>
				{:else if feedStatus === 'error' && channels.length === 0}
					<div class="bank-state" role="alert">
						<p>{feedError}</p>
						<button type="button" class="btn" onclick={() => loadFeed(sort, feedWindow, null)}
							>{m.comunidade_retry()}</button
						>
					</div>
				{:else if channels.length === 0}
					<p class="bank-state" data-testid="feed-empty">
						{sort === 'new' ? m.comunidade_feed_empty() : m.comunidade_feed_empty_ranking()}
					</p>
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
			<span aria-live="polite"
				>{m.comunidade_channel_count({ count: String(channels.length) })}</span
			>
			{#if cursor && feedStatus === 'ready'}
				<button
					type="button"
					class="btn"
					disabled={loadingMore || !online}
					onclick={() => loadFeed(sort, feedWindow, cursor)}>{m.comunidade_load_more()}</button
				>
			{/if}
			<span>{m.comunidade_leds_note()}</span>
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
						<p class="note">{m.comunidade_recall_owner_only()}</p>
						<LoginPrompt signedIn={false} />
					</div>
				{/if}
			</div>
		</section>

		<OnAir
			{api}
			{session}
			{editor}
			editorName={editorCurve?.name ?? ''}
			{online}
			onpublished={published}
		/>
		<SharePanel {api} {session} channel={target} {online} />
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
			<PacksPanel {api} {session} {online} />
		</div>
		<div class="pair-grid">
			<ReportPanel {api} {session} channel={target} {siteKey} {online} />
			<PrefersPanel {api} {channels} {online} />
		</div>
	</div>
</div>

<style>
	.hero {
		max-width: 1520px;
		margin: 0 auto;
		padding: 40px 36px 24px;
		display: grid;
		grid-template-columns: 1.25fr 1fr;
		gap: 40px;
		align-items: end;
	}
	.kicker {
		font-size: 10px;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: #b9b4a8;
	}
	.hero h1 {
		font: italic 104px/0.88 var(--serif);
		letter-spacing: -0.035em;
		margin-top: 10px;
		text-shadow: 0 8px 40px #000;
	}
	.hero p {
		max-width: 600px;
		color: #d4cec2;
		font-size: 14px;
		line-height: 1.75;
		margin-top: 16px;
	}
	.facts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.facts li {
		font: 11px/1.5 var(--mono);
		color: #e4e0d6;
		padding: 9px 11px;
		background: linear-gradient(160deg, #2c2f33, #1f2124);
		border: 1px solid #000;
		box-shadow:
			inset 0 1px 0 #ffffff1a,
			0 4px 10px #0008;
	}
	.facts b {
		display: block;
		font: 500 11px var(--mono);
		color: #b9b4a8;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		margin-bottom: 3px;
	}
	.desk {
		max-width: 1540px;
		margin: 0 auto;
		padding: 0 18px 50px;
	}
	.offline-banner {
		margin: 0 0 12px;
		padding: 8px 12px;
		border-left: 3px solid var(--amber);
		background: #ffb54714;
		color: #f6dcae;
		font-size: 12.5px;
	}
	.console {
		position: relative;
		border-radius: 16px 16px 8px 8px;
		padding: 12px 16px 0;
		background:
			radial-gradient(90% 50% at 10% 0, #ffffff10, transparent 60%),
			linear-gradient(180deg, #3a3d41, #2a2c2f 6%, #25272a);
		border: 1px solid #000;
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
		padding: 6px 6px 12px;
		border-bottom: 1px solid #0008;
		box-shadow: 0 1px 0 #ffffff10;
		margin-bottom: 10px;
	}
	.plate-title {
		font: 600 12px var(--mono);
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: #e4e0d6;
	}
	.head-spacer {
		flex: 1;
	}
	.mini-tally {
		font: 700 11px var(--sans);
		letter-spacing: 0.24em;
		padding: 5px 10px;
		border-radius: 3px;
		background: #251c14;
		/* Unlit but legible (≥ 4.5:1 on the dark lens). */
		color: #a8916f;
		border: 1px solid #000;
		box-shadow: inset 0 1px 3px #000;
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
	.bank-state {
		display: grid;
		place-items: center;
		gap: 10px;
		min-height: 220px;
		margin: 0;
		padding: 20px;
		font: 22px var(--crt);
		color: var(--amber);
		text-align: center;
	}
	.bank-state p {
		margin: 0;
	}
	.armrest {
		height: 48px;
		margin: 0 -16px;
		border-radius: 0 0 8px 8px;
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
		font: 11px var(--mono);
		color: #b39c88;
		letter-spacing: 0.08em;
	}
	.bank-count {
		font: 12px var(--mono);
		color: #d6d2c8;
		margin: 10px 4px 0;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
	}
	.page-notice {
		margin: 8px 4px 0;
		font: 12px var(--mono);
		color: #f6dcae;
	}
	.page-notice:empty {
		display: none;
	}
	.centre {
		margin-top: 26px;
		padding: 20px;
		border-radius: 12px;
		background:
			radial-gradient(80% 60% at 10% 0, #ffffff0e, transparent 60%),
			linear-gradient(180deg, #303337, #232528);
		border: 1px solid #000;
		box-shadow:
			0 30px 60px #000c,
			inset 0 1px 0 #ffffff22;
	}
	.centre-grid {
		display: grid;
		grid-template-columns: 1.25fr 1fr;
		gap: 22px;
	}
	.recall-anon h2 {
		font: italic 30px/1 var(--serif);
		margin-bottom: 10px;
	}
	.recall-anon {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.pair-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0 22px;
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
		.hero h1 {
			font-size: 80px;
		}
		.pair-grid {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 640px) {
		.hero {
			padding: 28px 18px 18px;
		}
		.hero h1 {
			font-size: 62px;
		}
		.facts {
			grid-template-columns: 1fr;
		}
		.desk {
			padding: 0 10px 40px;
		}
	}
</style>
