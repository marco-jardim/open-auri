<!--
	The single account card of the Comunidade page (spec §4.4, T9). It replaces the sign-in notice
	that every panel used to repeat: visitors read once why an account is needed and what already
	works without one (sign-up open or closed); a signed-in account whose e-mail is not verified is
	asked to confirm it. The panels only show their actions as unavailable, with the reason
	(`Button` `disabledReason`).
-->
<script lang="ts">
	import { EmptyState } from '#lib/components/primitives/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { requireLoginHref } from '#lib/social/index.ts';

	let {
		signedIn,
		signupOpen = true,
		path = '/comunidade'
	}: {
		signedIn: boolean;
		/** SIGNUP_ENABLED as known by the page (the prerendered page assumes open). */
		signupOpen?: boolean;
		path?: string;
	} = $props();

	const variant = $derived(signedIn ? 'verify' : signupOpen ? 'open' : 'closed');
</script>

{#snippet desk()}
	<svg viewBox="0 0 96 64" width="96" height="64" fill="none" stroke="currentColor">
		<path d="M20 8v48M48 8v48M76 8v48" stroke-width="1.5" opacity=".55" />
		<rect x="12" y="30" width="16" height="8" rx="1.5" stroke-width="1.5" />
		<rect x="40" y="16" width="16" height="8" rx="1.5" stroke-width="1.5" />
		<rect x="68" y="38" width="16" height="8" rx="1.5" stroke-width="1.5" />
		<path d="M6 60h84" stroke-width="1" stroke-dasharray="3 4" opacity=".6" />
	</svg>
{/snippet}

<div class="login-card" data-testid="login-prompt" data-variant={variant}>
	{#if signedIn}
		<EmptyState
			level={2}
			title={m.comunidade_verify_prompt()}
			why={m.empty_guest_open()}
			illustration={desk}
		>
			{#snippet action()}
				<a class="btn btn--primary btn--md" href="/verificar-email">{m.comunidade_verify_link()}</a>
			{/snippet}
		</EmptyState>
	{:else}
		<EmptyState
			level={2}
			title={m.empty_guest_title()}
			why={signupOpen ? m.empty_guest_open() : m.empty_guest_closed()}
			illustration={desk}
		>
			{#snippet action()}
				<a class="btn btn--primary btn--md" href={requireLoginHref(path)}
					>{m.comunidade_login_link()}</a
				>
				{#if signupOpen}
					<a class="btn btn--ghost btn--md" href="/criar-conta">{m.empty_guest_action()}</a>
				{/if}
			{/snippet}
		</EmptyState>
	{/if}
</div>

<style>
	.login-card {
		margin-top: var(--space-5);
	}
	.login-card :global(.empty-state) {
		max-width: none;
		grid-template-columns: auto 1fr;
		column-gap: var(--space-5);
		background: linear-gradient(180deg, #23262a, #191b1e);
		border-color: var(--rule-control);
		border-radius: var(--rad-xl);
	}
	.login-card :global(.empty-state__art) {
		grid-row: span 3;
		align-self: center;
	}
	.login-card :global(.empty-state__why) {
		max-width: 70ch;
	}
	@media (max-width: 640px) {
		.login-card :global(.empty-state) {
			grid-template-columns: 1fr;
		}
		.login-card :global(.empty-state__art) {
			grid-row: auto;
		}
	}
</style>
