<script lang="ts">
	import { onMount } from 'svelte';
	import { getAppContext } from '#lib/app/index.ts';
	import { PUBLIC_TURNSTILE_SITE_KEY } from '#lib/config/public.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { createSocialApi, createSocialOutbox, createSocialSession } from '#lib/social/index.ts';
	import Comunidade from '#lib/components/pages/comunidade/Comunidade.svelte';

	const context = getAppContext();
	const app = $derived(context.client);
	const api = createSocialApi();
	// Prerendered page: the session is unknown at build time and read in the browser.
	const session = createSocialSession();
	// Only enqueues here; the layout's SocialSync flushes the outbox.
	const outbox = $derived(app ? createSocialOutbox({ store: app.state.outbox, session }) : null);

	onMount(() => {
		const controller = new AbortController();
		void session.refresh(controller.signal);
		return () => controller.abort();
	});
</script>

<svelte:head>
	<title>{m.comunidade_title()} · open-auri</title>
	<meta name="description" content={m.comunidade_meta_description()} />
</svelte:head>

<Comunidade {app} {api} {session} {outbox} siteKey={PUBLIC_TURNSTILE_SITE_KEY} />
