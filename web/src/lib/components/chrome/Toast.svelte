<script lang="ts">
	import { toast, type ToastStore } from './toast.ts';
	import ToastItem from './ToastItem.svelte';

	interface Props {
		store?: ToastStore;
	}

	let { store = toast }: Props = $props();
	/** Spec §2.6: at most 3 on screen; older ones wait in the queue (their timers start when shown). */
	const MAX_VISIBLE = 3;
	const visible = $derived($store.slice(-MAX_VISIBLE));
</script>

<div
	class="toast-region"
	role="status"
	aria-live="polite"
	aria-atomic="false"
	aria-relevant="additions text"
>
	<ol>
		{#each visible as notification (notification.id)}
			<ToastItem {notification} onDismiss={store.dismiss} />
		{/each}
	</ol>
</div>

<style>
	/* Bottom right on desktop; bottom centre on mobile, above the safe area (spec §2.6). */
	.toast-region {
		position: fixed;
		right: var(--gutter);
		bottom: calc(var(--space-5) + env(safe-area-inset-bottom, 0px));
		z-index: 300;
		width: min(420px, calc(100vw - 32px));
		max-height: calc(100dvh - 88px);
		overflow-y: auto;
		pointer-events: none;
	}

	ol {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 4px;
		list-style: none;
	}

	@media (max-width: 640px) {
		.toast-region {
			right: auto;
			left: 50%;
			bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
			transform: translateX(-50%);
		}
	}
</style>
