<!--
	Global bar (FUX.NAV): one row that never scrolls sideways, from 320 to 2560 px.
	- Desktop (> 720 px), 40 px tall: wordmark; the main navigation, whose links fold into
	  "Mais" by tier as the bar narrows (Nav.svelte); then the cable status (lamp and a short
	  label; full text for screen readers, in the tooltip and in the popover), play/pause, ♪ Áudio,
	  the editor presets (Neutro, Padrão Auri: a "Carregar no editor" menu, inline buttons from
	  1600 px), "Gravar no cabo" (a dot, or the count, for unsaved changes), and the account,
	  language and help as square buttons with tooltips.
	- Mobile (≤ 720 px), 52 px tall: wordmark, cable lamp, play/pause, ♪, "Gravar" and a menu button;
	  the menu sheet (BarSheet, its own chunk) holds the navigation, the presets, the account, the
	  language and the help. 44 px touch targets.
	- Overflow guard: the CSS tiers fit the usual content; if something still does not fit
	  (another locale, a long file name, a user font), `data-squeeze` folds more, one level at a
	  time (status label and file name, then nav tiers 3, 2, 1, 0), until the row fits. On mobile
	  the levels fold spacing, then the "Gravar" padding; below 360 px the folded spacing is the
	  static CSS, so 320 px fits without the guard.
	Every unavailable action says why (T8); writes only go through `onWrite` (the layout's
	`app.requestWrite()`, which opens the checklist).
-->
<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { LazyModule } from '#lib/app/lazy.svelte.ts';
	// Direct files, not the primitives barrel: the bar is in every route's first load, and the
	// barrel would bring every primitive (and their module side effects) along (FUX.NAV budgets).
	import Button from '#lib/components/primitives/Button.svelte';
	import IconButton from '#lib/components/primitives/IconButton.svelte';
	import Lamp from '#lib/components/primitives/Lamp.svelte';
	import Tooltip from '#lib/components/primitives/Tooltip.svelte';
	import type { MenuItem } from '#lib/components/primitives/Menu.svelte';
	import LazyMenu from './LazyMenu.svelte';
	import Nav from './Nav.svelte';
	import LanguageToggle from './LanguageToggle.svelte';
	import PlayStoreLink from './PlayStoreLink.svelte';
	import { togglePreview, type PlaybackEngine, type PlaybackErrorHandler } from './playback.ts';

	interface Props {
		currentPath?: string;
		statusText?: string;
		/** Short visible form of `statusText` (≤ 12 characters); the full text stays announced. */
		statusShort?: string;
		connected?: boolean;
		/** Current curve differs from what is on the cable. */
		unsaved?: boolean;
		/**
		 * Number of unsaved changes, when the caller counts them. Shown with the right
		 * singular/plural ("1 alteração não gravada", "3 alterações não gravadas"); without
		 * it the indicator stays a boolean ("Alterações não gravadas no cabo").
		 */
		unsavedCount?: number;
		writeDisabled?: boolean;
		/** Why "Gravar no cabo" is unavailable; defaults explain loading or a write in progress. */
		writeDisabledReason?: string;
		onNeutro?: () => void;
		onPadraoAuri?: () => void;
		onWrite?: () => void;
		onAudio?: () => void;
		/** Existing page-created preview only; absent until the lazy app runtime arrives. */
		playbackEngine?: PlaybackEngine;
		onPlaybackError?: PlaybackErrorHandler;
		/** Opens the help dialog from the mobile menu sheet (the layout's lazy HelpOverlay). */
		onHelp?: () => void;
		navigation?: Snippet;
		status?: Snippet;
		unsavedIndicator?: Snippet;
		audio?: Snippet;
		actions?: Snippet;
		/** Header account entry (the layout renders AccountEntry here). */
		account?: Snippet;
		/** Help trigger (the layout renders HelpOverlay here; it used to float over pages, T3). */
		help?: Snippet;
	}

	let {
		currentPath = '/',
		statusText = m.chrome_cable_disconnected(),
		statusShort,
		connected = false,
		unsaved = false,
		unsavedCount,
		writeDisabled = false,
		writeDisabledReason,
		onNeutro,
		onPadraoAuri,
		onWrite,
		onAudio,
		playbackEngine,
		onPlaybackError,
		onHelp,
		navigation,
		status,
		unsavedIndicator,
		audio,
		actions,
		account,
		help
	}: Props = $props();

	const uid = $props.id();
	/** The announced unsaved text; also Gravar's description (static, the tooltip only shows it). */
	const dirtyId = `${uid}-dirty`;

	const dirty = $derived(
		unsavedCount !== undefined ? Number.isFinite(unsavedCount) && unsavedCount > 0 : unsaved
	);
	const unsavedText = $derived(
		!dirty
			? ''
			: unsavedCount === undefined
				? m.chrome_unsaved()
				: unsavedCount === 1
					? m.fux1_unsaved_one()
					: m.fux1_unsaved_other({ count: String(unsavedCount) })
	);
	/** The badge on "Gravar no cabo": the count when known (capped), a dot otherwise. */
	const badge = $derived(
		unsavedCount !== undefined && dirty ? (unsavedCount > 99 ? '99+' : String(unsavedCount)) : ''
	);
	// T8: an unavailable bar action always says why.
	const writeReason = $derived(
		!onWrite
			? (writeDisabledReason ?? m.fux1_write_loading())
			: writeDisabled
				? (writeDisabledReason ?? m.fux1_write_busy())
				: null
	);
	const editorReason = $derived(m.fux1_editor_loading());
	let playbackState = $state.raw<ReturnType<PlaybackEngine['state']> | null>(null);
	$effect(() => {
		const engine = playbackEngine;
		playbackState = engine?.state() ?? null;
		return engine?.onChange((next) => {
			playbackState = next;
		});
	});
	const playbackLabel = $derived(
		playbackState?.playing ? m.transport_toggle_pause() : m.transport_toggle_resume()
	);
	const playbackReason = $derived(
		!playbackState
			? m.seek3_audio_loading()
			: playbackState.canToggle
				? null
				: playbackState.toggleReason === 'unsupported'
					? m.transport_toggle_unsupported()
					: m.transport_toggle_no_session()
	);

	const tools = $derived<MenuItem[]>([
		{
			id: 'neutro',
			label: m.chrome_neutral(),
			disabledReason: onNeutro ? null : editorReason,
			onselect: () => onNeutro?.()
		},
		{
			id: 'padrao-auri',
			label: m.chrome_default_auri(),
			disabledReason: onPadraoAuri ? null : editorReason,
			onselect: () => onPadraoAuri?.()
		}
	]);
	let toolsOpen = $state(false);
	let toolsTrigger: HTMLButtonElement | undefined = $state();
	let toolsTip = $state(false);
	let writeElement: HTMLButtonElement | undefined = $state();
	// An open menu shows its own content; the trigger's tooltip would cover it.
	// Also when a hover delay that started before the menu opened fires afterwards.
	$effect(() => {
		if (toolsOpen && toolsTip) toolsTip = false;
	});

	// --- mobile menu sheet (lazy) ----------------------------------------------------------
	const sheet = new LazyModule(() => import('./BarSheet.svelte'));
	let sheetOpen = $state(false);

	function warmSheet(): void {
		sheet.request();
	}

	async function openSheet(): Promise<void> {
		try {
			await sheet.load();
		} catch (error) {
			console.error('The menu could not load', error);
			return;
		}
		sheetOpen = true;
	}

	function closeSheet(): void {
		sheetOpen = false;
	}

	// A navigation (link in the sheet, back button) or a wider window closes the sheet.
	let lastPath = untrack(() => currentPath);
	$effect(() => {
		const path = currentPath;
		if (path === lastPath) return;
		lastPath = path;
		untrack(closeSheet);
	});
	$effect(() => {
		const wide = window.matchMedia('(min-width: 721px)');
		const change = () => {
			if (wide.matches) closeSheet();
		};
		wide.addEventListener('change', change);
		return () => wide.removeEventListener('change', change);
	});

	// --- overflow guard ---------------------------------------------------------------------
	let header: HTMLElement | undefined = $state();
	let inner: HTMLDivElement | undefined = $state();
	const SQUEEZE_MAX = 5;
	/** Committed level; the template mirrors it, so Svelte keeps the `[data-squeeze]` rules. */
	let squeezeLevel = $state(0);
	const squeezeValue = $derived(levels(squeezeLevel));

	function levels(level: number): string {
		return Array.from({ length: level }, (_, index) => String(index + 1)).join(' ');
	}

	/**
	 * Smallest level at which the row fits. Probing writes the attribute directly (one
	 * synchronous layout per level, never painted) and always ends on the result; the level is
	 * committed through state only when it changed. A fit that changes nothing therefore leaves
	 * the DOM exactly as it was: no attribute change, no size change, no observer feedback.
	 */
	function fit(): void {
		const bar = header;
		const row = inner;
		if (!bar || !row) return;
		let level = 0;
		bar.dataset.squeeze = levels(0);
		while (level < SQUEEZE_MAX && row.scrollWidth > row.clientWidth + 1) {
			bar.dataset.squeeze = levels(++level);
		}
		if (level !== squeezeLevel) squeezeLevel = level;
	}

	$effect(() => {
		const row = inner;
		if (!row) return;
		// What can change the fit: the row's width (window), and the widths of what it holds
		// (labels, snippets, fonts, a file name). No MutationObserver: live DOM inside the bar
		// (a playing preview's readouts, menu items, tooltips) must never schedule work.
		const parts = [row, ...row.children];
		/** Widths right after the last fit: notifications that only echo a fit are ignored. */
		const fitted = new WeakMap<Element, number>();
		const remember = () => {
			for (const part of parts) fitted.set(part, part.getBoundingClientRect().width);
		};
		let frame = 0;
		const run = () => {
			frame = 0;
			untrack(fit);
			remember();
		};
		const resize = new ResizeObserver((entries) => {
			const changed = entries.some((entry) => {
				const width = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
				return Math.abs(width - (fitted.get(entry.target) ?? -1)) > 0.5;
			});
			if (changed && frame === 0) frame = requestAnimationFrame(run);
		});
		untrack(fit);
		remember();
		for (const part of parts) resize.observe(part);
		return () => {
			cancelAnimationFrame(frame);
			resize.disconnect();
		};
	});
</script>

<header class="cable-bar" data-squeeze={squeezeValue} bind:this={header}>
	<div class="cable-inner" bind:this={inner}>
		<a class="wordmark" href="/">open-auri</a>
		<div class="navigation">
			{#if navigation}
				{@render navigation()}
			{:else}
				<Nav {currentPath} />
			{/if}
		</div>
		<div class="cable-actions">
			<div class="bar-status">
				<div class="cable-state" class:on={connected} role="status">
					{#if status}
						{@render status()}
					{:else}
						<span class="status-fallback">
							<Lamp on={connected} tone="ok" />
							<span class="status-short" aria-hidden="true">{statusShort ?? statusText}</span>
							<span class="sr-only">{statusText}</span>
						</span>
					{/if}
				</div>
				<!-- Announced on change; seen as the dot (or count) on "Gravar no cabo". -->
				<div
					id={dirtyId}
					class="dirty sr-only"
					class:has={dirty}
					aria-live="polite"
					aria-atomic="true"
				>
					{#if unsavedIndicator}
						{@render unsavedIndicator()}
					{:else}
						{unsavedText}
					{/if}
				</div>
			</div>
			<div class="bar-tools">
				<IconButton
					size="sm"
					variant="plate"
					class="btn--bar playback-btn"
					label={playbackLabel}
					aria-keyshortcuts="k"
					disabledReason={playbackReason}
					onclick={() => void togglePreview(playbackEngine, onPlaybackError)}
				>
					{playbackState?.playing ? '❚❚' : '▶'}
				</IconButton>
				{#if audio}
					{@render audio()}
				{:else}
					<Button
						size="sm"
						variant="plate"
						class="btn--bar bar-audio"
						disabledReason={onAudio ? null : m.fux1_audio_loading()}
						onclick={() => onAudio?.()}
					>
						<span class="bar-audio-glyph" aria-hidden="true">♪</span>
						<span class="bar-audio-name">{m.chrome_audio()}</span>
					</Button>
				{/if}
				{#if actions}
					{@render actions()}
				{:else}
					<span class="tools-inline">
						<Button
							size="sm"
							variant="plate"
							class="btn--bar"
							disabledReason={onNeutro ? null : editorReason}
							onclick={() => onNeutro?.()}
						>
							{m.chrome_neutral()}
						</Button>
						<Button
							size="sm"
							variant="plate"
							class="btn--bar"
							disabledReason={onPadraoAuri ? null : editorReason}
							onclick={() => onPadraoAuri?.()}
						>
							{m.chrome_default_auri()}
						</Button>
					</span>
					<span class="tools-menu">
						<LazyMenu
							items={tools}
							bind:open={toolsOpen}
							bind:triggerElement={toolsTrigger}
							class="btn btn--plate btn--sm btn--bar btn--icon tools-trigger"
							aria-label={m.fuxnav_tools()}
						>
							{#snippet trigger()}
								<!-- Two faders: load a preset into the editor (never writes). -->
								<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
									<path
										d="M5 2.5v11M11 2.5v11"
										fill="none"
										stroke="currentColor"
										stroke-width="1.4"
										stroke-linecap="round"
									/>
									<rect x="3" y="8.5" width="4" height="2.5" rx="0.6" fill="currentColor" />
									<rect x="9" y="4.5" width="4" height="2.5" rx="0.6" fill="currentColor" />
								</svg>
							{/snippet}
						</LazyMenu>
						<Tooltip
							text={m.fuxnav_tools()}
							anchor={toolsOpen ? null : toolsTrigger}
							bind:open={toolsTip}
						/>
					</span>
					<Button
						size="sm"
						variant="primary"
						class={['primary', 'btn--bar', 'write-btn', dirty && 'is-dirty']}
						bind:element={writeElement}
						aria-label={m.chrome_write()}
						aria-describedby={dirty && !writeReason ? dirtyId : undefined}
						disabledReason={writeReason}
						onclick={() => onWrite?.()}
					>
						<span class="write-full">{m.chrome_write()}</span>
						<span class="write-short">{m.fuxnav_write_short()}</span>
						{#if dirty}<span class="write-badge" aria-hidden="true">{badge}</span>{/if}
					</Button>
					{#if dirty && !writeReason}
						<Tooltip text={unsavedText} anchor={writeElement} />
					{/if}
				{/if}
			</div>
			<div class="bar-meta bar-compact">
				{#if account}<span class="meta-account">{@render account()}</span>{/if}
				<PlayStoreLink />
				<span class="meta-lang"><LanguageToggle /></span>
				{#if help}<span class="meta-help">{@render help()}</span>{/if}
				<IconButton
					size="sm"
					variant="plate"
					class="btn--bar menu-btn"
					label={m.fuxnav_menu_open()}
					aria-haspopup="dialog"
					aria-expanded={sheetOpen}
					onpointerenter={warmSheet}
					onpointerdown={warmSheet}
					onfocus={warmSheet}
					onclick={() => void openSheet()}
				>
					<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
						<path
							d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
						/>
					</svg>
				</IconButton>
			</div>
		</div>
	</div>
</header>
<div class="bar-space" aria-hidden="true"></div>
{#if sheetOpen && sheet.current}
	{@const Sheet = sheet.current}
	<Sheet
		{currentPath}
		{navigation}
		{account}
		tools={!actions}
		{onNeutro}
		{onPadraoAuri}
		{editorReason}
		{onHelp}
		onclose={closeSheet}
	/>
{/if}

<style>
	/* Material from the mocks' bar: ink-2 with a hairline and a soft top highlight. */
	.cable-bar {
		--bar-row: 40px;
		box-sizing: border-box;
		position: fixed;
		inset: 0 0 auto;
		z-index: 60;
		height: var(--bar-row);
		border-bottom: 1px solid var(--rule);
		background: var(--bar-bg);
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.03),
			0 1px 0 rgba(0, 0, 0, 0.6),
			0 10px 24px -20px rgba(0, 0, 0, 0.9);
		color: var(--text);
		font-family: var(--face-body);
	}

	.bar-space {
		height: 40px;
	}

	/* No overflow property: nothing scrolls or clips here, the guard keeps the row in. */
	.cable-inner {
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		max-width: var(--frame-max);
		height: 100%;
		margin: auto;
		padding: 0 var(--gutter);
	}

	.wordmark {
		flex: none;
		color: inherit;
		font: italic 400 var(--fs-lede) / 1 var(--face-display);
		letter-spacing: var(--tracking-title);
		text-decoration: none;
		white-space: nowrap;
	}

	.wordmark:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}

	.navigation {
		display: flex;
		flex: none;
		align-self: stretch;
	}

	.cable-actions {
		display: flex;
		flex: none;
		align-items: center;
		gap: var(--space-2);
		margin-left: auto;
		white-space: nowrap;
	}

	.bar-status,
	.bar-tools,
	.bar-meta {
		display: flex;
		flex: none;
		align-items: center;
		gap: var(--space-1);
	}

	/* Hairline between the cable controls and the account, language and help. */
	.bar-meta {
		padding-left: var(--space-2);
		border-left: 1px solid var(--rule);
	}

	.meta-account,
	.meta-lang,
	.meta-help,
	.tools-inline,
	.tools-menu {
		display: contents;
	}

	/* --- cable status -------------------------------------------------------------------- */
	.cable-state {
		display: inline-flex;
		align-items: center;
		color: var(--state-text);
		font-size: var(--label-min);
		line-height: var(--lh-caps);
		/* Skeleton geometry while the runtime loads (layout): the trigger's lamp and label. */
		--status-skeleton-w: 5.25rem;
		--status-skeleton-h: 0.75rem;
	}

	.cable-state.on {
		color: var(--accent-text);
	}

	.status-fallback,
	.cable-state :global(.status-trigger) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0 8px;
		color: inherit;
		font: 500 var(--label-min) / var(--lh-caps) var(--face-body);
	}

	.status-fallback,
	.cable-state :global(.status-skeleton-slot) {
		min-height: 32px;
	}

	.cable-state :global(.status-skeleton-slot) {
		display: inline-flex;
		align-items: center;
		padding: 0 8px;
	}

	.cable-state :global(.status-short) {
		display: inline-block;
		max-width: 12ch;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cable-state :global(.lamp) {
		width: 8px;
		height: 8px;
	}

	/* The bar's plain snippet buttons keep the bar recipe (T1). */
	.bar-tools > :global(button:not(.btn)) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		box-sizing: border-box;
		min-height: 32px;
		padding: 0 10px;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-sm);
		background: color-mix(in srgb, var(--text) 4%, transparent);
		box-shadow: var(--bevel);
		color: var(--text);
		font: 500 var(--fs-caption) / var(--lh-ui) var(--face-body);
		white-space: nowrap;
		cursor: pointer;
	}

	/* --- Áudio fallback (the layout renders AudioLoader, same geometry) -------------------- */
	.bar-tools :global(.bar-audio) {
		width: var(--btn-h);
		padding: 0;
	}

	.bar-tools :global(.bar-audio-glyph) {
		font-size: var(--fs-ui);
		line-height: 1;
	}

	.bar-tools :global(.bar-audio-name) {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	/* --- presets: menu below 1600 px, inline buttons above ---------------------------------- */
	.tools-inline > :global(.btn) {
		display: none;
	}

	@media (min-width: 1600px) {
		.tools-inline > :global(.btn) {
			display: inline-flex;
		}

		.tools-menu > :global(.tools-trigger) {
			display: none;
		}

		.bar-tools :global(.bar-audio) {
			width: auto;
			padding: 0 var(--btn-pad);
		}

		.bar-tools :global(.bar-audio-name) {
			position: static;
			width: auto;
			height: auto;
			clip-path: none;
		}
	}

	/* --- Gravar no cabo ---------------------------------------------------------------------- */
	.bar-tools :global(.write-btn) {
		margin-left: var(--space-1);
	}

	.bar-tools :global(.write-short) {
		display: none;
	}

	/* Unsaved changes: a cream dot (or the count) on the accent face, ringed by the bar. */
	.bar-tools :global(.write-badge) {
		position: absolute;
		top: -5px;
		right: -5px;
		box-sizing: border-box;
		min-width: 12px;
		height: 12px;
		padding: 0 3px;
		border: 2px solid var(--bar-bg);
		border-radius: var(--rad-pill);
		background: var(--text);
		color: var(--ink);
		font: 500 var(--label-min) / 14px var(--face-data);
		font-variant-numeric: tabular-nums;
		text-align: center;
	}

	.bar-tools :global(.write-badge:not(:empty)) {
		top: -8px;
		right: -8px;
		min-width: 18px;
		height: 18px;
	}

	/* --- menu button: mobile only ------------------------------------------------------------ */
	.bar-meta :global(.menu-btn) {
		display: none;
	}

	/* --- overflow guard ---------------------------------------------------------------------- */
	.cable-bar[data-squeeze~='1'] :global(.status-short) {
		display: none;
	}

	.cable-bar[data-squeeze~='1'] .bar-tools :global(.bar-audio) {
		width: var(--btn-h);
		padding: 0;
	}

	.cable-bar[data-squeeze~='1'] .bar-tools :global(.bar-audio-name) {
		position: absolute;
		width: 1px;
		height: 1px;
		clip-path: inset(50%);
	}

	.cable-bar[data-squeeze~='2'] .tools-inline > :global(.btn) {
		display: none;
	}

	/* Desktop only: on mobile the presets are in the sheet whatever the squeeze. */
	@media (min-width: 721px) {
		.cable-bar[data-squeeze~='2'] .tools-menu > :global(.tools-trigger) {
			display: inline-flex;
		}
	}

	.cable-bar[data-squeeze~='5'] .wordmark {
		font-size: var(--fs-body);
	}

	/* Narrow desktop: the status keeps its lamp; the label is in the tooltip and popover. */
	@media (max-width: 1023px) {
		.cable-state :global(.status-short) {
			display: none;
		}

		.cable-state {
			--status-skeleton-w: 0.75rem;
		}
	}

	/*
	 * Mobile (≤ 720 px): one row. Wordmark, cable lamp, play/pause, ♪, "Gravar" and the menu button;
	 * navigation, presets, account, language and help move into the menu sheet. 44 px targets.
	 * The help snippet stays mounted (its dialog lives there); only its trigger hides.
	 */
	@media (max-width: 720px) {
		.cable-bar {
			--bar-row: 52px;
		}

		.bar-space {
			height: 52px;
		}

		.cable-inner {
			gap: var(--space-2);
			padding-inline: var(--gutter) calc(var(--gutter) - 4px);
		}

		/* Same width, a 44 px tall target for the home link. */
		.wordmark {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
		}

		.navigation,
		.meta-account,
		.meta-lang {
			display: none;
		}

		.tools-inline > :global(.btn),
		.tools-menu > :global(.tools-trigger),
		.meta-help :global(.help-btn) {
			display: none;
		}

		.cable-actions,
		.bar-status,
		.bar-tools,
		.bar-meta {
			gap: var(--space-1);
		}

		.bar-meta {
			padding-left: 0;
			border-left: 0;
		}

		.bar-meta :global(.menu-btn) {
			display: inline-flex;
		}

		.cable-state :global(.status-trigger),
		.cable-state :global(.status-skeleton-slot),
		.status-fallback {
			justify-content: center;
			box-sizing: border-box;
			min-width: 44px;
			min-height: 44px;
			padding: 0;
		}

		.cable-state :global(.lamp) {
			width: 10px;
			height: 10px;
		}

		.cable-state {
			--status-skeleton-w: 10px;
			--status-skeleton-h: 10px;
		}

		.bar-tools :global(.write-btn) {
			margin-left: 0;
		}

		.bar-tools :global(.write-full) {
			display: none;
		}

		.bar-tools :global(.write-short) {
			display: inline;
		}

		.cable-bar[data-squeeze~='1'] .wordmark {
			font-size: var(--fs-body);
		}

		/* At 320 px retain every control and its 44 px target; fold spacing, not actions. */
		.cable-bar[data-squeeze~='1'] .cable-inner {
			gap: var(--space-1);
			padding-inline: var(--space-1);
		}

		.cable-bar[data-squeeze~='1'] .cable-actions,
		.cable-bar[data-squeeze~='1'] .bar-tools {
			gap: 0;
		}

		/* Still too wide (a longer locale, a user font): a tighter "Gravar", same 44 px target. */
		.cable-bar[data-squeeze~='2'] .bar-tools :global(.write-btn) {
			--btn-pad: 8px;
		}
	}

	/*
	 * Narrow phones (< 360 px): the folded spacing above is the static layout, not only a guard
	 * level. Unfolded, the mobile row needs about 350 px (wordmark at --fs-lede, 16 and 12 px
	 * gutters, 8 and 4 px gaps), so at 320 px it fitted only while the guard held level 1;
	 * whenever the guard sat at level 0 the actions and the menu button ran about 19 px past
	 * the right edge. Now the row fits from CSS alone; the guard only folds the extra levels.
	 */
	@media (max-width: 359.98px) {
		.wordmark {
			font-size: var(--fs-body);
		}

		.cable-inner {
			gap: var(--space-1);
			padding-inline: var(--space-1);
		}

		.cable-actions,
		.bar-tools {
			gap: 0;
		}
	}
</style>
