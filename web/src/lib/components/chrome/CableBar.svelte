<script lang="ts">
	import type { Snippet } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { Button } from '#lib/components/primitives/index.ts';
	import Nav from './Nav.svelte';
	import LanguageToggle from './LanguageToggle.svelte';

	interface Props {
		currentPath?: string;
		statusText?: string;
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
		connected = false,
		unsaved = false,
		unsavedCount,
		writeDisabled = false,
		writeDisabledReason,
		onNeutro,
		onPadraoAuri,
		onWrite,
		onAudio,
		navigation,
		status,
		unsavedIndicator,
		audio,
		actions,
		account,
		help
	}: Props = $props();

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
	// T8: an unavailable bar action always says why.
	const writeReason = $derived(
		!onWrite
			? (writeDisabledReason ?? m.fux1_write_loading())
			: writeDisabled
				? (writeDisabledReason ?? m.fux1_write_busy())
				: null
	);
	const editorReason = $derived(m.fux1_editor_loading());
</script>

<header class="cable-bar">
	<div class="cable-inner">
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
						<span class="status-dot" class:connected aria-hidden="true">●</span>
						<span>{statusText}</span>
					{/if}
				</div>
				<div class="dirty" class:has={dirty} aria-live="polite" aria-atomic="true">
					{#if unsavedIndicator}
						{@render unsavedIndicator()}
					{:else}
						{unsavedText}
					{/if}
				</div>
			</div>
			<div class="bar-tools">
				{#if audio}
					{@render audio()}
				{:else}
					<Button
						size="sm"
						variant="plate"
						disabledReason={onAudio ? null : m.fux1_audio_loading()}
						onclick={() => onAudio?.()}
					>
						<span aria-hidden="true">♪</span>
						{m.chrome_audio()}
					</Button>
				{/if}
				{#if actions}
					{@render actions()}
				{:else}
					<Button
						size="sm"
						variant="plate"
						disabledReason={onNeutro ? null : editorReason}
						onclick={() => onNeutro?.()}
					>
						{m.chrome_neutral()}
					</Button>
					<Button
						size="sm"
						variant="plate"
						disabledReason={onPadraoAuri ? null : editorReason}
						onclick={() => onPadraoAuri?.()}
					>
						{m.chrome_default_auri()}
					</Button>
					<Button
						size="sm"
						variant="primary"
						class="primary"
						disabledReason={writeReason}
						onclick={() => onWrite?.()}
					>
						{m.chrome_write()}
					</Button>
				{/if}
			</div>
			<div class="bar-meta">
				{#if account}{@render account()}{/if}
				<LanguageToggle />
				{#if help}{@render help()}{/if}
			</div>
		</div>
	</div>
</header>
<div class="bar-space" aria-hidden="true"></div>

<style>
	/* Material from the mocks' bar: ink-2 with a hairline and a soft top highlight. */
	.cable-bar {
		box-sizing: border-box;
		position: fixed;
		inset: 0 0 auto;
		z-index: 60;
		height: var(--bar-h);
		border-bottom: 1px solid var(--rule);
		background: var(--bar-bg);
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.03),
			0 1px 0 rgba(0, 0, 0, 0.6);
		color: var(--text);
		font-family: var(--face-body);
	}

	.bar-space {
		height: var(--bar-h);
	}

	.cable-inner {
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 20px;
		max-width: var(--frame-max);
		height: 100%;
		margin: auto;
		padding: 0 var(--gutter);
		overflow-x: auto;
		scrollbar-width: thin;
	}

	.wordmark {
		flex: none;
		color: inherit;
		font: italic 400 var(--fs-wordmark) / 1 var(--face-display);
		text-decoration: none;
		white-space: nowrap;
	}

	.navigation {
		align-self: stretch;
		margin-inline: auto;
	}

	.cable-actions,
	.bar-status,
	.bar-tools,
	.bar-meta {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		white-space: nowrap;
	}

	/*
	 * Bar buttons handed in through snippets as plain <button> get the same plate recipe as
	 * the bar's own buttons, like the mock's `.cable-actions button` (T1).
	 */
	.bar-tools > :global(button:not(.btn)) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		box-sizing: border-box;
		min-height: 28px;
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

	.cable-state {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 0 10px;
		border: 1px solid var(--rule);
		border-radius: var(--rad-pill);
		color: var(--state-text);
		font-size: var(--label-min);
		line-height: var(--lh-caps);
	}

	.cable-state.on {
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
		color: var(--accent-text);
	}

	.status-dot {
		margin-right: 5px;
		color: var(--muted);
		font-size: 8px;
	}

	.status-dot.connected {
		color: var(--ok);
	}

	/* Status text, not data: Geist at the label minimum (T4, T5), counts in tabular figures. */
	.dirty {
		max-width: 116px;
		color: var(--muted);
		font: 500 var(--label-min) / var(--lh-ui) var(--face-body);
		font-variant-numeric: tabular-nums;
		white-space: normal;
	}

	.dirty.has {
		color: var(--accent-text);
	}

	.wordmark:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}

	/*
	 * Mobile (spec §1.4b, mock biblioteca-mobile-top.png): the actions stay on screen above the
	 * navigation instead of hiding at the end of one scrolling strip. Rows: wordmark with
	 * account, language and help; cable status; Áudio, Neutro, Padrão Auri, Gravar no cabo;
	 * then the navigation, which alone scrolls sideways. The bar is tall here, so it scrolls
	 * away with the page instead of covering a sixth of the screen.
	 */
	@media (max-width: 720px) {
		.cable-bar {
			position: relative;
			height: auto;
		}

		.bar-space {
			display: none;
		}

		.cable-inner {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			grid-template-areas:
				'brand meta'
				'status status'
				'tools tools'
				'nav nav';
			align-items: center;
			gap: 8px 12px;
			height: auto;
			padding-top: 8px;
			overflow: visible;
		}

		.wordmark {
			grid-area: brand;
		}

		.cable-actions {
			display: contents;
		}

		.bar-meta {
			grid-area: meta;
			justify-self: end;
			gap: 4px;
		}

		.bar-status {
			grid-area: status;
			flex-wrap: wrap;
			white-space: normal;
		}

		.dirty {
			max-width: none;
		}

		.bar-tools {
			grid-area: tools;
			flex-wrap: wrap;
			justify-content: flex-end;
			white-space: normal;
		}

		.bar-tools > :global(*) {
			flex: 0 0 auto;
		}

		/* Touch targets: 44 px on mobile (--hit) */
		.bar-tools :global(.btn),
		.bar-tools > :global(button),
		.bar-meta :global(.btn) {
			min-height: var(--hit);
		}

		.bar-meta :global(.btn--icon) {
			width: var(--hit);
		}

		.navigation {
			grid-area: nav;
			align-self: stretch;
			margin-inline: calc(-1 * var(--gutter));
			padding-inline: var(--gutter);
			overflow-x: auto;
			border-top: 1px solid var(--rule);
			scrollbar-width: thin;
		}
	}
</style>
