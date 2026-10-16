<script lang="ts">
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { legalContent } from '#lib/content/docs/legal-content.ts';
	import type { PublicLegalValues } from '#lib/content/docs/legal.ts';
	import LegalPage from '#lib/components/pages/docs/LegalPage.svelte';
	import { docsUi } from '#lib/components/pages/docs/ui.ts';
	let { data }: { data: { legalValues: PublicLegalValues } } = $props();
	const document = $derived(legalContent('terms', getLocale()));
</script>

<svelte:head><title>{document.title} · open-auri</title></svelte:head>
<LegalPage {document} values={data.legalValues} ui={docsUi()} />
