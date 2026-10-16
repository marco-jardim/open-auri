<script lang="ts">
	import { page } from '$app/state';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import AuditTable from '#lib/components/admin/AuditTable.svelte';
	import { pageHref } from '#lib/components/admin/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const audit = $derived(data.audit);
</script>

<h2 class="heading">{m.admin_audit_heading()}</h2>

{#if data.target}
	<p>
		{m.admin_audit_filtered({ target: data.target })}
		<a href="/admin/auditoria">{m.admin_audit_clear_filter()}</a>
	</p>
{/if}

<AuditTable rows={audit.rows} locale={getLocale()} />

<nav class="pager" aria-label={m.admin_audit_nav_label()}>
	{#if audit.page > 1}
		<a
			rel="prev"
			href={pageHref(page.url.pathname, new URLSearchParams(page.url.search), audit.page - 1)}
			>{m.admin_audit_prev()}</a
		>
	{/if}
	<span aria-current="page">
		{m.admin_audit_page({ page: String(audit.page), pages: String(audit.pages) })}
	</span>
	{#if audit.page < audit.pages}
		<a
			rel="next"
			href={pageHref(page.url.pathname, new URLSearchParams(page.url.search), audit.page + 1)}
			>{m.admin_audit_next()}</a
		>
	{/if}
</nav>

<style>
	.heading {
		margin: 0 0 var(--space-3);
		font-size: var(--fs-body);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}
	.pager {
		display: flex;
		gap: var(--space-4);
		align-items: center;
		margin-top: var(--space-4);
	}
	a {
		color: var(--nav-link);
	}
	a:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
</style>
