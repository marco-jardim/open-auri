<script lang="ts">
	import { getAppContext } from '#lib/app/index.ts';
	import CaboPage from '#lib/components/pages/cabo/CaboPage.svelte';

	const context = getAppContext();
	const app = $derived(context.client);
</script>

<CaboPage {app} />
