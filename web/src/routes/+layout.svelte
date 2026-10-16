<script lang="ts">
	import '#lib/styles/index.css';
	import { onMount, type Snippet } from 'svelte';
	import { page } from '$app/state';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale, getTextDirection } from '#lib/paraglide/runtime.js';
	import { PUBLIC_GITHUB_URL } from '#lib/config/public.ts';
	import { setAppContext } from '#lib/app/index.ts';
	import { getFooterHonoree, getPageMeta } from '#lib/page-meta.ts';
	import {
		CableBar,
		Footer,
		HelpOverlay,
		Toast,
		createToastStore
	} from '#lib/components/chrome/index.ts';
	import { AudioLoader } from '#lib/components/audio/index.ts';
	import { CableStatus, PreWriteChecklist, RescueNotice } from '#lib/components/cable/index.ts';

	let { children }: { children: Snippet } = $props();
	const context = setAppContext();
	const app = $derived(context.client);
	const emptyToasts = createToastStore();
	const meta = $derived(getPageMeta(page.route.id ?? page.url.pathname));
	const homage = $derived(getFooterHonoree(meta));
	const pending = $derived(app?.pendingWrite);
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
	const shortcuts = $derived([
		{ keys: '?', description: m.layout_shortcut_help() },
		{ keys: 'Esc', description: m.layout_shortcut_close() },
		{ keys: 'Ctrl / ⌘ + Z', description: m.layout_shortcut_undo() },
		{ keys: 'Ctrl / ⌘ + Shift + Z', description: m.layout_shortcut_redo() }
	]);
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

	// Prerendered HTML carries the base locale; keep <html lang/dir> in sync with the client locale.
	$effect(() => {
		const locale = getLocale();
		document.documentElement.lang = locale;
		document.documentElement.dir = getTextDirection(locale);
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
			unsavedCount={app?.state.curve.dirty ? 1 : 0}
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
		</CableBar>
	</div>

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
	<div data-chrome="footer">
		<Footer {honoree} githubUrl={PUBLIC_GITHUB_URL} />
	</div>
</div>

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
