<script lang="ts">
	import { getAppContext } from '#lib/app/index.ts';
	import CaboPage from '#lib/components/pages/cabo/CaboPage.svelte';
	import type { SocialSession } from '#lib/social/index.ts';
	import { loadSocialRuntime } from '#lib/social/runtime.ts';

	const context = getAppContext();
	const app = $derived(context.client);
	// T4.16: the session only decides whether the "instalada" status is shown. Effects run in the
	// browser only, so SSR and signed-out visitors see the Cabo exactly as before. FUX.B: the
	// session comes from the social runtime chunk (the layout loads it at once on this route), so
	// the social client is not in the page's initial JS; until it is there, nothing is shown.
	let session = $state.raw<SocialSession | null>(null);

	$effect(() => {
		const controller = new AbortController();
		loadSocialRuntime().then(
			(social) => {
				if (controller.signal.aborted) return;
				const created = social.createSocialSession();
				session = created;
				void created.refresh(controller.signal);
			},
			(error: unknown) => console.warn('The social session could not load', error)
		);
		return () => controller.abort();
	});
</script>

<CaboPage {app} signedIn={session?.signedIn ?? false} />
