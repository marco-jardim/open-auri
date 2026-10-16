<script lang="ts">
	import { enhance } from '$app/forms';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import ReauthPrompt from '#lib/components/admin/ReauthPrompt.svelte';
	import { formatWhen, minutesLeft } from '#lib/components/admin/format.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const uid = $props.id();

	const reauthError = $derived(form && 'reauthError' in form ? form.reauthError : null);
	const needsReauth = $derived(
		Boolean(form && 'reauth' in form) || minutesLeft(data.admin.freshUntil) === 0
	);
	const done = $derived(form && 'done' in form ? form.done : null);
	const errorCode = $derived(form && 'error' in form ? form.error : null);
	const reauthed = $derived(Boolean(form && 'reauthed' in form));
	const locale = $derived(getLocale());

	const DURATIONS = ['1', '7', '30', '90', '365'] as const;

	function kindText(kind: string): string {
		if (kind === 'lineage') return m.admin_mod_kind_lineage();
		if (kind === 'pack') return m.admin_mod_kind_pack();
		return m.admin_mod_kind_user();
	}

	function stateText(state: string | null): string {
		switch (state) {
			case 'visible':
				return m.admin_mod_state_visible();
			case 'auto_hidden':
				return m.admin_mod_state_auto_hidden();
			case 'hidden':
				return m.admin_mod_state_hidden();
			case 'removed':
				return m.admin_mod_state_removed();
			default:
				return m.admin_mod_state_none();
		}
	}

	function reasonText(reason: string): string {
		switch (reason) {
			case 'dangerous':
				return m.admin_mod_reason_dangerous();
			case 'spam':
				return m.admin_mod_reason_spam();
			case 'offensive':
				return m.admin_mod_reason_offensive();
			case 'copyright':
				return m.admin_mod_reason_copyright();
			case 'impersonation':
				return m.admin_mod_reason_impersonation();
			default:
				return m.admin_mod_reason_other();
		}
	}

	function doneText(action: string): string {
		switch (action) {
			case 'hide':
				return m.admin_mod_done_hide();
			case 'restore':
				return m.admin_mod_done_restore();
			case 'remove':
				return m.admin_mod_done_remove();
			case 'dismiss':
				return m.admin_mod_done_dismiss();
			case 'ban':
				return m.admin_mod_done_ban();
			case 'curate':
				return m.admin_mod_done_curate();
			default:
				return m.admin_mod_done_uncurate();
		}
	}

	function errorText(code: string): string {
		switch (code) {
			case 'NOT_FOUND':
				return m.admin_error_not_found();
			case 'SELF':
				return m.admin_error_self();
			case 'TARGET_IS_ADMIN':
				return m.admin_error_target_admin();
			case 'NO_AUTHOR':
				return m.admin_mod_error_no_author();
			case 'UNSUPPORTED':
				return m.admin_mod_error_unsupported();
			case 'FAILED':
				return m.admin_error_failed();
			default:
				return m.admin_error_invalid();
		}
	}
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<h2 class="heading">{m.admin_mod_heading()}</h2>
<p class="note">{m.admin_mod_intro()}</p>

{#if needsReauth}
	<ReauthPrompt twoFactorEnabled={data.admin.twoFactorEnabled} error={reauthError} />
{/if}

<div aria-live="polite">
	{#if done}
		<p class="ok">{doneText(done)}</p>
	{:else if reauthed}
		<p class="ok">{m.admin_reauth_ok()}</p>
	{:else if errorCode}
		<p class="error" role="alert">{errorText(errorCode)}</p>
	{/if}
</div>

{#if data.items.length === 0}
	<p>{m.admin_mod_empty()}</p>
{:else}
	<ul class="queue">
		{#each data.items as item, index (`${item.targetKind}:${item.targetId}`)}
			{@const preview = item.preview}
			{@const author = preview?.author ?? null}
			<li class="item">
				<h3 class="target">
					<span class="kind">{kindText(item.targetKind)}</span>
					{preview?.name ?? m.admin_mod_no_name()}
					<span class="id">{item.targetId}</span>
				</h3>
				<dl class="facts">
					<dt>{m.admin_mod_state()}</dt>
					<dd data-state={preview?.moderation ?? undefined}>
						{preview ? stateText(preview.moderation) : m.admin_mod_gone()}
						{#if preview?.curated}<span class="tag">{m.admin_mod_curated()}</span>{/if}
					</dd>
					<dt>{m.admin_mod_author()}</dt>
					<dd>
						{#if author}
							{author.nickname ?? author.id}
							{#if author.banned}<span class="danger">{m.admin_status_banned()}</span>{/if}
						{:else}
							{m.admin_mod_author_removed()}
						{/if}
					</dd>
					<dt>{m.admin_mod_reports()}</dt>
					<dd>
						{m.admin_mod_open({
							count: String(item.openReports),
							eligible: String(item.eligibleReporters)
						})}
					</dd>
					<dt>{m.admin_mod_when()}</dt>
					<dd>
						{formatWhen(item.firstAt, locale)} · {formatWhen(item.lastAt, locale)}
					</dd>
				</dl>
				<ul class="reasons" aria-label={m.admin_mod_reasons()}>
					{#each item.reasons as entry (entry.reason)}
						<li>{reasonText(entry.reason)}: {entry.count}</li>
					{/each}
				</ul>
				{#if item.notes.length > 0}
					<details>
						<summary>{m.admin_mod_notes({ count: String(item.notes.length) })}</summary>
						<ul class="notes">
							{#each item.notes as note, n (n)}
								<li>
									<span class="note">{reasonText(note.reason)}</span>
									<span class="text">{note.note}</span>
								</li>
							{/each}
						</ul>
					</details>
				{/if}

				<form method="POST" use:enhance class="decision">
					<input type="hidden" name="targetKind" value={item.targetKind} />
					<input type="hidden" name="targetId" value={item.targetId} />
					<label for="{uid}-reason-{index}">{m.admin_mod_reason_label()}</label>
					<textarea
						id="{uid}-reason-{index}"
						name="reason"
						maxlength="500"
						rows="2"
						aria-describedby="{uid}-hint-{index}"></textarea>
					<p id="{uid}-hint-{index}" class="note">{m.admin_mod_reason_hint()}</p>
					<div class="buttons">
						{#if item.targetKind !== 'user'}
							<button formaction="?/hide">{m.admin_mod_action_hide()}</button>
							<button formaction="?/restore">{m.admin_mod_action_restore()}</button>
							<button formaction="?/remove" class="danger">{m.admin_mod_action_remove()}</button>
						{/if}
						<button formaction="?/dismiss">{m.admin_mod_action_dismiss()}</button>
						{#if item.targetKind === 'lineage'}
							{#if preview?.curated}
								<button formaction="?/uncurate">{m.admin_mod_action_uncurate()}</button>
							{:else}
								<button formaction="?/curate">{m.admin_mod_action_curate()}</button>
							{/if}
						{/if}
					</div>
					{#if author && !author.admin && author.id !== data.selfId && !author.banned}
						<div class="ban">
							<label for="{uid}-duration-{index}">{m.admin_mod_duration_label()}</label>
							<select id="{uid}-duration-{index}" name="duration">
								{#each DURATIONS as days (days)}
									<option value={days}>{m.admin_mod_days({ days })}</option>
								{/each}
								<option value="permanent">{m.admin_mod_permanent()}</option>
							</select>
							<button formaction="?/ban" class="danger">{m.admin_mod_action_ban()}</button>
						</div>
					{/if}
				</form>
				<a href="/admin/auditoria?target={encodeURIComponent(item.targetId)}"
					>{m.admin_audit_link()}</a
				>
			</li>
		{/each}
	</ul>
{/if}

<nav class="pages" aria-label={m.admin_mod_pages()}>
	{#if data.cursor}
		<a href="/admin/moderacao">{m.admin_mod_first()}</a>
	{/if}
	{#if data.nextCursor}
		<a href="/admin/moderacao?cursor={encodeURIComponent(data.nextCursor)}">{m.admin_mod_next()}</a>
	{/if}
</nav>

<style>
	.heading {
		margin: 0 0 var(--space-3);
		font-size: var(--fs-body);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}
	.queue,
	.reasons,
	.notes {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.item {
		margin-top: var(--space-4);
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--rule);
	}
	.target {
		margin: 0 0 var(--space-2);
		font-size: var(--fs-body);
		font-weight: 400;
		overflow-wrap: anywhere;
	}
	.kind,
	.id,
	dt,
	.note {
		color: var(--muted);
	}
	.kind,
	dt {
		font-size: var(--label-min);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}
	.id {
		display: block;
		font-size: var(--label-min);
	}
	.facts {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-3);
		margin: 0 0 var(--space-2);
	}
	dd {
		margin: 0;
	}
	.reasons {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.text {
		display: block;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.tag {
		margin-inline-start: var(--space-2);
		color: var(--accent-hi);
	}
	.decision {
		display: grid;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}
	.buttons,
	.ban {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	textarea,
	select {
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
	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}
	textarea:focus-visible,
	select:focus-visible,
	button:focus-visible,
	a:focus-visible,
	summary:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	.danger,
	.error {
		color: var(--danger);
	}
	.ok {
		color: var(--state-text);
	}
	.pages {
		display: flex;
		gap: var(--space-4);
		margin-top: var(--space-4);
	}
	a {
		color: var(--nav-link);
	}
</style>
