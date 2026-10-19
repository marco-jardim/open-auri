<!--
	Shared-curve card of `/c/[id]` (T4.5), in the Biblioteca theme: the same tape box as the shelf
	cards and the same paper track sheet as the Biblioteca sheet (FUX.P1).
	Safety (plan §0.12): this page never writes to a cable. "Instalar" hands a plain copy of the
	curve to `app.requestWrite`, which opens the layout's PreWriteChecklist; only its explicit
	confirmation writes, and the transport re-runs the gate on the snapshot. "Abrir na Curva" is the
	`#p=<S1>` link, which works without the API. User text (name, description, nickname) is only
	rendered through `{text}` interpolation. Courier Prime (--type) comes from the global fonts.css.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { decodeS1 } from 'open-auri/share';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import type { ABPreview, AudioEngine, AudioEngineState } from '#lib/audio/engine.ts';
	import ResponseChart from '#lib/charts/ResponseChart.svelte';
	import { Button } from '#lib/components/primitives/index.ts';
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import { Transport } from '#lib/components/audio/index.ts';
	import { checkedCurve, type CurrentCurve } from '#lib/state/model.ts';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { m } from '#lib/paraglide/messages.js';
	import type { SharedCurveData, SharedCurveMeta } from './types.ts';
	import { curveClassification } from '#lib/gate-verdicts.ts';
	import YoloCurveNotice from '#lib/components/yolo/YoloCurveNotice.svelte';
	import { waivedLabels } from '#lib/components/yolo/yolo-curve.ts';

	type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

	let {
		curve: shared,
		meta,
		signedIn,
		app = null,
		fetcher = (input, init) => fetch(input, init)
	}: {
		curve: SharedCurveData;
		meta: SharedCurveMeta;
		signedIn: boolean;
		app?: ClientApp | null;
		fetcher?: Fetcher;
	} = $props();

	const id = $props.id();
	const locale = $derived(getLocale());
	const DESCRIPTION_META_MAX = 200;

	/** The decoded curve (null when the S1 does not decode or validate). */
	const curve = $derived.by((): CurrentCurve | null => {
		try {
			const decoded = decodeS1(shared.s1);
			return checkedCurve({
				schema: 1,
				name: shared.name,
				source: `community:${shared.lineageId}`,
				preampDb: decoded.preampDb,
				bands: decoded.bands,
				// The version's filter labels (lenient: refused entries become null). They travel with
				// "Instalar"; the `#p=` link of "Abrir na Curva" never carries them.
				labels: shared.labels ?? null,
				updatedAt: 0
			});
		} catch (error) {
			console.error('Shared curve decode failed', error instanceof Error ? error.name : 'unknown');
			return null;
		}
	});
	// The Curva page checks l/v against the S1 before remembering the origin (T4.15).
	const curvaHref = $derived(
		`/?l=${encodeURIComponent(shared.lineageId)}&v=${encodeURIComponent(shared.versionId)}#p=${shared.s1}`
	);
	const authorName = $derived(
		shared.author ? shared.author.displayUsername : m.shared_curve_author_removed()
	);
	const metaTitle = $derived(`${shared.name} · open-auri`);
	const metaDescription = $derived.by(() => {
		const text = shared.description.trim() || m.shared_curve_description_fallback();
		const points = Array.from(text);
		return points.length > DESCRIPTION_META_MAX
			? `${points.slice(0, DESCRIPTION_META_MAX - 1).join('')}…`
			: text;
	});
	const signInHref = '/entrar';

	let notice = $state('');
	let loginPrompt = $state(false);
	let favorited = $state(false);
	let favoriting = $state(false);
	let listening = $state(false);
	let busy = $state(false);
	let preview: ABPreview | null = null;
	let startedBy: AudioEngine | null = null;
	let unsubscribe: (() => void) | null = null;
	let attempt = 0;
	/** Session tag of this page's comparison (Transport, navbar). */
	const SHARED_CURVE_SESSION = 'shared-curve';

	/** The engine plays or holds paused this page's session (not raw, not another page's). */
	function owned(engine: AudioEngine): boolean {
		const state = engine.state();
		return state.session === SHARED_CURVE_SESSION && (state.playing || state.paused);
	}

	/**
	 * Follows the engine (as Comunidade's listener does): a pause or resume of this session from
	 * the Transport or the navbar keeps the comparison; a stop, raw playback or another page's
	 * session means it is no longer ours, so "Parar" goes and the A/B chains are disposed.
	 */
	function follow(state: AudioEngineState) {
		const ours = state.session === SHARED_CURVE_SESSION;
		if (ours && state.playing && state.mode === 'chains') return;
		if (ours && state.paused) return;
		stopListening();
	}

	/**
	 * Ends the comparison ("Parar", unmount, the engine moved on); the Transport's pause keeps
	 * it instead. Stops the engine only while the session is still this page's.
	 */
	function stopListening() {
		attempt++;
		unsubscribe?.();
		unsubscribe = null;
		const engine = startedBy;
		startedBy = null;
		if (engine && owned(engine)) engine.stop();
		if (preview) {
			preview.dispose();
			preview = null;
		}
		listening = false;
		busy = false;
	}
	onDestroy(stopListening);

	async function listen() {
		if (listening) {
			stopListening();
			return;
		}
		await begin();
	}

	/** Transport play with nothing of this page paused: a fresh comparison (a stale one goes). */
	async function transportPlay() {
		if (busy) return;
		if (listening) stopListening();
		await begin();
	}

	/** Drops the notice of an earlier playback attempt; other notices (favorite) stay. */
	function clearAudioNotice() {
		if (notice === m.shared_curve_audio_error() || notice === m.shared_curve_audio_unavailable())
			notice = '';
	}

	async function begin() {
		if (!app || !curve || busy) {
			notice = m.shared_curve_audio_unavailable();
			return;
		}
		const engine = app.audio;
		const token = ++attempt;
		busy = true;
		clearAudioNotice();
		try {
			preview = engine.createAB(app.state.curve.current, curve, {
				experimental: true,
				initial: 'B'
			});
			// A comparison starts at a random point of the file (SEEK.2); the file loops.
			await engine.start('chains', { startAt: 'random', session: SHARED_CURVE_SESSION });
			if (token !== attempt) {
				// A late start of an ended attempt (stop, install, unmount) is an orphan: it goes.
				// A newer attempt that is starting (busy) or playing (listening) shares the session
				// tag, so the playback is its own: the stale attempt leaves it alone.
				if (!busy && !listening && owned(engine)) engine.stop();
				return;
			}
			startedBy = engine;
			listening = true;
			// A successful start supersedes the error of an earlier failed attempt.
			clearAudioNotice();
			unsubscribe = engine.onChange(follow);
			// Another page may have taken the engine between the start and this subscription.
			if (!owned(engine)) stopListening();
		} catch (error) {
			// A failure of an earlier attempt must not end (or flag) the attempt that replaced it.
			if (token !== attempt) return;
			stopListening();
			notice = m.shared_curve_audio_error();
			console.error('Shared curve preview failed', error instanceof Error ? error.name : 'unknown');
		} finally {
			// `busy` belongs to the current attempt (stopListening already released it otherwise).
			if (token === attempt) busy = false;
		}
	}

	async function favorite() {
		if (!signedIn) {
			loginPrompt = true;
			return;
		}
		if (favoriting || favorited) return;
		favoriting = true;
		notice = '';
		const query = shared.shareId ? `?s=${encodeURIComponent(shared.shareId)}` : '';
		try {
			const response = await fetcher(
				`/api/v1/curves/${encodeURIComponent(shared.lineageId)}/favorite${query}`,
				{ method: 'PUT', credentials: 'same-origin' }
			);
			if (response.ok) {
				favorited = true;
				notice = m.shared_curve_favorited();
			} else if (response.status === 401) {
				loginPrompt = true;
			} else {
				notice = m.shared_curve_favorite_error();
			}
		} catch (error) {
			notice = m.shared_curve_favorite_error();
			console.error(
				'Shared curve favorite failed',
				error instanceof Error ? error.name : 'unknown'
			);
		} finally {
			favoriting = false;
		}
	}

	/**
	 * The class of the published curve, derived from its own bands (never a stored marker): a YOLO
	 * curve gets the `public` notice at the top and a YOLO install label. Writing it needs Modo
	 * YOLO on (in Engenharia, this tab): then "Instalar curva YOLO" opens the checklist with the
	 * YOLO profile; otherwise the action is "Ativar Modo YOLO", which opens the curve in the
	 * editor's Engenharia layer (locked there until YOLO is on). The checklist re-gates every write.
	 */
	const sharedClass = $derived(curve ? curveClassification(curve.bands, curve.preampDb) : null);
	const sharedYolo = $derived(sharedClass?.class === 'yolo');
	/** Modo YOLO is on in this tab and allows a write (not the free preview). */
	const yoloReady = $derived(app !== null && app.yolo.enabled && app.yolo.writeBlock() === null);
	const yoloHref = $derived(
		`/?camada=engenharia&l=${encodeURIComponent(shared.lineageId)}&v=${encodeURIComponent(shared.versionId)}#p=${shared.s1}`
	);

	function install() {
		if (!app || !curve) {
			notice = m.shared_curve_install_unavailable();
			return;
		}
		// A YOLO curve with YOLO off: the checklist would refuse it; the template offers the
		// "Ativar Modo YOLO" link instead.
		if (sharedYolo && !yoloReady) return;
		stopListening();
		// Opens the checklist only; the write needs its explicit confirmation (and the gate).
		const snapshot = { ...curve, updatedAt: Date.now() };
		if (sharedYolo) app.requestWrite(snapshot, { profile: 'yolo' });
		else app.requestWrite(snapshot);
	}
</script>

<svelte:head>
	<title>{metaTitle}</title>
	<meta name="description" content={metaDescription} />
	<link rel="canonical" href={meta.canonical} />
	{#if !meta.indexable}<meta name="robots" content="noindex" />{/if}
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="open-auri" />
	<meta property="og:title" content={shared.name} />
	<meta property="og:description" content={metaDescription} />
	<meta property="og:image" content={meta.image} />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:url" content={meta.canonical} />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={shared.name} />
	<meta name="twitter:description" content={metaDescription} />
	<meta name="twitter:image" content={meta.image} />
</svelte:head>

<div class="room">
	<div class="window" aria-hidden="true"></div>
	<article class="sheet" aria-labelledby="{id}-title">
		{#if sharedYolo}
			<YoloCurveNotice
				variant="public"
				waived={waivedLabels(sharedClass?.waived)}
				data-testid="shared-yolo-notice"
			/>
		{/if}
		<header class="tape-header">
			<span class="caps">{m.shared_curve_eyebrow()}</span>
			<span class="header-end"
				>{#if shared.visibility !== 'public'}<span class="badge">{m.shared_curve_unlisted()}</span
					>{/if}<span>96 kHz</span><span class="dot" aria-hidden="true"></span></span
			>
		</header>
		<div class="tape-label">
			<h1 id="{id}-title" lang={shared.lang}>{shared.name}</h1>
			<p class="author" data-testid="shared-curve-author">
				{#if shared.author}{m.shared_curve_by()}
					<a href="/u/{encodeURIComponent(shared.author.username)}">{authorName}</a>{:else}<span
						class="removed">{authorName}</span
					>{/if}
			</p>
		</div>
		{#if !shared.isHead}<p class="version-note">{m.shared_curve_version_note()}</p>{/if}
		<div class="paper">
			<div class="chart">
				{#if curve}
					<ResponseChart
						{curve}
						label={shared.name}
						description={m.shared_curve_response()}
						{locale}
						theme="paper"
					/>
				{:else}
					<p role="alert">{m.shared_curve_invalid()}</p>
				{/if}
			</div>
			{#if shared.description}<p class="description" lang={shared.lang}>
					{shared.description}
				</p>{/if}
		</div>
		<dl class="facts">
			<div>
				<dt>{m.shared_curve_license()}</dt>
				<dd data-testid="shared-curve-license">{shared.license}</dd>
			</div>
			<div>
				<dt class="term">
					{m.shared_curve_code()}
					<!-- The "?" trigger uses light ink (--text-2): give it its own dark key on the paper. -->
					<span class="explain-key"><Explainer term="s1" /></span>
				</dt>
				<dd class="code">{shared.s1}</dd>
			</div>
		</dl>
		<!--
			Control deck: the plate/primary buttons and the Transport are drawn for dark surfaces
			(light text, translucent faces, --rule-control borders), so they sit on a dark panel,
			as on the Biblioteca sheet's listen panel, never on the light paper itself.
		-->
		<div class="deck">
			<div class="actions">
				<Button loading={busy} aria-pressed={listening} onclick={listen}
					>{listening ? m.shared_curve_stop() : m.shared_curve_listen()}</Button
				>
				<a class="btn btn--plate btn--md" href={curvaHref} data-sveltekit-reload
					>{m.shared_curve_open()}</a
				>
				<Button loading={favoriting} aria-pressed={favorited} onclick={favorite}
					>{favorited ? m.shared_curve_favorited() : m.shared_curve_favorite()}</Button
				>
				{#if sharedYolo && !yoloReady}
					<a
						class="btn btn--primary btn--md"
						href={yoloHref}
						data-sveltekit-reload
						data-testid="shared-yolo-enable">{m.yolopub_enable_yolo()}</a
					>
				{:else}
					<Button variant="primary" onclick={install}
						>{sharedYolo ? m.yolopub_install_yolo() : m.shared_curve_install()}</Button
					>
				{/if}
			</div>
			<!-- Pause keeps the comparison (trims, position); "Parar" ends it. -->
			<Transport
				engine={app?.audio ?? null}
				variant="compact"
				session={SHARED_CURVE_SESSION}
				onplay={transportPlay}
				playDisabledReason={app && curve ? null : m.shared_curve_audio_unavailable()}
			/>
		</div>
		<p class="install-note">{m.shared_curve_install_note()}</p>
		{#if sharedYolo && !yoloReady}
			<p class="install-note" data-testid="shared-yolo-why">{m.yolopub_install_needs_yolo()}</p>
		{/if}
		{#if loginPrompt}<div class="login" role="alert">
				<p>{m.shared_curve_login_prompt()}</p>
				<a href={signInHref}>{m.shared_curve_login()}</a>
			</div>{/if}
		<div class="notice" role="status">{notice}</div>
	</article>
</div>

<style>
	.room {
		position: relative;
		isolation: isolate;
		min-height: 70vh;
		padding: 48px 28px;
		overflow: hidden;
		color: #ece7dd;
		background:
			linear-gradient(90deg, #0006, transparent 20% 80%, #0006),
			repeating-linear-gradient(1deg, #0000 0 3px, #21130955 4px, #0000 6px 12px),
			repeating-linear-gradient(
				90deg,
				#5b3823 0,
				#44291c 5px,
				#71472b 7px,
				#4c2d1c 10px,
				#3b251a 90px,
				#241810 92px,
				#6b4328 96px,
				#4a2e1e 170px
			);
		font: 400 var(--fs-ui, 14px) / 1.5 var(--face-body, 'Geist', Arial, sans-serif);
	}
	.window {
		position: absolute;
		z-index: -1;
		top: 10px;
		left: 12%;
		right: 12%;
		height: 265px;
		border: 13px ridge #30271e;
		background:
			linear-gradient(120deg, #96896825, #28302d88 55%, #bda76d18),
			repeating-linear-gradient(90deg, #0000 0 24%, #191a16 24% 25%);
		box-shadow:
			inset 0 0 70px #000,
			0 0 90px #cba76d22;
	}
	/* Same tape box as the Biblioteca shelf; it slides out once on arrival (UI, not data). */
	.sheet {
		max-width: 760px;
		margin: 40px auto 0;
		border: 1px solid #b6a17c;
		border-radius: 2px 4px 3px 1px;
		background:
			repeating-linear-gradient(0deg, #0000 0 3px, #9b805408 4px),
			linear-gradient(130deg, #eaddbd, #cab892 90%);
		color: #302c23;
		box-shadow:
			inset 3px 0 #f5ebcc,
			inset -7px 0 #9e896533,
			3px 5px 5px #0008,
			0 16px 0 -5px #805236,
			0 18px 0 -5px #241910;
		animation: box-out var(--dur-scene, 0.72s) var(--ease-out, ease-out) both;
	}
	/* Transform only: fading opacity would drop every text/surface pair below WCAG mid-motion. */
	@keyframes box-out {
		from {
			transform: translateY(28px) rotate(-0.5deg);
		}
	}
	h1,
	p,
	dl,
	dd {
		margin: 0;
	}
	.tape-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		padding: 12px 18px 9px;
		border-bottom: 1px solid #63543945;
		font: 400 var(--label-min, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
	}
	.header-end {
		display: inline-flex;
		align-items: center;
		gap: 10px;
	}
	.caps {
		font-weight: 500;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.badge {
		padding: 2px 8px;
		border: 1px solid #6f6049;
	}
	.dot {
		width: 8px;
		height: 8px;
		border: 1px solid #6f6049;
		border-radius: 50%;
		background: #716342;
	}
	.tape-label {
		position: relative;
		margin: 18px 18px 0;
		padding: 16px 14px 10px;
		background: #eee5cc99;
		border: 1px solid #81725255;
	}
	.tape-label::before {
		content: '';
		position: absolute;
		top: -8px;
		left: calc(50% - 23px);
		width: 47px;
		height: 14px;
		background: #baa16a66;
		transform: rotate(-6deg);
	}
	h1 {
		font: 700 34px/1.05 var(--type, 'Courier Prime', monospace);
		letter-spacing: -0.045em;
		overflow-wrap: anywhere;
	}
	.author {
		margin-top: 8px;
		font: 400 var(--fs-small, 13px) / 1.4 var(--type, 'Courier Prime', monospace);
	}
	.author a {
		color: inherit;
		text-underline-offset: 3px;
	}
	.removed {
		font-style: italic;
	}
	.version-note,
	.install-note {
		padding: 10px 18px 0;
		font: 400 var(--label-min, 11px) / 1.6 var(--face-data, 'JetBrains Mono', monospace);
	}
	/* Paper track sheet, unfolding like the Biblioteca sheet. */
	.paper {
		margin: 16px 18px 0;
		padding: 4px 0 8px;
		background:
			repeating-linear-gradient(0deg, #0000 0 26px, #9f895617 27px 28px),
			linear-gradient(125deg, #f0e6cb, #d7c6a0);
		box-shadow: 2px 5px 12px #0005;
		transform-origin: top center;
		animation: paper-open var(--dur-scene, 0.72s) var(--ease-out, ease-out) both;
		animation-delay: calc(var(--dur-scene, 0.72s) * 0.3);
	}
	@keyframes paper-open {
		from {
			transform: perspective(1200px) rotateX(-62deg);
		}
	}
	.chart {
		padding: 12px 14px;
	}
	.description {
		padding: 0 14px 8px;
		font: 400 var(--fs-small, 13px) / 1.6 var(--type, 'Courier Prime', monospace);
		overflow-wrap: anywhere;
		white-space: pre-line;
	}
	.facts {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 18px;
		margin-top: 14px;
		padding: 12px 18px;
		border-top: 1px solid #63543945;
		font: 400 var(--label-min, 11px) / 1.5 var(--face-data, 'JetBrains Mono', monospace);
	}
	dt {
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}
	.term {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.explain-key {
		display: inline-flex;
		padding: 2px;
		border-radius: 999px;
		background: #232920;
	}
	.code {
		overflow-wrap: anywhere;
	}
	/*
		Dark deck under the controls (same panel as the Biblioteca sheet's listen section): the
		plate border (--rule-control) reads 3.3:1 on it, the Biblioteca primary 7:1. A column
		with a gap: the actions row and the Transport (which wraps its seek bar under its own
		buttons when narrow) stack in normal flow and never overlap at any width.
	*/
	.deck {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin: 14px 18px 0;
		padding: 14px;
		border: 1px solid #a69f7144;
		border-radius: 2px;
		background: #1c211a;
		color: #ece7dd;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}
	.login {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		margin: 14px 18px 0;
		padding: 10px 12px;
		background: #e1d6b9;
		border: 1px dashed #6f6049;
		font: 400 var(--fs-caption, 12px) / 1.5 var(--type, 'Courier Prime', monospace);
	}
	.login a {
		color: inherit;
		font-weight: 700;
	}
	.notice {
		padding: 12px 18px 18px;
		font: 400 var(--fs-caption, 12px) / 1.5 var(--face-data, 'JetBrains Mono', monospace);
	}
	:where(a):focus-visible {
		outline: 3px solid #f6bd55;
		outline-offset: 4px;
	}
	@media (max-width: 780px) {
		.room {
			padding: 24px 13px;
		}
		.window {
			display: none;
		}
		.sheet {
			margin-top: 0;
		}
		h1 {
			font-size: 28px;
		}
		.facts {
			grid-template-columns: 1fr;
		}
		.deck {
			padding: 12px;
		}
		/* Touch: 44 px targets that share the rows (the labels still never wrap). */
		.actions > :global(.btn) {
			flex: 1 1 auto;
			min-height: 44px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sheet,
		.paper {
			animation: none;
		}
	}
</style>
