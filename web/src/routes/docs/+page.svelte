<script lang="ts">
	import { getAppContext } from '#lib/app/index.ts';
	import { PUBLIC_GITHUB_URL } from '#lib/config/public.ts';
	import DocsPage from '#lib/components/pages/docs/DocsPage.svelte';
	import { docsUi } from '#lib/components/pages/docs/ui.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const context = getAppContext();
	const app = $derived(context.client);
	// The locale prose comes from the load (one dynamic chunk per locale, L7).
	const content = $derived(data.content);
	const ui = $derived(docsUi());
	async function prepareClear() {
		// Release the active MP3 and its object URL without navigating the document.
		// Shared database connections close on versionchange during deletion.
		await app?.audio.removeFile();
	}
	/** Toasts only exist once the app runtime is mounted; DocsPage falls back to inline feedback. */
	function notify(message: string, tone: 'success' | 'error') {
		if (!app) return false;
		app.toasts.push(message, { tone, duration: 2600 });
		return true;
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
	{notify}
/>
