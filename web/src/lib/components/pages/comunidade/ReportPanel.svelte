<!--
	Report the scope target (signed in, verified). Reason + optional private note (only admins read
	it) + the Turnstile check (`x-turnstile-token`, action "report"): sending is impossible without a
	token, and the token is single use.

	Silent consent (spec §4.1, L6, T10): the page mounts this panel only when the visitor opens the
	"Denunciar" drawer, and the Turnstile module is imported only when the form is really shown (a
	verified account and a selected channel). Before that no third party is contacted and no check
	error can appear.
-->
<script lang="ts">
	import Button from '#lib/components/primitives/Button.svelte';
	import { page } from '$app/state';
	import { signInHref } from '#lib/components/chrome/account.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { SocialApi } from '#lib/social/index.ts';
	import type { ReportReason, ReportTargetKind } from '#lib/server/social/types.ts';
	import {
		NOTE_MAX,
		REPORT_REASONS,
		TURNSTILE_REPORT_ACTION,
		errorText,
		type SessionView
	} from './model.ts';

	type TurnstileComponent = typeof import('#lib/components/security/Turnstile.svelte').default;

	let {
		api,
		session,
		subject,
		targetName,
		siteKey,
		online,
		token = $bindable('')
	}: {
		api: SocialApi;
		session: SessionView;
		subject: { kind: ReportTargetKind; id: string } | null;
		targetName?: string;
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
	const targetKey = $derived(subject ? `${subject.kind}:${subject.id}` : '');

	const canSend = $derived(
		!!subject && session.verified && token !== '' && online && !busy && sentFor !== targetKey
	);
	/** Why "Enviar denúncia" cannot act right now; null when it can (T8). */
	const sendReason = $derived(
		!subject
			? m.comunidade_select_first()
			: !session.verified
				? session.signedIn
					? m.comunidade_verify_prompt()
					: m.comunidade_v2_reason_account()
				: !online
					? m.comunidade_offline()
					: sentFor === targetKey
						? m.comunidade_v2_reason_report_sent()
						: token === ''
							? m.comunidade_report_needs_check()
							: null
	);
	const formShown = $derived(!!subject && session.verified);

	const reasonText: Record<ReportReason, () => string> = {
		dangerous: () => m.comunidade_report_reason_dangerous(),
		spam: () => m.comunidade_report_reason_spam(),
		offensive: () => m.comunidade_report_reason_offensive(),
		copyright: () => m.comunidade_report_reason_copyright(),
		impersonation: () => m.comunidade_report_reason_impersonation(),
		other: () => m.comunidade_report_reason_other()
	};

	// ---- Turnstile, on demand -----------------------------------------------------------------------

	let Turnstile = $state.raw<TurnstileComponent | null>(null);
	let turnstileFailed = $state(false);
	let checkAttempt = $state(0);

	$effect(() => {
		if (!formShown || !siteKey || Turnstile || turnstileFailed) return;
		let live = true;
		import('#lib/components/security/Turnstile.svelte')
			.then((module) => {
				if (live) Turnstile = module.default;
			})
			.catch((error: unknown) => {
				if (!live) return;
				turnstileFailed = true;
				console.warn(
					JSON.stringify({
						event: 'comunidade.turnstile_import_failed',
						error: error instanceof Error ? error.name : 'unknown'
					})
				);
			});
		return () => {
			live = false;
		};
	});

	async function send() {
		if (!canSend || !subject) return;
		busy = true;
		message = '';
		// The submitted target: the selected channel may change while the request is in flight.
		const { kind: targetKind, id: targetId } = subject;
		const submittedKey = targetKey;
		try {
			await api.report(
				{
					targetKind,
					targetId,
					reason,
					note: note.trim() === '' ? null : note
				},
				token
			);
			sentFor = submittedKey;
			if (targetKey === submittedKey) {
				note = '';
				message = m.comunidade_report_sent();
			}
		} catch (error) {
			message = errorText(error);
		} finally {
			token = '';
			checkAttempt++;
			busy = false;
		}
	}
</script>

<svelte:head>
	{#if formShown && siteKey}
		<link rel="preconnect" href="https://challenges.cloudflare.com" />
	{/if}
</svelte:head>

<div class="report" data-testid="report-panel">
	{#if !subject}
		<p class="note">{m.comunidade_select_first()}</p>
	{:else if !session.verified}
		{#if session.signedIn}
			<p>{m.comunidade_verify_prompt()}</p>
		{:else}
			<p>{m.fxpc_report_account()}</p>
			<a href={signInHref(page.url.pathname + page.url.search + page.url.hash)}
				>{m.shared_curve_login()}</a
			>
		{/if}
		<div class="row-btns">
			<Button variant="danger" disabledReason={sendReason}>{m.comunidade_report_send()}</Button>
		</div>
	{:else}
		<p class="target">{m.comunidade_report_target({ name: targetName ?? subject.id })}</p>
		<label for="{id}-reason">
			<span class="fld-lbl">{m.comunidade_report_reason()}</span>
		</label>
		<select id="{id}-reason" class="desk-select" bind:value={reason}>
			{#each REPORT_REASONS as value (value)}
				<option {value}>{reasonText[value]()}</option>
			{/each}
		</select>
		<label>
			<span class="fld-lbl">{m.comunidade_report_note()}</span>
			<textarea maxlength={NOTE_MAX} bind:value={note}></textarea>
		</label>
		<div class="check" data-testid="report-check">
			{#if !siteKey || turnstileFailed}
				<p class="note">{m.comunidade_turnstile_unavailable()}</p>
			{:else if Turnstile}
				{#key checkAttempt}
					<Turnstile {siteKey} action={TURNSTILE_REPORT_ACTION} bind:token />
				{/key}
			{:else}
				<div class="turnstile-wait" role="status" aria-busy="true">
					<span class="skeleton" aria-hidden="true"></span>
					<span>{m.comunidade_v2_turnstile_preparing()}</span>
				</div>
			{/if}
		</div>
		<div class="row-btns">
			<Button variant="danger" disabledReason={sendReason} loading={busy} onclick={send}
				>{m.comunidade_report_send()}</Button
			>
		</div>
		{#if token === '' && sentFor !== targetKey}
			<p class="note">{m.comunidade_report_needs_check()}</p>
		{/if}
	{/if}
	<p class="note" role="status">{message}</p>
</div>

<style>
	.report {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-top: var(--space-3);
	}
	.report label {
		display: flex;
		flex-direction: column;
	}
	.report select {
		max-width: 320px;
	}
	.target {
		margin: 0;
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}
	.check {
		min-height: 65px;
	}
</style>
