<script lang="ts">
	// Re-authentication prompt for destructive admin actions. Posts the TOTP code to the page's
	// `?/reauth` action (progressive enhancement: works without JavaScript). Admins without 2FA
	// (possible only with ADMIN_2FA_REQUIRED=false) are told to sign out and in again.
	import { enhance } from '$app/forms';
	import { m } from '#lib/paraglide/messages.js';

	type ReauthError = 'NO_SECOND_FACTOR' | 'INVALID_CODE' | 'RATE_LIMITED';

	let {
		twoFactorEnabled,
		error = null
	}: { twoFactorEnabled: boolean; error?: ReauthError | null } = $props();

	const id = $props.id();
	const errorText = $derived(
		error === 'INVALID_CODE'
			? m.admin_reauth_invalid()
			: error === 'RATE_LIMITED'
				? m.admin_reauth_rate_limited()
				: error === 'NO_SECOND_FACTOR'
					? m.admin_reauth_no_2fa()
					: null
	);
</script>

<section class="reauth" aria-labelledby="{id}-heading">
	<h2 id="{id}-heading">{m.admin_reauth_heading()}</h2>
	<p>{m.admin_reauth_body()}</p>
	{#if twoFactorEnabled}
		<form method="POST" action="?/reauth" use:enhance>
			<label for="{id}-code">{m.admin_reauth_code_label()}</label>
			<input
				id="{id}-code"
				name="code"
				inputmode="numeric"
				autocomplete="one-time-code"
				maxlength="8"
				required
				aria-invalid={errorText ? 'true' : undefined}
				aria-describedby={errorText ? `${id}-error` : undefined}
			/>
			<button type="submit">{m.admin_reauth_submit()}</button>
		</form>
	{:else if error !== 'NO_SECOND_FACTOR'}
		<!-- With that error the alert below carries this same sentence: it is said once, as the alert. -->
		<p>{m.admin_reauth_no_2fa()}</p>
	{/if}
	{#if errorText}
		<p id="{id}-error" class="error" role="alert">{errorText}</p>
	{/if}
</section>

<style>
	.reauth {
		margin-block: var(--space-4);
		padding: var(--space-4);
		border: 1px solid var(--danger);
		border-radius: var(--rad-md);
		background: var(--ink-2);
	}
	h2 {
		margin: 0 0 var(--space-2);
		font-family: var(--mono);
		font-size: var(--fs-body);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}
	form {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	input {
		width: 10ch;
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--rule);
		border-radius: var(--rad-sm);
		background: var(--ink);
		color: var(--text);
		font-family: var(--mono);
	}
	button {
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--accent);
		border-radius: var(--rad-sm);
		background: transparent;
		color: var(--accent-hi);
		font-family: var(--mono);
		cursor: pointer;
	}
	input:focus-visible,
	button:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	.error {
		color: var(--danger);
	}
</style>
