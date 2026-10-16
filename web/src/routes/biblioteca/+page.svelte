<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { getAppContext } from '#lib/app/index.ts';
	import { PUBLIC_ORIGIN } from '#lib/config/public.ts';
	import Biblioteca from '#lib/components/pages/biblioteca/Biblioteca.svelte';
	import { createSocialApi, createSocialSession } from '#lib/social/index.ts';

	const context = getAppContext();
	const app = $derived(context.client);
	// Account shelves (T4.14): one session and API client for this page; the session is read in
	// the browser only, so SSR and signed-out visitors get the local library exactly as before.
	const session = createSocialSession();
	const api = createSocialApi();
	// Prerendered page: url.search is unavailable at build time, so sign-in returns to the path.
	const social = { session, api, currentPath: page.url.pathname };

	onMount(() => {
		const controller = new AbortController();
		void session.refresh(controller.signal);
		const visible = () => {
			// Sign-in or sign-out in another tab: read the session again when the tab comes back.
			if (document.visibilityState === 'visible') void session.refresh(controller.signal);
		};
		document.addEventListener('visibilitychange', visible);
		return () => {
			controller.abort();
			document.removeEventListener('visibilitychange', visible);
		};
	});
</script>

<Biblioteca {app} origin={PUBLIC_ORIGIN} {social} />
