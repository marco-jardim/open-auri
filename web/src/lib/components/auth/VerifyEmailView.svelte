<!--
	/verificar-email: where Better Auth's verification link lands (`?verificado=1`, or `&error=…`
	when the token is bad) and where sign-up sends the visitor (`?enviado=1`).
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import FormAlert from './FormAlert.svelte';
	import ResendForm from './ResendForm.svelte';
	import { withNext } from './next.ts';
	import type { VerifyStatus } from './status.ts';
	import type { AuthFormState } from './types.ts';
	import type { FormEnhancer } from './enhancer-types.ts';

	interface Props {
		status: VerifyStatus;
		result?: AuthFormState | null;
		next?: string | null;
		availableAt?: number | null;
		now?: () => number;
		enhancer?: FormEnhancer;
	}

	let { status, result = null, next = null, availableAt = null, now, enhancer }: Props = $props();
</script>

{#if status === 'verified'}
	<FormAlert tone="ok" message={m.auth_verify_done()}>
		<p><a href={withNext('/entrar', next)}>{m.auth_verify_signin()}</a></p>
	</FormAlert>
{:else}
	{#if !result}
		{#if status === 'invalid'}
			<FormAlert message={m.auth_verify_invalid()} />
		{:else if status === 'sent'}
			<FormAlert tone="ok" message={m.auth_verify_sent()} />
		{:else}
			<FormAlert tone="info" message={m.auth_verify_idle()} />
		{/if}
	{/if}
	<ResendForm {result} {next} {availableAt} {now} {enhancer} />
{/if}
