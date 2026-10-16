<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { AuthShell, ResetForm } from '#lib/components/auth/index.ts';
	import { kitEnhancer } from '#lib/components/auth/kit-enhance.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>{m.auth_reset_title()} · open-auri</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<AuthShell channel="05" title={m.auth_reset_title()} lede={m.auth_reset_lede()}>
	<ResetForm token={data.token} result={form} enhancer={kitEnhancer} />
	{#snippet footer()}
		<a href="/entrar">{m.auth_back_signin()}</a>
	{/snippet}
</AuthShell>
