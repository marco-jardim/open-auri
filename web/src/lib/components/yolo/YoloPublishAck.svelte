<!--
	Acknowledgement step before a YOLO curve is opened to others (unlisted or public): the owner
	reads what the publication means and ticks a required box; only then "Publicar como YOLO" sends
	`acknowledge: 'yolo'` (the parent does the request). Private saves never show it. Inline, so it
	sits inside the dialog or panel that asked (publish dialog, Minha Biblioteca, blend publish).
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { Button } from '#lib/components/primitives/index.ts';
	import YoloCurveNotice from './YoloCurveNotice.svelte';

	interface Props {
		/** Waived criteria as display text (`waivedLabels`). */
		waived?: readonly string[];
		busy?: boolean;
		/** Called once the box is ticked and the button pressed. */
		onconfirm: () => void;
		oncancel?: () => void;
		/** Level of the title (default 3). */
		headingLevel?: 2 | 3 | 4 | 5 | 6;
	}

	let { waived = [], busy = false, onconfirm, oncancel, headingLevel = 3 }: Props = $props();
	const id = $props.id();
	let understood = $state(false);
	const reason = $derived(understood ? null : m.yolopub_ack_required());

	function confirm() {
		if (!understood || busy) return;
		onconfirm();
	}
</script>

<!-- A group, not a form: it sits inside the publish dialog's own form. -->
<div class="ypa" role="group" aria-labelledby="{id}-title" data-yolo-publish-ack>
	<svelte:element this={`h${headingLevel}`} id="{id}-title" class="ypa-title">
		{m.yolopub_ack_title()}
	</svelte:element>
	<p class="ypa-body">{m.yolopub_ack_body()}</p>
	<YoloCurveNotice variant="public" compact {waived} />
	<label class="ypa-check">
		<input type="checkbox" name="yolo-ack" aria-required="true" bind:checked={understood} />
		<span>{m.yolopub_ack_checkbox()}</span>
	</label>
	<div class="ypa-actions">
		<Button
			variant="primary"
			type="button"
			loading={busy}
			disabledReason={busy ? null : reason}
			onclick={confirm}>{m.yolopub_ack_button()}</Button
		>
		{#if oncancel}
			<Button type="button" onclick={oncancel} disabledReason={busy ? m.yolopub_busy() : null}
				>{m.yolopub_ack_cancel()}</Button
			>
		{/if}
	</div>
</div>

<style>
	.ypa {
		display: grid;
		gap: var(--space-3, 12px);
		margin: 0;
		padding: var(--space-3, 12px);
		border: 1px solid color-mix(in srgb, #e5a23a 55%, transparent);
		border-radius: var(--rad-md, 4px);
	}
	.ypa-title {
		margin: 0;
		font: 600 var(--fs-ui, 14px) / var(--lh-ui, 1.3) var(--face-body, 'Geist', sans-serif);
	}
	.ypa-body {
		max-width: 70ch;
		margin: 0;
	}
	.ypa-check {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2, 8px);
	}
	.ypa-check input {
		flex: none;
		margin-top: 3px;
	}
	.ypa-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2, 8px);
	}
</style>
