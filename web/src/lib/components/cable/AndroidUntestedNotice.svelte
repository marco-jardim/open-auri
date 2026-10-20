<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import {
		ANDROID_DISCLAIMER_VERSION,
		ANDROID_WRITE_VALIDATED
	} from '#lib/cable/android-status.ts';
	import { ANDROID_REPORT_URL } from '#lib/cable/android-links.ts';
	import type { NativeCableStatus } from '#lib/cable/native-state.svelte.ts';
	import { modalDialog } from '#lib/components/chrome/modal.ts';

	let {
		kind,
		presentation = 'modal',
		validated = ANDROID_WRITE_VALIDATED,
		version = ANDROID_DISCLAIMER_VERSION
	}: {
		kind: NativeCableStatus['kind'];
		presentation?: 'modal' | 'banner';
		validated?: boolean;
		version?: number;
	} = $props();
	const id = $props.id();
	const enabled = $derived(!validated && kind !== 'none');
	let seenVersion = $state<number | null>(null);
	let checkedVersion = $state<number | null>(null);
	const open = $derived(enabled && checkedVersion === version && seenVersion !== version);

	$effect(() => {
		if (!enabled || presentation !== 'modal') return;
		try {
			const saved = localStorage.getItem('oa.androidDisclaimerAck');
			seenVersion = saved === null ? null : Number(saved);
		} catch (error) {
			// Fail visible: storage being unavailable must never bypass the first-use choice.
			console.warn('Android disclaimer acknowledgement could not be read', error);
			seenVersion = null;
		}
		checkedVersion = version;
	});

	function acknowledge(): void {
		try {
			localStorage.setItem('oa.androidDisclaimerAck', String(version));
		} catch (error) {
			console.warn('Android disclaimer acknowledgement could not be saved', error);
		}
		seenVersion = version;
	}
</script>

{#if enabled && presentation === 'banner'}
	<aside class="banner" aria-label={m.android_untested_title()}>
		<p>{m.android_untested_short()}</p>
		<div class="links">
			<a href={ANDROID_REPORT_URL}>{m.android_report_result()}</a>
			<a href="/docs#android-resgate">{m.android_how_to_recover()}</a>
		</div>
	</aside>
{:else if enabled}
	<dialog
		aria-modal="true"
		aria-labelledby="{id}-title"
		aria-describedby="{id}-description"
		use:modalDialog={{
			open,
			onDismiss: () => undefined,
			canDismiss: () => false,
			initialFocus: '[data-ack]'
		}}
	>
		<h2 id="{id}-title">{m.android_untested_title()}</h2>
		<p id="{id}-description">{m.android_untested_body()}</p>
		<div class="links">
			<a href={ANDROID_REPORT_URL}>{m.android_report_result()}</a>
			<a href="/docs#android-resgate">{m.android_how_to_recover()}</a>
		</div>
		<button type="button" data-ack onclick={acknowledge}>{m.android_untested_ack()}</button>
	</dialog>
{/if}

<style>
	.banner,
	dialog {
		box-sizing: border-box;
		padding: 20px;
		border: 1px solid #e5bc65;
		border-radius: 6px;
		background: #242016;
		color: #fff1d0;
		font: 400 15px/1.6 var(--face-body, system-ui, sans-serif);
	}
	.banner {
		position: sticky;
		top: 0;
		z-index: 10;
		max-width: 1380px;
		margin: 0 auto 24px;
	}
	dialog {
		margin: auto;
		width: min(680px, calc(100vw - 32px));
		max-width: calc(100vw - 32px);
		max-height: calc(100dvh - 32px);
		overflow-y: auto;
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 75%);
	}
	h2,
	p {
		margin: 0 0 12px;
	}
	h2 {
		font-size: 24px;
		line-height: 1.25;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 24px;
	}
	a {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		color: inherit;
	}
	button {
		min-height: 48px;
		margin-top: 16px;
		padding: 10px 24px;
		border: 1px solid #e5bc65;
		border-radius: 4px;
		background: #fff1d0;
		color: #242016;
		font: inherit;
		cursor: pointer;
	}
</style>
