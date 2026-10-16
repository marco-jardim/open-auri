<!-- /esqueci-senha: request a reset link. Same answer for any address (no enumeration). -->
<script lang="ts">
	import { untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import AuthField from './AuthField.svelte';
	import FormAlert from './FormAlert.svelte';
	import HumanCheck from './HumanCheck.svelte';
	import SubmitSwitch from './SubmitSwitch.svelte';
	import { AUTH_TURNSTILE_ACTIONS } from './fields.ts';
	import { FormController } from './form-controller.svelte.ts';
	import { errorMessage } from './messages.ts';
	import type { AuthFormState, FormEnhancer } from './types.ts';

	interface Props {
		result?: AuthFormState | null;
		siteKey: string;
		enhancer?: FormEnhancer;
	}

	let { result = null, siteKey, enhancer }: Props = $props();
	const controller = new FormController(() => enhancer);
	let email = $state(untrack(() => result?.values?.email ?? ''));
</script>

<form method="POST" use:controller.enhance>
	{#if result?.sent}
		<FormAlert tone="ok" message={m.auth_forgot_done()} />
	{:else if result?.error}
		<FormAlert message={errorMessage(result.error, result.retryAfter)} />
	{/if}
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
	<HumanCheck {siteKey} action={AUTH_TURNSTILE_ACTIONS.reset} resetKey={controller.attempt} />
	<SubmitSwitch
		label={m.auth_forgot_submit()}
		busyLabel={m.auth_forgot_busy()}
		busy={controller.busy}
	/>
</form>
