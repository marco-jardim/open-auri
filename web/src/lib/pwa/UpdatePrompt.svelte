<script lang="ts">
	import { onMount } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { registerPwa, type PwaController, type UpdateState } from './register.ts';

	interface Props {
		enabled?: boolean;
		workerUrl?: string;
		scope?: string;
	}
	let { enabled = true, workerUrl = '/service-worker.js', scope = '/' }: Props = $props();
	let offline = $state(false);
	let failed = $state(false);
	let update = $state<UpdateState>({ waiting: false, applying: false, blocked: false });
	let controller: PwaController | undefined;

	onMount(() => {
		let disposed = false;
		const connectivity = () => (offline = !navigator.onLine);
		connectivity();
		window.addEventListener('online', connectivity);
		window.addEventListener('offline', connectivity);
		if (enabled) {
			void registerPwa({ workerUrl, scope, onState: (state) => (update = state) })
				.then((registered) => {
					if (disposed) registered.dispose();
					else controller = registered;
				})
				.catch((error: unknown) => {
					console.warn('PWA registration failed', error);
					if (!disposed) failed = true;
				});
		}
		return () => {
			disposed = true;
			controller?.dispose();
			window.removeEventListener('online', connectivity);
			window.removeEventListener('offline', connectivity);
		};
	});
</script>

{#if offline || update.waiting || failed}
	<aside class="pwa-notices" aria-label={m.pwa_status_label()}>
		{#if offline}
			<p role="status" data-testid="pwa-offline-notice">{m.pwa_offline_notice()}</p>
		{/if}
		{#if failed}
			<p role="status">{m.pwa_registration_error()}</p>
		{/if}
		{#if update.waiting}
			<div class="update" data-testid="pwa-update-prompt">
				<p role="status">
					{update.blocked ? m.pwa_update_write_blocked() : m.pwa_update_available()}
				</p>
				<button type="button" disabled={update.applying} onclick={() => controller?.applyUpdate()}>
					{update.applying ? m.pwa_update_applying() : m.pwa_update_action()}
				</button>
			</div>
		{/if}
	</aside>
{/if}

<style>
	.pwa-notices {
		position: fixed;
		z-index: 100;
		inset-inline-end: 16px;
		bottom: calc(16px + env(safe-area-inset-bottom, 0px));
		width: min(390px, calc(100vw - 32px));
		padding: 16px;
		border: 1px solid var(--pop-rule, #34332f);
		border-radius: var(--rad-lg, 6px);
		background: var(--pop-bg, #1b1b19);
		color: var(--text, #ece7dd);
		font: 14px/1.5 var(--sans, system-ui, sans-serif);
		box-shadow: 0 4px 24px rgb(0 0 0 / 0.3);
	}
	p {
		margin: 0;
	}
	.update {
		display: grid;
		gap: 12px;
	}
	.pwa-notices > * + * {
		margin-top: 12px;
	}
	button {
		min-height: 44px;
		padding: 8px 16px;
		border: 1px solid var(--text, #ece7dd);
		border-radius: var(--rad-sm, 3px);
		background: var(--text, #ece7dd);
		color: var(--ink, #0f0f0e);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	button:focus-visible {
		outline: 2px solid var(--text, #ece7dd);
		outline-offset: 4px;
	}
	button:disabled {
		cursor: wait;
		opacity: 0.7;
	}
</style>
