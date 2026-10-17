<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { Button } from '#lib/components/primitives/index.ts';
	import './account.css';

	interface Props {
		/** POST endpoint answering with the JSON attachment. */
		action?: string;
	}

	let { action = '/conta/exportar' }: Props = $props();
</script>

<!-- Plain form on purpose (no enhance, no fetch): the browser posts it and handles the attachment
     download. The page gets no signal when the download ends, so no progress is shown: a
     "preparing" state could not be cleared honestly. -->
<form method="POST" {action} class="acc-form" data-sveltekit-reload>
	<p class="acc-hint">{m.conta_export_contents()}</p>
	<p class="acc-hint">{m.conta_export_later()}</p>
	<div class="acc-row">
		<Button type="submit">{m.conta_export_submit()}</Button>
	</div>
</form>
