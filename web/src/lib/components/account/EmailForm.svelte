<script lang="ts">
	import Turnstile from '#lib/components/security/Turnstile.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import Feedback from './Feedback.svelte';
	import { formatDateTime } from './format.ts';
	import {
		feedbackFor,
		noEnhance,
		type FormEnhance,
		type FormFeedback,
		type PendingEmailView
	} from './types.ts';
	import './account.css';

	interface Props {
		email: string;
		pending: PendingEmailView | null;
		/** Session younger than the freshness window: no password needed. */
		fresh: boolean;
		/** Turnstile site key; empty renders no widget (tests, misconfiguration). */
		siteKey: string;
		/** TURNSTILE_ACTIONS.changeEmail. */
		turnstileAction?: string;
		/** Set after the new address's link brought the user back (`?email=alterado`). */
		changed?: boolean;
		feedback?: FormFeedback | null;
		enhance?: FormEnhance;
	}

	let {
		email,
		pending,
		fresh,
		siteKey,
		turnstileAction = 'change-email',
		changed = false,
		feedback = null,
		enhance = noEnhance
	}: Props = $props();

	const uid = $props.id();
	const mine = $derived(feedbackFor(feedback, 'email'));
	let token = $state('');
</script>

<div class="email">
	<p class="current">
		<span class="acc-label">{m.conta_email_current()}</span>
		<span class="acc-mono address">{email}</span>
	</p>
	{#if changed && !pending}
		<p class="acc-note" role="status">{m.conta_email_changed()}</p>
	{/if}
	{#if pending}
		<div class="acc-note acc-note--warn pending" data-testid="email-pending">
			<p class="acc-label">{m.conta_email_pending_title()}</p>
			<p>
				{m.conta_email_pending_body({
					email: pending.newEmail,
					date: formatDateTime(pending.expiresAt)
				})}
			</p>
		</div>
	{/if}
	<form method="POST" action="?/email" class="acc-form" use:enhance>
		<div class="acc-field">
			<label class="acc-label" for="{uid}-new">{m.conta_email_new()}</label>
			<input
				id="{uid}-new"
				class="acc-input"
				name="newEmail"
				type="email"
				autocomplete="email"
				maxlength={254}
				required
				value={mine && !mine.ok ? (mine.value ?? '') : ''}
				aria-describedby="{uid}-how"
			/>
			<p class="acc-hint" id="{uid}-how">{m.conta_email_how()}</p>
		</div>
		{#if !fresh}
			<div class="acc-field">
				<label class="acc-label" for="{uid}-password">{m.conta_email_password()}</label>
				<input
					id="{uid}-password"
					class="acc-input"
					name="password"
					type="password"
					autocomplete="current-password"
					required
					aria-describedby="{uid}-password-why"
				/>
				<p class="acc-hint" id="{uid}-password-why">{m.conta_email_password_why()}</p>
			</div>
		{/if}
		{#if siteKey}
			<!-- A Turnstile token is single use: a new widget after every answer. -->
			{#key mine}
				<Turnstile {siteKey} action={turnstileAction} bind:token />
			{/key}
		{/if}
		<div class="acc-row">
			<button class="acc-btn" type="submit" disabled={siteKey !== '' && token === ''}>
				{m.conta_email_submit()}
			</button>
		</div>
		<Feedback feedback={mine} />
	</form>
</div>

<style>
	.email {
		display: grid;
		gap: var(--space-3, 12px);
	}

	.current {
		display: grid;
		gap: 4px;
		margin: 0;
	}

	.address {
		color: var(--text, #ece7dd);
		font-size: 14px;
		overflow-wrap: anywhere;
	}

	.pending {
		display: grid;
		gap: 4px;
	}

	.pending p {
		margin: 0;
		overflow-wrap: anywhere;
	}
</style>
