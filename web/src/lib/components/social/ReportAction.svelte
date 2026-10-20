<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { createSocialApi, createSocialSession, type SocialApi } from '#lib/social/index.ts';
	import type { ReportTargetKind } from '#lib/server/social/types.ts';
	import type { SessionView } from '#lib/components/pages/comunidade/model.ts';
	import ReportPanel from '#lib/components/pages/comunidade/ReportPanel.svelte';
	import { getReportSiteKey } from '#lib/social/report-context.ts';

	let {
		subject,
		name,
		api = createSocialApi(),
		session,
		siteKey,
		online = true
	}: {
		subject: { kind: ReportTargetKind; id: string };
		name: string;
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
	async function toggle(event: Event) {
		open = (event.currentTarget as HTMLDetailsElement).open;
		if (!open) return;
		if (!session && !ownSession.known) await ownSession.refresh();
	}
</script>

<details class="report-action" ontoggle={toggle}>
	<summary>{m.fxpc_report_item({ name })}</summary>
	{#if open}
		{#if !(session ?? ownSession).known}
			<p role="status">{m.hidden_loading()}</p>
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
