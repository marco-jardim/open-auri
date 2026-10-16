<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import type { ToastMessage } from './toast.ts';

	interface Props {
		notification: ToastMessage;
		onDismiss: (id: number) => void;
	}

	let { notification, onDismiss }: Props = $props();
	// Track primitives, not the object: a re-emitted but equal notification must not restart the
	// countdown (the effect below resets `remaining` whenever its dependencies change).
	const id = $derived(notification.id);
	const duration = $derived(notification.duration);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let remaining = 0;
	let startedAt = 0;
	let hovered = false;
	let focused = false;

	function pause() {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
		remaining = Math.max(0, remaining - (performance.now() - startedAt));
	}

	function resume() {
		if (hovered || focused || duration === 0 || timer !== undefined) return;
		startedAt = performance.now();
		const target = id;
		timer = setTimeout(() => onDismiss(target), remaining);
	}

	$effect(() => {
		remaining = duration;
		resume();
		return pause;
	});
</script>

<li
	class="toast"
	class:bad={notification.tone === 'error'}
	onmouseenter={() => {
		hovered = true;
		pause();
	}}
	onmouseleave={() => {
		hovered = false;
		resume();
	}}
	onfocusin={() => {
		focused = true;
		pause();
	}}
	onfocusout={(event) => {
		if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
			return;
		}
		focused = false;
		resume();
	}}
>
	<span>{notification.message}</span>
	<button
		type="button"
		aria-label={m.chrome_toast_dismiss()}
		onclick={() => onDismiss(notification.id)}>×</button
	>
</li>

<style>
	.toast {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		padding: 10px 14px;
		border: 1px solid #57554e;
		border-left: 3px solid var(--accent, #ff7a2f);
		border-radius: 4px;
		background: #1b1b19;
		color: #ece7dd;
		font: 12.5px/1.5 var(--ui, 'Geist', system-ui, sans-serif);
		box-shadow: 0 14px 30px rgb(0 0 0 / 60%);
		pointer-events: auto;
		animation: appear 150ms ease-out;
	}

	.toast.bad {
		border-left-color: #e5484d;
	}

	span {
		overflow-wrap: anywhere;
	}

	button {
		flex: none;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 0;
		border-radius: 3px;
		background: transparent;
		color: inherit;
		font-size: 22px;
		cursor: pointer;
	}

	button:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 3px;
	}

	@keyframes appear {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.toast {
			animation: none;
		}
	}
</style>
