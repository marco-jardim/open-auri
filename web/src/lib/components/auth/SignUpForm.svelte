<script lang="ts">
	import { untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import AuthField from './AuthField.svelte';
	import FormAlert from './FormAlert.svelte';
	import HumanCheck from './HumanCheck.svelte';
	import PasswordStrength from './PasswordStrength.svelte';
	import SubmitSwitch from './SubmitSwitch.svelte';
	import { AUTH_TURNSTILE_ACTIONS } from './fields.ts';
	import { FormController } from './form-controller.svelte.ts';
	import { errorMessage } from './messages.ts';
	import { PASSWORD_MAX, PASSWORD_MIN } from './password-strength.ts';
	import type { AuthFormState } from './types.ts';
	import type { FormEnhancer } from './enhancer-types.ts';

	interface Props {
		result?: AuthFormState | null;
		next?: string | null;
		siteKey: string;
		enhancer?: FormEnhancer;
	}

	let { result = null, next = null, siteKey, enhancer }: Props = $props();
	const controller = new FormController(() => enhancer);
	const uid = $props.id();
	const meterId = `${uid}-strength`;
	let email = $state(untrack(() => result?.values?.email ?? ''));
	let password = $state('');
</script>

<form method="POST" use:controller.enhance>
	{#if result?.error}
		<FormAlert message={errorMessage(result.error, result.retryAfter)} />
	{/if}
	{#if next}<input type="hidden" name="next" value={next} />{/if}
	<AuthField
		name="email"
		type="email"
		label={m.auth_field_email()}
		autocomplete="email"
		inputmode="email"
		maxlength={254}
		bind:value={email}
		issue={result?.fields?.email}
	/>
	<AuthField
		name="password"
		type="password"
		label={m.auth_field_password()}
		autocomplete="new-password"
		minlength={PASSWORD_MIN}
		maxlength={PASSWORD_MAX}
		hint={m.auth_password_hint({ min: PASSWORD_MIN })}
		describedby={meterId}
		bind:value={password}
		issue={result?.fields?.password}
	/>
	<PasswordStrength id={meterId} {password} context={[email]} />
	<AuthField
		name="confirm"
		type="password"
		label={m.auth_field_confirm()}
		autocomplete="new-password"
		maxlength={PASSWORD_MAX}
		revealable={false}
		mustMatch={password}
		issue={result?.fields?.confirm}
	/>
	<HumanCheck {siteKey} action={AUTH_TURNSTILE_ACTIONS.signUp} resetKey={controller.attempt} />
	<p class="terms">
		{m.auth_signup_terms()}
		<a href="/termos">{m.auth_signup_terms_link()}</a> ·
		<a href="/privacidade">{m.auth_signup_privacy_link()}</a>
	</p>
	<SubmitSwitch
		label={m.auth_signup_submit()}
		busyLabel={m.auth_signup_busy()}
		busy={controller.busy}
	/>
</form>

<style>
	.terms {
		margin: 14px 0 0;
		font-size: 12.5px;
		color: var(--strip-muted, #a9b2bd);
	}

	.terms a {
		color: var(--strip-text, #e3e7ec);
	}
</style>
