<!--
	Main navigation of the bar (FUX.NAV): inline links that fold, by tier, into "Mais" as the bar
	narrows, so the bar never scrolls sideways (tiers in nav-links.ts). The bar's overflow guard can
	fold more at any width (`data-squeeze` on an ancestor). "Mais" (LazyMenu, its menu a chunk of
	its own) lists exactly the links hidden at the moment it opens; it carries the page mark when
	the current page is among them. Every link keeps `aria-current`,
	`data-sveltekit-preload-code="hover"` and the "Soe como X" warm-up (W5), also inside "Mais".
	The mobile list lives in the menu sheet (BarSheet.svelte).
-->
<script module lang="ts">
	import { mainLinks, navPathname, warmLink, type NavItem } from './nav-links.ts';

	/** Delegated intent from the "Mais" items, which the Menu primitive renders. */
	function warmFrom(event: Event): void {
		const target = event.target;
		if (target instanceof Element) warmLink(target.closest('a[href]')?.getAttribute('href'));
	}

	function slug(href: string): string {
		return href === '/' ? 'home' : href.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
	}
</script>

<script lang="ts">
	import type { Attachment } from 'svelte/attachments';
	import { m } from '#lib/paraglide/messages.js';
	import type { MenuItem } from '#lib/components/primitives/Menu.svelte';
	import LazyMenu from './LazyMenu.svelte';

	interface Props {
		currentPath?: string;
		items?: readonly NavItem[];
		label?: string;
	}

	let { currentPath = '/', items, label = m.chrome_nav_label() }: Props = $props();
	const links = $derived<readonly NavItem[]>(items ?? mainLinks());
	const pathname = $derived(navPathname(currentPath));
	const foldable = $derived(links.some((item) => (item.tier ?? 0) > 0));

	let navElement: HTMLElement | undefined = $state();
	/** Hrefs of the inline links hidden when "Mais" was last opened. */
	let folded = $state<readonly string[]>([]);

	/** Reads the hidden links from the DOM (width tiers and the guard's squeeze level). */
	function refresh(): void {
		if (!navElement) return;
		const hidden = [...navElement.querySelectorAll<HTMLAnchorElement>('a[data-nav-link]')]
			.filter((link) => link.getClientRects().length === 0)
			.map((link) => link.getAttribute('href') ?? '');
		if (hidden.length !== folded.length || hidden.some((href, index) => href !== folded[index])) {
			folded = hidden;
		}
	}

	/** Every later opening re-reads too (pointer press, or the keys that open a menu button). */
	const moreIntent: Attachment<HTMLElement> = (node) => {
		node.addEventListener('pointerdown', refresh, true);
		node.addEventListener('keydown', refresh, true);
		node.addEventListener('pointerover', warmFrom);
		node.addEventListener('focusin', warmFrom);
		return () => {
			node.removeEventListener('pointerdown', refresh, true);
			node.removeEventListener('keydown', refresh, true);
			node.removeEventListener('pointerover', warmFrom);
			node.removeEventListener('focusin', warmFrom);
		};
	};

	const moreItems = $derived(
		links
			.filter((item) => folded.includes(item.href))
			.map((item): MenuItem => ({
				id: slug(item.href),
				label: item.label,
				href: item.href,
				current: pathname === item.href
			}))
	);
</script>

<nav class="main-nav" aria-label={label} bind:this={navElement}>
	{#each links as item (item.href)}
		<!-- W1 (FUX.2): route code on hover, focus or touch start; data stays per <body>.
		     W5: pointer or keyboard intent on "Soe como X" also prefetches its AutoEq index. -->
		<a
			class="nav-link"
			href={item.href}
			data-nav-link
			data-tier={item.tier ?? 0}
			data-sveltekit-preload-code="hover"
			aria-current={pathname === item.href ? 'page' : undefined}
			onpointerenter={() => warmLink(item.href)}
			onfocus={() => warmLink(item.href)}
		>
			{item.label}
		</a>
	{/each}
	{#if foldable}
		<div class="nav-more" data-sveltekit-preload-code="hover" {@attach moreIntent}>
			<LazyMenu items={moreItems} align="start" class="nav-more-trigger" onintent={refresh}>
				{#snippet trigger()}
					{m.fuxnav_more()}
					<svg class="caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
						<path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
					</svg>
				{/snippet}
			</LazyMenu>
		</div>
	{/if}
</nav>

<style>
	.main-nav {
		display: flex;
		align-items: stretch;
		align-self: stretch;
		width: max-content;
		height: 100%;
		white-space: nowrap;
		font: 400 var(--fs-caption) / var(--lh-ui) var(--face-body);
	}

	.nav-link,
	.main-nav :global(.nav-more-trigger) {
		position: relative;
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 5px;
		box-sizing: border-box;
		min-height: 36px;
		margin: 0;
		padding: 0 6px;
		border: 0;
		background: transparent;
		color: var(--text-2);
		font: inherit;
		text-decoration: none;
		cursor: pointer;
		transition: color var(--dur-fast) var(--ease-out);
	}

	.nav-link:hover,
	.nav-link[aria-current='page'],
	.main-nav :global(.nav-more-trigger:hover),
	.main-nav :global(.nav-more-trigger[aria-expanded='true']) {
		color: var(--text);
	}

	/* Accent underline on the bar's bottom edge, as in the mocks. */
	.nav-link[aria-current='page']::after,
	.main-nav :global(.nav-more-trigger)::after {
		position: absolute;
		right: 6px;
		bottom: 0;
		left: 6px;
		height: 2px;
		background: var(--accent);
		box-shadow: 0 0 8px var(--accent-glow);
		content: '';
	}

	/* "Mais" shows the mark only when the current page is folded inside (set below). */
	.main-nav :global(.nav-more-trigger)::after {
		opacity: var(--more-mark, 0);
	}

	.nav-link:focus-visible,
	.main-nav :global(.nav-more-trigger:focus-visible) {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: -2px;
		border-radius: var(--rad-sm);
	}

	.main-nav :global(.nav-more-trigger .caret) {
		flex: none;
		opacity: 0.75;
		transition: transform var(--dur-fast) var(--ease-out);
	}

	.main-nav :global(.nav-more-trigger[aria-expanded='true'] .caret) {
		transform: rotate(180deg);
	}

	.nav-more {
		display: flex;
		align-items: stretch;
	}

	/* Fold tiers by width (nav-links.ts). */
	.nav-link[data-tier='2'],
	.nav-link[data-tier='3'] {
		display: none;
	}

	@media (max-width: 1599px) {
		.main-nav:has(.nav-link[data-tier='3'][aria-current='page']) {
			--more-mark: 1;
		}
	}

	@media (min-width: 1024px) {
		.nav-link[data-tier='2'] {
			display: inline-flex;
		}
	}

	@media (max-width: 1023px) {
		.main-nav:has(.nav-link[data-tier='2'][aria-current='page']) {
			--more-mark: 1;
		}
	}

	@media (min-width: 1600px) {
		.nav-link[data-tier='3'] {
			display: inline-flex;
		}

		.nav-more {
			display: none;
		}
	}

	/* The bar's overflow guard (CableBar `data-squeeze`) folds more, last tier first. */
	:global([data-squeeze~='2']) .nav-link[data-tier='3'],
	:global([data-squeeze~='3']) .nav-link[data-tier='2'],
	:global([data-squeeze~='4']) .nav-link[data-tier='1'],
	:global([data-squeeze~='5']) .nav-link[data-tier='0'] {
		display: none;
	}

	:global([data-squeeze~='2']) .nav-more {
		display: flex;
	}

	:global([data-squeeze~='2']) .main-nav:has(.nav-link[data-tier='3'][aria-current='page']),
	:global([data-squeeze~='3']) .main-nav:has(.nav-link[data-tier='2'][aria-current='page']),
	:global([data-squeeze~='4']) .main-nav:has(.nav-link[data-tier='1'][aria-current='page']),
	:global([data-squeeze~='5']) .main-nav:has(.nav-link[data-tier='0'][aria-current='page']) {
		--more-mark: 1;
	}

	@media (prefers-reduced-motion: reduce) {
		.main-nav :global(.nav-more-trigger .caret) {
			transition: none;
		}
	}
</style>
