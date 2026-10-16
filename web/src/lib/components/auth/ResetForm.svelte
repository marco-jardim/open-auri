<!-- /redefinir-senha?token=…: choose a new password (the link from the reset e-mail). -->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import AuthField from './AuthField.svelte';
	import FormAlert from './FormAlert.svelte';
	import PasswordStrength from './PasswordStrength.svelte';
	import SubmitSwitch from './SubmitSwitch.svelte';
	import { FormController } from './form-controller.svelte.ts';
	import { errorMessage } from './messages.ts';
	import { PASSWORD_MAX, PASSWORD_MIN } from './password-strength.ts';
	import type { AuthFormState } from './types.ts';
	import type { FormEnhancer } from './enhancer-types.ts';

	interface Props {
		/** Token from the e-mail link, or null when the link is missing or malformed. */
		token: string | null;
		result?: AuthFormState | null;
		enhancer?: FormEnhancer;
	}

	let { token, result = null, enhancer }: Props = $props();
	const controller = new FormController(() => enhancer);
	const uid = $props.id();
	const meterId = `${uid}-strength`;
	let password = $state('');
</script>

{#if !token || result?.error === 'token'}
	<FormAlert message={token ? m.auth_error_token() : m.auth_reset_missing()}>
		<p><a href="/esqueci-senha">{m.auth_reset_request_new()}</a></p>
	</FormAlert>
{:else}
	<form method="POST" use:controller.enhance>
		{#if result?.error}
			<FormAlert message={errorMessage(result.error, result.retryAfter)} />
		{/if}
		<input type="hidden" name="token" value={token} />
		<AuthField
			name="password"
			type="password"
			label={m.auth_field_new_password()}
			autocomplete="new-password"
			minlength={PASSWORD_MIN}
			maxlength={PASSWORD_MAX}
			hint={m.auth_password_hint({ min: PASSWORD_MIN })}
			describedby={meterId}
			bind:value={password}
			issue={result?.fields?.password}
		/>
		<PasswordStrength id={meterId} {password} />
		<AuthField
			name="confirm"
			type="password"
			label={m.auth_field_confirm()}
			autocomplete="new-password"
			maxlength={PASSWORD_MAX}
			revealable={false}
			issue={result?.fields?.confirm}
		/>
		<SubmitSwitch
			label={m.auth_reset_submit()}
			busyLabel={m.auth_reset_busy()}
			busy={controller.busy}
		/>
	</form>
{/if}
