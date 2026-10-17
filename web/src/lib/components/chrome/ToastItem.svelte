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
	class:ok={notification.tone === 'success'}
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
	<!-- Tone icon (decorative: the message carries the meaning) -->
	<svg class="tone" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
		<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5" />
		{#if notification.tone === 'success'}
			<path d="M4.8 8.2 7 10.4l4.2-4.6" fill="none" stroke="currentColor" stroke-width="1.6" />
		{:else if notification.tone === 'error'}
			<path
				d="M8 4.2v4.6M8 10.9v.9"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linecap="round"
			/>
		{:else}
			<path
				d="M8 7.2v4.4M8 4.3v.9"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linecap="round"
			/>
		{/if}
	</svg>
	<span class="message">{notification.message}</span>
	<button
		type="button"
		aria-label={m.chrome_toast_dismiss()}
		onclick={() => onDismiss(notification.id)}>×</button
	>
</li>

<style>
	.toast {
		--tone: var(--accent);
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 10px 8px 10px 14px;
		border: 1px solid var(--pop-rule);
		border-left: 3px solid var(--tone);
		border-radius: var(--rad-md);
		background: var(--pop-bg);
		color: var(--text);
		font: 400 var(--fs-small) / var(--lh-small) var(--face-body);
		box-shadow: var(--elev-3);
		pointer-events: auto;
		animation: appear var(--dur-base) var(--ease-out);
	}

	.toast.ok {
		--tone: var(--ok);
	}

	.toast.bad {
		--tone: var(--danger);
	}

	.tone {
		flex: none;
		color: var(--tone);
	}

	.message {
		flex: 1 1 auto;
		overflow-wrap: anywhere;
	}

	button {
		flex: none;
		width: var(--hit);
		height: var(--hit);
		padding: 0;
		border: 0;
		border-radius: var(--rad-sm);
		background: transparent;
		color: var(--text-2);
		font: 400 22px/1 var(--face-body);
		cursor: pointer;
	}

	button:hover {
		background: var(--lamp-off);
		color: var(--text);
	}

	button:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: 1px;
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
