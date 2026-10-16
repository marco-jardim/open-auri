<script lang="ts">
	import type { Snippet } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { modalDialog } from './modal.ts';

	interface Props {
		open?: boolean;
		title: string;
		description?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		confirmDisabled?: boolean;
		children?: Snippet;
		onResult?: (confirmed: boolean) => void;
	}

	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = m.chrome_confirm(),
		cancelLabel = m.chrome_cancel(),
		confirmDisabled = false,
		children,
		onResult
	}: Props = $props();
	const id = $props.id();

	function finish(confirmed: boolean) {
		if (!open || (confirmed && confirmDisabled)) return;
		open = false;
		onResult?.(confirmed);
	}
</script>

<dialog
	aria-labelledby="{id}-title"
	aria-describedby={description ? `${id}-description` : undefined}
	use:modalDialog={{ open, onDismiss: () => finish(false), initialFocus: '[data-cancel]' }}
>
	<div class="dlg">
		<h2 id="{id}-title">{title}</h2>
		{#if description}
			<p id="{id}-description">{description}</p>
		{/if}
		{#if children}
			{@render children()}
		{/if}
		<div class="dlg-actions">
			<button type="button" data-cancel onclick={() => finish(false)}>{cancelLabel}</button>
			<button type="button" class="go" disabled={confirmDisabled} onclick={() => finish(true)}>
				{confirmLabel}
			</button>
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

	.dlg-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 14px;
	}

	button {
		min-height: 36px;
		padding: 7px 11px;
		border: 1px solid #77736b;
		border-radius: 3px;
		background: #262725;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.go {
		border-color: var(--accent, #ff7a2f);
		background: var(--accent, #ff7a2f);
		color: #140a04;
	}

	button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	button:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 3px;
	}
</style>
