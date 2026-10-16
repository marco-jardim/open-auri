<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { PUBLIC_TURNSTILE_SITE_KEY } from '#lib/config/public.ts';
	import { AuthShell, SignInForm, withNext } from '#lib/components/auth/index.ts';
	import { kitEnhancer } from '#lib/components/auth/kit-enhance.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>{m.auth_signin_title()} · open-auri</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<AuthShell channel="01" title={m.auth_signin_title()} lede={m.auth_signin_lede()}>
	<SignInForm
		result={form}
		next={data.next}
		notice={data.notice}
		siteKey={PUBLIC_TURNSTILE_SITE_KEY}
		enhancer={kitEnhancer}
	/>
	{#snippet footer()}
		<a href="/esqueci-senha">{m.auth_signin_forgot()}</a>
		<span>
			{m.auth_signin_no_account()}
			<a href={withNext('/criar-conta', form?.next ?? data.next)}>{m.auth_signin_create()}</a>
		</span>
	{/snippet}
</AuthShell>
