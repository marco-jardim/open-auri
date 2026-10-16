<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { m } from '#lib/paraglide/messages.js';
	import AdminNav from '#lib/components/admin/AdminNav.svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
	<title>{m.admin_meta_title()}</title>
</svelte:head>

<div class="admin">
	<header class="admin-head">
		<h1>{m.admin_title()}</h1>
		<AdminNav currentPath={page.url.pathname} />
		<ul class="status" aria-label={m.admin_status_label()}>
			<li data-state={data.readOnly ? 'warn' : 'ok'}>
				<span aria-hidden="true">●</span>
				{data.readOnly ? m.admin_status_read_only_on() : m.admin_status_read_only_off()}
			</li>
			<li data-state={data.accessConfigured ? 'ok' : 'warn'}>
				<span aria-hidden="true">●</span>
				{data.accessConfigured ? m.admin_access_on() : m.admin_access_off()}
			</li>
		</ul>
	</header>
	{@render children()}
</div>

<style>
	.admin {
		max-width: var(--frame-max);
		margin: auto;
		padding: var(--space-5) var(--gutter) var(--space-8);
		font-family: var(--mono);
		font-size: var(--fs-ui);
		color: var(--text);
	}
	.admin-head {
		display: grid;
		gap: var(--space-3);
		margin-bottom: var(--space-5);
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--rule);
	}
	h1 {
		margin: 0;
		font-size: var(--fs-honoree);
		font-family: var(--serif);
		font-weight: 400;
	}
	.status {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
		color: var(--state-text);
	}
	.status li[data-state='warn'] {
		color: var(--danger);
	}
</style>
