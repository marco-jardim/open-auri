<script lang="ts">
	import { enhance } from '$app/forms';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import ReauthPrompt from '#lib/components/admin/ReauthPrompt.svelte';
	import UserModeration from '#lib/components/admin/UserModeration.svelte';
	import { formatWhen, minutesLeft, userStatus } from '#lib/components/admin/format.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const id = $props.id();

	const emailResults = $derived(form && 'users' in form ? form.users : null);
	const rows = $derived(emailResults ?? data.users);
	const reauthError = $derived(form && 'reauthError' in form ? form.reauthError : null);
	const needsReauth = $derived(
		Boolean(form && 'reauth' in form) || minutesLeft(data.admin.freshUntil) === 0
	);
	const done = $derived(form && 'done' in form ? form.done : null);
	const errorCode = $derived(form && 'error' in form ? form.error : null);
	const emailInvalid = $derived(Boolean(form && 'invalid' in form));
	const reauthed = $derived(Boolean(form && 'reauthed' in form));
	const locale = $derived(getLocale());

	function errorText(code: string): string {
		switch (code) {
			case 'NOT_FOUND':
				return m.admin_error_not_found();
			case 'SELF':
				return m.admin_error_self();
			case 'TARGET_IS_ADMIN':
				return m.admin_error_target_admin();
			case 'NOT_BANNED':
				return m.admin_error_not_banned();
			case 'FAILED':
				return m.admin_error_failed();
			default:
				return m.admin_error_invalid();
		}
	}

	function statusText(row: { banned: boolean; banExpires: string | null }): string {
		const status = userStatus(row);
		if (status === 'active') return m.admin_status_active();
		if (status === 'banned') return m.admin_status_banned();
		if (status === 'ban_expired') return m.admin_status_ban_expired();
		return m.admin_status_banned_until({ date: formatWhen(row.banExpires, locale) });
	}
</script>

<h2 class="heading">{m.admin_users_heading()}</h2>

<div class="searches">
	<form method="GET" role="search" aria-label={m.admin_users_search_label()}>
		<label for="{id}-q">{m.admin_users_search_label()}</label>
		<input id="{id}-q" name="q" value={data.q} maxlength="64" autocomplete="off" />
		<button type="submit">{m.admin_users_search_submit()}</button>
	</form>
	<form method="POST" action="?/searchEmail" use:enhance aria-label={m.admin_users_email_label()}>
		<label for="{id}-email">{m.admin_users_email_label()}</label>
		<input
			id="{id}-email"
			name="email"
			type="email"
			maxlength="254"
			autocomplete="off"
			required
			aria-invalid={emailInvalid ? 'true' : undefined}
		/>
		<button type="submit">{m.admin_users_search_submit()}</button>
	</form>
</div>
{#if data.emailInUrl}
	<p class="note">{m.admin_users_email_in_url()}</p>
{/if}

{#if needsReauth}
	<ReauthPrompt twoFactorEnabled={data.admin.twoFactorEnabled} error={reauthError} />
{/if}

<div aria-live="polite">
	{#if done === 'ban'}
		<p class="ok">{m.admin_done_ban()}</p>
	{:else if done === 'unban'}
		<p class="ok">{m.admin_done_unban()}</p>
	{:else if reauthed}
		<p class="ok">{m.admin_reauth_ok()}</p>
	{:else if errorCode}
		<p class="error" role="alert">{errorText(errorCode)}</p>
	{:else if emailInvalid}
		<p class="error" role="alert">{m.admin_error_invalid()}</p>
	{/if}
</div>

<p class="note">
	{emailResults || data.q
		? m.admin_users_results({ count: String(rows.length) })
		: m.admin_users_recent()}
</p>

{#if rows.length === 0}
	<p>{m.admin_users_empty()}</p>
{:else}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named scroll regions must be focusable for keyboard scrolling.) -->
	<div class="scroll" role="region" aria-label={m.admin_users_heading()} tabindex="0">
		<table>
			<thead>
				<tr>
					<th scope="col">{m.admin_col_nickname()}</th>
					<th scope="col">{m.admin_col_email()}</th>
					<th scope="col">{m.admin_col_verified()}</th>
					<th scope="col">{m.admin_col_role()}</th>
					<th scope="col">{m.admin_col_status()}</th>
					<th scope="col">{m.admin_col_created()}</th>
					<th scope="col">{m.admin_col_actions()}</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.id)}
					<tr>
						<th scope="row">
							{row.nickname ?? m.admin_no_nickname()}
							<span class="id">{row.id}</span>
						</th>
						<td>{row.emailMasked}</td>
						<td>{row.emailVerified ? m.admin_yes() : m.admin_no()}</td>
						<td>{row.role === 'admin' ? m.admin_role_admin() : m.admin_role_user()}</td>
						<td data-banned={row.banned ? 'true' : undefined}>{statusText(row)}</td>
						<td>{formatWhen(row.createdAt, locale)}</td>
						<td>
							{#if row.role === 'admin' || row.id === data.selfId}
								<span class="note">{m.admin_user_is_admin()}</span>
							{:else}
								<UserModeration
									userId={row.id}
									banned={row.banned}
									label={row.nickname ?? row.id}
								/>
							{/if}
							<a href="/admin/auditoria?target={encodeURIComponent(row.id)}"
								>{m.admin_audit_link()}</a
							>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	.heading {
		margin: 0 0 var(--space-3);
		font-size: var(--fs-body);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}
	.searches {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
	}
	.searches form {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	input {
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--rule);
		border-radius: var(--rad-sm);
		background: var(--ink);
		color: var(--text);
		font-family: var(--mono);
	}
	button {
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--accent);
		border-radius: var(--rad-sm);
		background: transparent;
		color: var(--accent-hi);
		font-family: var(--mono);
		cursor: pointer;
	}
	input:focus-visible,
	button:focus-visible,
	a:focus-visible,
	.scroll:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	.scroll {
		overflow-x: auto;
		margin-top: var(--space-3);
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th,
	td {
		padding: var(--space-2);
		border-bottom: 1px solid var(--rule);
		text-align: start;
		vertical-align: top;
	}
	thead th {
		color: var(--muted);
		font-weight: 400;
		font-size: var(--label-min);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}
	tbody th {
		font-weight: 400;
	}
	.id {
		display: block;
		color: var(--muted);
		font-size: var(--label-min);
	}
	[data-banned] {
		color: var(--danger);
	}
	.note {
		color: var(--muted);
	}
	.ok {
		color: var(--state-text);
	}
	.error {
		color: var(--danger);
	}
	a {
		color: var(--nav-link);
	}
</style>
