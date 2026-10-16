<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { PUBLIC_TURNSTILE_SITE_KEY } from '#lib/config/public.ts';
	import { AuthShell, ForgotForm } from '#lib/components/auth/index.ts';
	import { kitEnhancer } from '#lib/components/auth/kit-enhance.ts';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head>
	<title>{m.auth_forgot_title()} · open-auri</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<AuthShell channel="04" title={m.auth_forgot_title()} lede={m.auth_forgot_lede()}>
	<ForgotForm result={form} siteKey={PUBLIC_TURNSTILE_SITE_KEY} enhancer={kitEnhancer} />
	{#snippet footer()}
		<a href="/entrar">{m.auth_back_signin()}</a>
	{/snippet}
</AuthShell>
