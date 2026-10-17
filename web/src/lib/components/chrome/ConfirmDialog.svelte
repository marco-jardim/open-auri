<script lang="ts">
	import type { Snippet } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { Button } from '#lib/components/primitives/index.ts';
	import { modalDialog } from './modal.ts';

	interface Props {
		open?: boolean;
		title: string;
		description?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		confirmDisabled?: boolean;
		/** Why the confirmation is unavailable (T8); a generic reason is used when omitted. */
		confirmDisabledReason?: string;
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
		confirmDisabledReason,
		children,
		onResult
	}: Props = $props();
	const id = $props.id();
	const confirmReason = $derived(
		confirmDisabled ? (confirmDisabledReason ?? m.fux1_confirm_unavailable()) : null
	);

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
			<Button variant="plate" data-cancel onclick={() => finish(false)}>{cancelLabel}</Button>
			<Button
				variant="primary"
				class="go"
				disabledReason={confirmReason}
				onclick={() => finish(true)}
			>
				{confirmLabel}
			</Button>
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
		margin: 0 0 var(--space-3, 12px);
		color: var(--text-2, #cfc9be);
		font-size: var(--fs-body, 15px);
	}

	.dlg-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-3);
		margin-top: var(--space-4);
	}
</style>
