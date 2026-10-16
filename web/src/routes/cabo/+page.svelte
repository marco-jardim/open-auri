<script lang="ts">
	import { untrack } from 'svelte';
	import { getAppContext } from '#lib/app/index.ts';
	import CaboPage from '#lib/components/pages/cabo/CaboPage.svelte';
	import { createSocialSession } from '#lib/social/index.ts';

	const context = getAppContext();
	const app = $derived(context.client);
	// T4.16: the session only decides whether the "instalada" status is shown. Effects run in the
	// browser only, so SSR and signed-out visitors see the Cabo exactly as before.
	const session = createSocialSession();

	$effect(() => {
		const controller = new AbortController();
		untrack(() => void session.refresh(controller.signal));
		return () => controller.abort();
	});
</script>

<CaboPage {app} signedIn={session.signedIn} />
