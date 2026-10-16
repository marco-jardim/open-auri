<!-- Second step of sign-in for accounts with two-factor authentication (TOTP or backup code). -->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import AuthField from './AuthField.svelte';
	import FormAlert from './FormAlert.svelte';
	import SubmitSwitch from './SubmitSwitch.svelte';
	import { FormController } from './form-controller.svelte.ts';
	import { errorMessage } from './messages.ts';
	import { withNext } from './next.ts';
	import type { AuthFormState } from './types.ts';
	import type { FormEnhancer } from './enhancer-types.ts';

	interface Props {
		result?: AuthFormState | null;
		next?: string | null;
		enhancer?: FormEnhancer;
	}

	let { result = null, next: given = null, enhancer }: Props = $props();
	const controller = new FormController(() => enhancer);
	const next = $derived(result?.next ?? given);
	const uid = $props.id();
	let method = $state<'totp' | 'backup'>('totp');
</script>

<form method="POST" action="?/twoFactor" use:controller.enhance aria-labelledby="{uid}-title">
	<h2 id="{uid}-title" class="step-title">{m.auth_twofactor_title()}</h2>
	<p class="step-lede">{m.auth_twofactor_lede()}</p>
	{#if result?.error}
		<FormAlert message={errorMessage(result.error, result.retryAfter)} />
	{/if}
	{#if next}<input type="hidden" name="next" value={next} />{/if}
	<fieldset class="methods">
		<legend>{m.auth_twofactor_method()}</legend>
		<label>
			<input type="radio" name="method" value="totp" bind:group={method} />
			{m.auth_twofactor_totp()}
		</label>
		<label>
			<input type="radio" name="method" value="backup" bind:group={method} />
			{m.auth_twofactor_backup()}
		</label>
	</fieldset>
	<AuthField
		name="code"
		label={m.auth_field_code()}
		autocomplete="one-time-code"
		inputmode={method === 'totp' ? 'numeric' : 'text'}
		maxlength={32}
		revealable={false}
		issue={result?.fields?.code}
	/>
	<SubmitSwitch
		label={m.auth_twofactor_submit()}
		busyLabel={m.auth_twofactor_busy()}
		busy={controller.busy}
	/>
	<p class="restart"><a href={withNext('/entrar', next)}>{m.auth_twofactor_restart()}</a></p>
</form>

<style>
	.step-title {
		margin: 14px 0 0;
		font: 600 14px/1.3 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}

	.step-lede {
		margin: 6px 0 0;
		font-size: 13px;
		color: var(--strip-muted, #a9b2bd);
	}

	.methods {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 18px;
		margin: 14px 0 0;
		padding: 0;
		border: 0;
		font-size: 13px;
	}

	legend {
		margin-bottom: 6px;
		padding: 0;
		font: 600 12px/1.3 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}

	.methods label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
	}

	input[type='radio'] {
		accent-color: var(--accent);
	}

	.restart {
		margin: 12px 0 0;
		font-size: 13px;
	}

	.restart a {
		color: var(--strip-text, #e3e7ec);
	}
</style>
