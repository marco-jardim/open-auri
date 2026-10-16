<!--
	Report the scope target (signed in, verified). Reason + optional private note (only admins read
	it) + the Turnstile check (`x-turnstile-token`, action "report"): sending is impossible without a
	token, and the token is single use.
-->
<script lang="ts">
	import Turnstile from '#lib/components/security/Turnstile.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { SocialApi } from '#lib/social/index.ts';
	import type { ReportReason } from '#lib/server/social/types.ts';
	import LoginPrompt from './LoginPrompt.svelte';
	import {
		NOTE_MAX,
		REPORT_REASONS,
		TURNSTILE_REPORT_ACTION,
		errorText,
		type Channel,
		type SessionView
	} from './model.ts';

	let {
		api,
		session,
		channel,
		siteKey,
		online,
		token = $bindable('')
	}: {
		api: SocialApi;
		session: SessionView;
		channel: Channel | null;
		siteKey: string;
		online: boolean;
		token?: string;
	} = $props();

	const id = $props.id();
	let reason = $state<ReportReason>('dangerous');
	let note = $state('');
	let busy = $state(false);
	let message = $state('');
	let sentFor = $state('');

	const canSend = $derived(
		!!channel &&
			session.verified &&
			token !== '' &&
			online &&
			!busy &&
			sentFor !== channel.lineageId
	);

	const reasonText: Record<ReportReason, () => string> = {
		dangerous: () => m.comunidade_report_reason_dangerous(),
		spam: () => m.comunidade_report_reason_spam(),
		offensive: () => m.comunidade_report_reason_offensive(),
		copyright: () => m.comunidade_report_reason_copyright(),
		impersonation: () => m.comunidade_report_reason_impersonation(),
		other: () => m.comunidade_report_reason_other()
	};

	async function send() {
		if (!canSend || !channel) return;
		busy = true;
		message = '';
		try {
			await api.report(
				{
					targetKind: 'lineage',
					targetId: channel.lineageId,
					reason,
					note: note.trim() === '' ? null : note
				},
				token
			);
			sentFor = channel.lineageId;
			note = '';
			message = m.comunidade_report_sent();
		} catch (error) {
			message = errorText(error);
		} finally {
			token = '';
			busy = false;
		}
	}
</script>

<section class="panel report" aria-labelledby="{id}-title">
	<div class="sec-head">
		<h2 id="{id}-title">{m.comunidade_report_title()}</h2>
		<p>{m.comunidade_report_lede()}</p>
	</div>
	{#if !channel}
		<p class="note">{m.comunidade_select_first()}</p>
	{:else if !session.verified}
		<LoginPrompt signedIn={session.signedIn} />
	{:else}
		<p class="target">{m.comunidade_report_target({ name: channel.name })}</p>
		<label>
			<span class="fld-lbl">{m.comunidade_report_reason()}</span>
			<select bind:value={reason}>
				{#each REPORT_REASONS as value (value)}
					<option {value}>{reasonText[value]()}</option>
				{/each}
			</select>
		</label>
		<label>
			<span class="fld-lbl">{m.comunidade_report_note()}</span>
			<textarea maxlength={NOTE_MAX} bind:value={note}></textarea>
		</label>
		{#if siteKey}
			<Turnstile {siteKey} action={TURNSTILE_REPORT_ACTION} bind:token />
		{:else}
			<p class="note">{m.comunidade_turnstile_unavailable()}</p>
		{/if}
		<div class="row-btns">
			<button type="button" class="btn primary" disabled={!canSend} onclick={send}
				>{m.comunidade_report_send()}</button
			>
		</div>
		{#if token === '' && sentFor !== channel.lineageId}
			<p class="note">{m.comunidade_report_needs_check()}</p>
		{/if}
	{/if}
	<p class="note" role="status">{message}</p>
</section>

<style>
	.report {
		background: linear-gradient(180deg, #2b2324, #1c1718);
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.report label {
		display: flex;
		flex-direction: column;
	}
	.target {
		margin: 0;
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	select {
		background: #0f0e0c;
		color: #ece7dd;
		border: 1px solid #000;
		padding: 6px 8px;
		font: 12px var(--mono);
		max-width: 320px;
	}
</style>
