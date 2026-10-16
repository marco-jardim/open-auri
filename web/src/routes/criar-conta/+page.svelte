<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { PUBLIC_TURNSTILE_SITE_KEY } from '#lib/config/public.ts';
	import { AuthShell, SignUpForm, SignupClosed, withNext } from '#lib/components/auth/index.ts';
	import { kitEnhancer } from '#lib/components/auth/kit-enhance.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const open = $derived(data.signupEnabled && form?.error !== 'signup_disabled');
</script>

<svelte:head>
	<title>{m.auth_signup_title()} · open-auri</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<AuthShell
	channel="02"
	title={open ? m.auth_signup_title() : m.auth_signup_closed_title()}
	lede={open ? m.auth_signup_lede() : undefined}
>
	{#if open}
		<SignUpForm
			result={form}
			next={data.next}
			siteKey={PUBLIC_TURNSTILE_SITE_KEY}
			enhancer={kitEnhancer}
		/>
	{:else}
		<SignupClosed next={data.next} />
	{/if}
	{#snippet footer()}
		{#if open}
			<span>
				{m.auth_signup_have_account()}
				<a href={withNext('/entrar', data.next)}>{m.auth_signup_signin()}</a>
			</span>
		{/if}
		<a href="/privacidade">{m.auth_signup_privacy_link()}</a>
	{/snippet}
</AuthShell>
