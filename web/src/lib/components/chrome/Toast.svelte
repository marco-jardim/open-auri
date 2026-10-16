<script lang="ts">
	import { toast, type ToastStore } from './toast.ts';
	import ToastItem from './ToastItem.svelte';

	interface Props {
		store?: ToastStore;
	}

	let { store = toast }: Props = $props();
</script>

<div
	class="toast-region"
	role="status"
	aria-live="polite"
	aria-atomic="false"
	aria-relevant="additions text"
>
	<ol>
		{#each $store as notification (notification.id)}
			<ToastItem {notification} onDismiss={store.dismiss} />
		{/each}
	</ol>
</div>

<style>
	.toast-region {
		position: fixed;
		bottom: 26px;
		left: 50%;
		z-index: 300;
		width: min(620px, calc(100vw - 32px));
		max-height: calc(100dvh - 88px);
		overflow-y: auto;
		transform: translateX(-50%);
		pointer-events: none;
	}

	ol {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 4px;
		list-style: none;
	}
</style>
