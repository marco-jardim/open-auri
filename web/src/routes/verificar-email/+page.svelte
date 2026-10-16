<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { AuthShell, VerifyEmailView, withNext } from '#lib/components/auth/index.ts';
	import { kitEnhancer } from '#lib/components/auth/kit-enhance.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const verified = $derived(data.status === 'verified');
</script>

<svelte:head>
	<title>{m.auth_verify_title()} · open-auri</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<AuthShell
	channel="03"
	title={verified ? m.auth_verify_done_title() : m.auth_verify_title()}
	lede={verified ? undefined : m.auth_verify_lede()}
>
	<VerifyEmailView
		status={data.status}
		result={form}
		next={data.next}
		availableAt={data.availableAt}
		enhancer={kitEnhancer}
	/>
	{#snippet footer()}
		<a href={withNext('/entrar', data.next)}>{m.auth_back_signin()}</a>
	{/snippet}
</AuthShell>
