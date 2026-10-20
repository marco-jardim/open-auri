<script lang="ts">
	import Button from '#lib/components/primitives/Button.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { getHiddenStore } from '#lib/social/hidden-context.ts';
	import type { HiddenType } from '#lib/social/hidden.ts';
	let {
		lineageId,
		author,
		curveName,
		authorName
	}: { lineageId?: string; author?: string | null; curveName?: string; authorName?: string } =
		$props();
	const hidden = getHiddenStore();
	async function hide(type: HiddenType, id: string, label?: string) {
		try {
			await hidden.hide(type, id, label);
		} catch (error) {
			console.warn('Could not hide item', error);
		}
	}
</script>

<div class="hide-actions">
	{#if lineageId}
		<Button
			size="sm"
			variant="ghost"
			loading={$hidden.busy}
			disabledReason={!$hidden.ready ? m.hidden_loading() : null}
			onclick={() => hide('curve', lineageId, curveName)}>{m.hidden_hide_curve()}</Button
		>
	{/if}
	{#if author}
		<Button
			size="sm"
			variant="ghost"
			loading={$hidden.busy}
			disabledReason={!$hidden.ready ? m.hidden_loading() : null}
			onclick={() => hide('author', author, authorName)}>{m.hidden_hide_author()}</Button
		>
	{/if}
	{#if $hidden.error}<p role="alert">{m.hidden_error()}</p>{/if}
</div>

<style>
	.hide-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		overflow-wrap: anywhere;
	}
</style>
