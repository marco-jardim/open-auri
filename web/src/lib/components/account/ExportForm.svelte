<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import './account.css';

	interface Props {
		/** POST endpoint answering with the JSON attachment. */
		action?: string;
	}

	let { action = '/conta/exportar' }: Props = $props();
</script>

<!-- Plain form on purpose (no enhance): the browser handles the attachment download. -->
<form method="POST" {action} class="acc-form" data-sveltekit-reload>
	<p class="acc-hint">{m.conta_export_contents()}</p>
	<p class="acc-hint">{m.conta_export_later()}</p>
	<div class="acc-row">
		<button class="acc-btn" type="submit">{m.conta_export_submit()}</button>
	</div>
</form>
