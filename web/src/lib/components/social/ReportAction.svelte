<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { page } from '$app/state';
	import { createSocialApi, createSocialSession, type SocialApi } from '#lib/social/index.ts';
	import type { ReportTargetKind } from '#lib/server/social/types.ts';
	import type { SessionView } from '#lib/components/pages/comunidade/model.ts';
	import ReportPanel from '#lib/components/pages/comunidade/ReportPanel.svelte';
	import { getReportSiteKey } from '#lib/social/report-context.ts';

	let {
		subject,
		name,
		author,
		api = createSocialApi(),
		session,
		siteKey,
		online = true
	}: {
		subject: { kind: ReportTargetKind; id: string };
		name: string;
		/** Public username of the owner (not their opaque hidden-author id). */
		author?: string | null;
		api?: SocialApi;
		session?: SessionView;
		/** Turnstile site key; the layout provides it through context when not given. */
		siteKey?: string;
		online?: boolean;
	} = $props();
	const contextKey = getReportSiteKey();
	const key = $derived(siteKey ?? contextKey);
	const ownSession = createSocialSession();
	let open = $state(false);
	let sessionBusy = $state(false);
	const viewer = $derived(session?.nickname ?? page.data.user?.username ?? ownSession.nickname);
	const owner = $derived(subject.kind === 'user' ? subject.id : author);
	const isOwn = $derived(!!viewer && !!owner && viewer.toLowerCase() === owner.toLowerCase());
	async function toggle(event: Event) {
		open = (event.currentTarget as HTMLDetailsElement).open;
		if (!open) return;
		if (!session && !ownSession.known) await refreshSession();
	}
	async function refreshSession() {
		sessionBusy = true;
		try {
			await ownSession.refresh();
		} finally {
			sessionBusy = false;
		}
	}
</script>

{#if !isOwn}
	<details class="report-action" ontoggle={toggle}>
		<summary>{m.fxpc_report_item({ name })}</summary>
		{#if open}
			{#if !(session ?? ownSession).known}
				{#if sessionBusy}<p role="status">{m.hidden_loading()}</p>
				{:else}
					<p role="alert">{m.hidden_error()}</p>
					<button type="button" onclick={refreshSession}>{m.hidden_retry()}</button>
				{/if}
			{:else}
				<ReportPanel
					{api}
					session={session ?? ownSession}
					{subject}
					targetName={name}
					siteKey={key}
					{online}
				/>
			{/if}
		{/if}
	</details>
{/if}

<style>
	.report-action {
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	summary {
		cursor: pointer;
		min-height: var(--hit);
		padding: var(--space-2);
	}
</style>
