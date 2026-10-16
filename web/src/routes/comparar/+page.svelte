<script lang="ts">
	import { getAppContext } from '#lib/app/index.ts';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import CompararPage from '#lib/components/pages/comparar/CompararPage.svelte';

	const context = getAppContext();
	const app = $derived(context.client);
</script>

<CompararPage {app} locale={getLocale()} />
