<script lang="ts">
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { getAppContext } from '#lib/app/index.ts';
	import { PUBLIC_GITHUB_URL } from '#lib/config/public.ts';
	import { docsContent } from '#lib/content/docs/index.ts';
	import DocsPage from '#lib/components/pages/docs/DocsPage.svelte';
	import { docsUi } from '#lib/components/pages/docs/ui.ts';
	const context = getAppContext();
	const app = $derived(context.client);
	const content = $derived(docsContent(getLocale()));
	const ui = $derived(docsUi());
	async function prepareClear() {
		// Release the active MP3 and its object URL without navigating the document.
		// Shared database connections close on versionchange during deletion.
		await app?.audio.removeFile();
	}
</script>

<svelte:head
	><title>{content.title} · open-auri</title><meta
		name="description"
		content={content.introduction}
	/></svelte:head
>
<DocsPage
	{content}
	{ui}
	githubUrl={PUBLIC_GITHUB_URL}
	clearDisabled={!app || app.cableState.writing}
	{prepareClear}
/>
