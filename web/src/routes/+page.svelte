<script lang="ts">
	import { browser } from '$app/env';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { getAppContext } from '#lib/app/index.ts';
	import CurvaPage from '#lib/components/pages/curva/CurvaPage.svelte';
	import {
		DEFAULT_LAYER,
		LAYER_PARAM,
		layerUrl,
		parseLayer,
		type Layer
	} from '#lib/components/pages/curva/layers.ts';

	const context = getAppContext();
	const app = $derived(context.client);
	// The route is prerendered: query and hash exist only in the browser.
	const layer = $derived(
		browser ? parseLayer(page.url.searchParams.get(LAYER_PARAM)) : DEFAULT_LAYER
	);
	const hash = $derived(browser ? page.url.hash : '');

	function onlayer(next: Layer) {
		if (!browser || next === layer) return;
		const target = layerUrl(page.url, next);
		void goto(resolve('/') + target.search + target.hash, { replace: true, reset: false });
	}
</script>

<CurvaPage {app} {layer} {hash} pageUrl={page.url} {onlayer} />
