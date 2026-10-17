<script module lang="ts">
	export interface Shortcut {
		keys: string;
		description: string;
	}
</script>

<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import Button from '#lib/components/primitives/Button.svelte';
	import IconButton from '#lib/components/primitives/IconButton.svelte';
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

	/**
	 * Escape closes this dialog, the top layer, and is consumed here: a page-level window
	 * handler under it (a page's guided tour, which auto-opens on a first desktop visit) must not
	 * take the key and cancel the dialog's close request. A control inside the dialog that
	 * handled Escape first (prevented) keeps it.
	 */
	function escapeCloses(node: HTMLDialogElement): () => void {
		const keydown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
			event.preventDefault();
			changeOpen(false);
		};
		node.addEventListener('keydown', keydown);
		return () => node.removeEventListener('keydown', keydown);
	}
</script>

<svelte:window onkeydown={shortcut} />

{#if showTrigger}
	<IconButton
		size="sm"
		variant="plate"
		class="help-btn"
		label={m.chrome_help_open()}
		aria-haspopup="dialog"
		aria-controls={id}
		aria-expanded={open}
		onclick={() => changeOpen(true)}>?</IconButton
	>
{/if}

<dialog
	{id}
	aria-labelledby="{id}-title"
	aria-describedby="{id}-hint"
	use:modalDialog={{ open, onDismiss: () => changeOpen(false), initialFocus: '[data-close]' }}
	{@attach escapeCloses}
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
			<Button variant="plate" data-close onclick={() => changeOpen(false)}
				>{m.chrome_close()}</Button
			>
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
		border: 1px solid var(--pop-rule, #34332f);
		border-radius: var(--rad-xl, 10px);
		/* Own dark face: colours keep fallbacks so the dialog stays legible anywhere */
		background: var(--ink-2, #171715);
		color: var(--text, #ece7dd);
		font: 400 var(--fs-small, 13px) / var(--lh-body, 1.55)
			var(--face-body, 'Geist', system-ui, sans-serif);
		box-shadow: var(--elev-3, 0 24px 64px -16px rgba(0, 0, 0, 0.8));
	}

	dialog::backdrop {
		background: rgb(5 5 4 / 72%);
		backdrop-filter: blur(2px);
	}

	.dlg {
		padding: var(--panel-pad);
	}

	h2 {
		margin: 0 0 var(--space-3);
		font: italic 400 var(--fs-display-m) / var(--lh-display-m) var(--face-display);
		letter-spacing: var(--tracking-display-m);
	}

	p {
		margin: 0 0 var(--space-4, 16px);
		color: var(--text-2, #cfc9be);
	}

	.help-grid {
		display: grid;
		grid-template-columns: auto 1fr;
		align-items: baseline;
		gap: var(--space-2) var(--space-4);
		margin: 0;
	}

	dt {
		color: var(--accent-text, var(--accent, #ece7dd));
	}

	/* Key caps: data face at 400, never bold mono (T4) */
	kbd {
		display: inline-block;
		padding: 2px 6px;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-sm);
		box-shadow: var(--bevel);
		font: 400 var(--fs-caption) / 1.3 var(--face-data);
		white-space: nowrap;
	}

	dd {
		margin: 0;
	}

	.dlg-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: var(--space-4);
	}

	/* The "?" glyph in Geist (actions never in mono, T4) */
	:global(.help-btn) {
		font-weight: 600;
	}
</style>
