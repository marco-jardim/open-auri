<!--
	CurvaPage under an app context whose client is the page's own `app`, as the root layout gives
	it in production (`routes/+page.svelte` passes `context.client`). The bank and the scope read
	the stored filter labels from that context (`band-labels.svelte.ts`); rendered without it they
	keep their names in a local state instead.
-->
<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { setAppContext, type ClientApp } from '#lib/app/index.ts';
	import CurvaPage from '#lib/components/pages/curva/CurvaPage.svelte';

	type Props = ComponentProps<typeof CurvaPage> & { app: ClientApp };
	let props: Props = $props();

	setAppContext({
		get client() {
			return props.app;
		},
		status: 'ready',
		mount: async () => props.app,
		// The test owns the app (and disposes of it).
		dispose: () => undefined
	});
</script>

<CurvaPage {...props} />
