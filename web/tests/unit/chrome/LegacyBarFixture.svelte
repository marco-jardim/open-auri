<!--
	The global bar as it was before FUX.NAV (CableBar, Nav and LanguageToggle at e3982e4 plus the
	FUX.2 layout status trigger), frozen here so bar-fit.svelte.test.ts measures "before" and
	"after" in the same browser with the same fonts. Markup and styles are copied, not shared:
	the 56 px height is literal because the --bar-h token follows the new bar.
	Content as the layout renders it with the runtime ready and no visitor signed in.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { Button, IconButton } from '#lib/components/primitives/index.ts';

	const links = [
		{ href: '/', label: m.chrome_nav_curve() },
		{ href: '/biblioteca', label: m.chrome_nav_library() },
		{ href: '/comparar', label: m.chrome_nav_compare() },
		{ href: '/soe-como-x', label: m.chrome_nav_sound() },
		{ href: '/comunidade', label: m.chrome_nav_community() },
		{ href: '/teste-cego', label: m.chrome_nav_blind() },
		{ href: '/cabo', label: m.chrome_nav_cable() },
		{ href: '/docs', label: m.chrome_nav_docs() }
	];
</script>

<header class="cable-bar">
	<div class="cable-inner">
		<a class="wordmark" href="/">open-auri</a>
		<div class="navigation">
			<nav class="main-nav" aria-label={m.chrome_nav_label()}>
				{#each links as item (item.href)}
					<a href={item.href} aria-current={item.href === '/' ? 'page' : undefined}>{item.label}</a>
				{/each}
			</nav>
		</div>
		<div class="cable-actions">
			<div class="bar-status">
				<div class="cable-state" role="status">
					<button type="button" class="status-trigger">
						<span aria-hidden="true">●</span>
						{m.cable_status_disconnected()}
					</button>
				</div>
				<div class="dirty" aria-live="polite" aria-atomic="true"></div>
			</div>
			<div class="bar-tools">
				<Button size="sm" variant="plate"
					><span aria-hidden="true">♪</span> {m.chrome_audio()}</Button
				>
				<Button size="sm" variant="plate">{m.chrome_neutral()}</Button>
				<Button size="sm" variant="plate">{m.chrome_default_auri()}</Button>
				<Button size="sm" variant="primary">{m.chrome_write()}</Button>
			</div>
			<div class="bar-meta">
				<a class="account btn btn--plate btn--sm" href="/entrar?next=%2F">
					{m.auth_account_signin()}
				</a>
				<button type="button" class="language" lang="en-US">
					<span lang="pt-BR" class="on">PT</span>
					<span aria-hidden="true">·</span>
					<span lang="en-US">EN</span>
					<span class="sr-only">{m.chrome_language_switch()}</span>
				</button>
				<IconButton size="sm" variant="plate" label={m.chrome_help_open()}>?</IconButton>
			</div>
		</div>
	</div>
</header>

<style>
	.cable-bar {
		box-sizing: border-box;
		position: fixed;
		inset: 0 0 auto;
		z-index: 60;
		height: 56px;
		border-bottom: 1px solid var(--rule);
		background: var(--bar-bg);
		color: var(--text);
		font-family: var(--face-body);
	}

	.cable-inner {
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 20px;
		max-width: var(--frame-max);
		height: 100%;
		margin: auto;
		padding: 0 var(--gutter);
		overflow-x: auto;
		scrollbar-width: thin;
	}

	.wordmark {
		flex: none;
		color: inherit;
		font: italic 400 var(--fs-wordmark) / 1 var(--face-display);
		text-decoration: none;
		white-space: nowrap;
	}

	.navigation {
		align-self: stretch;
		margin-inline: auto;
	}

	.main-nav {
		display: flex;
		align-items: center;
		align-self: stretch;
		gap: 14px;
		width: max-content;
		height: 100%;
		white-space: nowrap;
		font: 400 var(--fs-caption) / var(--lh-ui) var(--face-body);
	}

	.main-nav a {
		position: relative;
		display: inline-flex;
		align-items: center;
		align-self: stretch;
		min-height: 44px;
		color: var(--text-2);
		text-decoration: none;
	}

	.cable-actions,
	.bar-status,
	.bar-tools,
	.bar-meta {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		white-space: nowrap;
	}

	.cable-state {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 0 10px;
		border: 1px solid var(--rule);
		border-radius: var(--rad-pill);
		color: var(--state-text);
		font-size: var(--label-min);
		line-height: var(--lh-caps);
	}

	.status-trigger {
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	.dirty {
		max-width: 116px;
		color: var(--muted);
		font: 500 var(--label-min) / var(--lh-ui) var(--face-body);
		white-space: normal;
	}

	.language {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		gap: 5px;
		min-width: 64px;
		min-height: 44px;
		padding: 7px 4px;
		border: 0;
		background: transparent;
		color: var(--muted);
		font: 400 var(--label-min) / 1.2 var(--face-data);
		letter-spacing: var(--tracking-data);
		white-space: nowrap;
	}

	.on {
		color: var(--text);
	}

	@media (max-width: 720px) {
		.cable-bar {
			position: relative;
			height: auto;
		}

		.cable-inner {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			grid-template-areas:
				'brand meta'
				'status status'
				'tools tools'
				'nav nav';
			align-items: center;
			gap: 8px 12px;
			height: auto;
			padding-top: 8px;
			overflow: visible;
		}

		.wordmark {
			grid-area: brand;
		}

		.cable-actions {
			display: contents;
		}

		.bar-meta {
			grid-area: meta;
			justify-self: end;
			gap: 4px;
		}

		.bar-status {
			grid-area: status;
			flex-wrap: wrap;
			white-space: normal;
		}

		.dirty {
			max-width: none;
		}

		.bar-tools {
			grid-area: tools;
			flex-wrap: wrap;
			justify-content: flex-end;
			white-space: normal;
		}

		.bar-tools :global(.btn),
		.bar-meta :global(.btn) {
			min-height: var(--hit);
		}

		.bar-meta :global(.btn--icon) {
			width: var(--hit);
		}

		.navigation {
			grid-area: nav;
			align-self: stretch;
			margin-inline: calc(-1 * var(--gutter));
			padding-inline: var(--gutter);
			overflow-x: auto;
			border-top: 1px solid var(--rule);
		}
	}
</style>
