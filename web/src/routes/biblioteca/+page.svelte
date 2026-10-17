<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { getAppContext } from '#lib/app/index.ts';
	import { PUBLIC_ORIGIN } from '#lib/config/public.ts';
	import Biblioteca from '#lib/components/pages/biblioteca/Biblioteca.svelte';
	import type { SocialApi, SocialSession } from '#lib/social/index.ts';
	import { loadSocialRuntime } from '#lib/social/runtime.ts';

	const context = getAppContext();
	const app = $derived(context.client);
	// Account shelves (T4.14): one session and API client for this page; the session is read in
	// the browser only, so SSR and signed-out visitors get the local library exactly as before.
	// FUX.B: both come from the social runtime chunk (the layout loads it at once on this route),
	// so the social client is not in the page's initial JS; the shelves appear once it is there.
	let social = $state.raw<{
		session: SocialSession;
		api: SocialApi;
		currentPath: string;
	} | null>(null);

	onMount(() => {
		const controller = new AbortController();
		let session: SocialSession | null = null;
		loadSocialRuntime().then(
			(runtime) => {
				if (controller.signal.aborted) return;
				session = runtime.createSocialSession();
				// Prerendered page: url.search is unavailable at build time, so sign-in returns to the path.
				social = { session, api: runtime.createSocialApi(), currentPath: page.url.pathname };
				void session.refresh(controller.signal);
			},
			(error: unknown) => console.warn('The social client could not load', error)
		);
		const visible = () => {
			// Sign-in or sign-out in another tab: read the session again when the tab comes back.
			if (document.visibilityState === 'visible') void session?.refresh(controller.signal);
		};
		document.addEventListener('visibilitychange', visible);
		return () => {
			controller.abort();
			document.removeEventListener('visibilitychange', visible);
		};
	});
</script>

<Biblioteca {app} origin={PUBLIC_ORIGIN} {social} />
