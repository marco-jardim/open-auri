<script module lang="ts">
	export interface NavItem {
		href: string;
		label: string;
	}
</script>

<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';

	interface Props {
		currentPath?: string;
		items?: readonly NavItem[];
		label?: string;
	}

	let { currentPath = '/', items, label = m.chrome_nav_label() }: Props = $props();
	const links = $derived(
		items ?? [
			{ href: '/', label: m.chrome_nav_curve() },
			{ href: '/biblioteca', label: m.chrome_nav_library() },
			{ href: '/comparar', label: m.chrome_nav_compare() },
			{ href: '/soe-como-x', label: m.chrome_nav_sound() },
			{ href: '/comunidade', label: m.chrome_nav_community() },
			{ href: '/teste-cego', label: m.chrome_nav_blind() },
			{ href: '/cabo', label: m.chrome_nav_cable() },
			{ href: '/docs', label: m.chrome_nav_docs() }
		]
	);
	const pathname = $derived(currentPath.split(/[?#]/)[0].replace(/\/$/, '') || '/');
</script>

<nav class="main-nav" aria-label={label}>
	{#each links as item (item.href)}
		<a href={item.href} aria-current={pathname === item.href ? 'page' : undefined}>
			{item.label}
		</a>
	{/each}
</nav>

<style>
	.main-nav {
		display: flex;
		align-items: center;
		align-self: stretch;
		gap: 15px;
		white-space: nowrap;
		font: 11.5px/1.5 var(--ui, 'Geist', system-ui, sans-serif);
	}

	a {
		position: relative;
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: #cfc9be;
		text-decoration: none;
	}

	a:hover,
	a[aria-current='page'] {
		color: #ece7dd;
	}

	a[aria-current='page']::after {
		position: absolute;
		right: 0;
		bottom: 0;
		left: 0;
		height: 2px;
		background: var(--accent, #ff7a2f);
		content: '';
	}

	a:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 3px;
	}
</style>
