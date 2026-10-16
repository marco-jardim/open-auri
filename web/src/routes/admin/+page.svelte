<script lang="ts">
	import { enhance } from '$app/forms';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import ReauthPrompt from '#lib/components/admin/ReauthPrompt.svelte';
	import AuditTable from '#lib/components/admin/AuditTable.svelte';
	import { minutesLeft } from '#lib/components/admin/format.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const reauthError = $derived(form && 'reauthError' in form ? form.reauthError : null);
	const needsReauth = $derived(
		Boolean(form && 'reauth' in form) || minutesLeft(data.admin.freshUntil) === 0
	);
	const done = $derived(form && 'done' in form ? form.done : null);
	const reauthed = $derived(Boolean(form && 'reauthed' in form));
	const invalid = $derived(Boolean(form && 'error' in form));
</script>

<section aria-labelledby="mode-heading" class="panel">
	<h2 id="mode-heading">{m.admin_mode_heading()}</h2>
	<p>{data.readOnly ? m.admin_mode_on() : m.admin_mode_off()}</p>
	<p class="note">{m.admin_mode_note()}</p>

	{#if needsReauth}
		<ReauthPrompt twoFactorEnabled={data.admin.twoFactorEnabled} error={reauthError} />
	{:else}
		<p class="note">
			{m.admin_session_fresh({ minutes: String(minutesLeft(data.admin.freshUntil)) })}
		</p>
	{/if}

	<form method="POST" action="?/readOnly" use:enhance>
		<input type="hidden" name="mode" value={data.readOnly ? 'off' : 'on'} />
		<button type="submit" class:danger={!data.readOnly}>
			{data.readOnly ? m.admin_mode_turn_off() : m.admin_mode_turn_on()}
		</button>
	</form>

	<div aria-live="polite">
		{#if done === 'read_only_on'}
			<p class="ok">{m.admin_done_read_only_on()}</p>
		{:else if done === 'read_only_off'}
			<p class="ok">{m.admin_done_read_only_off()}</p>
		{:else if reauthed}
			<p class="ok">{m.admin_reauth_ok()}</p>
		{:else if invalid}
			<p class="error" role="alert">{m.admin_error_invalid()}</p>
		{/if}
	</div>
</section>

<section aria-labelledby="recent-heading" class="panel">
	<h2 id="recent-heading">{m.admin_recent_heading()}</h2>
	<AuditTable rows={data.recent} locale={getLocale()} />
	<p><a href="/admin/auditoria">{m.admin_audit_see_all()}</a></p>
</section>

<style>
	.panel {
		margin-bottom: var(--space-6);
	}
	h2 {
		margin: 0 0 var(--space-3);
		font-size: var(--fs-body);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}
	.note {
		color: var(--muted);
	}
	button {
		padding: var(--space-2) var(--space-4);
		border: 1px solid var(--accent);
		border-radius: var(--rad-sm);
		background: transparent;
		color: var(--accent-hi);
		font-family: var(--mono);
		cursor: pointer;
	}
	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}
	button:focus-visible,
	a:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	a {
		color: var(--nav-link);
	}
	.ok {
		color: var(--state-text);
	}
	.error {
		color: var(--danger);
	}
</style>
