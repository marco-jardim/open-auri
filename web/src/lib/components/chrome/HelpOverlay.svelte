<script module lang="ts">
	export interface Shortcut {
		keys: string;
		description: string;
	}
</script>

<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { modalDialog } from './modal.ts';

	interface Props {
		shortcuts: readonly Shortcut[];
		open?: boolean;
		title?: string;
		enabled?: boolean;
		showTrigger?: boolean;
		onOpenChange?: (open: boolean) => void;
	}

	let {
		shortcuts,
		open = $bindable(false),
		title = m.chrome_help_title(),
		enabled = true,
		showTrigger = true,
		onOpenChange
	}: Props = $props();
	const id = $props.id();

	function changeOpen(value: boolean) {
		if (open === value) return;
		open = value;
		onOpenChange?.(value);
	}

	function shortcut(event: KeyboardEvent) {
		if (
			!enabled ||
			event.defaultPrevented ||
			event.repeat ||
			event.key !== '?' ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			event.isComposing
		) {
			return;
		}
		const target = event.target;
		if (
			target instanceof Element &&
			target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
		) {
			return;
		}
		if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
		event.preventDefault();
		changeOpen(true);
	}
</script>

<svelte:window onkeydown={shortcut} />

{#if showTrigger}
	<button
		type="button"
		class="help-btn"
		aria-label={m.chrome_help_open()}
		aria-haspopup="dialog"
		aria-controls={id}
		aria-expanded={open}
		onclick={() => changeOpen(true)}>?</button
	>
{/if}

<dialog
	{id}
	aria-labelledby="{id}-title"
	aria-describedby="{id}-hint"
	use:modalDialog={{ open, onDismiss: () => changeOpen(false), initialFocus: '[data-close]' }}
>
	<div class="dlg">
		<h2 id="{id}-title">{title}</h2>
		<p id="{id}-hint">{m.chrome_help_hint()}</p>
		<dl class="help-grid">
			{#each shortcuts as item, index (index)}
				<dt><kbd>{item.keys}</kbd></dt>
				<dd>{item.description}</dd>
			{/each}
		</dl>
		<div class="dlg-actions">
			<button type="button" data-close onclick={() => changeOpen(false)}>{m.chrome_close()}</button>
		</div>
	</div>
</dialog>

<style>
	dialog {
		box-sizing: border-box;
		width: 100%;
		max-width: min(720px, calc(100vw - 32px));
		max-height: calc(100dvh - 32px);
		padding: 0;
		overflow-y: auto;
		border: 1px solid #57554e;
		border-radius: 8px;
		background: #171715;
		color: #ece7dd;
		font: 12px/1.5 var(--ui, 'Geist', system-ui, sans-serif);
		box-shadow: 0 30px 60px rgb(0 0 0 / 80%);
	}

	dialog::backdrop {
		background: rgb(5 5 4 / 72%);
		backdrop-filter: blur(2px);
	}

	.dlg {
		padding: 22px 24px 20px;
	}

	h2 {
		margin: 4px 0 12px;
		font: italic 400 34px/1.1 var(--serif, 'Instrument Serif', Georgia, serif);
	}

	p {
		color: #d3cdc2;
	}

	.help-grid {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 6px 16px;
	}

	dt {
		color: var(--accent, #ff7a2f);
	}

	kbd {
		font: 11px var(--mono, 'JetBrains Mono', monospace);
		white-space: nowrap;
	}

	dd {
		margin: 0;
	}

	.dlg-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 14px;
	}

	button {
		min-height: 36px;
		padding: 7px 11px;
		border: 1px solid #77736b;
		border-radius: 3px;
		background: #262725;
		color: #ece7dd;
		font: 12px/1.5 var(--ui, 'Geist', system-ui, sans-serif);
		cursor: pointer;
	}

	.help-btn {
		width: 32px;
		min-height: 32px;
		padding: 0;
		border-radius: 50%;
		font: 600 14px var(--mono, 'JetBrains Mono', monospace);
	}

	button:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 3px;
	}
</style>
