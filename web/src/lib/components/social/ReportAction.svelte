<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { page } from '$app/state';
	import { createSocialApi, createSocialSession, type SocialApi } from '#lib/social/index.ts';
	import type { ReportTargetKind } from '#lib/server/social/types.ts';
	import type { SessionView } from '#lib/components/pages/comunidade/model.ts';
	import ReportPanel from '#lib/components/pages/comunidade/ReportPanel.svelte';
	import { getReportSiteKey } from '#lib/social/report-context.ts';
	import { getViewer } from '#lib/social/viewer-context.ts';

	/** A page session that can be read again (`createSocialSession`); a plain view cannot. */
	type ReportSession = SessionView & {
		refresh?: (signal?: AbortSignal) => Promise<unknown>;
	};

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
		session?: ReportSession;
		/** Turnstile site key; the layout provides it through context when not given. */
		siteKey?: string;
		online?: boolean;
	} = $props();
	const contextKey = getReportSiteKey();
	const key = $derived(siteKey ?? contextKey);
	// Prerendered pages have no `page.data.user`: the layout's AccountSession knows the viewer.
	const layoutViewer = getViewer();
	const ownSession = createSocialSession();
	/** The session this action reads, so also the one it refreshes. */
	const used: ReportSession = $derived(session ?? ownSession);
	let open = $state(false);
	/** Opened or focused once: never unmounted under the reader (no focus loss), see `isOwn`. */
	let engaged = $state(false);
	let sessionBusy = $state(false);
	const viewer = $derived(
		session?.nickname ??
			page.data.user?.username ??
			layoutViewer?.current?.username ??
			ownSession.nickname
	);
	const owner = $derived(subject.kind === 'user' ? subject.id : author);
	const isOwn = $derived(!!viewer && !!owner && viewer.toLowerCase() === owner.toLowerCase());
	async function toggle(event: Event) {
		open = (event.currentTarget as HTMLDetailsElement).open;
		if (!open) return;
		engaged = true;
		if (!used.known) await refreshSession();
	}
	async function refreshSession() {
		const target = used;
		if (!target.refresh || sessionBusy) return;
		sessionBusy = true;
		try {
			await target.refresh();
		} catch (error) {
			console.warn('Report session check failed', error);
		} finally {
			sessionBusy = false;
		}
	}
	// Back online with the drawer open on a failed check: read the session again by itself.
	$effect(() => {
		const up = () => {
			if (open && !isOwn && !used.known) void refreshSession();
		};
		window.addEventListener('online', up);
		return () => window.removeEventListener('online', up);
	});
</script>

<!-- Own content known up front renders no Report. Once the reader opened or focused it, the
	 element stays and says the item is theirs instead of disappearing with the focus. -->
{#if !isOwn || engaged}
	<details class="report-action" ontoggle={toggle} onfocusin={() => (engaged = true)}>
		<summary>{m.fxpc_report_item({ name })}</summary>
		{#if open}
			{#if isOwn}
				<p role="status">{m.w4r1_report_own()}</p>
			{:else if !used.known}
				{#if sessionBusy}<p role="status">{m.w4r1_report_session_loading()}</p>
				{:else}
					<p role="alert">{m.w4r1_report_session_error()}</p>
					<button type="button" onclick={refreshSession}>{m.w4r1_report_retry()}</button>
				{/if}
			{:else}
				<ReportPanel {api} session={used} {subject} targetName={name} siteKey={key} {online} />
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
