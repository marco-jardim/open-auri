<script lang="ts">
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { LegalPageData } from '#lib/content/legal/render.ts';
	import LegalPage from '#lib/components/pages/docs/LegalPage.svelte';
	import { docsUi } from '#lib/components/pages/docs/ui.ts';
	let { data }: { data: LegalPageData } = $props();
	const document = $derived(data.documents[getLocale()]);
</script>

<svelte:head><title>{document.title} · open-auri</title></svelte:head>
<LegalPage {document} values={data.values} ui={docsUi()} />
