<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import Button from '#lib/components/primitives/Button.svelte';
	import Field from '#lib/components/primitives/Field.svelte';
	import Feedback from './Feedback.svelte';
	import { feedbackFor, noEnhance, type FormEnhance, type FormFeedback } from './types.ts';
	import './account.css';

	interface Props {
		min?: number;
		max?: number;
		feedback?: FormFeedback | null;
		enhance?: FormEnhance;
	}

	let { min = 10, max = 128, feedback = null, enhance = noEnhance }: Props = $props();

	const uid = $props.id();
	const mine = $derived(feedbackFor(feedback, 'password'));
</script>

<form method="POST" action="?/password" class="acc-form" use:enhance>
	<Field id="{uid}-current" label={m.conta_password_current()} required>
		{#snippet children(control)}
			<input {...control} name="currentPassword" type="password" autocomplete="current-password" />
		{/snippet}
	</Field>
	<Field
		id="{uid}-new"
		label={m.conta_password_new()}
		hint={m.conta_password_rule({ min: String(min) })}
		required
	>
		{#snippet children(control)}
			<input
				{...control}
				name="newPassword"
				type="password"
				autocomplete="new-password"
				minlength={min}
				maxlength={max}
			/>
		{/snippet}
	</Field>
	<Field id="{uid}-confirm" label={m.conta_password_confirm()} required>
		{#snippet children(control)}
			<input
				{...control}
				name="confirmPassword"
				type="password"
				autocomplete="new-password"
				minlength={min}
				maxlength={max}
			/>
		{/snippet}
	</Field>
	<label class="acc-check">
		<input type="checkbox" name="revokeOtherSessions" checked aria-describedby="{uid}-revoke" />
		<span>{m.conta_password_revoke_label()}</span>
	</label>
	<p class="acc-hint" id="{uid}-revoke">{m.conta_password_revoke_help()}</p>
	<div class="acc-row">
		<Button type="submit">{m.conta_password_submit()}</Button>
	</div>
	<Feedback feedback={mine} />
</form>
