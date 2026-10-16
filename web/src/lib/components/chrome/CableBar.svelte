<script lang="ts">
	import type { Snippet } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import Nav from './Nav.svelte';
	import LanguageToggle from './LanguageToggle.svelte';

	interface Props {
		currentPath?: string;
		statusText?: string;
		connected?: boolean;
		/** Current curve differs from what is on the cable (boolean; there is no change count). */
		unsaved?: boolean;
		writeDisabled?: boolean;
		onNeutro?: () => void;
		onPadraoAuri?: () => void;
		onWrite?: () => void;
		onAudio?: () => void;
		navigation?: Snippet;
		status?: Snippet;
		unsavedIndicator?: Snippet;
		audio?: Snippet;
		actions?: Snippet;
	}

	let {
		currentPath = '/',
		statusText = m.chrome_cable_disconnected(),
		connected = false,
		unsaved = false,
		writeDisabled = false,
		onNeutro,
		onPadraoAuri,
		onWrite,
		onAudio,
		navigation,
		status,
		unsavedIndicator,
		audio,
		actions
	}: Props = $props();
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
			<div class="cable-state" role="status">
				{#if status}
					{@render status()}
				{:else}
					<span class="status-dot" class:connected aria-hidden="true">●</span>
					<span>{statusText}</span>
				{/if}
			</div>
			<div class="dirty" class:has={unsaved} aria-live="polite" aria-atomic="true">
				{#if unsavedIndicator}
					{@render unsavedIndicator()}
				{:else if unsaved}
					{m.chrome_unsaved()}
				{/if}
			</div>
			{#if audio}
				{@render audio()}
			{:else}
				<button type="button" onclick={() => onAudio?.()} disabled={!onAudio}>
					<span aria-hidden="true">♪</span>
					{m.chrome_audio()}
				</button>
			{/if}
			{#if actions}
				{@render actions()}
			{:else}
				<button type="button" onclick={() => onNeutro?.()} disabled={!onNeutro}>
					{m.chrome_neutral()}
				</button>
				<button type="button" onclick={() => onPadraoAuri?.()} disabled={!onPadraoAuri}>
					{m.chrome_default_auri()}
				</button>
				<button
					type="button"
					class="primary"
					onclick={() => onWrite?.()}
					disabled={writeDisabled || !onWrite}
				>
					{m.chrome_write()}
				</button>
			{/if}
			<LanguageToggle />
		</div>
	</div>
</header>
<div class="bar-space" aria-hidden="true"></div>

<style>
	.cable-bar {
		box-sizing: border-box;
		position: fixed;
		inset: 0 0 auto;
		z-index: 60;
		height: 56px;
		border-bottom: 1px solid #353530;
		background: #171715;
		color: #ece7dd;
		font-family: var(--ui, 'Geist', system-ui, sans-serif);
	}

	.bar-space {
		height: 56px;
	}

	.cable-inner {
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 22px;
		max-width: 1480px;
		height: 100%;
		margin: auto;
		padding: 0 24px;
		overflow-x: auto;
		scrollbar-width: thin;
	}

	.wordmark {
		flex: none;
		color: inherit;
		font: italic 27px/1 var(--serif, 'Instrument Serif', Georgia, serif);
		text-decoration: none;
		white-space: nowrap;
	}

	.navigation {
		align-self: stretch;
		margin-inline: auto;
	}

	.cable-actions {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		white-space: nowrap;
	}

	button {
		min-height: 32px;
		padding: 7px 10px;
		border: 1px solid #57554e;
		border-radius: 3px;
		background: transparent;
		color: inherit;
		font: 11px/1.2 var(--ui, 'Geist', system-ui, sans-serif);
		cursor: pointer;
	}

	button:hover:not(:disabled) {
		border-color: #aaa499;
	}

	button.primary {
		border-color: var(--accent, #ff7a2f);
		background: var(--accent, #ff7a2f);
		color: #120a05;
		font-weight: 650;
	}

	button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.cable-state {
		padding: 4px 9px;
		border: 1px solid #353530;
		border-radius: 999px;
		color: #b5afa4;
		font-size: 10.5px;
	}

	.status-dot {
		margin-right: 5px;
		color: #aaa499;
		font-size: 8px;
	}

	.status-dot.connected {
		color: #3ddc97;
	}

	.dirty {
		max-width: 100px;
		color: #aaa499;
		font: 9.5px/1.35 var(--mono, 'JetBrains Mono', monospace);
		white-space: normal;
	}

	.dirty.has {
		color: var(--accent, #ff7a2f);
	}

	a:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 3px;
	}

	@media (max-width: 720px) {
		.cable-inner {
			gap: 16px;
			padding-inline: 14px;
		}
	}
</style>
