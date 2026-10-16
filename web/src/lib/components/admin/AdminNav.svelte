<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';

	let { currentPath }: { currentPath: string } = $props();

	const links = $derived([
		{ href: '/admin', label: m.admin_nav_dashboard() },
		{ href: '/admin/usuarios', label: m.admin_nav_users() },
		{ href: '/admin/moderacao', label: m.admin_nav_moderation() },
		{ href: '/admin/auditoria', label: m.admin_nav_audit() }
	]);
</script>

<nav class="admin-nav" aria-label={m.admin_nav_label()}>
	<ul>
		{#each links as link (link.href)}
			<li>
				<a href={link.href} aria-current={currentPath === link.href ? 'page' : undefined}
					>{link.label}</a
				>
			</li>
		{/each}
	</ul>
</nav>

<style>
	.admin-nav ul {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.admin-nav a {
		display: inline-block;
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--rule);
		border-radius: var(--rad-sm);
		color: var(--nav-link);
		font-family: var(--mono);
		font-size: var(--fs-ui);
		text-decoration: none;
	}
	.admin-nav a:hover {
		color: var(--text);
	}
	.admin-nav a[aria-current='page'] {
		border-color: var(--accent);
		color: var(--accent-hi);
	}
	.admin-nav a:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
</style>
