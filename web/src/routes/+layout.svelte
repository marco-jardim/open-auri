<script lang="ts">
	import '#lib/styles/index.css';
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { browser, dev } from '$app/env';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale, getTextDirection } from '#lib/paraglide/runtime.js';
	import { PUBLIC_GITHUB_URL, PUBLIC_TURNSTILE_SITE_KEY } from '#lib/config/public.ts';
	// FUX.2: no static import of the runtime (#lib/app/index.ts re-exports createClientApp).
	import { setAppContext, mountNativeCable, setNativeCableState } from '#lib/app/context.svelte.ts';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import {
		hasInflightMarker,
		isInstrumentRoute,
		isTurnstileRoute,
		loadAppRuntime,
		runtimeTrigger,
		whenIdle
	} from '#lib/app/runtime.ts';
	import { LazyModule } from '#lib/app/lazy.svelte.ts';
	import { createSocialAttacher } from '#lib/app/social-attach.ts';
	import { getFooterHonoree, getPageMeta } from '#lib/page-meta.ts';
	import AccountEntry from '#lib/components/chrome/AccountEntry.svelte';
	import CableBar from '#lib/components/chrome/CableBar.svelte';
	import Footer from '#lib/components/chrome/Footer.svelte';
	import Toast from '#lib/components/chrome/Toast.svelte';
	import YoloBar from '#lib/components/yolo/YoloBar.svelte';
	import AndroidUpdateBanner from '#lib/components/cable/AndroidUpdateBanner.svelte';
	import { AccountSession } from '#lib/components/chrome/account.svelte.ts';
	import { postPolicyAcceptance } from '#lib/components/chrome/account.ts';
	import { revealLocale } from '#lib/components/chrome/lang-boot.ts';
	import { appShortcuts, playbackShortcut } from '#lib/components/chrome/shortcuts.ts';
	import { createToastStore } from '#lib/components/chrome/toast.ts';
	import { nativeBackPopover } from '#lib/components/chrome/native-back.ts';
	import AudioLoader from '#lib/components/audio/AudioLoader.svelte';
	// Direct files, not the primitives barrel: every route loads the layout first (FUX.NAV budgets).
	import IconButton from '#lib/components/primitives/IconButton.svelte';
	import Lamp, { type LampTone } from '#lib/components/primitives/Lamp.svelte';
	import Skeleton from '#lib/components/primitives/Skeleton.svelte';
	import Tooltip from '#lib/components/primitives/Tooltip.svelte';
	import { resolveAnonymousSeen, writePolicySeen } from '#lib/components/legal/policy-seen.ts';
	import { POLICY_VERSION } from '#lib/content/legal/version.ts';
	import { loadSocialRuntime, type SocialRuntime } from '#lib/social/runtime.ts';
	import type { SocialOutbox, SocialSession, SocialApi } from '#lib/social/index.ts';
	import type { LayoutProps } from './$types';
	import { setHiddenStore } from '#lib/social/hidden-context.ts';
	import { createAccountHiddenStore } from '#lib/social/account-hidden.svelte.ts';
	import { setReportSiteKey } from '#lib/social/report-context.ts';
	import { setViewer } from '#lib/social/viewer-context.ts';

	let { children, data }: LayoutProps = $props();
	const accountSession = new AccountSession(() => ({
		user: data.user,
		resolved: data.sessionResolved,
		path: page.url.pathname
	}));
	// Policy banner: anonymous visitors use localStorage (resolved after mount); signed-in users
	// use their latest acknowledgement from the server and record a new one at /conta/politica.
	let anonymousSeen = $state<string | null>(POLICY_VERSION);
	const policyBanner = $derived.by(() => {
		if (accountSession.current) {
			return data.sessionResolved && data.policy
				? { seen: data.policy.seen, accept: (version: string) => postPolicyAcceptance(version) }
				: null;
		}
		if (!accountSession.known) return null;
		return {
			seen: anonymousSeen,
			accept: (version: string) => {
				writePolicySeen(version);
				anonymousSeen = version;
			}
		};
	});
	// The toast region exists before the runtime: the app gets this store injected (FUX.2).
	const toasts = createToastStore();
	const context = setAppContext();
	const nativeCable = setNativeCableState();
	setHiddenStore(createAccountHiddenStore(accountSession));
	setViewer(accountSession);
	setReportSiteKey(PUBLIC_TURNSTILE_SITE_KEY);
	const app = $derived(context.client);
	const meta = $derived(getPageMeta(page.route.id ?? page.url.pathname));
	const homage = $derived(getFooterHonoree(meta));
	const pending = $derived(app?.pendingWrite);
	const statusId = $props.id();

	// --- lazy chrome islands (spec §5.3 L2) -------------------------------------------------
	const checklist = new LazyModule(() => import('#lib/components/cable/PreWriteChecklist.svelte'));
	const cableStatus = new LazyModule(() => import('#lib/components/cable/CableStatus.svelte'));
	const rescueNotice = new LazyModule(() => import('#lib/components/cable/RescueNotice.svelte'));
	const helpOverlay = new LazyModule(() => import('#lib/components/chrome/HelpOverlay.svelte'));
	const updatePrompt = new LazyModule(() => import('#lib/pwa/UpdatePrompt.svelte'));
	const policyBannerIsland = new LazyModule(
		() => import('#lib/components/legal/PolicyBanner.svelte')
	);
	const androidNotice = new LazyModule(
		() => import('#lib/components/cable/AndroidUntestedNotice.svelte')
	);

	function islandFailed(error: unknown): void {
		console.error('A page component could not load', error);
		toasts.push(m.layout_error_generic(), { tone: 'error' });
	}

	// --- runtime (L1, W2) --------------------------------------------------------------------
	// Read synchronously: a marker means an interrupted write; the rescue notice must not wait.
	const marker = browser && hasInflightMarker();
	if (browser && runtimeTrigger(page.route.id, marker) === 'now') {
		// Start the chunk requests during hydration; onMount's mount() reuses the same promises.
		loadAppRuntime().catch((error: unknown) => console.warn('Runtime prefetch failed', error));
		loadSocialRuntime().catch((error: unknown) => console.warn('Social prefetch failed', error));
		if (marker) rescueNotice.request();
	}

	// Social wiring (F4, FUX.2 L3): the bridge is attached in `prepare`, before the app is
	// published, so while social is available a real cable write never happens without it.
	// SocialSync itself renders on idle, or at once with a session or queued items.
	//
	// FUX.Q N6: social is an optional prepare. When its chunk cannot load (offline without the
	// chunk cached, a deploy that replaced it) or does not load within SOCIAL_ATTACH_TIMEOUT_MS
	// (a stalled request, #35), the app is published anyway and the outbox is marked unavailable
	// (`data-social="unavailable"`): cable status, rescue notice and writes keep working. Writes
	// and the rescue are never blocked or delayed by social; a write or rescue request and a
	// press or focus on the bar only retry the wiring in the background (at most once per
	// SOCIAL_RETRY_INTERVAL_MS, `#lib/app/social-attach.ts`), and the bridge records the writes
	// that come after it attached. The trade-off is deliberate: a missed "installed" activity in
	// the social feed is acceptable, a device left half-written that cannot be rescued is not.
	interface SocialWiring {
		runtime: SocialRuntime;
		session: SocialSession;
		api: SocialApi;
		outbox: SocialOutbox;
		stop: () => void;
	}
	let social = $state.raw<SocialWiring | null>(null);
	let syncReady = $state(false);
	let cancelSyncIdle: (() => void) | undefined;
	/** The social chunk failed to load: the outbox bridge is not attached (writes still work). */
	let socialUnavailable = $state(false);
	/** Set by the layout's teardown: wiring that arrives later is undone at once. */
	let destroyed = false;

	/**
	 * Wires the social session, API and outbox bridge for `client`. Returns the cleanup the app
	 * context runs when that app is disposed (also when it is disposed before being published),
	 * so a bridge started for an app that went away never leaks. Safe to call more than once.
	 */
	async function attachSocial(client: ClientApp): Promise<() => void> {
		const runtime = await loadSocialRuntime();
		const session = runtime.createSocialSession(
			accountSession.known ? { initial: accountSession.current } : {}
		);
		const api = runtime.createSocialApi();
		const outbox = runtime.createSocialOutbox({ store: client.state.outbox, session });
		const stopBridge = runtime.startOutboxBridge({
			app: client,
			outbox,
			session,
			onqueued: (result) => {
				if (result.ok) void outbox.flush(api);
			}
		});
		let stopped = false;
		const stop = () => {
			if (stopped) return;
			stopped = true;
			stopBridge();
			if (social?.stop === stop) social = null;
		};
		// A layout that went away, or an app replaced while the chunk loaded: undone at once, and
		// never shown in place of the live app's wiring (#35).
		if (destroyed || !socialAttach.keeps(client)) {
			stop();
			return stop;
		}
		// The attacher stops the wiring it kept before (one live bridge); this one replaces it.
		social = { runtime, session, api, outbox, stop };
		if (accountSession.current) {
			syncReady = true;
			return stop;
		}
		outbox.pending().then(
			(items) => {
				if (items.length > 0) syncReady = true;
			},
			(error: unknown) => console.warn('Social outbox could not be read', error)
		);
		cancelSyncIdle?.();
		cancelSyncIdle = whenIdle(() => (syncReady = true));
		return stop;
	}

	/**
	 * First attach timeout, retry pace and ownership (#35). A failed or timed-out prepare marks
	 * the outbox unavailable (the context logs it once); wiring that lands later, from a retry or
	 * from a first attach that outlived its timeout, is kept for the live app and undone for an
	 * app that was replaced or a layout that went away (the teardown stops a kept one). The
	 * context never sees the cleanup of such wiring, so the attacher stops it itself when the app
	 * is replaced (a new prepare) or newer wiring lands: never two live outbox bridges.
	 */
	const socialAttach = createSocialAttacher<ClientApp>({
		attach: attachSocial,
		// Before the context publishes it (a late landing races the publication), the app is ours.
		owns: (client) => !destroyed && (context.client === null || context.client === client),
		onavailable: (available) => {
			socialUnavailable = !available;
		}
	});

	/**
	 * Background retry of the social wiring after a failure, on a write or rescue request and on
	 * a press or focus on the bar (not on hover). Never awaited by a write: see the FUX.Q N6 note
	 * above. Rate-limited and logged once per outage by `socialAttach`.
	 */
	function retrySocial(): void {
		if (social || destroyed) return;
		socialAttach.retry(context.client);
	}

	/** "Gravar no cabo": straight to the checklist; social only retries alongside. */
	function requestWrite(): void {
		retrySocial();
		app?.requestWrite();
	}

	/** The rescue never waits for anything but the cable service (FUX.Q N6). */
	function requestRescue(): void {
		retrySocial();
		app?.requestRescue();
	}

	let startingRuntime = false;
	function startRuntime(): void {
		if (!browser || destroyed || startingRuntime || context.client || context.status === 'loading')
			return;
		loadSocialRuntime().catch((error: unknown) => console.warn('Social prefetch failed', error));
		// Raced against SOCIAL_ATTACH_TIMEOUT_MS: a stalled social chunk never holds the cable and
		// rescue chrome back; the app is published without social and the wiring may land later.
		const mountOptions = {
			prepare: (client: ClientApp) => socialAttach.prepare(client),
			optional: true
		};
		// Detection must precede creation: the cable service fixes its mode at construction.
		// The helper is synchronous on desktop and never loads the native bridge there.
		startingRuntime = true;
		mountNativeCable(
			(options) => (destroyed ? Promise.resolve(null) : context.mount(options, mountOptions)),
			toasts,
			nativeCable
		).then(
			(client) => {
				startingRuntime = false;
				if (!client) return;
				client.start().catch((error: unknown) => {
					console.error('App restore failed', error);
					toasts.push(m.layout_error_generic(), { tone: 'error' });
				});
				// Writes start on instrument pages: warm the checklist chunk once things are quiet.
				if (isInstrumentRoute(page.route.id)) whenIdle(() => checklist.request());
			},
			(error: unknown) => {
				startingRuntime = false;
				console.error('App runtime failed to load', error);
				toasts.push(m.layout_error_generic(), { tone: 'error' });
			}
		);
	}

	// Instrument routes and the rescue marker: at once (also after a client-side navigation).
	$effect(() => {
		if (runtimeTrigger(page.route.id, marker) === 'now') untrack(startRuntime);
	});

	/**
	 * First interaction that needs the runtime on a static route: pointer over, press or focus
	 * on the bar's tools or status (Áudio, Neutro, Padrão Auri, Gravar no cabo). Once the app is
	 * there, the same intent warms the checklist chunk; only a press or focus also retries a
	 * failed social wiring (a hover would re-import on every pass over the bar, #35).
	 */
	function barIntent(node: HTMLElement): () => void {
		const intent = (event: Event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (!target.closest('.bar-tools, .bar-status, [data-runtime-intent]')) return;
			startRuntime();
			if (!context.client) return;
			checklist.request();
			if (event.type !== 'pointerover') retrySocial();
		};
		const types = ['pointerover', 'pointerdown', 'focusin'] as const;
		for (const type of types) node.addEventListener(type, intent, { passive: true });
		return () => {
			for (const type of types) node.removeEventListener(type, intent);
		};
	}

	$effect(() => {
		const wiring = social;
		if (wiring && accountSession.known) wiring.session.set(accountSession.current);
		if (wiring && accountSession.current) syncReady = true;
	});
	$effect(() => {
		if (app && pending) checklist.request(onChecklistFailed);
	});
	$effect(() => {
		if (app && app.cableState.rescue !== null) rescueNotice.request();
	});
	const showPolicy = $derived(policyBanner !== null && policyBanner.seen !== POLICY_VERSION);
	$effect(() => {
		if (showPolicy) policyBannerIsland.request();
	});
	$effect(() => {
		if (nativeCable.result.kind !== 'none') androidNotice.request(islandFailed);
	});

	function onChecklistFailed(error: unknown): void {
		// Never leave a pending write that cannot be reviewed: close it, then say so.
		app?.closeChecklist();
		islandFailed(error);
	}

	onMount(() => {
		anonymousSeen = resolveAnonymousSeen(POLICY_VERSION);
		const cancelIdle = whenIdle(() => {
			startRuntime();
			updatePrompt.request();
		});
		return () => {
			destroyed = true;
			cancelIdle();
			cancelSyncIdle?.();
			social?.stop();
			social = null;
			// Also runs the cleanup of the published app's prepare (idempotent stop), or of a
			// prepare still running when it lands.
			context.dispose();
		};
	});

	// References resolve after the integration queue merges T2.9's staging catalogs.
	const metaMessages = {
		meta_curva_curiosity: m.meta_curva_curiosity,
		meta_biblioteca_curiosity: m.meta_biblioteca_curiosity,
		meta_comparar_curiosity: m.meta_comparar_curiosity,
		meta_soe_como_x_curiosity: m.meta_soe_como_x_curiosity,
		meta_comunidade_curiosity: m.meta_comunidade_curiosity,
		meta_teste_cego_curiosity: m.meta_teste_cego_curiosity,
		meta_cabo_curiosity: m.meta_cabo_curiosity,
		meta_docs_curiosity: m.meta_docs_curiosity,
		meta_auth_curiosity: m.meta_auth_curiosity,
		meta_source: m.meta_source,
		meta_source_patent: m.meta_source_patent,
		meta_source_wikipedia: m.meta_source_wikipedia,
		meta_source_les_paul: m.meta_source_les_paul,
		meta_source_tracks: m.meta_source_tracks,
		meta_source_lab: m.meta_source_lab,
		meta_source_speakers: m.meta_source_speakers,
		meta_source_target: m.meta_source_target,
		meta_source_type_a: m.meta_source_type_a,
		meta_source_stability: m.meta_source_stability
	};
	function metaText(key: string): string {
		if (!Object.hasOwn(metaMessages, key)) throw new Error(`Unknown homage message: ${key}`);
		return metaMessages[key as keyof typeof metaMessages]();
	}
	const honoree = $derived({
		name: homage.curiosity === 'meta_teste_cego_curiosity' ? m.meta_teste_cego_name() : homage.name,
		years: homage.years,
		curiosity: metaText(homage.curiosity),
		sources: homage.sources.map((source) => ({
			label: metaText(source.labelKey),
			href: source.href
		}))
	});
	const shortcuts = $derived(appShortcuts());
	const statusText = $derived(
		!app
			? m.layout_initializing()
			: app.cableState.writing
				? m.cable_status_writing()
				: app.cableState.connection === 'connecting'
					? m.cable_status_connecting()
					: app.cableState.connection === 'connected'
						? m.cable_status_connected({ device: app.cableState.deviceLabel ?? '' })
						: m.cable_status_disconnected()
	);
	// FUX.NAV: the bar shows a short label (a word of the full text) beside a lamp bound to the
	// real link state; the full text stays announced, in the tooltip and in the popover.
	const statusShort = $derived(
		!app
			? m.layout_initializing()
			: app.cableState.writing
				? m.fuxnav_cable_writing()
				: app.cableState.connection === 'connecting'
					? m.fuxnav_cable_waiting()
					: app.cableState.connection === 'connected'
						? m.fuxnav_cable_on()
						: m.fuxnav_cable_off()
	);
	const cableLamp = $derived.by((): { on: boolean; tone: LampTone } => {
		if (!app) return { on: false, tone: 'ok' };
		if (app.cableState.writing) return { on: true, tone: 'accent' };
		if (app.cableState.connection === 'connecting') return { on: true, tone: 'warn' };
		return { on: app.cableState.connection === 'connected', tone: 'ok' };
	});

	// --- help (lazy dialog behind a stable bar trigger) --------------------------------------
	let helpOpen = $state(false);
	function openHelp(): void {
		helpOpen = true;
		helpOverlay.request(islandFailed);
	}

	// --- cable status popover, placed from its trigger (desktop and mobile rows) ------------
	let statusTrigger: HTMLButtonElement | undefined = $state();
	let statusPos = $state<{ top: number; left: number; maxHeight: number } | null>(null);
	/** The popover is open: the trigger's tooltip stays closed (it would cover the popover). */
	let statusShown = $state(false);
	let statusTip = $state(false);
	// Also when a hover delay that started before the popover opened fires afterwards.
	$effect(() => {
		if (statusShown && statusTip) statusTip = false;
	});
	const POPOVER_WIDTH = 440;
	const POPOVER_MARGIN = 16;
	function placeStatus(): void {
		if (!statusTrigger) return;
		const rect = statusTrigger.getBoundingClientRect();
		const width = Math.min(POPOVER_WIDTH, window.innerWidth - 2 * POPOVER_MARGIN);
		const left = Math.max(
			POPOVER_MARGIN,
			Math.min(rect.right - width, window.innerWidth - width - POPOVER_MARGIN)
		);
		const top = rect.bottom + 8;
		statusPos = { top, left, maxHeight: Math.max(160, window.innerHeight - top - POPOVER_MARGIN) };
	}
	function statusPopover(node: HTMLElement): () => void {
		// Tracked from the toggle events (no `:popover-open` query, which throws where unsupported).
		let shown = false;
		const before = (event: Event) => {
			if (!('newState' in event)) return;
			shown = event.newState === 'open';
			statusShown = shown;
			if (!shown) return;
			statusTip = false;
			cableStatus.request(islandFailed);
			placeStatus();
		};
		const follow = () => {
			if (shown) placeStatus();
		};
		node.addEventListener('beforetoggle', before);
		window.addEventListener('resize', follow);
		window.addEventListener('scroll', follow, { passive: true });
		return () => {
			node.removeEventListener('beforetoggle', before);
			window.removeEventListener('resize', follow);
			window.removeEventListener('scroll', follow);
		};
	}

	function loadEditor(which: 'neutral' | 'auri') {
		if (!app) return;
		const loaded = which === 'neutral' ? app.loadNeutral() : app.loadAuriDefault();
		if (loaded) app.toasts.push(m.layout_editor_loaded());
	}

	function helpShortcut(event: KeyboardEvent): boolean {
		// Until HelpOverlay is loaded, the layout answers its "?" shortcut (same rules).
		if (helpOverlay.current || event.key !== '?' || event.ctrlKey || event.metaKey) return false;
		const target = event.target;
		if (
			target instanceof Element &&
			target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
		) {
			return false;
		}
		if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return false;
		event.preventDefault();
		openHelp();
		return true;
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey) return;
		if (helpShortcut(event)) return;
		if (!helpOpen && playbackShortcut(event, app?.audio, playbackFailed)) return;
		if (!app) return;
		if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
		const target = event.target;
		if (
			target instanceof Element &&
			target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
		) {
			return;
		}
		if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
		event.preventDefault();
		if (event.shiftKey) app.state.curve.redo();
		else app.state.curve.undo();
	}

	function playbackFailed(message: string): void {
		toasts.push(message, { tone: 'error' });
	}

	// Prerendered HTML carries the base locale; /lang-boot.js hides it when the visitor resolves to
	// another locale. Once hydrated in the client locale, sync <html lang/dir> and reveal the page.
	$effect(() => {
		const locale = getLocale();
		revealLocale(document.documentElement, locale, getTextDirection(locale));
	});
</script>

<svelte:window onkeydown={onKeydown} />

<svelte:head>
	{#if isTurnstileRoute(page.route.id)}
		<!-- W7: Turnstile's origin only where the auth form renders it. -->
		<link rel="preconnect" href="https://challenges.cloudflare.com" />
	{/if}
</svelte:head>

<div
	class="app-root"
	data-page={meta.page}
	data-runtime={context.status}
	data-social={socialUnavailable ? 'unavailable' : undefined}
	style:--accent={meta.accent}
>
	<a class="skip-link" href="#main-content">{m.layout_skip()}</a>
	{#snippet audioLoader()}
		{#if app}<AudioLoader engine={app.audio} />{/if}
	{/snippet}
	<div data-chrome="bar" {@attach barIntent}>
		<!-- CableBar owns Nav and LanguageToggle; slots retain one of each shared control.
		     Before the runtime, its own ♪ Áudio fallback says why it waits (same geometry). -->
		<CableBar
			currentPath={page.url.pathname}
			connected={app?.cableState.connection === 'connected'}
			unsaved={app?.state.curve.unsaved ?? false}
			writeDisabled={!app || app.cableState.writing}
			writeDisabledReason={app ? undefined : m.fux2_cable_runtime_loading()}
			onNeutro={app ? () => loadEditor('neutral') : undefined}
			onPadraoAuri={app ? () => loadEditor('auri') : undefined}
			onWrite={app ? requestWrite : undefined}
			onHelp={openHelp}
			playbackEngine={app?.audio}
			onPlaybackError={playbackFailed}
			audio={app ? audioLoader : undefined}
		>
			{#snippet status()}
				{#if app}
					<button
						type="button"
						class="status-trigger btn btn--ghost btn--sm btn--bar"
						popovertarget={statusId}
						bind:this={statusTrigger}
						onpointerenter={() => cableStatus.request()}
						onfocus={() => cableStatus.request()}
					>
						<Lamp on={cableLamp.on} tone={cableLamp.tone} />
						<span class="status-short" aria-hidden="true">{statusShort}</span>
						<span class="sr-only">{statusText}</span>
					</button>
				{:else}
					<!-- §5.5: skeleton with the lamp and label geometry while the runtime loads
					     (CableBar sizes it per width through --status-skeleton-w/h). -->
					<span class="status-skeleton-slot">
						<Skeleton
							class="status-skeleton"
							width="var(--status-skeleton-w, 5.25rem)"
							height="var(--status-skeleton-h, 0.75rem)"
							radius="var(--rad-pill)"
							label={m.fux2_cable_runtime_loading()}
						/>
					</span>
				{/if}
			{/snippet}
			{#snippet account()}
				<AccountEntry
					user={accountSession.current}
					currentPath={page.url.pathname}
					pending={!accountSession.known}
					admin={data.sessionResolved ? data.admin : accountSession.current?.admin === true}
				/>
			{/snippet}
			{#snippet help()}
				<!-- T3: help lives in the bar. FUX.2: the dialog is its own chunk, loaded on open. -->
				<span class="help-slot" data-chrome="help">
					<IconButton
						size="sm"
						variant="plate"
						class="help-btn btn--bar"
						label={m.chrome_help_open()}
						aria-haspopup="dialog"
						aria-expanded={helpOpen}
						onpointerenter={() => helpOverlay.request()}
						onfocus={() => helpOverlay.request()}
						onclick={openHelp}>?</IconButton
					>
					{#if helpOverlay.current}
						{@const Help = helpOverlay.current}
						<Help {shortcuts} showTrigger={false} bind:open={helpOpen} />
					{/if}
				</span>
			{/snippet}
		</CableBar>
	</div>

	{#if nativeCable.result.kind !== 'none'}
		<AndroidUpdateBanner
			kind={nativeCable.result.kind}
			writing={app?.cableState.writing ?? false}
		/>
	{/if}

	{#if policyBanner && showPolicy && policyBannerIsland.current}
		{@const PolicyBanner = policyBannerIsland.current}
		<div data-chrome="policy">
			<PolicyBanner
				version={POLICY_VERSION}
				seenVersion={policyBanner.seen}
				onAccept={policyBanner.accept}
			/>
		</div>
	{/if}

	{#if app && app.yolo.enabled}
		<!-- Modo YOLO: a compact hazard bar on every page of this tab while it is on. A direct child
		     of the app root, so it stays sticky under the top bar for the whole page. -->
		<YoloBar yolo={app.yolo} />
	{/if}

	{#if app}
		<!-- The full cable status beside its short bar label; closed while the popover shows. -->
		<Tooltip text={statusText} anchor={statusShown ? null : statusTrigger} bind:open={statusTip} />
	{/if}
	<div
		id={statusId}
		popover="auto"
		class="cable-popover"
		data-chrome="status"
		style:top={statusPos ? `${statusPos.top}px` : null}
		style:left={statusPos ? `${statusPos.left}px` : null}
		style:right={statusPos ? 'auto' : null}
		style:max-height={statusPos ? `${statusPos.maxHeight}px` : null}
		{@attach statusPopover}
		{@attach nativeBackPopover}
	>
		{#if app && cableStatus.current}
			{@const CableStatus = cableStatus.current}
			<CableStatus service={app.cable} />
		{/if}
	</div>

	{#if app}
		<div class="rescue-wrap" data-chrome="rescue">
			{#if rescueNotice.current && app.cableState.rescue !== null}
				{@const RescueNotice = rescueNotice.current}
				<RescueNotice service={app.cable} onrescue={requestRescue} />
			{/if}
		</div>
	{/if}
	<div id="main-content" tabindex="-1">{@render children()}</div>

	{#if app && pending && checklist.current}
		{@const PreWriteChecklist = checklist.current}
		<PreWriteChecklist
			service={app.cable}
			open={true}
			bands={pending.bands}
			preampDb={pending.preampDb}
			name={pending.name}
			experimental={app.experimentalWrite}
			profile={app.pendingProfile}
			onclose={() => app?.closeChecklist()}
			onresult={(outcome) => app?.onWriteResult(outcome)}
		/>
	{/if}
	<Toast store={toasts} />
	{#if nativeCable.result.kind !== 'none' && androidNotice.current}
		{@const AndroidNotice = androidNotice.current}
		<AndroidNotice
			kind={nativeCable.result.kind}
			presentation={page.url.pathname.replace(/\/$/, '') === '/docs' ? 'banner' : 'modal'}
		/>
	{/if}
	{#if social && syncReady}
		{@const SocialSync = social.runtime.SocialSync}
		<SocialSync
			{app}
			account={accountSession.known ? accountSession.current : undefined}
			session={social.session}
			api={social.api}
			outbox={social.outbox}
		/>
	{/if}
	<div data-chrome="footer">
		<Footer {honoree} githubUrl={PUBLIC_GITHUB_URL} />
	</div>
</div>

{#if updatePrompt.current}
	{@const UpdatePrompt = updatePrompt.current}
	<UpdatePrompt enabled={!dev} workerUrl="/service-worker.js" scope="/" />
{/if}

<style>
	.app-root {
		min-height: 100dvh;
	}
	.skip-link {
		position: fixed;
		top: 8px;
		left: 16px;
		z-index: 400;
		transform: translateY(-160%);
		padding: 10px 16px;
		background: var(--accent);
		color: var(--accent-ink);
	}
	.skip-link:focus {
		transform: none;
	}
	/* A ghost bar button (recipe in components.css); CableBar sets its geometry per width. */
	.status-trigger {
		cursor: pointer;
	}
	.cable-popover {
		position: fixed;
		inset: 64px 16px auto auto;
		width: min(440px, calc(100vw - 32px));
		margin: 0;
		padding: 20px;
		overflow-y: auto;
		border: 1px solid var(--rule);
		border-radius: var(--rad-md);
		background: var(--ink-2);
		color: var(--text);
	}
	.rescue-wrap {
		max-width: var(--frame-max);
		margin: auto;
		padding-inline: var(--gutter);
	}
	.help-slot {
		display: contents;
	}
	/* HelpOverlay's own rule, needed before its chunk loads: the "?" glyph in Geist 600 (T4). */
	.help-slot :global(.help-btn) {
		font-weight: 600;
	}
</style>
