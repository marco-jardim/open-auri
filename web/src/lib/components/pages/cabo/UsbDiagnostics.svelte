<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { ANDROID_REPORT_URL } from '#lib/cable/android-links.ts';
	import type { NativeHIDDevice } from '#lib/cable/native/index.ts';

	let {
		engineering,
		inApp,
		device
	}: {
		engineering: boolean;
		inApp: boolean;
		device: Pick<NativeHIDDevice, 'diagnostics'> | null;
	} = $props();
	const id = $props.id();
	let json = $state<string | null>(null);
	let busy = $state(false);
	let message = $state<'load-failed' | 'copied' | 'copy-failed' | null>(null);
	let generation = 0;
	const visible = $derived(engineering && inApp && device !== null);
	const feedback = $derived(
		message === 'load-failed'
			? m.android_diagnostics_load_failed()
			: message === 'copied'
				? m.android_diagnostics_copied()
				: message === 'copy-failed'
					? m.android_diagnostics_copy_failed()
					: ''
	);
	$effect(() => {
		// Never retain the previous device's report, including a load finishing after disconnect.
		void device;
		void visible;
		generation += 1;
		json = null;
		message = null;
		busy = false;
	});

	async function load(): Promise<void> {
		if (!visible || !device || busy) return;
		const ticket = generation;
		busy = true;
		message = null;
		try {
			const report = await device.diagnostics();
			if (ticket === generation) json = JSON.stringify(report, null, 2);
		} catch (error) {
			console.warn('USB diagnostics could not be loaded', error);
			if (ticket === generation) message = 'load-failed';
		} finally {
			if (ticket === generation) busy = false;
		}
	}

	async function copy(): Promise<void> {
		if (json === null) return;
		const ticket = generation;
		try {
			await navigator.clipboard.writeText(json);
			if (ticket === generation) message = 'copied';
		} catch (error) {
			console.warn('USB diagnostics could not be copied', error);
			if (ticket === generation) message = 'copy-failed';
		}
	}
</script>

{#if visible}
	<section aria-labelledby="{id}-title">
		<h2 id="{id}-title">{m.android_diagnostics_title()}</h2>
		<p>{m.android_diagnostics_local()}</p>
		<button type="button" disabled={busy} onclick={load}>{m.android_diagnostics_load()}</button>
		{#if json !== null}
			<pre aria-label={m.android_diagnostics_title()}>{json}</pre>
			<button type="button" onclick={copy}>{m.android_diagnostics_copy()}</button>
		{/if}
		<a href={ANDROID_REPORT_URL}>{m.android_report_result()}</a>
		<p role="status">{feedback}</p>
	</section>
{/if}

<style>
	section {
		margin-top: 20px;
		padding: 16px;
		border: 1px solid #5b625f;
		border-radius: 4px;
		background: #101817;
		color: #e4fffb;
	}
	h2 {
		font-size: 18px;
	}
	pre {
		max-height: 32rem;
		overflow: auto;
		padding: 12px;
		background: #050a09;
		color: #e4fffb;
		font-size: 12px;
	}
	button,
	a {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		margin-right: 16px;
		color: inherit;
	}
	button {
		padding: 8px 16px;
		border: 1px solid currentColor;
		border-radius: 4px;
		background: transparent;
		font: inherit;
		cursor: pointer;
	}
</style>
