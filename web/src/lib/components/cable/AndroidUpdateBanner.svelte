<script lang="ts">
	import { updated } from '$app/state';
	import type { NativeCableStatus } from '#lib/app/context.svelte.ts';
	import { isWriteInProgress, onWriteProgress } from '#lib/cable/write-flag.ts';
	import { m } from '#lib/paraglide/messages.js';
	import Button from '#lib/components/primitives/Button.svelte';
	import { reloadWhenSafe } from './i18n.ts';

	interface Props {
		kind: NativeCableStatus['kind'];
		writing?: boolean;
		reload?: () => void;
	}
	let { kind, writing = false, reload }: Props = $props();
	let writeInProgress = $state(false);
	$effect(() => {
		const sync = () => (writeInProgress = isWriteInProgress());
		sync();
		return onWriteProgress(sync);
	});

	function reloadPage() {
		if (!writing) reloadWhenSafe(reload);
	}
</script>

{#if kind !== 'none' && updated.current}
	<div class="android-update" data-testid="android-update-banner">
		<p role="status">{m.cable_native_update_available()}</p>
		{#if !writing && !writeInProgress}
			<Button variant="plate" onclick={reloadPage}>{m.cable_native_reload()}</Button>
		{:else}
			<p>{m.cabo_fux_busy_writing()}</p>
		{/if}
	</div>
{/if}

<style>
	.android-update {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 8px 16px;
		padding: 8px var(--gutter, 16px);
		border-bottom: 1px solid var(--rule);
		background: var(--ink-2);
		color: var(--text);
		font-size: var(--fs-small, 13px);
	}
	p {
		margin: 0;
	}
</style>
