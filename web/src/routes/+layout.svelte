<script lang="ts">
	import '#lib/styles/index.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale, getTextDirection } from '#lib/paraglide/runtime.js';
	import { PUBLIC_GITHUB_URL } from '#lib/config/public.ts';
	import { setAppContext } from '#lib/app/index.ts';
	import { dev } from '$app/env';
	import UpdatePrompt from '#lib/pwa/UpdatePrompt.svelte';
	import { getFooterHonoree, getPageMeta } from '#lib/page-meta.ts';
	import {
		AccountEntry,
		AccountSession,
		CableBar,
		Footer,
		HelpOverlay,
		Toast,
		appShortcuts,
		createToastStore,
		postPolicyAcceptance,
		revealLocale
	} from '#lib/components/chrome/index.ts';
	import { AudioLoader } from '#lib/components/audio/index.ts';
	import { CableStatus, PreWriteChecklist, RescueNotice } from '#lib/components/cable/index.ts';
	import {
		PolicyBanner,
		resolveAnonymousSeen,
		writePolicySeen
	} from '#lib/components/legal/index.ts';
	import { POLICY_VERSION } from '#lib/content/legal/version.ts';
	import SocialSync from '#lib/components/social/SocialSync.svelte';
	import { startOutboxBridge } from '#lib/cable/outbox-bridge.ts';
	import { createSocialApi, createSocialOutbox, createSocialSession } from '#lib/social/index.ts';
	import type { LayoutProps } from './$types';

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
	const context = setAppContext();
	const app = $derived(context.client);
	const emptyToasts = createToastStore();
	const meta = $derived(getPageMeta(page.route.id ?? page.url.pathname));
	const homage = $derived(getFooterHonoree(meta));
	const pending = $derived(app?.pendingWrite);
	// Social activity (F4): one outbox over the app's store, flushed by SocialSync; real cable
	// writes of a remembered community curve enqueue an installed event through the bridge, only
	// for the signed-in, verified account that wrote (SocialSync purges on sign-out or switch).
	const socialSession = createSocialSession();
	const socialApi = createSocialApi();
	const socialOutbox = $derived(
		app ? createSocialOutbox({ store: app.state.outbox, session: socialSession }) : null
	);
	$effect(() => {
		const client = app;
		const outbox = socialOutbox;
		if (!client || !outbox) return;
		return startOutboxBridge({
			app: client,
			outbox,
			session: socialSession,
			onqueued: (result) => {
				if (result.ok) void outbox.flush(socialApi);
			}
		});
	});
	const statusId = $props.id();

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

	onMount(() => {
		anonymousSeen = resolveAnonymousSeen(POLICY_VERSION);
	});

	onMount(() => {
		const client = context.mount();
		if (client) {
			void client.start().catch((error: unknown) => {
				console.error('App restore failed', error);
				client.toasts.push(m.layout_error_generic(), { tone: 'error' });
			});
		}
		return () => context.dispose();
	});

	function loadEditor(which: 'neutral' | 'auri') {
		if (!app) return;
		const loaded = which === 'neutral' ? app.loadNeutral() : app.loadAuriDefault();
		if (loaded) app.toasts.push(m.layout_editor_loaded());
	}

	function onKeydown(event: KeyboardEvent) {
		if (!app || event.defaultPrevented || event.repeat || event.isComposing || event.altKey) return;
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

	// Prerendered HTML carries the base locale; /lang-boot.js hides it when the visitor resolves to
	// another locale. Once hydrated in the client locale, sync <html lang/dir> and reveal the page.
	$effect(() => {
		const locale = getLocale();
		revealLocale(document.documentElement, locale, getTextDirection(locale));
	});
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app-root" data-page={meta.page} style:--accent={meta.accent}>
	<a class="skip-link" href="#main-content">{m.layout_skip()}</a>
	<div data-chrome="bar">
		<!-- CableBar owns Nav and LanguageToggle; slots retain one of each shared control. -->
		<CableBar
			currentPath={page.url.pathname}
			connected={app?.cableState.connection === 'connected'}
			unsaved={app?.state.curve.unsaved ?? false}
			writeDisabled={!app || app.cableState.writing}
			onNeutro={app ? () => loadEditor('neutral') : undefined}
			onPadraoAuri={app ? () => loadEditor('auri') : undefined}
			onWrite={app ? () => app?.requestWrite() : undefined}
		>
			{#snippet status()}
				<button type="button" class="status-trigger" popovertarget={statusId} disabled={!app}>
					<span aria-hidden="true">●</span>
					{statusText}
				</button>
			{/snippet}
			{#snippet audio()}
				{#if app}
					<AudioLoader engine={app.audio} />
				{:else}
					<button type="button" disabled
						><span aria-hidden="true">♪</span> {m.chrome_audio()}</button
					>
				{/if}
			{/snippet}
			{#snippet account()}
				<AccountEntry
					user={accountSession.current}
					currentPath={page.url.pathname}
					pending={!accountSession.known}
				/>
			{/snippet}
		</CableBar>
	</div>

	{#if policyBanner}
		<div data-chrome="policy">
			<PolicyBanner
				version={POLICY_VERSION}
				seenVersion={policyBanner.seen}
				onAccept={policyBanner.accept}
			/>
		</div>
	{/if}

	<div id={statusId} popover="auto" class="cable-popover" data-chrome="status">
		{#if app}
			<CableStatus service={app.cable} />
		{/if}
	</div>

	{#if app}
		<div class="rescue-wrap" data-chrome="rescue">
			<RescueNotice service={app.cable} onrescue={() => app?.requestRescue()} />
		</div>
	{/if}
	<div id="main-content" tabindex="-1">{@render children()}</div>

	{#if app && pending}
		<PreWriteChecklist
			service={app.cable}
			open={true}
			bands={pending.bands}
			preampDb={pending.preampDb}
			name={pending.name}
			experimental={app.experimentalWrite}
			onclose={() => app?.closeChecklist()}
			onresult={(outcome) => app?.onWriteResult(outcome)}
		/>
	{/if}
	<div class="help-trigger" data-chrome="help">
		<HelpOverlay {shortcuts} />
	</div>
	<Toast store={app?.toasts ?? emptyToasts} />
	<SocialSync
		{app}
		account={accountSession.known ? accountSession.current : undefined}
		session={socialSession}
		api={socialApi}
		outbox={socialOutbox}
	/>
	<div data-chrome="footer">
		<Footer {honoree} githubUrl={PUBLIC_GITHUB_URL} />
	</div>
</div>

<UpdatePrompt enabled={!dev} workerUrl="/service-worker.js" scope="/" />

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
	.status-trigger {
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.cable-popover {
		position: fixed;
		inset: 64px 16px auto auto;
		width: min(440px, calc(100vw - 32px));
		margin: 0;
		padding: 20px;
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
	.help-trigger {
		position: fixed;
		right: 16px;
		bottom: 16px;
		z-index: 50;
	}
</style>
