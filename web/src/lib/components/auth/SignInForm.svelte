<script lang="ts">
	import { untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import AuthField from './AuthField.svelte';
	import FormAlert from './FormAlert.svelte';
	import HumanCheck from './HumanCheck.svelte';
	import SubmitSwitch from './SubmitSwitch.svelte';
	import TwoFactorForm from './TwoFactorForm.svelte';
	import { AUTH_TURNSTILE_ACTIONS } from './fields.ts';
	import { FormController } from './form-controller.svelte.ts';
	import { errorMessage } from './messages.ts';
	import { withNext } from './next.ts';
	import type { AuthFormState, FormEnhancer } from './types.ts';

	interface Props {
		/** Action data (`form` prop of the page). */
		result?: AuthFormState | null;
		/** Validated return path (safeNext), or null. */
		next?: string | null;
		siteKey: string;
		/** `reset`: the password was just reset (from `?redefinida=1`). */
		notice?: 'reset' | null;
		enhancer?: FormEnhancer;
	}

	let { result = null, next = null, siteKey, notice = null, enhancer }: Props = $props();
	const controller = new FormController(() => enhancer);
	// After a no-JS post to `?/signIn` the page URL has lost `?next=`; the action echoes it.
	const target = $derived(result?.next ?? next);
	let email = $state(untrack(() => result?.values?.email ?? ''));
</script>

{#if result?.step === 'two-factor'}
	<TwoFactorForm {result} next={target} {enhancer} />
{:else}
	<form method="POST" action="?/signIn" use:controller.enhance>
		{#if notice === 'reset' && !result?.error}
			<FormAlert tone="ok" message={m.auth_signin_reset_done()} />
		{/if}
		{#if result?.error}
			<FormAlert message={errorMessage(result.error, result.retryAfter)}>
				{#if result.error === 'unverified'}
					<p><a href={withNext('/verificar-email', target)}>{m.auth_error_unverified_link()}</a></p>
				{/if}
			</FormAlert>
		{/if}
		{#if target}<input type="hidden" name="next" value={target} />{/if}
		<AuthField
			name="email"
			type="email"
			label={m.auth_field_email()}
			autocomplete="username"
			inputmode="email"
			maxlength={254}
			bind:value={email}
			issue={result?.fields?.email}
		/>
		<AuthField
			name="password"
			type="password"
			label={m.auth_field_password()}
			autocomplete="current-password"
			maxlength={128}
			issue={result?.fields?.password}
		/>
		<HumanCheck {siteKey} action={AUTH_TURNSTILE_ACTIONS.signIn} resetKey={controller.attempt} />
		<SubmitSwitch
			label={m.auth_signin_submit()}
			busyLabel={m.auth_signin_busy()}
			busy={controller.busy}
		/>
	</form>
{/if}
