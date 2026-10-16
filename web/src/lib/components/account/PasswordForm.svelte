<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
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
	<div class="acc-field">
		<label class="acc-label" for="{uid}-current">{m.conta_password_current()}</label>
		<input
			id="{uid}-current"
			class="acc-input"
			name="currentPassword"
			type="password"
			autocomplete="current-password"
			required
		/>
	</div>
	<div class="acc-field">
		<label class="acc-label" for="{uid}-new">{m.conta_password_new()}</label>
		<input
			id="{uid}-new"
			class="acc-input"
			name="newPassword"
			type="password"
			autocomplete="new-password"
			minlength={min}
			maxlength={max}
			required
			aria-describedby="{uid}-rule"
		/>
		<p class="acc-hint" id="{uid}-rule">{m.conta_password_rule({ min: String(min) })}</p>
	</div>
	<div class="acc-field">
		<label class="acc-label" for="{uid}-confirm">{m.conta_password_confirm()}</label>
		<input
			id="{uid}-confirm"
			class="acc-input"
			name="confirmPassword"
			type="password"
			autocomplete="new-password"
			minlength={min}
			maxlength={max}
			required
		/>
	</div>
	<label class="acc-check">
		<input type="checkbox" name="revokeOtherSessions" checked aria-describedby="{uid}-revoke" />
		<span>{m.conta_password_revoke_label()}</span>
	</label>
	<p class="acc-hint" id="{uid}-revoke">{m.conta_password_revoke_help()}</p>
	<div class="acc-row">
		<button class="acc-btn" type="submit">{m.conta_password_submit()}</button>
	</div>
	<Feedback feedback={mine} />
</form>
