<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import Button from '#lib/components/primitives/Button.svelte';
	import { dispositionFilename, isAndroidApp, saveFile } from '#lib/files/save.ts';
	import './account.css';

	interface Props {
		/** POST endpoint answering with the JSON attachment. */
		action?: string;
	}

	let { action = '/conta/exportar' }: Props = $props();
	let busy = $state(false);
	let error = $state('');

	async function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
		if (!isAndroidApp()) return;
		event.preventDefault();
		if (busy) return;
		const body = new FormData(event.currentTarget, event.submitter);
		busy = true;
		error = '';
		try {
			// The endpoint requires the signed-in cookie and same-origin Origin, not a token.
			// FormData also preserves any successful form fields added in the future.
			const response = await fetch(action, { method: 'POST', credentials: 'same-origin', body });
			if (!response.ok) throw new Error(`Account export: ${response.status}`);
			const name = dispositionFilename(response.headers.get('content-disposition'));
			if (!name) throw new Error('Account export attachment has no filename');
			await saveFile({
				name,
				mime: response.headers.get('content-type') ?? 'application/json',
				bytes: await response.blob()
			});
		} catch (cause) {
			error = m.conta_error_generic();
			console.error('Account export failed', cause);
		} finally {
			busy = false;
		}
	}
</script>

<!-- Browsers (including without JS) post normally and handle the attachment. Only Android
     intercepts the POST, since WebView cannot hand that response to its document picker. -->
<form method="POST" {action} class="acc-form" data-sveltekit-reload onsubmit={submit}>
	<p class="acc-hint">{m.conta_export_contents()}</p>
	<p class="acc-hint">{m.conta_export_later()}</p>
	<div class="acc-row">
		<Button type="submit" loading={busy}>{m.conta_export_submit()}</Button>
	</div>
	{#if error}<p class="acc-note" role="alert">{error}</p>{/if}
</form>
