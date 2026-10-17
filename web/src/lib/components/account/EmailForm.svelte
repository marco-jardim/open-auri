<script lang="ts">
	import Turnstile from '#lib/components/security/Turnstile.svelte';
	import Button from '#lib/components/primitives/Button.svelte';
	import Field from '#lib/components/primitives/Field.svelte';
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
		<Field id="{uid}-new" label={m.conta_email_new()} hint={m.conta_email_how()} required>
			{#snippet children(control)}
				<input
					{...control}
					name="newEmail"
					type="email"
					autocomplete="email"
					maxlength={254}
					value={mine && !mine.ok ? (mine.value ?? '') : ''}
				/>
			{/snippet}
		</Field>
		{#if !fresh}
			<Field
				id="{uid}-password"
				label={m.conta_email_password()}
				hint={m.conta_email_password_why()}
				required
			>
				{#snippet children(control)}
					<input {...control} name="password" type="password" autocomplete="current-password" />
				{/snippet}
			</Field>
		{/if}
		{#if siteKey}
			<!-- A Turnstile token is single use: a new widget after every answer. -->
			{#key mine}
				<Turnstile {siteKey} action={turnstileAction} bind:token />
			{/key}
		{/if}
		<div class="acc-row">
			<!-- Waits for the Turnstile token and says so; the server checks the token anyway. -->
			<Button
				type="submit"
				disabledReason={siteKey !== '' && token === '' ? m.fuxp8_email_wait_check() : null}
			>
				{m.conta_email_submit()}
			</Button>
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
		font-size: var(--fs-ui, 14px);
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
